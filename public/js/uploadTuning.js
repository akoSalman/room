// The web's copy of how big a chunk should be, and when to give up on one.
//
// A mirror of the chunk-sizing half of native-app/src/uploadSession.ts,
// compared against it value for value in test/uploadTuning.test.js. The
// reasoning — why a fixed half-megabyte chunk makes a progress bar that does
// not move — is written out in full there.
(function (global) {
  var CHUNK_BYTES = 512 * 1024;
  var CHUNK_MIN = 64 * 1024;
  var CHUNK_MAX = CHUNK_BYTES;
  var TARGET_CHUNK_MS = 6000;
  var FIRST_CHUNK_BYTES = 128 * 1024;
  var STALL_FLOOR_MS = 45000;

  function nextChunkBytes(bytesPerSecond, current) {
    var cur = current === undefined ? FIRST_CHUNK_BYTES : current;
    cur = Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, Math.round(cur) || FIRST_CHUNK_BYTES));
    if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return cur;
    var ideal = bytesPerSecond * (TARGET_CHUNK_MS / 1000);
    var step = 32 * 1024;
    var rounded = Math.round(ideal / step) * step;
    var capped = Math.min(rounded, cur * 2);
    return Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, capped));
  }

  /**
   * Smaller, after a chunk failed to get through.
   *
   * nextChunkBytes only learns from chunks that SUCCEEDED, so on a connection
   * where the current size never completes it never adapts — the same doomed
   * chunk is tried for ever. A failure is evidence in its own right.
   */
  function shrinkAfterFailure(current) {
    var cur = Math.round(current) || FIRST_CHUNK_BYTES;
    if (!(cur > 0)) return CHUNK_MIN;
    return Math.min(CHUNK_MAX, Math.max(CHUNK_MIN, Math.floor(cur / 2)));
  }

  /**
   * What the bar should say, given what it said before: never less.
   *
   * Re-sending a chunk starts its byte count again, and reporting that
   * honestly is a bar that jumps backwards — reported as an upload that
   * "resets and begins from scratch". The bytes are not lost (the server
   * keeps whatever arrived), so the lower number is the less truthful one.
   */
  function reportedSent(peak, sent, total) {
    var t = Number(total);
    var hi = Math.max(Number(peak) || 0, Number(sent) || 0);
    if (!isFinite(t) || t <= 0) return hi;
    return Math.min(hi, t);
  }

  function stallTimeoutMs(chunkBytes, bytesPerSecond, floor) {
    var f = floor === undefined ? STALL_FLOOR_MS : floor;
    if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return f;
    var expected = (chunkBytes / bytesPerSecond) * 1000;
    return Math.max(f, Math.round(expected * 3));
  }

  /**
   * How long to wait for the finish request before assuming it is never
   * coming. Reported as an upload that hangs at the final stage — see
   * native-app/src/uploadSession.ts for the whole story.
   */
  var FINISH_TIMEOUT_MS = 45000;

  global.UploadTuning = {
    FINISH_TIMEOUT_MS: FINISH_TIMEOUT_MS,
    CHUNK_BYTES: CHUNK_BYTES,
    CHUNK_MIN: CHUNK_MIN,
    CHUNK_MAX: CHUNK_MAX,
    TARGET_CHUNK_MS: TARGET_CHUNK_MS,
    FIRST_CHUNK_BYTES: FIRST_CHUNK_BYTES,
    STALL_FLOOR_MS: STALL_FLOOR_MS,
    nextChunkBytes: nextChunkBytes,
    shrinkAfterFailure: shrinkAfterFailure,
    reportedSent: reportedSent,
    stallTimeoutMs: stallTimeoutMs,
  };
})(typeof window !== 'undefined' ? window : this);
