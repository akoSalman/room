// The web's copy of what a tap on a voice message does.
//
// A mirror of native-app/src/voiceTap.ts, compared against it function by
// function in test/voiceTap.test.js — a voice message that plays from anywhere
// in the app and only from the ▶ on the web is a bug in whichever is behind.
(function (global) {
  function tapAction(o) {
    if (o.selectMode) return 'select';
    if (o.region === 'speed') return 'speed';
    if (o.region === 'waveform' && o.isCurrent) return 'seek';
    return 'toggle';
  }
  function longPressOpensMenu() { return true; }
  function seekFraction(x, width) {
    if (!width || !isFinite(x) || !isFinite(width)) return 0;
    return Math.min(1, Math.max(0, x / width));
  }
  global.VoiceTap = { tapAction: tapAction, longPressOpensMenu: longPressOpensMenu, seekFraction: seekFraction };
})(typeof window !== 'undefined' ? window : this);
