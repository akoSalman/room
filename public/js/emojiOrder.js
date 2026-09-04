// The web's copy of "which emojis go first".
//
// A mirror of native-app/src/emojiOrder.ts, compared function by function in
// test/emojiOrder.test.js. The reasoning — in particular why the order is
// recomputed only when the bar OPENS — is written out in full there.
(function (global) {
  'use strict';

  var AGE_AT = 60;
  var MAX_TRACKED = 40;

  function trim(counts, max) {
    if (max === undefined) max = MAX_TRACKED;
    var keys = Object.keys(counts);
    if (keys.length <= max) return counts;
    keys.sort(function (a, b) { return (counts[b] - counts[a]) || (a < b ? -1 : 1); });
    var out = {};
    keys.slice(0, max).forEach(function (k) { out[k] = counts[k]; });
    return out;
  }

  function bump(counts, emoji) {
    var key = String(emoji || '');
    var next = Object.assign({}, counts || {});
    if (!key) return next;
    next[key] = (Number(next[key]) || 0) + 1;
    if (next[key] < AGE_AT) return trim(next);
    Object.keys(next).forEach(function (k) { next[k] = Math.floor(next[k] / 2); });
    return trim(next);
  }

  function orderFor(list, counts) {
    var c = counts || {};
    return (list || []).slice().map(function (e, i) { return { e: e, i: i }; })
      .sort(function (a, b) {
        var d = (Number(c[b.e]) || 0) - (Number(c[a.e]) || 0);
        return d !== 0 ? d : a.i - b.i;
      })
      .map(function (x) { return x.e; });
  }

  function countsAsUse(source) {
    return source === 'bar' || source === 'reaction';
  }

  global.EmojiOrder = {
    AGE_AT: AGE_AT,
    MAX_TRACKED: MAX_TRACKED,
    bump: bump,
    trim: trim,
    orderFor: orderFor,
    countsAsUse: countsAsUse,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).EmojiOrder;
}
