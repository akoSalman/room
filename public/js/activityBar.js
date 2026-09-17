// The web's copy of "the line above the composer".
//
// A mirror of native-app/src/activityBar.ts, compared function by function in
// test/activityBar.test.js. Why the wording lives in one place — the two
// clients had each written their own and were already drifting — and why the
// sending announcement follows a count rather than each upload, are written
// out in full there.
(function (global) {
  'use strict';

  function sendKindFor(messageType) {
    switch (String(messageType || '')) {
      case 'image': return 'photo';
      case 'gallery': return 'photos';
      case 'video': return 'video';
      case 'audio': return 'voice';
      case 'music': return 'audio';
      default: return 'file';
    }
  }

  // The same answer from a mime type, for callers holding a File rather than
  // a message type. See activityBar.ts.
  function sendKindForMime(mime) {
    var m = String(mime || '');
    if (m.indexOf('image/') === 0) return 'photo';
    if (m.indexOf('video/') === 0) return 'video';
    if (m.indexOf('audio/') === 0) return 'audio';
    return 'file';
  }

  function sendNoun(kind) {
    switch (kind) {
      case 'photo': return 'a photo';
      case 'photos': return 'photos';
      case 'video': return 'a video';
      case 'voice': return 'a voice message';
      case 'audio': return 'an audio file';
      default: return 'a file';
    }
  }

  function others(names, me) {
    var seen = Object.create(null);
    var out = [];
    (names || []).forEach(function (n) {
      var name = String(n || '');
      if (!name || (me && name === me) || seen[name]) return;
      seen[name] = true;
      out.push(name);
    });
    return out;
  }

  function nameList(names) {
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names[0] + ' and ' + (names.length - 1) + ' others';
  }

  function isPlural(names) { return names.length > 1; }

  function activityBar(a) {
    a = a || {};
    var me = a.me === undefined ? null : a.me;

    var recording = others(a.recording, me);
    if (recording.length) {
      return {
        kind: 'recording', icon: '🎙',
        text: nameList(recording) + ' ' + (isPlural(recording) ? 'are' : 'is') + ' recording',
      };
    }

    var sendingAll = (a.sending || []).filter(function (s) { return s && s.username; });
    var senders = others(sendingAll.map(function (s) { return s.username; }), me);
    if (senders.length) {
      var only = null;
      if (senders.length === 1) {
        for (var i = 0; i < sendingAll.length; i++) {
          if (sendingAll[i].username === senders[0]) { only = sendingAll[i]; break; }
        }
      }
      var what = only ? sendNoun(only.kind) : 'files';
      return {
        kind: 'sending', icon: '📎',
        text: nameList(senders) + ' ' + (isPlural(senders) ? 'are' : 'is') + ' sending ' + what,
      };
    }

    var typing = others(a.typing, me);
    if (typing.length) {
      return {
        kind: 'typing', icon: '',
        text: nameList(typing) + ' ' + (isPlural(typing) ? 'are' : 'is') + ' typing',
      };
    }
    return null;
  }

  function announceOnChange(before, after) {
    var b = Math.max(0, Number(before) || 0);
    var a = Math.max(0, Number(after) || 0);
    if (b === 0 && a > 0) return 'start';
    if (b > 0 && a === 0) return 'stop';
    return null;
  }

  function nextInFlight(count, delta) {
    return Math.max(0, (Number(count) || 0) + (Number(delta) || 0));
  }

  global.ActivityBar = {
    sendKindFor: sendKindFor,
    sendKindForMime: sendKindForMime,
    sendNoun: sendNoun,
    activityBar: activityBar,
    announceOnChange: announceOnChange,
    nextInFlight: nextInFlight,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).ActivityBar;
}
