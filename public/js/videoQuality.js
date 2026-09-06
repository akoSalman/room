// The web's copy of "how big should this video be sent".
//
// A mirror of native-app/src/videoQuality.ts, compared function by function in
// test/videoQuality.test.js. Why these presets, why the dimensions are rounded
// to even numbers, and why a re-encode that would save little is not worth
// doing at all are all written out in full there.
//
// The web has no native encoder, so what it can DO with these numbers is
// decided in js/webVideo.js — this file is only the arithmetic, and it has to
// agree with the app's or the same clip would be sent at two different sizes
// depending on which client the person happened to open.
(function (global) {
  'use strict';

  var VIDEO_PRESETS = [
    { id: 'low', label: '480p', maxEdge: 854, bitrate: 800000 },
    { id: 'medium', label: '720p', maxEdge: 1280, bitrate: 1800000 },
    { id: 'high', label: '1080p', maxEdge: 1920, bitrate: 3500000 },
    { id: 'original', label: 'Original', maxEdge: 0, bitrate: 0 },
  ];

  function presetFor(id) {
    for (var i = 0; i < VIDEO_PRESETS.length; i++) {
      if (VIDEO_PRESETS[i].id === id) return VIDEO_PRESETS[i];
    }
    return VIDEO_PRESETS[1];
  }

  function videoTarget(width, height, quality) {
    var preset = presetFor(quality);
    if (!preset.maxEdge) return null;
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;
    var longest = Math.max(width, height);
    if (longest <= preset.maxEdge) return null;
    var scale = preset.maxEdge / longest;
    var even = function (n) { return Math.max(2, Math.round(n * scale / 2) * 2); };
    return { width: even(width), height: even(height) };
  }

  function trimmedDuration(durationSec, startSec, endSec) {
    if (!isFinite(durationSec) || durationSec <= 0) return 0;
    var start = Math.max(0, Math.min(startSec, durationSec));
    var end = Math.max(start, Math.min(endSec, durationSec));
    return end - start;
  }

  function estimateBytes(quality, seconds, originalBytes, originalSeconds) {
    originalBytes = originalBytes || 0;
    originalSeconds = originalSeconds || 0;
    if (seconds <= 0) return 0;
    var preset = presetFor(quality);
    if (!preset.bitrate) {
      if (originalBytes <= 0) return 0;
      if (originalSeconds <= 0) return originalBytes;
      return Math.round(originalBytes * Math.min(1, seconds / originalSeconds));
    }
    var AUDIO_BITRATE = 128000;
    return Math.round(((preset.bitrate + AUDIO_BITRATE) / 8) * seconds);
  }

  function fmtDuration(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var s = Math.floor(sec % 60);
    var m = Math.floor(sec / 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function shouldTranscode(quality, originalBytes, seconds, size) {
    if (quality === 'original') return false;
    if (seconds <= 0) return false;
    if (size && !videoTarget(size.width, size.height, quality)) return false;
    if (originalBytes <= 0) return true;
    var estimated = estimateBytes(quality, seconds);
    return estimated > 0 && estimated < originalBytes * 0.9;
  }

  global.VideoQuality = {
    VIDEO_PRESETS: VIDEO_PRESETS,
    presetFor: presetFor,
    videoTarget: videoTarget,
    trimmedDuration: trimmedDuration,
    estimateBytes: estimateBytes,
    fmtDuration: fmtDuration,
    shouldTranscode: shouldTranscode,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).VideoQuality;
}
