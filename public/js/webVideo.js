// ── What this browser can do with a video before sending it ─────────────────
//
// Reported: "on ios web version sending video doesn't give user change
// resolution and trim options". The app has both; the web had neither, and
// staged a video as a grey 🎥 box that was sent whole — a 90 MB clip with no
// warning and nothing to press.
//
// The web has no native encoder. The only way to re-encode in a page is to
// play the video into a <canvas>, capture that canvas as a stream and record
// it — which means:
//
//   • it runs in REAL TIME (a 40-second clip takes 40 seconds), and
//   • it needs HTMLMediaElement.captureStream and MediaRecorder, and
//   • the recording has to come out in a format the OTHER clients can play.
//
// That last point is what decides the answer, and it is why this file exists
// rather than a bare feature-check. A browser that can record only WebM/VP8
// would produce a file that Safari and iPhones cannot play at all — the video
// would be smaller and useless. Sending the original untouched is then the
// RIGHT answer, not a failure, and the sheet says so instead of hiding the
// controls with no explanation.
//
// On iOS Safari, captureStream on a media element does not exist, so this
// browser — the one in the report — falls into exactly that case: it is told
// plainly that the clip will be sent as it is, with its size, which is a
// better answer than a silent 90 MB upload.
(function (global) {
  'use strict';

  /**
   * What a recording must be for the rest of the chat to be able to play it.
   *
   * MP4/H.264 plays everywhere: the Android app, iPhones, desktop browsers.
   * WebM is deliberately NOT accepted — Chrome would happily produce it and
   * every iPhone in the chat would show a black box.
   */
  var OUTPUT_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];

  /** The recording format this browser can produce, or '' for none. */
  function outputType(Rec) {
    var R = Rec || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
    if (!R || typeof R.isTypeSupported !== 'function') return '';
    for (var i = 0; i < OUTPUT_TYPES.length; i++) {
      try { if (R.isTypeSupported(OUTPUT_TYPES[i])) return OUTPUT_TYPES[i]; } catch (e) {}
    }
    return '';
  }

  /**
   * Can this browser re-encode at all?
   *
   * Every piece has to be there: a canvas that can be captured, a media
   * element that can be captured (for the sound), a recorder, and a format
   * worth producing.
   */
  function canReencode(env) {
    var e = env || {};
    var canvasCapture = 'canvasCapture' in e ? e.canvasCapture
      : (typeof document !== 'undefined'
        && typeof HTMLCanvasElement !== 'undefined'
        && !!HTMLCanvasElement.prototype.captureStream);
    var mediaCapture = 'mediaCapture' in e ? e.mediaCapture
      : (typeof HTMLVideoElement !== 'undefined'
        && !!(HTMLVideoElement.prototype.captureStream
          || HTMLVideoElement.prototype.mozCaptureStream));
    var type = 'outputType' in e ? e.outputType : outputType(e.MediaRecorder);
    return !!(canvasCapture && mediaCapture && type);
  }

  /**
   * What will happen when Send is pressed, in one object.
   *
   * The sheet renders this rather than deciding for itself, so what the user
   * is promised and what the sender actually does cannot drift apart.
   */
  function plan(o) {
    var s = o || {};
    var duration = Number(s.duration) || 0;
    var start = Math.max(0, Number(s.start) || 0);
    var end = Number(s.end);
    if (!isFinite(end) || end <= 0) end = duration;
    var seconds = global.VideoQuality.trimmedDuration(duration, start, end);
    var trimmed = duration > 0 && seconds > 0 && seconds < duration - 0.05;
    var size = (s.width > 0 && s.height > 0) ? { width: s.width, height: s.height } : null;

    // Without a re-encoder nothing can be cut or shrunk — a trim is a re-encode
    // too, since the range has to be played out and recorded.
    if (!s.canReencode) {
      return {
        action: 'as-is',
        seconds: duration,
        bytes: Number(s.bytes) || 0,
        target: null,
        why: 'This browser cannot re-encode video, so it will be sent as it is.',
      };
    }

    var wantsWork = trimmed
      || global.VideoQuality.shouldTranscode(s.quality, Number(s.bytes) || 0, seconds, size);
    if (!wantsWork) {
      return {
        action: 'as-is',
        seconds: duration,
        bytes: Number(s.bytes) || 0,
        target: null,
        // Not a failure: a re-encode that saves nothing costs the length of the
        // clip in waiting and loses quality for it.
        why: s.quality === 'original'
          ? 'Sent as it is.'
          : 'Already small enough — sending it as it is instead of re-encoding.',
      };
    }

    return {
      action: 'reencode',
      seconds: seconds,
      bytes: global.VideoQuality.estimateBytes(
        s.quality, seconds, Number(s.bytes) || 0, duration),
      target: size ? global.VideoQuality.videoTarget(size.width, size.height, s.quality) : null,
      trimmed: trimmed,
      // Said before it starts, because it is real time and there is no way to
      // make it faster — a person who is not warned assumes it has hung.
      why: 'Takes about ' + global.VideoQuality.fmtDuration(Math.ceil(seconds)) + ' to prepare.',
    };
  }

  /** "3.4 MB", for the sheet. */
  function humanSize(bytes) {
    var n = Number(bytes) || 0;
    if (n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  /** A trim range that always makes sense, whichever handle was dragged. */
  function clampRange(o) {
    var s = o || {};
    var duration = Math.max(0, Number(s.duration) || 0);
    var start = Math.min(Math.max(0, Number(s.start) || 0), duration);
    var end = Math.min(Math.max(0, isFinite(Number(s.end)) ? Number(s.end) : duration), duration);
    // A range of nothing would record an empty file, so the handles cannot
    // cross or meet: they stop a second apart.
    var MIN = Math.min(1, duration);
    if (s.moved === 'start' && end - start < MIN) start = Math.max(0, end - MIN);
    else if (end - start < MIN) end = Math.min(duration, start + MIN);
    return { start: start, end: end };
  }

  global.WebVideo = {
    OUTPUT_TYPES: OUTPUT_TYPES,
    outputType: outputType,
    canReencode: canReencode,
    plan: plan,
    humanSize: humanSize,
    clampRange: clampRange,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).WebVideo;
}
