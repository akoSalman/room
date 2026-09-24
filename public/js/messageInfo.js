// ── Who has seen this message, and when ─────────────────────────────────────
//
// The web's copy of native-app/src/messageInfo.ts, compared function by
// function in test/messageInfo.test.js.
//
// The server has answered `message_info` since the app got this; the web
// simply never asked. The answer is the same on both, so the rules for
// presenting it are written once and mirrored, rather than typed out twice and
// left to drift — which is how two clients end up disagreeing about whether a
// message has been read.
(function (global) {
  'use strict';

  /**
   * Can this message be asked about at all?
   *
   * A message still being sent has a client-side id — a string, or a negative
   * number — and the server has never heard of it. Offering Info there opens a
   * panel that can only ever say "not found".
   */
  function canShowInfo(msg) {
    if (!msg) return false;
    var id = Number(msg.id);
    return isFinite(id) && id > 0;
  }

  /**
   * A timestamp, in the reader's own locale and timezone.
   *
   * The server sends SQLite's "YYYY-MM-DD HH:MM:SS", which is UTC and which no
   * browser parses the same way: Safari returns Invalid Date for it, so the
   * space becomes a T and a Z is appended before parsing. That is the
   * difference between a time and a blank on an iPhone.
   */
  function fullWhen(v) {
    if (v === null || v === undefined || v === '') return '';
    var d;
    if (typeof v === 'number') {
      d = new Date(v);
    } else {
      var str = String(v);
      d = new Date(str.indexOf('T') >= 0 ? str : str.replace(' ', 'T') + 'Z');
    }
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  /**
   * The headings.
   *
   * Counted, because "Seen by" over a list of four names makes the reader
   * count them, and the count is the thing they opened this to learn.
   */
  function seenHeading(n) {
    return 'Seen by ' + Math.max(0, Math.floor(Number(n) || 0));
  }

  function notSeenHeading(n) {
    return 'Not seen yet ' + Math.max(0, Math.floor(Number(n) || 0));
  }

  /** What stands in for an empty list — never a bare "0". */
  function emptySeenText() {
    return 'Nobody has seen this yet.';
  }

  global.MessageInfo = {
    canShowInfo: canShowInfo,
    fullWhen: fullWhen,
    seenHeading: seenHeading,
    notSeenHeading: notSeenHeading,
    emptySeenText: emptySeenText,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).MessageInfo;
}
