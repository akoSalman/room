// ── Muting for two hours, or for good ───────────────────────────────────────
//
// Asked for as: mute, in rooms and DMs, with a choice of two hours or forever.
//
// The two are one mechanism. A mute row already meant "silent, permanently",
// so the whole change is that a row can carry an EXPIRY — and "forever" is
// simply the absence of one. That keeps every existing row valid without a
// migration that has to invent a date for it.
//
// Time is the part that goes wrong. It is stored as milliseconds since the
// epoch in UTC, compared against the server's clock, and never formatted here:
// the phone knows the user's timezone and locale, this process does not, and a
// server deciding that "until 14:30" means half past two in Tehran is how
// somebody ends up unmuted two and a half hours early.

/** Two hours, the only timed option offered. */
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/**
 * When a mute chosen now should end.
 *
 * `null` means forever, and is what every unrecognised choice falls back to.
 * The asymmetry is deliberate: a mute that outlasts its welcome is a small
 * annoyance somebody can undo in two taps, while one that silently expires
 * early is the notification storm they muted to escape.
 */
function expiryFor(choice, now) {
  if (String(choice) !== '2h') return null;
  const t = Number(now);
  if (!Number.isFinite(t) || t <= 0) return null;
  return t + TWO_HOURS_MS;
}

/**
 * Is a mute row still in force?
 *
 * A row with no expiry is forever. A row whose expiry has passed is over, and
 * the caller is free to delete it — but this must answer correctly whether or
 * not anybody ever gets round to that, because the tidying is best-effort and
 * the silence is not.
 */
function isActive(o) {
  if (!o) return false;
  const until = untilOrNull(o.until);
  if (until === null) return true;          // forever
  const now = Number(o.now);
  if (!Number.isFinite(now)) return true;   // no clock: stay muted, see above
  return until > now;
}

/**
 * Has this mute expired, and so become rubbish worth deleting?
 *
 * Distinct from `!isActive`, which is also false for a row that does not
 * exist. Only a row that once meant something and no longer does is swept.
 */
function hasExpired(o) {
  if (!o) return false;
  const until = untilOrNull(o.until);
  if (until === null) return false;
  const now = Number(o.now);
  if (!Number.isFinite(now)) return false;
  return until <= now;
}

/**
 * What the client should be told, in a form it can render itself.
 *
 * A timestamp, not a sentence. The phone formats it in the user's own locale
 * and timezone; this process knows neither.
 */
function describe(o) {
  if (!isActive(o)) return { muted: false, until: null };
  return { muted: true, until: untilOrNull(o && o.until) };
}

/**
 * 0 and null both mean "no expiry", because SQLite hands back whichever the
 * column happened to be written with, and `Number(null)` is 0 — so a plain
 * numeric check would read "forever" as "expired in 1970" and unmute
 * everybody who chose it.
 */
function untilOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

module.exports = { TWO_HOURS_MS, expiryFor, isActive, hasExpired, describe, untilOrNull };
