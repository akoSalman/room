// ── When a live share should send a position ─────────────────────────────────
//
// Reported, with the app open, location granted and the network up: a live
// location that never moves. The pin stayed where the share started and the
// card said "updated 1 h ago" while the person it was tracking drove 53 km.
//
// The cause was not here — it was a socket captured once and held for the
// whole share, which is in locationManager — but the rest of the reason the
// fault was invisible is:
//
//   • the watcher only fires after the phone has moved 15 m AND 5 s have
//     passed, so a phone sitting still legitimately sends nothing. From the
//     outside "has not moved" and "has stopped reporting" look identical, and
//     the second one is the one worth knowing about;
//   • one lost send is permanent. There is nothing to re-send it, so a single
//     dropped update leaves the pin behind until the next real movement.
//
// A heartbeat fixes both. Sending the last position again on a slow timer
// costs almost nothing, makes "updated" mean "we heard from them this
// recently" — which is the thing a person waiting for someone actually wants
// to know — and makes a lost update self-repairing instead of permanent.
//
// Pure, so it can be tested. locationManager cannot be: it reaches for
// expo-location and a socket the moment it is imported.

/** How often to repeat a position that has not changed. */
export const HEARTBEAT_MS = 60_000;

/**
 * Is a send due, given what the watcher just handed us?
 *
 * Movement is the watcher's business — if it called us, the phone moved far
 * enough to be worth reporting. This decides the other case: nothing has
 * moved, and the last update is getting old enough to be mistaken for a dead
 * share.
 */
export function sendDue(
  now: unknown, lastSentAt: unknown, every: number = HEARTBEAT_MS,
): boolean {
  const t = typeof now === 'number' && isFinite(now) ? now : null;
  if (t === null) return false;
  // Nothing has been sent yet: the first fix always goes.
  if (typeof lastSentAt !== 'number' || !isFinite(lastSentAt)) return true;
  // A clock that went backwards (a phone correcting its time, which these do)
  // must not park the heartbeat until it catches up.
  if (t < lastSentAt) return true;
  const gap = Number.isFinite(every) && every > 0 ? every : HEARTBEAT_MS;
  return t - lastSentAt >= gap;
}

/**
 * Has the share run out?
 *
 * Checked on the client so the watcher stops itself, and on the server so a
 * client that does not cannot keep broadcasting. Both, deliberately.
 */
export function shareOver(now: unknown, until: unknown): boolean {
  const t = typeof now === 'number' && isFinite(now) ? now : null;
  const u = typeof until === 'number' && isFinite(until) ? until : null;
  if (t === null || u === null) return false;
  return t > u;
}
