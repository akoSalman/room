// ── Sending a file in pieces, so it can be paused (web) ─────────────────────
//
// The browser could already POST a whole file with real progress events, and
// that is all it could do: no pause, and a connection that died at 90% of a
// 60 MB video cost all 60 MB again.
//
// Same design as the app. The file goes up in chunks against a server session
// that remembers how many bytes it holds; pausing aborts the chunk in flight,
// and resuming asks the server where it actually got to. The offset always
// comes from the SERVER — the browser counts bytes handed to the network
// stack, not bytes that arrived, and after a mid-chunk drop those differ.
// Carrying on from the browser's number would append the tail of a chunk the
// server never received, leaving a hole in the middle of a file that then
// uploads "successfully" and is broken.
//
// The chunking rules — size, where to resume, what is worth retrying, how to
// word the status line — are the app's, in uploadSession.ts. This file is the
// browser's half: Blob.slice, which is exactly the thing the app has to work
// to get and the browser gives away.
(function () {
  'use strict';

  // How big a chunk is, and how long one may go silent, both come from
  // UploadTuning — see native-app/src/uploadSession.ts for why they are not
  // constants any more.
  var MAX_BYTES = 80 * 1024 * 1024;
  var MAX_ATTEMPTS = 5;

  function shouldRetry(attempt, status) {
    if (attempt >= MAX_ATTEMPTS) return false;
    if (status === undefined || status === 0) return true;   // network failure
    if (status === 408 || status === 429) return true;
    return status >= 500;
  }

  /** Exponential, with jitter — or every browser that lost the same wifi comes back at once. */
  function retryDelay(attempt) {
    var base = Math.min(1000 * Math.pow(2, Math.max(0, attempt)), 30000);
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }

  function fmtBytes(n) {
    if (!isFinite(n) || n <= 0) return '0 B';
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  /**
   * Send a file, resumably.
   *
   * Returns { pause, resume, cancel } straight away; everything else arrives
   * through the callbacks.
   */
  function upload(file, filename, cb) {
    var stopped = false, paused = false, running = false;
    var sessionId = null;
    var total = file.size;
    var offset = 0;
    var attempt = 0;
    var inFlight = null;
    var wake = null, timer = null;
    var lastByteAt = 0;
    var stallTimer = null;
    var stalled = false;
    // Reported from an iPhone: the bar does not advance unless you pause and
    // resume. Progress is only KNOWN when a chunk lands — the server discards
    // an incomplete one — so at half a megabyte and the 13 KB/s that phone had,
    // the bar sat still for forty seconds at a time. The chunk now follows the
    // connection: the first one is small because it is the measurement.
    var chunk = UploadTuning.FIRST_CHUNK_BYTES;
    var rate = 0;            // bytes per second, from the chunks that landed
    var chunkStartedAt = 0;
    // The highest progress already shown. Re-sending a chunk starts its byte
    // count again, so reporting it honestly makes the bar jump backwards —
    // and the bytes are not lost, because the server keeps whatever arrived.
    var peak = 0;

    /** Progress, never going backwards. See UploadTuning.reportedSent. */
    function report(sent) {
      peak = UploadTuning.reportedSent(peak, sent, total);
      cb.onProgress(peak, total);
    }

    function headers(extra) {
      var h = { Authorization: 'Bearer ' + window.token };
      for (var k in (extra || {})) h[k] = extra[k];
      return h;
    }

    function sleep(ms) {
      return new Promise(function (resolve) {
        wake = function () { clearTimeout(timer); wake = null; resolve(); };
        timer = setTimeout(function () { wake = null; resolve(); }, ms);
      });
    }

    // Aborting the request in flight AND waking any backoff sleep. Without the
    // second, pausing between two retries parks the loop on a promise nobody
    // will ever settle, and resume does nothing at all.
    function stopWaiting() {
      clearInterval(stallTimer);
      try { if (inFlight) inFlight.abort(); } catch (e) {}
      if (wake) wake();
    }

    function sendChunk(start, end) {
      return new Promise(function (resolve) {
        var xhr = new XMLHttpRequest();
        inFlight = xhr;
        // POST, not PATCH. There is no semantic need for PATCH — this appends
        // to a session — and PATCH with a body is the least well-trodden path
        // through the Apache reverse proxy in front of this app. Whole-file
        // POST uploads have always worked through it.
        xhr.open('POST', '/upload/session/' + sessionId);
        xhr.setRequestHeader('Authorization', 'Bearer ' + window.token);
        xhr.setRequestHeader('x-offset', String(start));
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        // ── Progress WITHIN the chunk ──────────────────────────────────────
        //
        // Reported as: the bar never advances; pausing and resuming is the
        // only way to move it.
        //
        // Progress was reported only BETWEEN chunks, and a chunk is half a
        // megabyte — so anything smaller is a SINGLE chunk, and the bar sat at
        // "0 B / 239 KB" for the whole upload before jumping to done. Not a
        // stall, but indistinguishable from one. Pause-and-resume appeared to
        // fix it because resuming asks the server how much it already has, and
        // by then it had all of it.
        //
        // The stall watchdog is fed from here too: bytes actually moving is
        // the only evidence that anything is still happening.
        xhr.upload.onprogress = function (e) {
          lastByteAt = Date.now();
          if (e.lengthComputable) report(start + e.loaded);
        };
        xhr.onload = function () {
          var body = {};
          try { body = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
          if (xhr.status >= 200 && xhr.status < 300 && typeof body.offset === 'number') {
            resolve({ ok: true, offset: body.offset });
          } else {
            // A 409 carries the offset the server really has, which is exactly
            // what a resume needs, so it is passed back rather than discarded.
            resolve({ ok: false, status: xhr.status, offset: body.offset });
          }
        };
        xhr.onerror = function () { resolve({ ok: false, status: 0 }); };
        xhr.ontimeout = function () { resolve({ ok: false, status: 0 }); };
        // Aborted by pause or cancel, or by the watchdog below. The watchdog
        // marks itself, so a stall is retried while a deliberate pause is not.
        xhr.onabort = function () { resolve({ ok: false, status: stalled ? 0 : -1 }); };
        // Blob.slice is a reference to a range of the file, not a copy: the
        // bytes never pass through JavaScript.
        xhr.send(file.slice(start, end));

        // Restarted for each chunk, and only fires when nothing at all has
        // moved for long enough that this cannot be a chunk still on its way.
        //
        // It has to outlast the chunk itself, because a browser that reports
        // nothing until the chunk lands — Safari on iOS, for uploads — makes a
        // healthy chunk look identical to a dead connection. Aborting there is
        // worse than useless: the server discards the partial, so the retry
        // sends the same bytes again and the upload never advances.
        var patience = UploadTuning.stallTimeoutMs(end - start, rate);
        stalled = false;
        lastByteAt = Date.now();
        clearInterval(stallTimer);
        stallTimer = setInterval(function () {
          if (Date.now() - lastByteAt < patience) return;
          clearInterval(stallTimer);
          stalled = true;
          try { xhr.abort(); } catch (err) {}
        }, 5000);
      });
    }

    async function start() {
      if (running || stopped) return;
      running = true;
      try {
        if (!sessionId) {
          if (!total) throw new Error('That file is empty');
          if (total > MAX_BYTES) throw new Error('That file is too large');
          var r = await window.api('/upload/session', 'POST',
            { name: filename || file.name, size: total, mime: file.type || 'application/octet-stream' });
          if (!r || r.error || !r.id) throw new Error((r && r.error) || 'Could not start upload');
          sessionId = r.id;
          offset = 0;
        } else {
          // Resuming: the server's count is the only one that can be trusted.
          var w = await window.api('/upload/session/' + sessionId);
          if (!w || w.error) throw new Error('This upload expired — send it again');
          offset = Math.max(0, Math.min(w.offset || 0, total));
        }
        report(offset);
        await pump();
      } catch (e) {
        running = false;
        if (!stopped) cb.onFailed(e);
        return;
      }
      running = false;
    }

    async function pump() {
      while (!stopped && !paused && offset < total) {
        var end = Math.min(offset + chunk, total);
        chunkStartedAt = Date.now();
        var sending = end - offset;
        var res = await sendChunk(offset, end);
        inFlight = null;
        clearInterval(stallTimer);

        if (res.ok) {
          attempt = 0;
          // What that chunk actually managed, which decides the next one.
          var elapsed = Date.now() - chunkStartedAt;
          if (elapsed > 0) {
            var observed = (sending / elapsed) * 1000;
            // Smoothed: one quick chunk on a flaky connection is not a
            // promise about the next one.
            rate = rate ? (rate * 0.6 + observed * 0.4) : observed;
            chunk = UploadTuning.nextChunkBytes(rate, chunk);
          }
          offset = res.offset;
          report(offset);
          continue;
        }
        if (res.status === -1) return;                    // aborted by us
        if (res.status === 409 && typeof res.offset === 'number') {
          offset = Math.max(0, Math.min(res.offset, total));
          report(offset);
          continue;
        }
        if (!shouldRetry(attempt, res.status)) {
          throw new Error('Upload failed (' + (res.status || 'connection') + ')');
        }
        // A chunk that failed is evidence about this connection, and the only
        // evidence the rate never sees — it is measured from successes alone.
        chunk = UploadTuning.shrinkAfterFailure(chunk);
        await sleep(retryDelay(attempt));
        attempt++;
        if (stopped || paused) return;
      }

      if (stopped || paused || offset < total) return;

      // The last request, and the one that used to hang forever: every byte
      // has arrived, and this is what turns the pieces into a file. It had no
      // timeout on it, so a connection that changed hands mid-request left the
      // bar sitting at 100% with nothing below it that would ever fire.
      //
      // Retried, which is only safe because the server answers a repeat finish
      // with the result it already produced rather than "no such upload".
      var fin = null;
      for (var fa = 0; fa <= MAX_ATTEMPTS; fa++) {
        if (stopped || paused) return;
        fin = await finishOnce(sessionId);
        if (fin && fin.url) break;
        if (!shouldRetry(fa, fin && fin.status)) break;
        await sleep(retryDelay(fa));
      }
      if (!fin || !fin.url) throw new Error((fin && fin.error) || 'Could not finish upload');
      cb.onDone(fin);
    }

    /** One attempt at the finish, with a deadline on it. */
    async function finishOnce(id) {
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var killer = setTimeout(function () { try { ctl && ctl.abort(); } catch (e) {} },
        UploadTuning.FINISH_TIMEOUT_MS);
      try {
        // A relative path, like every other request the page makes; and
        // fetch directly rather than through window.api(), which has no
        // deadline — a deadline is the entire point of this function.
        var r = await fetch('/upload/session/' + id + '/finish', {
          method: 'POST',
          headers: headers({ 'Content-Type': 'application/json' }),
          signal: ctl ? ctl.signal : undefined,
        });
        var j = {};
        try { j = await r.json(); } catch (e) {}
        if (r.ok && j && j.url) return j;
        return { status: r.status, error: j && j.error };
      } catch (e) {
        // Aborted by the deadline, or the network went away: both retryable.
        return { status: 0 };
      } finally {
        clearTimeout(killer);
      }
    }

    start();

    return {
      pause: function () {
        if (stopped || paused) return;
        paused = true;
        stopWaiting();
        if (cb.onPaused) cb.onPaused();
      },
      resume: function () {
        if (stopped || !paused) return;
        paused = false;
        // The previous run may not have unwound yet — aborting an XHR settles
        // on a later tick — and start() refuses to run twice. Wait for it
        // rather than dropping the resume on the floor.
        var kick = function () {
          if (stopped || paused) return;
          if (running) setTimeout(kick, 50);
          else start();
        };
        kick();
      },
      cancel: function () {
        if (stopped) return;
        stopped = true;
        stopWaiting();
        // Best effort: the server reaps abandoned partials within a day even
        // if this never lands.
        if (sessionId) {
          window.api('/upload/session/' + sessionId, 'DELETE').catch(function () {});
        }
      },
    };
  }

  window.Resumable = { upload: upload, fmtBytes: fmtBytes };
})();
