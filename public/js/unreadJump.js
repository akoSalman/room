// The web's copy of "open the chat where the unread messages are".
//
// A mirror of native-app/src/unreadJump.ts, compared function by function in
// test/unreadJump.test.js. The reasoning is written out in full there.
(function (global) {
  'use strict';

  var JUMP_MIN = 2;

  function firstUnread(messages, lastReadId, me) {
    var mark = Number(lastReadId) || 0;
    if (!mark) return null;
    var list = messages || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var id = Number(m && m.id);
      if (!isFinite(id) || id <= mark) continue;
      if (me && m.username === me) continue;
      return m;
    }
    return null;
  }

  function worthJumping(unreadCount) {
    return (Number(unreadCount) || 0) >= JUMP_MIN;
  }

  function unreadLabel(count) {
    var n = Math.max(0, Math.floor(Number(count) || 0));
    if (n <= 0) return '';
    return n === 1 ? '1 new message' : n + ' new messages';
  }

  global.UnreadJump = {
    JUMP_MIN: JUMP_MIN,
    firstUnread: firstUnread,
    worthJumping: worthJumping,
    unreadLabel: unreadLabel,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).UnreadJump;
}
