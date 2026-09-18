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


  // Counts the rows from the anchor to the end of the list, in the order they
  // are drawn — NOT by comparing ids. The anchor is chosen by walking the list,
  // and the list is drawn in that same order; comparing ids agrees with that
  // only while the array happens to be sorted by id, and an optimistic send, a
  // page merged from cache or a forward can each break that. When they
  // disagree, a message counted as after the anchor is drawn before it: the
  // label says two and the line has one beneath it. See unreadJump.ts.
  // Where the divider goes and what it says, from ONE pass over the array that
  // is actually being drawn. There is no stored count: the label is recomputed
  // from the rows that follow the anchor whenever the list changes, so it
  // describes what is on screen rather than remembering what once was. The two
  // earlier fixes and why neither was enough are in unreadJump.ts.
  function unreadDivider(rendered, anchorId, me) {
    if (anchorId === null || anchorId === undefined || anchorId === '') return null;
    var list = rendered || [];
    var key = String(anchorId);
    var at = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === key) { at = i; break; }
    }
    if (at < 0) return null;
    var count = 0;
    for (var j = at; j < list.length; j++) {
      var m = list[j];
      if (me && m && m.username === me) continue;
      count++;
    }
    if (count < 1) return null;
    return { anchorId: key, count: count };
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
    unreadDivider: unreadDivider,
    worthJumping: worthJumping,
    unreadLabel: unreadLabel,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).UnreadJump;
}
