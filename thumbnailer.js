// ── Thumbnails in the background, for the server that cannot run sharp ──────
//
// The /thumb route already does the right thing when there is no
// thumbnailer: it redirects to the signed original, so the picture appears
// and only the bandwidth is wasted. What it never did was make the thumbnail
// anyway, so the same full-size file was sent again on every single view.
//
// This changes that WITHOUT changing what the request does. The route still
// answers immediately with the original; a worker builds the thumbnail behind
// it, and the next request for that size finds it cached. No request waits,
// no event loop blocks, and the worst case is exactly today's behaviour.
//
// ── WHY IT IS BOUNDED ───────────────────────────────────────────────────────
//
// A gallery opening sends a burst of thumbnail requests, each of which misses
// the cache until the work is done. Unbounded, that spawns a worker per
// request for the same few files — on a box whose CPU is already the problem.
// So: one at a time, a short queue, and the same output path never queued
// twice. A dropped request costs nothing, because the next view queues it
// again and the first view was being served the original regardless.

const path = require('path');

/** One worker at a time. This is a background nicety on a slow CPU. */
const CONCURRENCY = 1;
/**
 * How many may wait. Past this they are dropped, not queued.
 *
 * Dropping is safe and queueing is not: a queue that grows with every missed
 * view would still be working through a gallery somebody closed ten minutes
 * ago, while new views wait behind it. The next request re-queues anyway.
 */
const MAX_QUEUE = 24;

const JPEG_QUALITY = 72;   // the same the sharp path uses

let pending = [];
let running = 0;
const claimed = new Set();
let runner = null;
// ── Which era a job belongs to ──────────────────────────────────────────
//
// _reset() zeroes the counters, but it cannot un-start a worker that is
// already running. Its completion then decrements a counter that has already
// been zeroed, and `running` goes NEGATIVE — after which the concurrency
// limit means nothing, because running < CONCURRENCY is true however many
// workers are live. A job only touches the state it was started in.
let generation = 0;

/** Swap the thing that does the work. Tests use this; nothing else should. */
function _setRunner(fn) { runner = fn; }

function _state() {
  return { queued: pending.length, running, claimed: claimed.size };
}

function _reset() {
  pending = [];
  running = 0;
  claimed.clear();
  generation++;
}

/** The real worker. Kept behind _setRunner so tests need no threads. */
function spawnWorker(job) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, info) => { if (!settled) { settled = true; resolve({ ok, info }); } };
    try {
      const { Worker } = require('worker_threads');
      const w = new Worker(path.join(__dirname, 'thumbWorker.js'), { workerData: job });
      // A decode that runs away cannot be allowed to hold the only slot for
      // ever. The worker is terminated and the queue moves on.
      const timer = setTimeout(() => { try { w.terminate(); } catch {} done(false, 'timeout'); }, 60000);
      w.on('message', m => { clearTimeout(timer); done(!!(m && m.ok), m && m.error); });
      w.on('error', e => { clearTimeout(timer); done(false, String(e && e.message)); });
      w.on('exit', () => { clearTimeout(timer); done(false, 'exited'); });
    } catch (e) {
      done(false, String(e && e.message));
    }
  });
}

function pump() {
  while (running < CONCURRENCY && pending.length) {
    const job = pending.shift();
    const era = generation;
    running++;
    Promise.resolve((runner || spawnWorker)(job)).then(res => {
      if (res && res.ok === false && res.info) {
        // Said once per failure, and without the path: this runs on uploads
        // whose names are in a log that is read into a public repository.
        console.log('[thumb] background thumbnail failed:', String(res.info).slice(0, 60));
      }
    }).catch(() => {}).then(() => {
      // A job from a previous era has nothing to give back: its slot and its
      // claim were already discarded by the reset.
      if (era !== generation) return;
      running--;
      claimed.delete(job.out);
      pump();
    });
  }
}

/**
 * Ask for a thumbnail to exist soon. Returns whether it was accepted.
 *
 * Fire and forget by design: the caller has already answered the request.
 */
function queue(src, out, size) {
  if (!src || !out) return false;
  const n = Math.floor(Number(size));
  if (!Number.isFinite(n) || n <= 0) return false;
  // The same file at the same size, already on its way.
  if (claimed.has(out)) return false;
  if (pending.length >= MAX_QUEUE) return false;
  claimed.add(out);
  pending.push({ src, out, size: n, quality: JPEG_QUALITY });
  pump();
  return true;
}

module.exports = {
  queue, CONCURRENCY, MAX_QUEUE, JPEG_QUALITY,
  _state, _reset, _setRunner,
};
