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


  var PREVIEW_CHARS = 48;

  function trimTo(text, max) {
    var s = String(text || '');
    if (s.length <= max) return s;
    var cut = s.slice(0, max);
    var space = cut.lastIndexOf(' ');
    return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/\s+$/, '') + '\u2026';
  }

  function labelFor(type) {
    switch (type) {
      case 'image': return 'Photo';
      case 'gallery': return 'Photos';
      case 'video': return 'Video';
      case 'audio': return 'Voice message';
      case 'music': return 'Audio';
      case 'location': return 'Location';
      default: return 'File';
    }
  }

  function looksEncrypted(text) {
    return /^e2e:/.test(String(text || ''));
  }

  function parentPreview(msg) {
    var m = msg || {};
    var type = String(m.type || 'text');
    var raw = String(m.content || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    var words = looksEncrypted(raw) ? '' : trimTo(raw, PREVIEW_CHARS);
    var pictorial = type === 'image' || type === 'gallery' || type === 'video';
    if (pictorial) return { text: words || labelFor(type), thumb: true };
    if (type === 'text') return { text: words || 'Message', thumb: false };
    // A voice note's file_name carries the waveform, not a name.
    if (type === 'audio') return { text: words || labelFor(type), thumb: false };
    var named = trimTo(String(m.file_name || '').replace(/^\s+|\s+$/g, ''), PREVIEW_CHARS);
    return { text: words || named || labelFor(type), thumb: false };
  }

  global.CommentsView = {
    NEAR_BOTTOM_PX: NEAR_BOTTOM_PX,
    SWIPE_CLOSE_PX: SWIPE_CLOSE_PX,
    commentsBarLabel: commentsBarLabel,
    PREVIEW_CHARS: PREVIEW_CHARS,
    parentPreview: parentPreview,
    looksEncrypted: looksEncrypted,
    trimTo: trimTo,
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
