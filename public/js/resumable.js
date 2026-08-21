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

  var CHUNK = 512 * 1024;
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
      try { if (inFlight) inFlight.abort(); } catch (e) {}
      if (wake) wake();
    }

    function sendChunk(start, end) {
      return new Promise(function (resolve) {
        var xhr = new XMLHttpRequest();
        inFlight = xhr;
        xhr.open('PATCH', '/upload/session/' + sessionId);
        xhr.setRequestHeader('Authorization', 'Bearer ' + window.token);
        xhr.setRequestHeader('x-offset', String(start));
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
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
        xhr.onabort = function () { resolve({ ok: false, status: -1 }); };  // our own pause
        // Blob.slice is a reference to a range of the file, not a copy: the
        // bytes never pass through JavaScript.
        xhr.send(file.slice(start, end));
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
        cb.onProgress(offset, total);
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
        var end = Math.min(offset + CHUNK, total);
        var res = await sendChunk(offset, end);
        inFlight = null;

        if (res.ok) {
          attempt = 0;
          offset = res.offset;
          cb.onProgress(offset, total);
          continue;
        }
        if (res.status === -1) return;                    // aborted by us
        if (res.status === 409 && typeof res.offset === 'number') {
          offset = Math.max(0, Math.min(res.offset, total));
          cb.onProgress(offset, total);
          continue;
        }
        if (!shouldRetry(attempt, res.status)) {
          throw new Error('Upload failed (' + (res.status || 'connection') + ')');
        }
        await sleep(retryDelay(attempt));
        attempt++;
        if (stopped || paused) return;
      }

      if (stopped || paused || offset < total) return;
      var fin = await window.api('/upload/session/' + sessionId + '/finish', 'POST');
      if (!fin || fin.error || !fin.url) throw new Error((fin && fin.error) || 'Could not finish upload');
      cb.onDone(fin);
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
