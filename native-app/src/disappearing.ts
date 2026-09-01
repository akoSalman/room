// ── Disappearing messages ────────────────────────────────────────────────────
//
// A chat-wide timer: once it is on, everything EITHER side sends is destroyed
// that long after the other person has READ it. Distinct from a one-time
// message, which is destroyed after it is opened, and which only affects the
// one message.
//
// Read, not sent — and the wording says so, because it did not.
//
// Reported as: they do not disappear exactly after the set time. Two of the
// three causes were real delays (a server sweeping on a thirty-second
// interval, and clients waiting to be told rather than acting on a deadline
// they already knew) and both are fixed. The third was this: a message sitting
// unread does not start counting, so "vanish after 30 seconds" was a promise
// about a clock the reader had not started yet. Starting it at send time
// instead would mean destroying messages nobody ever saw, which is worse — so
// the sentence changed rather than the rule.
//
// The durations are a fixed list, matched by the server — a client cannot
// invent its own — so they live here and are shared by the menu, the banner
// and the system notices.

export const DISAPPEARING_OPTIONS = [0, 30, 300, 3600, 86400, 604800] as const;

/** "30 seconds", "1 hour", "1 week" — for the menu and the banner. */
export function disappearingLabel(seconds: number): string {
  switch (seconds) {
    case 0: return 'Off';
    case 30: return '30 seconds';
    case 300: return '5 minutes';
    case 3600: return '1 hour';
    case 86400: return '24 hours';
    case 604800: return '1 week';
    default: {
      // Anything unexpected still reads sensibly rather than showing a raw
      // number of seconds — an older client meeting a newer server, say.
      if (seconds < 60) return `${seconds} seconds`;
      if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
      if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
      return `${Math.round(seconds / 86400)} days`;
    }
  }
}

/**
 * The same durations, short enough to fit on a chip.
 *
 * Lives here rather than being spelled out at each button, because the web has
 * the same row of chips and two hand-written ladders had already drifted into
 * three copies of this list.
 */
export function chipLabel(seconds: number): string {
  switch (seconds) {
    case 0: return 'Off';
    case 30: return '30s';
    case 300: return '5m';
    case 3600: return '1h';
    case 86400: return '24h';
    case 604800: return '1w';
    default: {
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
      if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
      return `${Math.round(seconds / 86400)}d`;
    }
  }
}

/**
 * What someone DID, without their name.
 *
 * The chat already renders the name as its own styled element, so the notice
 * is split rather than assembled and then chopped apart again.
 */
export function disappearingPredicate(seconds: number): string {
  return seconds > 0
    ? `turned on disappearing messages — new messages vanish ${disappearingLabel(seconds)} after they are read`
    : 'turned off disappearing messages';
}

/** The whole sentence, for anywhere that renders it as one piece (the web). */
export function disappearingNotice(
  username: string, seconds: number, isMe: boolean,
): string {
  return `${isMe ? 'You' : username} ${disappearingPredicate(seconds)}`;
}
