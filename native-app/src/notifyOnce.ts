// ── One notification per message, whichever route gets there first ─────────
//
// Reported as: sometimes both the socket notification and the Firebase one
// arrive for the same message.
//
// There are two routes on purpose and neither can be switched off. Firebase
// does not reach every device here, which is why the app draws its own from
// the socket; and the socket is not running once Android has killed the
// process, which is why the push exists. Whichever arrives is the one the user
// gets, and usually only one does.
//
// When BOTH arrive — app backgrounded, process alive, keep-alive socket up,
// and the push delivered as well — they were supposed to collapse into one.
// They carry the same tag for exactly that reason. They do not collapse, and
// the reason is measurable rather than arguable:
//
//   expo-notifications posts every notification it draws with the Android id
//   0 (ANDROID_NOTIFICATION_ID in ExpoPresentationDelegate.kt), distinguishing
//   them only by tag.
//
//   notifee posts with the id String.hashCode() of the id it was given
//   (NotificationModel.b() in the shipped AAR).
//
// Android keys a notification by (package, tag, id). Same tag, different id,
// so the system holds them as two separate notifications. No tag alone could
// ever have fixed it.
//
// ── The rule ────────────────────────────────────────────────────────────────
//
// So the two routes agree in JavaScript instead, where they share a process
// and a single thread: the first one to ask about a message draws it, the
// second is told to stand down.
//
// It FAILS OPEN, which is the property that matters. If only one route is
// working — no Firebase, or no socket — that route asks first, is told yes,
// and the notification appears. Nothing here can produce silence; the worst it
// can do is let a duplicate through.
//
// And it does nothing at all once the process is dead, which is precisely when
// there is no duplicate to prevent: no JavaScript is running, the socket is
// gone, and the system tray draws the push by itself.

/**
 * How long a claim is remembered.
 *
 * Long enough to cover the gap between the two routes, which is a round trip
 * to Firebase and back — seconds, not minutes. Generous because the cost of
 * being too generous is one missed duplicate-suppression on a message somebody
 * re-sent, and the cost of being too mean is the duplicate this exists to
 * stop.
 */
export const WINDOW_MS = 5 * 60 * 1000;

/** Beyond this many remembered ids, the oldest go. A chat can be busy. */
export const MAX_REMEMBERED = 200;

const seen = new Map<string, number>();

/**
 * May the caller draw a notification for this message?
 *
 * True exactly once per message id within the window; false afterwards.
 *
 * A message with no usable id CANNOT be deduplicated — there is nothing to key
 * on — so it is always allowed. That is the fail-open direction: an
 * unidentifiable message notifies twice at worst, rather than never.
 */
export function claim(msgId: unknown, now: number = Date.now()): boolean {
  const key = idKey(msgId);
  if (key === null) return true;
  const t = Number(now);
  const at = Number.isFinite(t) ? t : Date.now();

  const prev = seen.get(key);
  if (prev !== undefined && at - prev < WINDOW_MS) return false;

  seen.set(key, at);
  sweep(at);
  return true;
}

/**
 * Has this message already been claimed? Asks without claiming.
 *
 * For a caller that wants to know before it commits to anything.
 */
export function claimed(msgId: unknown, now: number = Date.now()): boolean {
  const key = idKey(msgId);
  if (key === null) return false;
  const prev = seen.get(key);
  if (prev === undefined) return false;
  const t = Number(now);
  return (Number.isFinite(t) ? t : Date.now()) - prev < WINDOW_MS;
}

/** The key for a message id, or null when there is nothing to key on. */
function idKey(msgId: unknown): string | null {
  if (msgId === null || msgId === undefined) return null;
  const s = String(msgId).trim();
  // '0' is a legitimate id and must not be mistaken for an absent one — the
  // trap this codebase keeps meeting. Only genuinely empty is empty.
  return s === '' ? null : s;
}

/** Drop what has expired, and cap the rest. Called on every claim. */
function sweep(now: number) {
  for (const [k, t] of seen) {
    if (now - t >= WINDOW_MS) seen.delete(k);
  }
  // Map preserves insertion order, so the front is the oldest.
  while (seen.size > MAX_REMEMBERED) {
    const oldest = seen.keys().next();
    if (oldest.done) break;
    seen.delete(oldest.value);
  }
}

/** Forget everything. For tests, and for signing out. */
export function reset() {
  seen.clear();
}
