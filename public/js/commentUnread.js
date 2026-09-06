// The web's copy of "which message has new comments".
//
// A mirror of native-app/src/commentUnread.ts, compared function by function
// in test/commentUnread.test.js. The reasoning — why a comment leaves two
// marks, and why a jump downwards wins ties — is written out in full there.
(function (global) {
  'use strict';

  var BADGE_CAP = 99;

  function noteComment(counts, o) {
    var next = Object.assign({}, counts || {});
    var key = String((o && o.parentId) != null ? o.parentId : '');
    if (!key) return next;
    if (o && o.mine) return next;
    if (o && o.threadOpenId != null && String(o.threadOpenId) === key) return next;
    next[key] = (Number(next[key]) || 0) + 1;
    return next;
  }

  function clearFor(counts, parentId) {
    var next = Object.assign({}, counts || {});
    delete next[String(parentId != null ? parentId : '')];
    return next;
  }

  function countFor(counts, parentId) {
    return Number((counts || {})[String(parentId != null ? parentId : '')]) || 0;
  }

  function totalUnread(counts) {
    var c = counts || {};
    return Object.keys(c).reduce(function (n, k) { return n + (Number(c[k]) || 0); }, 0);
  }

  function badgeLabel(count) {
    var n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return '';
    return n > BADGE_CAP ? BADGE_CAP + '+' : String(n);
  }

  function chooseJump(items, view) {
    var list = (items || []).filter(function (x) {
      return x && isFinite(x.index) && x.index >= 0;
    });
    // Nothing measured yet is NOT "the top of the list" — see the .ts copy.
    if (!view || typeof view.first !== 'number' || typeof view.last !== 'number') return null;
    var first = view.first;
    var last = view.last;
    if (!list.length || !isFinite(first) || !isFinite(last)) return null;
    var below = list.filter(function (x) { return x.index > last; })
      .sort(function (a, b) { return a.index - b.index; })[0];
    if (below) return { id: String(below.id), dir: 'down', count: Number(below.count) || 0 };
    var above = list.filter(function (x) { return x.index < first; })
      .sort(function (a, b) { return b.index - a.index; })[0];
    if (above) return { id: String(above.id), dir: 'up', count: Number(above.count) || 0 };
    return null;
  }

  function jumpLabel(jump) {
    if (!jump) return '';
    var n = Math.max(0, Math.floor(Number(jump.count) || 0));
    var count = n > BADGE_CAP ? BADGE_CAP + '+' : String(n);
    return count + ' new ' + (n === 1 ? 'comment' : 'comments');
  }

  function jumpArrow(jump) {
    if (!jump) return '';
    return jump.dir === 'up' ? '↑' : '↓';
  }

  global.CommentUnread = {
    BADGE_CAP: BADGE_CAP,
    noteComment: noteComment,
    clearFor: clearFor,
    countFor: countFor,
    totalUnread: totalUnread,
    badgeLabel: badgeLabel,
    chooseJump: chooseJump,
    jumpLabel: jumpLabel,
    jumpArrow: jumpArrow,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).CommentUnread;
}
