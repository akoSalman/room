// The web's copy of "what a message will let you do, and what it says after".
//
// A mirror of native-app/src/messageMenu.ts, compared function by function in
// test/messageMenu.test.js. Why a message that is still uploading has no menu
// — and why a forward has to name where it went — is written out in full there.
(function (global) {
  'use strict';

  function canOpenMenu(msg) {
    return !!msg && !msg._uploading;
  }

  function forwardedTo(target, count) {
    var name = String(target || '').replace(/^\s+|\s+$/g, '');
    var n = Math.max(1, Math.floor(Number(count) || 1));
    var what = n === 1 ? 'Forwarded' : n + ' messages forwarded';
    return name ? what + ' to ' + name : what;
  }

  global.MessageMenu = {
    canOpenMenu: canOpenMenu,
    forwardedTo: forwardedTo,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).MessageMenu;
}
