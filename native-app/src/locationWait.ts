// ── Waiting for the phone to say where it is ─────────────────────────────────
//
// Asked for: when sharing a live location, if the location is not recognised,
// show a processing dialog with a cancel button.
//
// There was nothing. sendLocation closes the menu and the picker and THEN asks
// for a fix, so from the moment the button is pressed the app looks exactly as
// it did before — no spinner, no sheet, nothing — for however long the phone
// takes. Indoors or on a cell tower that is tens of seconds, and the first
// thing the user sees is either a message appearing out of nowhere or "Could
// not get your location" long after they gave up.
//
// Two things are needed and neither is cosmetic: something on screen saying
// the wait is deliberate, and a way out of it that does not involve force-
// quitting. A fix request cannot be cancelled — expo-location gives no handle
// for it — so cancelling means deciding to ignore the answer. Which is why the
// rule for whether an answer is still wanted lives here, next to the wording,
// rather than being an `if` somewhere in a screen.

/** Give up asking the GPS after this and fall back to a cached fix. */
export const FIX_TIMEOUT_MS = 25_000;

/** After this long the wait stops looking normal and needs explaining. */
export const SLOW_AFTER_MS = 6_000;

/**
 * Is the answer to attempt `attempt` still the one being waited for?
 *
 * Cancelling bumps a counter, so a fix that arrives afterwards belongs to a
 * question nobody is asking any more and is dropped. Pressing the button again
 * bumps it too, which is the same situation: the newest request owns the
 * screen.
 *
 * Compared strictly, so NaN — which is what a missing ref reads as — is never
 * equal to anything, including itself. An unknown attempt is not wanted.
 */
export function stillWanted(attempt: unknown, current: unknown): boolean {
  return typeof attempt === 'number' && typeof current === 'number'
    && Number.isFinite(attempt) && attempt === current;
}

/**
 * What to say while waiting.
 *
 * The first line is the plain truth. After a few seconds it becomes the plain
 * truth plus the reason, because by then the user is wondering whether the app
 * is broken and the honest answer — the sky is blocked — also tells them what
 * to do about it.
 */
export function waitMessage(elapsedMs: unknown, slowAfter: number = SLOW_AFTER_MS): string {
  const t = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs > 0
    ? elapsedMs : 0;
  const slow = Number.isFinite(slowAfter) && slowAfter > 0 ? slowAfter : SLOW_AFTER_MS;
  if (t < slow) return 'Finding your location…';
  return 'Still looking. This takes longer indoors or under cover — '
    + 'moving near a window usually helps.';
}

/** Has the wait gone on long enough to stop waiting? */
export function fixTimedOut(elapsedMs: unknown, limit: number = FIX_TIMEOUT_MS): boolean {
  const t = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? elapsedMs : null;
  if (t === null) return false;
  const cap = Number.isFinite(limit) && limit > 0 ? limit : FIX_TIMEOUT_MS;
  return t >= cap;
}
