// The web's copy of "a half-written message is still a message".
//
// A mirror of native-app/src/textDraft.ts, compared function by function in
// test/textDraft.test.js. Why the composer's text has to be written somewhere
// before the chat is left — and why a restore must never overwrite text that is
// already in the composer — is written out in full there.
(function (global) {
  'use strict';

  var MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
  var SAVE_DEBOUNCE_MS = 400;

  function draftKey(roomId) {
    return 'text-draft-' + roomId;
  }

  function worthKeeping(text) {
    return String(text === null || text === undefined ? '' : text).trim().length > 0;
  }

  function serialize(text, now) {
    if (!worthKeeping(text)) return null;
    return JSON.stringify({ at: now, text: String(text) });
  }

  function parse(raw, now, maxAge) {
    if (maxAge === undefined) maxAge = MAX_AGE_MS;
    if (!raw) return '';
    var d;
    try { d = JSON.parse(raw); } catch (e) {
      return typeof raw === 'string' && raw[0] !== '{' && raw[0] !== '[' ? raw : '';
    }
    if (typeof d === 'string') return d;
    if (!d || typeof d.text !== 'string') return '';
    var at = Number(d.at) || 0;
    if (at && now - at > maxAge) return '';
    return d.text;
  }

  function restoredText(saved, current) {
    var now = String(current === null || current === undefined ? '' : current);
    if (now.length) return now;
    return String(saved === null || saved === undefined ? '' : saved);
  }

  function changed(text, lastWritten) {
    var a = String(text === null || text === undefined ? '' : text);
    var b = String(lastWritten === null || lastWritten === undefined ? '' : lastWritten);
    return a !== b;
  }

  global.TextDraft = {
    MAX_AGE_MS: MAX_AGE_MS,
    SAVE_DEBOUNCE_MS: SAVE_DEBOUNCE_MS,
    draftKey: draftKey,
    worthKeeping: worthKeeping,
    serialize: serialize,
    parse: parse,
    restoredText: restoredText,
    changed: changed,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).TextDraft;
}
