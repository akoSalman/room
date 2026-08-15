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
