// The web's copy of the comment rules.
//
// A mirror of native-app/src/comments.ts, compared function by function in
// test/comments.test.js. The reasoning — why a comment is an ordinary message
// with a parent, and why the depth stops at one — is written out in full
// there.
(function (global) {
  'use strict';

  var MAX_DEPTH = 1;
  var BADGE_CAP = 99;

  function isComment(msg) {
    return !!msg && msg.parent_id != null && msg.parent_id !== '';
  }

  function canComment(msg) {
    if (!msg || msg.id == null) return false;
    if (isComment(msg)) return false;
    if (msg.one_time_seconds) return false;
    return msg.type !== 'system' && msg.type !== 'invite';
  }

  function normaliseCount(count) {
    var n = Number(count);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function showsBadge(count) { return normaliseCount(count) > 0; }

  function badgeLabel(count) {
    var n = normaliseCount(count);
    return n > BADGE_CAP ? BADGE_CAP + '+' : String(n);
  }

  function countAfter(count, delta) {
    return Math.max(0, normaliseCount(count) + (Number(delta) || 0));
  }

  function commentsTitle(count) {
    var n = normaliseCount(count);
    if (n === 0) return 'Comments';
    if (n === 1) return '1 comment';
    return n + ' comments';
  }

  global.Comments = {
    MAX_DEPTH: MAX_DEPTH,
    BADGE_CAP: BADGE_CAP,
    EMPTY_HINT: 'No comments yet. Write the first one.',
    isComment: isComment,
    canComment: canComment,
    normaliseCount: normaliseCount,
    showsBadge: showsBadge,
    badgeLabel: badgeLabel,
    countAfter: countAfter,
    commentsTitle: commentsTitle,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Comments;
}
