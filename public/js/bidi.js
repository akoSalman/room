// The web's copy of "which way round does this paragraph go".
//
// A mirror of native-app/src/bidi.ts, compared function by function in
// test/bidi.test.js. Why a Persian sentence with English words in it came out
// scrambled — and why this counts characters rather than taking the first
// strong one, as dir="auto" does — is written out in full there.
(function (global) {
  'use strict';

  var RTL_CHARS = /[֐-׿؀-ۿ܀-ݏހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/g;
  var LTR_CHARS = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;
  var RTL_SHARE = 0.3;

  function baseDirection(text) {
    var s = String(text || '');
    var rtl = (s.match(RTL_CHARS) || []).length;
    var ltr = (s.match(LTR_CHARS) || []).length;
    if (!rtl) return 'ltr';
    return rtl >= (rtl + ltr) * RTL_SHARE ? 'rtl' : 'ltr';
  }

  function alignFor(dir) { return dir === 'rtl' ? 'right' : 'left'; }

  function textDirection(text) {
    var dir = baseDirection(text);
    return { dir: dir, align: alignFor(dir) };
  }

  var FSI = '⁨';
  var PDI = '⁩';

  function isolate(text) {
    var s = String(text === null || text === undefined ? '' : text);
    if (!s) return s;
    return FSI + s + PDI;
  }

  /**
   * Set an element's direction from what it says.
   *
   * `text-align: start` rather than left or right: the alignment then follows
   * the direction that was just chosen, and one property cannot contradict the
   * other.
   */
  function applyDirection(el, text) {
    if (!el) return 'ltr';
    var dir = baseDirection(text);
    el.setAttribute('dir', dir);
    el.style.textAlign = 'start';
    return dir;
  }

  global.Bidi = {
    RTL_SHARE: RTL_SHARE,
    baseDirection: baseDirection,
    alignFor: alignFor,
    textDirection: textDirection,
    isolate: isolate,
    applyDirection: applyDirection,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Bidi;
}
