// When a disappearing message should leave the screen.
//
// Reported as: disappearing messages do not disappear exactly after the time
// they were set to.
//
// Two delays sat on top of the deadline. The server swept for expired messages
// every thirty seconds, so a thirty-second timer could last a minute — fixed
// on the server. And the page waited to be TOLD: the bubble stayed until the
// delete event arrived, which on a slow connection is a visible pause and on a
// dropped socket is indefinite.
//
// Both ends know the deadline, so this end stops showing an expired message on
// its own. The server still destroys it; this only decides what is drawn.
//
// Mirrors native-app/src/expiryRing.ts, and a drift test compares the two: a
// message that vanishes at a different moment in the browser than on the phone
// is a bug in whichever is behind.
(function (root) {
  'use strict';

  /** Is this message's time up? */
  function hasExpired(expiresAt, now) {
    if (now === undefined) now = Date.now();
    return !!expiresAt && expiresAt <= now;
  }

  /**
   * Milliseconds until the next message expires, or null when none is counting.
   *
   * One timer for the whole list rather than one per message: the only
   * deadline that matters is the earliest, and the rest follow from it.
   */
  function msUntilNextExpiry(messages, now) {
    if (now === undefined) now = Date.now();
    var soonest = null;
    (messages || []).forEach(function (m) {
      var at = m && m.expires_at;
      if (!at) return;
      if (soonest === null || at < soonest) soonest = at;
    });
    if (soonest === null) return null;
    // Never zero: a zero-delay timer that re-arms from a clock which has not
    // moved is a spin.
    return Math.max(1, soonest - now);
  }

  /** The messages still worth showing. */
  function dropExpired(messages, now) {
    if (now === undefined) now = Date.now();
    return (messages || []).filter(function (m) {
      return !hasExpired(m && m.expires_at, now);
    });
  }

  root.Expiry = {
    hasExpired: hasExpired,
    msUntilNextExpiry: msUntilNextExpiry,
    dropExpired: dropExpired,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).Expiry;
}
