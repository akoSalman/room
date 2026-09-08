// The web's copy of "what a file may be called".
//
// A mirror of native-app/src/fileName.ts, compared function by function in
// test/fileName.test.js. Why a name has to be made safe before it becomes a
// path — and why renaming keeps the extension unless the typed name brings its
// own — is written out in full there.
(function (global) {
  'use strict';

  var MAX_NAME = 120;
  // A space is deliberately absent: it is an ordinary thing to have in a
  // filename, and replacing it here would put a dash through every Persian
  // name. Spaces are handled in cacheName, where a path is built.
  var UNSAFE = /[\\/:*?"<>|#%]/g;

  function extensionOf(name) {
    var s = String(name || '').split('?')[0].split('#')[0];
    var dot = s.lastIndexOf('.');
    if (dot <= 0 || dot === s.length - 1) return '';
    var ext = s.slice(dot + 1);
    return /^[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : '';
  }

  function safeName(name, fallback) {
    if (fallback === undefined) fallback = 'file';
    var s = String(name || '').split('?')[0].trim();
    s = s.replace(UNSAFE, '-').replace(/\s+/g, ' ').replace(/^\.+/, '').trim();
    if (!s) return fallback;
    if (s.length > MAX_NAME) {
      var ext = extensionOf(s);
      var stem = ext ? s.slice(0, s.length - ext.length - 1) : s;
      var room = MAX_NAME - (ext ? ext.length + 1 : 0);
      s = stem.slice(0, Math.max(1, room)) + (ext ? '.' + ext : '');
    }
    return s;
  }

  function renamed(original, typed) {
    var want = String(typed === null || typed === undefined ? '' : typed).trim();
    var from = safeName(original);
    if (!want) return from;
    var safe = safeName(want, from);
    if (extensionOf(safe)) return safe;
    var ext = extensionOf(from);
    return ext ? safe + '.' + ext : safe;
  }

  function editableStem(name) {
    var s = safeName(name);
    var ext = extensionOf(s);
    return ext ? s.slice(0, s.length - ext.length - 1) : s;
  }

  function cacheName(name, at) {
    if (at === undefined) at = Date.now();
    var safe = safeName(name).replace(/\s+/g, '-');
    var ext = extensionOf(safe);
    var stem = ext ? safe.slice(0, safe.length - ext.length - 1) : safe;
    return at + '-' + stem + (ext ? '.' + ext : '');
  }

  global.FileName = {
    MAX_NAME: MAX_NAME,
    extensionOf: extensionOf,
    safeName: safeName,
    renamed: renamed,
    editableStem: editableStem,
    cacheName: cacheName,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).FileName;
}
