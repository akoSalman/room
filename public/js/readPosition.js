// The web's copy of "when a message counts as read".
//
// A mirror of native-app/src/readPosition.ts, compared function by function in
// test/readPosition.test.js. Why a message arriving is not the same as a
// message being read — and why that, rather than the counting, was what put
// the unread divider in the wrong place three times — is written out there.
(function (global) {
  'use strict';

  function marksRead(ctx) {
    if (!ctx) return false;
    if (ctx.fromMe) return true;
    return !!ctx.appActive && !!ctx.atBottom;
  }

  function readUpTo(lastMessageId, ctx) {
    if (lastMessageId === null || lastMessageId === undefined || lastMessageId === '') return null;
    if (!marksRead(ctx)) return null;
    return lastMessageId;
  }

  function opensAsRead(ctx) {
    return !!ctx && !!ctx.appActive;
  }

  global.ReadPosition = {
    marksRead: marksRead,
    readUpTo: readUpTo,
    opensAsRead: opensAsRead,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).ReadPosition;
}
