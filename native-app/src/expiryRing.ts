// Countdown maths for a disappearing message's ring. Kept apart from the
// component so it can be unit tested without React Native.

/** Remaining fraction of a message's life, 1 → 0. */
export function remainingFraction(
  expiresAt: number | null | undefined, seconds: number, now = Date.now(),
): number {
  if (!expiresAt || !seconds || seconds <= 0) return 1;
  const total = seconds * 1000;
  // Clamped at both ends: a phone whose clock lags the server would otherwise
  // render more than a full ring, and a long-dead message a negative one.
  return Math.max(0, Math.min(1, (expiresAt - now) / total));
}

/** How often to repaint: smooth for short timers, lazy for long ones. */
export function tickInterval(seconds: number): number {
  if (!seconds || seconds <= 0) return 1000;
  if (seconds <= 60) return 500;      // a 30s ring has to visibly move
  if (seconds <= 3600) return 5000;
  return 30000;                        // a week-long one barely changes
}

// ── Going at the right moment, not at the next round trip ────────────────────
//
// Reported as: disappearing messages do not disappear exactly after the time
// they were set to.
//
// Two separate delays sat on top of the deadline. The server swept for expired
// messages every thirty seconds, so a thirty-second timer could last a minute
// — fixed there. And this end waited to be TOLD: the message stayed on screen
// until the server's delete event arrived, which on a slow connection is a
// visible pause and on a dropped socket is forever.
//
// Both ends know the deadline, so this end stops showing an expired message on
// its own. The server is still the one that destroys it; the difference is
// that the screen no longer shows something it knows is gone.

/** Is this message's time up? */
export function hasExpired(
  expiresAt: number | null | undefined, now = Date.now(),
): boolean {
  return !!expiresAt && expiresAt <= now;
}

/**
 * When a message is due to be destroyed, whichever clock it is on.
 *
 * There are TWO, and fixing one of them left the other exactly as it was.
 *
 *   • A disappearing message carries `expires_at`, set when the other person
 *     reads it.
 *   • A ONE-TIME message carries `viewed_at` and `one_time_seconds`, and is
 *     due that long after it was opened.
 *
 * Reported with a screenshot: a one-time message showing "🔥 0s" — its
 * countdown finished — still sitting in the chat. The server does destroy it,
 * but this end only ever removed messages on the FIRST clock, and a copy that
 * came back from the offline cache, or a delete event missed while the app was
 * in the background, had nothing to remove it.
 */
export function deadlineOf(m: {
  expires_at?: number | null;
  viewed_at?: number | null;
  one_time_seconds?: number | null;
}): number | null {
  if (!m) return null;
  const deadlines: number[] = [];
  if (m.expires_at) deadlines.push(m.expires_at);
  // Not yet opened is not yet counting: a one-time message waits indefinitely
  // for the person it was sent to, which is the whole point of it.
  if (m.one_time_seconds && m.viewed_at) {
    deadlines.push(m.viewed_at + m.one_time_seconds * 1000);
  }
  if (!deadlines.length) return null;
  return Math.min(...deadlines);
}

/**
 * Milliseconds until the next message expires, or null when none is counting.
 *
 * One timer for the whole list rather than one per message: a chat showing
 * fifty disappearing messages does not need fifty timers, and the only one
 * that matters is the earliest.
 */
export function msUntilNextExpiry(
  messages: {
    expires_at?: number | null; viewed_at?: number | null; one_time_seconds?: number | null;
  }[],
  now = Date.now(),
): number | null {
  let soonest: number | null = null;
  for (const m of messages || []) {
    const at = deadlineOf(m);
    if (!at) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  if (soonest === null) return null;
  // Never negative, and never zero: a zero-delay timer that re-schedules
  // itself from a clock that has not moved is a spin.
  return Math.max(1, soonest - now);
}

/** The messages still worth showing. */
export function dropExpired<T extends {
  expires_at?: number | null; viewed_at?: number | null; one_time_seconds?: number | null;
}>(messages: T[], now = Date.now()): T[] {
  return (messages || []).filter(m => !hasExpired(deadlineOf(m), now));
}
