// The web's copy of how the comments screen behaves.
//
// A mirror of native-app/src/commentsView.ts, compared function by function in
// test/commentsView.test.js. The reasoning is written out in full there.
(function (global) {
  'use strict';

  var NEAR_BOTTOM_PX = 220;
  var SWIPE_CLOSE_PX = 70;

  function commentsBarLabel(count) {
    var n = Number(count) || 0;
    return n === 1 ? '1 Comment' : n + ' Comments';
  }

  function isNearBottom(o) {
    var gap = Number(o.scrollHeight) - Number(o.scrollTop) - Number(o.clientHeight);
    if (!isFinite(gap)) return true;
    return gap < NEAR_BOTTOM_PX;
  }

  function shouldStickToBottom(o) {
    if (o.reason === 'mine' || o.reason === 'opened') return true;
    return !!o.nearBottom;
  }

  function showsJumpButton(o) {
    if (Number(o.scrollHeight) - Number(o.clientHeight) < NEAR_BOTTOM_PX) return false;
    return !isNearBottom(o);
  }

  function closesOnSwipe(o) {
    var dx = Number(o.dx) || 0;
    var dy = Number(o.dy) || 0;
    if (dx < SWIPE_CLOSE_PX) return false;
    return Math.abs(dx) > Math.abs(dy) * 1.2;
  }


  function backAction(o) {
    if (o.fromHistory) return 'none';
    return o.pushed > 0 ? 'back' : 'none';
  }

  global.CommentsView = {
    NEAR_BOTTOM_PX: NEAR_BOTTOM_PX,
    SWIPE_CLOSE_PX: SWIPE_CLOSE_PX,
    commentsBarLabel: commentsBarLabel,
    isNearBottom: isNearBottom,
    shouldStickToBottom: shouldStickToBottom,
    showsJumpButton: showsJumpButton,
    closesOnSwipe: closesOnSwipe,
    backAction: backAction,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).CommentsView;
}
