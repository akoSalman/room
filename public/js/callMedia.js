// ── Asking for the microphone and camera, on a browser that only asks once ──
//
// Reported from an iPhone: tapping call says permission is needed, and no
// prompt ever appears, so the call cannot be made.
//
// Two rules, and the code broke the first and had nothing to say about the
// second.
//
// 1. getUserMedia must be called while the user gesture is still live.
//    Safari discards the activation as soon as the task that handled the tap
//    yields — so a single `await` on a network request before asking is
//    enough. It then rejects with NotAllowedError and shows NO prompt, which
//    is indistinguishable from the user having refused. Chrome is far more
//    forgiving, which is why this only ever showed up on an iPhone.
//
// 2. Safari REMEMBERS a refusal. Once denied, it will not ask again, and no
//    amount of tapping call will produce a prompt — the setting has to be
//    changed by hand. Telling somebody that is the difference between an app
//    that is broken and one that can be fixed in ten seconds.
(function (root) {
  'use strict';

  /**
   * Ask for the microphone (and camera).
   *
   * Call this FIRST, before awaiting anything else, or Safari will refuse
   * without asking. It is deliberately not `async`: an async function still
   * starts synchronously, but marking it plain makes it harder for somebody
   * to add an `await` above the request later.
   */
  function requestMedia(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('no-media-devices'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: 'user', width: { ideal: 640 } } : false,
    });
  }

  /**
   * What to tell somebody whose call did not start.
   *
   * Each case has a different remedy, and "Microphone/camera access is
   * required" — the message this replaces — is the remedy for none of them.
   */
  function mediaErrorMessage(err, opts) {
    opts = opts || {};
    // Name AND message, checked separately. `err.name || err.message` looks
    // equivalent and is not: a plain `new Error('no-media-devices')` has the
    // name "Error", so the message never gets looked at and the case below is
    // unreachable. Caught by a test, which is the only way anybody would.
    var name = (err && err.name) || '';
    var message = (err && err.message) || '';
    var isApple = !!opts.isApple;

    // Not a secure context. getUserMedia does not exist at all over plain
    // HTTP or with a broken certificate, so there is nothing to permit.
    if (name === 'no-media-devices' || message === 'no-media-devices' || !opts.secure) {
      return 'Calls need a secure connection (https). This page is not on one, '
        + 'so the browser will not give access to the microphone.';
    }

    // Refused — possibly long ago, and on Safari that decision sticks.
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return isApple
        ? 'The microphone is blocked for this site. Tap "aA" in the address bar → '
          + 'Website Settings → Microphone → Allow, then try again.'
        : 'The microphone is blocked for this site. Open the padlock in the address '
          + 'bar and allow microphone access, then try again.';
    }

    // There is no microphone, or it is being held by something else.
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found on this device.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The microphone is in use by another app. Close it and try again.';
    }

    return 'Could not start the call — the microphone could not be opened.';
  }

  /** Whether this page can use getUserMedia at all. */
  function isSecure() {
    return typeof isSecureContext === 'boolean'
      ? isSecureContext
      : location.protocol === 'https:' || location.hostname === 'localhost';
  }

  /** iPhone, iPad, and the Macs that behave like them. */
  function isApple() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua)
      || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      || /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  }

  root.CallMedia = {
    requestMedia: requestMedia,
    mediaErrorMessage: mediaErrorMessage,
    isSecure: isSecure,
    isApple: isApple,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).CallMedia;
}
