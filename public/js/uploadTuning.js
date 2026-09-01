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

  function stallTimeoutMs(chunkBytes, bytesPerSecond, floor) {
    var f = floor === undefined ? STALL_FLOOR_MS : floor;
    if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return f;
    var expected = (chunkBytes / bytesPerSecond) * 1000;
    return Math.max(f, Math.round(expected * 3));
  }

  global.UploadTuning = {
    CHUNK_BYTES: CHUNK_BYTES,
    CHUNK_MIN: CHUNK_MIN,
    CHUNK_MAX: CHUNK_MAX,
    TARGET_CHUNK_MS: TARGET_CHUNK_MS,
    FIRST_CHUNK_BYTES: FIRST_CHUNK_BYTES,
    STALL_FLOOR_MS: STALL_FLOOR_MS,
    nextChunkBytes: nextChunkBytes,
    stallTimeoutMs: stallTimeoutMs,
  };
})(typeof window !== 'undefined' ? window : this);
