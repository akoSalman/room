// The web's copy of "which phone makes which noise".
//
// A mirror of native-app/src/callTones.ts, compared function by function in
// test/callTones.test.js. The difference between a ringtone and a ringback —
// and why the caller was hearing the wrong one — is written out in full there.
(function (global) {
  'use strict';

  function toneFor(o) {
    if (!o || o.connected) return null;
    if (o.role === 'callee') return 'ringtone';
    if (o.role === 'caller') return 'ringback';
    return null;
  }

  function toneFile(tone) {
    if (tone === 'ringtone') return 'ring.wav';
    if (tone === 'ringback') return 'ringback.wav';
    return '';
  }

  function toneVolume(tone) {
    if (tone === 'ringtone') return 0.5;
    if (tone === 'ringback') return 0.35;
    return 0;
  }

  function toneLoops(tone) {
    return tone === 'ringtone' || tone === 'ringback';
  }

  // A tone that finishes loading after the ring was stopped belongs to a ring
  // that is over, and must be thrown away rather than played over a connected
  // call. See native-app/src/callTones.ts for why that gap exists at all.
  function toneStillWanted(startedGeneration, currentGeneration) {
    return Number(startedGeneration) === Number(currentGeneration);
  }

  // ── How long a ring may go on ───────────────────────────────────────────
  //
  // Mirrors RING_TIMEOUT_MS and NO_ANSWER_MS in native-app/src/callAudio.ts
  // and is compared against them by a drift test.
  //
  // Reported as: calling from the web, the ringing does not stop at all. The
  // app has had both of these from the start; the browser had neither and no
  // timer of any kind, so a call nobody answered rang until the tab was
  // closed — the caller's ringback and the callee's ringtone both loop.

  /** The caller gives up here. The ordinary way an unanswered ring ends. */
  var NO_ANSWER_MS = 45000;
  /**
   * The ringing phone gives up here. A backstop for a caller whose app died
   * or whose network dropped, so it must be the LONGER of the two or it
   * would pre-empt the ordinary ending every time.
   */
  var RING_TIMEOUT_MS = 60000;

  global.CallTones = {
    NO_ANSWER_MS: NO_ANSWER_MS,
    RING_TIMEOUT_MS: RING_TIMEOUT_MS,
    toneFor: toneFor,
    toneFile: toneFile,
    toneVolume: toneVolume,
    toneLoops: toneLoops,
    toneStillWanted: toneStillWanted,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).CallTones;
}
