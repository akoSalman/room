// ── Sending a file in pieces, so it can be paused ────────────────────────────
//
// The decisions (chunk size, where to resume from, what is worth retrying)
// live in uploadSession.ts and are tested there. This is the part that touches
// the network and the filesystem.
//
// Two ways of getting bytes out of a local file, tried in that order:
//
//   1. As a Blob, sliced. The bytes never enter JavaScript — the slice is a
//      reference to a range of the native file, and the network stack reads it
//      directly. This is the one that matters for a 60 MB video.
//   2. As base64 through the bridge. A third more bytes on the wire and a
//      round trip through a string, so it is the fallback and not the plan.
//      It exists because a file the Blob path cannot open would otherwise mean
//      no upload at all.
//
// The choice is made once per file, on the first chunk, and then kept.
import * as FileSystem from 'expo-file-system';
import {
  chunkRange, resumeOffset, isComplete,
  shouldRetry, retryDelay, MAX_UPLOAD_BYTES,
  stallTimeoutMs, FINISH_TIMEOUT_MS, shouldRetryFinish, MAX_ATTEMPTS,
  FIRST_CHUNK_BYTES, nextChunkBytes, shrinkAfterFailure, reportedSent,
} from './uploadSession';

export type UploadHandle = {
  /** Stop after the chunk in flight; the bytes already sent are kept. */
  pause(): void;
  /** Carry on from wherever the server says it got to. */
  resume(): void;
  /** Give up and tell the server to drop what it has. */
  cancel(): void;
};

export type UploadCallbacks = {
  onProgress(sent: number, total: number): void;
  onPaused?(): void;
  onDone(result: { url: string; name: string; mimetype: string }): void;
  onFailed(err: Error): void;
};

type Reader = (start: number, end: number) => Promise<{ body: any; base64: boolean }>;

/** How many bytes the file holds, or 0 if that cannot be established. */
async function sizeOf(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    return info.exists && typeof (info as any).size === 'number' ? (info as any).size : 0;
  } catch {
    return 0;
  }
}

/**
 * Prefer slicing a Blob; fall back to base64.
 *
 * The Blob is fetched ONCE and sliced per chunk. Fetching it per chunk would
 * re-open the file every half megabyte, which on a large video is most of the
 * cost of the upload.
 */
async function makeReader(uri: string): Promise<Reader> {
  try {
    const res = await fetch(uri);
    const blob = await res.blob();
    if (blob && typeof (blob as any).slice === 'function' && blob.size > 0) {
      return async (start, end) => ({ body: blob.slice(start, end), base64: false });
    }
  } catch {}
  return async (start, end) => ({
    body: await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: start,
      length: end - start,
    }),
    base64: true,
  });
}

type ChunkResult = { ok: boolean; status?: number; offset?: number };

/** One PATCH. Resolves rather than throwing, so the caller decides what next. */
function sendChunk(
  url: string, token: string, at: number, body: any, base64: boolean,
  onXhr: (x: XMLHttpRequest) => void,
  onBytes?: (loaded: number) => void,
  timeoutMs?: number,
): Promise<ChunkResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    // A deadline, at last. `ontimeout` was handled below all along and could
    // never fire, because nothing ever set one — so a request that stopped
    // making progress (a connection changing hands between towers, which on
    // these networks is routine) left the upload parked forever with the bar
    // frozen. The web upload has had this from the start; the app never did.
    if (timeoutMs && timeoutMs > 0) xhr.timeout = timeoutMs;
    // POST, not PATCH: there is no semantic need for PATCH here, and PATCH
    // with a body is the least well-trodden path through a reverse proxy or a
    // middlebox. The server accepts both.
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('x-offset', String(at));
    // Content-Type is what tells the server which of the two bodies this is.
    xhr.setRequestHeader('Content-Type', base64 ? 'text/plain' : 'application/octet-stream');
    if (base64) xhr.setRequestHeader('x-encoding', 'base64');
    // Progress WITHIN the chunk. Without it nothing is reported until a whole
    // half-megabyte lands, so anything smaller than that — which is most
    // photos — shows no movement at all before it finishes. That is not a
    // stall, but on screen it is indistinguishable from one.
    if (onBytes && xhr.upload) {
      xhr.upload.onprogress = (e: any) => {
        if (e?.lengthComputable) onBytes(e.loaded);
      };
    }
    xhr.onload = () => {
      let parsed: any = {};
      try { parsed = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && typeof parsed.offset === 'number') {
        resolve({ ok: true, offset: parsed.offset });
      } else {
        // A 409 carries the offset the server really has, which is exactly
        // what a resume needs — so it is passed back rather than discarded.
        resolve({ ok: false, status: xhr.status, offset: parsed?.offset });
      }
    };
    xhr.onerror = () => resolve({ ok: false, status: 0 });
    xhr.ontimeout = () => resolve({ ok: false, status: 0 });
    xhr.onabort = () => resolve({ ok: false, status: -1 });   // our own pause
    onXhr(xhr);
    xhr.send(body);
  });
}

