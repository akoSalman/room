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
 * Milliseconds until the next message expires, or null when none is counting.
 *
 * One timer for the whole list rather than one per message: a chat showing
 * fifty disappearing messages does not need fifty timers, and the only one
 * that matters is the earliest.
 */
export function msUntilNextExpiry(
  messages: { expires_at?: number | null }[], now = Date.now(),
): number | null {
  let soonest: number | null = null;
  for (const m of messages || []) {
    const at = m && m.expires_at;
    if (!at) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  if (soonest === null) return null;
  // Never negative, and never zero: a zero-delay timer that re-schedules
  // itself from a clock that has not moved is a spin.
  return Math.max(1, soonest - now);
}

/** The messages still worth showing. */
export function dropExpired<T extends { expires_at?: number | null }>(
  messages: T[], now = Date.now(),
): T[] {
  return (messages || []).filter(m => !hasExpired(m && m.expires_at, now));
}
