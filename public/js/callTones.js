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

  global.CallTones = {
    toneFor: toneFor,
    toneFile: toneFile,
    toneVolume: toneVolume,
    toneLoops: toneLoops,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).CallTones;
}
