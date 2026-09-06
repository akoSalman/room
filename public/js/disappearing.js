// The web's copy of the disappearing-messages vocabulary.
//
// A mirror of native-app/src/disappearing.ts, compared against it duration by
// duration in test/disappearing.test.js. It exists because the web had grown
// THREE hand-written copies of the same ladder of durations — one in the
// banner, one in the system notice, one nowhere near either — and a chat that
// says "5 minutes" in one place and "300 seconds" in another is a chat nobody
// trusts with a promise about deleting their messages.
//
// The list is fixed and the server checks it: a client cannot invent a
// duration of its own.
(function (global) {
  var DISAPPEARING_OPTIONS = [0, 30, 300, 3600, 86400, 604800];

  function disappearingLabel(seconds) {
    switch (seconds) {
      case 0: return 'Off';
      case 30: return '30 seconds';
      case 300: return '5 minutes';
      case 3600: return '1 hour';
      case 86400: return '24 hours';
      case 604800: return '1 week';
      default:
        if (seconds < 60) return seconds + ' seconds';
        if (seconds < 3600) return Math.round(seconds / 60) + ' minutes';
        if (seconds < 86400) return Math.round(seconds / 3600) + ' hours';
        return Math.round(seconds / 86400) + ' days';
    }
  }

  function chipLabel(seconds) {
    switch (seconds) {
      case 0: return 'Off';
      case 30: return '30s';
      case 300: return '5m';
      case 3600: return '1h';
      case 86400: return '24h';
      case 604800: return '1w';
      default:
        if (seconds < 60) return seconds + 's';
        if (seconds < 3600) return Math.round(seconds / 60) + 'm';
        if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
        return Math.round(seconds / 86400) + 'd';
    }
  }

  function disappearingPredicate(seconds) {
    return seconds > 0
      ? 'turned on disappearing messages — new messages vanish '
        + disappearingLabel(seconds) + ' after they are read'
      : 'turned off disappearing messages';
  }

  function disappearingNotice(username, seconds, isMe) {
    return (isMe ? 'You' : username) + ' ' + disappearingPredicate(seconds);
  }


  function oneTimePredicate(allowed) {
    return allowed
      ? 'turned one-time messages back on for this chat'
      : 'turned off one-time messages for this chat';
  }

  /** The line along the top of a chat that destroys its messages. */
  function bannerText(seconds) {
    if (!seconds) return '';
    return '⏳  Disappearing messages on · ' + disappearingLabel(seconds) + ' after reading';
  }

  global.Disappearing = {
    DISAPPEARING_OPTIONS: DISAPPEARING_OPTIONS,
    disappearingLabel: disappearingLabel,
    chipLabel: chipLabel,
    disappearingPredicate: disappearingPredicate,
    disappearingNotice: disappearingNotice,
    oneTimePredicate: oneTimePredicate,
    bannerText: bannerText,
  };
})(typeof window !== 'undefined' ? window : this);