/**
 * Send a file, resumably.
 *
 * Returns immediately with the controls; everything else happens through the
 * callbacks. Pausing aborts the chunk in flight, so it takes effect at once
 * rather than at the end of the current half megabyte — that chunk is simply
 * sent again on resume, which costs less than a pause button that does not
 * feel like one.
 */
export function uploadResumable(
  baseUrl: string,
  uri: string,
  name: string,
  mime: string,
  token: string,
  cb: UploadCallbacks,
  chunkBytes = FIRST_CHUNK_BYTES,
): UploadHandle {
  let stopped = false;      // cancelled for good
  let paused = false;
  let running = false;
  let sessionId: string | null = null;
  let total = 0;
  let offset = 0;
  let attempt = 0;
  let inFlight: XMLHttpRequest | null = null;
  let reader: Reader | null = null;
  let timer: any = null;
  /** Bytes per second, from the chunks that have landed — feeds the deadline. */
  let rate = 0;
  /**
   * How big the next piece should be.
   *
   * No longer a constant 512 KB. A chunk only counts when it lands whole, so
   * on a connection that drops every few seconds a large one may never land,
   * and the upload uses data continuously without advancing — reported as a
   * photo reaching ten per cent and starting again. Starts small, grows
   * towards a few seconds of transfer as the connection proves itself, and
   * halves whenever a chunk fails.
   */
  let chunk = chunkBytes;
  /**
   * The highest progress already shown.
   *
   * Re-sending a chunk starts its byte count again; reporting that honestly
   * makes the bar jump backwards, which is the thing people actually see and
   * report. The bytes are not lost — the server keeps whatever arrived — so
   * the lower number is the less truthful of the two. See reportedSent.
   */
  let peak = 0;
  // Resolves the backoff sleep early. Without it, pausing during the wait
  // between two retries left the loop parked on a promise nobody would ever
  // settle — `running` stayed true, and resume did nothing at all.
  let wake: (() => void) | null = null;

  function sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
      timer = setTimeout(() => { wake = null; resolve(); }, ms);
    });
  }

  function stopWaiting() {
    try { inFlight?.abort(); } catch {}
    wake?.();
  }

  const api = (p: string) => `${baseUrl}${p}`;
  const authed = (extra?: any) => ({
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(extra || {}) },
  });

  async function start() {
    if (running || stopped) return;
    running = true;
    try {
      if (!sessionId) {
        total = await sizeOf(uri);
        if (!total) throw new Error('Cannot read file');
        if (total > MAX_UPLOAD_BYTES) throw new Error('File too large');
        const r = await fetch(api('/upload/session'), {
          method: 'POST', ...authed(), body: JSON.stringify({ name, size: total, mime }),
        });
        const j = await r.json();
        if (!r.ok || !j.id) throw new Error(j.error || 'Could not start upload');
        sessionId = j.id;
        offset = 0;
      } else {
        // Resuming: the server's count is the only one that can be trusted.
        const r = await fetch(api(`/upload/session/${sessionId}`), authed());
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Upload expired');
        offset = resumeOffset(j.offset, total);
      }
      if (!reader) reader = await makeReader(uri);
      report(offset);
      await pump();
    } catch (e: any) {
      running = false;
      if (!stopped) cb.onFailed(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    running = false;
  }

  /** Progress, never going backwards. */
  function report(sent: number) {
    peak = reportedSent(peak, sent, total);
    cb.onProgress(peak, total);
  }

  async function pump() {
    while (!stopped && !paused) {
      const range = chunkRange(offset, total, chunk);
      if (!range) break;
      const { body, base64 } = await reader!(range.start, range.end);
      if (stopped || paused) return;
      const startedAt = Date.now();
      const res = await sendChunk(
        api(`/upload/session/${sessionId}`), token, range.start, body, base64,
        (x) => { inFlight = x; },
        (loaded) => report(range.start + loaded),
        // Generous, and measured from what this connection has actually
        // managed so far, so a slow link is not mistaken for a dead one.
        stallTimeoutMs(range.end - range.start, rate));
      inFlight = null;

      if (res.ok) {
        attempt = 0;
        const took = Date.now() - startedAt;
        if (took > 0) rate = ((range.end - range.start) / took) * 1000;
        // What this connection can actually carry in a few seconds, which is
        // only knowable from a chunk that arrived.
        chunk = nextChunkBytes(rate, chunk);
        offset = res.offset ?? offset;
        report(offset);
        continue;
      }
      if (res.status === -1) return;             // aborted by pause/cancel
      // The server telling us its offset is not a failure, it is the answer.
      // It is also how the bytes from a half-delivered chunk are recovered:
      // the server keeps whatever arrived, so its offset is ahead of ours.
      if (res.status === 409 && typeof res.offset === 'number') {
        offset = resumeOffset(res.offset, total);
        report(offset);
        continue;
      }
      if (!shouldRetry(attempt, res.status)) {
        throw new Error(`Upload failed (${res.status || 'network'})`);
      }
      // A chunk that failed is evidence about this connection, and the only
      // evidence the rate never sees — it is measured from successes.
      chunk = shrinkAfterFailure(chunk);
      await sleep(retryDelay(attempt));
      attempt++;
      if (stopped || paused) return;
    }

    if (stopped || paused || !isComplete(offset, total)) return;

    // The last request, and the one that used to hang: reported as the upload
    // stopping at the final stage, needing the app closed and the file sent
    // again. Every byte had arrived — the bar sat at 100% — and this one call
    // had no deadline and no retry, so a connection that changed hands here
    // left it waiting forever.
    //
    // Retrying is safe because the server answers a repeat finish with the
    // result it already produced, rather than "no such upload".
    let last: { url?: string; error?: string; status?: number } | null = null;
    for (let fa = 0; fa <= MAX_ATTEMPTS; fa++) {
      if (stopped || paused) return;
      last = await finishOnce();
      if (last.url) { cb.onDone(last as any); return; }
      if (!shouldRetryFinish(fa, last.status)) break;
      await sleep(retryDelay(fa));
    }
    throw new Error(last?.error || 'Could not finish upload');
  }

  /** One attempt at the finish, with a deadline on it. */
  async function finishOnce(): Promise<{ url?: string; name?: string; mimetype?: string; error?: string; status?: number }> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const killer = setTimeout(() => { try { ctl?.abort(); } catch {} }, FINISH_TIMEOUT_MS);
    try {
      const r = await fetch(api(`/upload/session/${sessionId}/finish`), {
        method: 'POST', ...authed(), signal: ctl?.signal as any,
      });
      let j: any = {};
      try { j = await r.json(); } catch {}
      if (r.ok && j?.url) return j;
      return { status: r.status, error: j?.error };
    } catch {
      // The deadline, or the network going away: both worth another go.
      return { status: 0 };
    } finally {
      clearTimeout(killer);
    }
  }

  start();

  return {
    pause() {
      if (stopped || paused) return;
      paused = true;
      stopWaiting();
      cb.onPaused?.();
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      // The previous run may not have unwound yet — aborting an XHR resolves
      // on a later tick — and start() refuses to run twice. Wait for it rather
      // than dropping the resume on the floor, which is what a user tapping
      // pause and then resume quickly would otherwise get.
      const kick = () => {
        if (stopped || paused) return;
        if (running) setTimeout(kick, 50);
        else start();
      };
      kick();
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      stopWaiting();
      // Best effort: the reaper clears it in a day even if this never lands.
      if (sessionId) {
        fetch(api(`/upload/session/${sessionId}`), { method: 'DELETE', ...authed() }).catch(() => {});
      }
    },
  };
}
