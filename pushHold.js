// ── Pushes waiting to see whether the socket beat them ─────────────────────
//
// Reported as: "don't send firebase notification of a message already arrived
// through socket and opened".
//
// There are two routes to a notification and both are deliberate: Firebase
// does not reach every device on these networks, which is why the app draws
// its own from the socket; and the socket is gone once Android has killed the
// process, which is why the push exists. When both work, both arrive. The
// phone draws only one of them (see notifyOnce.ts) — but the push was still
// sent, still paid for in data, and still sitting in Firebase's queue to be
// handed over later if the phone drops off in between.
//
// So a push to a device that looks connected waits a few seconds. If the app
// says it drew the notification itself, the push is dropped. If it says
// nothing — killed in those seconds, or a socket the server has not yet
// noticed is dead — it goes out as it always did.
//
// Kept here, apart from server.js, because this is the part that can be wrong
// in ways no screenshot shows: too eager and somebody gets nothing, too shy
// and nothing changes. Which decision applies to which push is
// heldForSocket in notify.js; this is the waiting itself.

/** How a (recipient, message) pair is named. Both parts, always. */
function keyFor(userId, msgId) {
  return `${userId}:${msgId}`;
}

/**
 * A push that will be sent in `graceMs` unless it is cancelled first.
 *
 * `timers` is injected so a test can run this without waiting five seconds
 * per case, and so the server can pass the real ones.
 */
function createHolder(graceMs, timers) {
  const t = timers || { setTimeout, clearTimeout };
  const held = new Map();

  return {
    /**
     * Hold one push. Returns whether it was taken (false if one was already
     * waiting for the same person and message, which is a repeat rather than
     * a second notification).
     */
    hold(userId, msgId, send) {
      const key = keyFor(userId, msgId);
      if (held.has(key)) return false;
      held.set(key, t.setTimeout(() => {
        // Removed BEFORE sending. Otherwise a send that throws leaves the
        // entry behind for ever and that message can never be held again.
        held.delete(key);
        send();
      }, graceMs));
      return true;
    },

    /**
     * The app drew this one itself: drop the waiting push.
     *
     * Returns whether anything was actually waiting, which is the difference
     * between "the socket got there first" and "the push had already gone" —
     * two outcomes worth being able to tell apart in a log.
     */
    cancel(userId, msgId) {
      const key = keyFor(userId, msgId);
      const timer = held.get(key);
      if (timer === undefined) return false;
      t.clearTimeout(timer);
      held.delete(key);
      return true;
    },

    /** How many are waiting. For tests and for a diagnostic line. */
    size() {
      return held.size;
    },
  };
}

module.exports = { createHolder, keyFor };
