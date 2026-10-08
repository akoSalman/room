// ── Not moving the list out from under a finger ────────────────────────────
//
// Reported as: a message arrives in a chat that is not at the top; on leaving
// that chat the list updates at that moment, and the wrong conversation gets
// tapped because everything moved.
//
// The chat list is thrown away while a chat is open and built again on the way
// back. It paints immediately from what was cached — the order from before —
// and the server's answer arrives a moment later with the new order. That
// moment is exactly when somebody is reaching for the next conversation, so
// the row under their finger changes between the decision and the tap.
//
// Opening the wrong conversation is not a small error. It is a message sent
// to the wrong person, read receipts in a chat nobody meant to open, and on a
// disappearing message it cannot be undone.
//
// So a reorder waits for a moment when nobody is reaching: a short settle
// after the list appears, and a pause after the last touch. The CONTENT —
// unread counts, the last line, who is online — updates immediately
// throughout. It is only the ORDER that waits, because order is the only part
// that moves a target.

/** How long after the list appears before its order may change. */
export const SETTLE_MS = 700;

/** How long after the last touch before its order may change. */
export const QUIET_MS = 400;

/**
 * May the list be put in a new order right now?
 *
 * Both conditions, not either: a list that has been up for a while is still
 * being touched, and a list nobody has touched yet is the one most likely to
 * be tapped in the next instant.
 */
export function mayReorder(o: {
  shownAt?: unknown; lastTouchAt?: unknown; now?: unknown;
  settleMs?: unknown; quietMs?: unknown;
}): boolean {
  const e = o || {};
  const now = Number(e.now);
  if (!Number.isFinite(now)) return true;
  const settle = Number.isFinite(Number(e.settleMs)) ? Number(e.settleMs) : SETTLE_MS;
  const quiet = Number.isFinite(Number(e.quietMs)) ? Number(e.quietMs) : QUIET_MS;

  const shownAt = Number(e.shownAt);
  // No idea when it appeared: do not hold the order hostage to a missing fact.
  if (Number.isFinite(shownAt) && now - shownAt < settle) return false;

  const touchedAt = Number(e.lastTouchAt);
  // Never touched is not recent touching.
  if (Number.isFinite(touchedAt) && touchedAt > 0 && now - touchedAt < quiet) return false;

  return true;
}

type Ided = { id?: unknown };

/**
 * The incoming rows, in an order that does not move anything under a finger.
 *
 * Every row is the INCOMING one, so counts and previews are current. Only the
 * sequence is borrowed from what is already on screen.
 *
 * A conversation that is genuinely new goes at the END while the order is
 * held. It is the one case where something must appear from nowhere, and the
 * bottom is the only place that pushes nothing else aside. It takes its real
 * position a moment later, once the list has settled.
 */
export function holdOrder<T extends Ided>(current: T[] | null | undefined, incoming: T[] | null | undefined): T[] {
  const next = Array.isArray(incoming) ? incoming : [];
  const prev = Array.isArray(current) ? current : [];
  if (!prev.length) return next;

  const byId = new Map<string, T>();
  next.forEach(r => { if (r && r.id != null) byId.set(String(r.id), r); });

  const out: T[] = [];
  const used = new Set<string>();
  prev.forEach(r => {
    if (!r || r.id == null) return;
    const key = String(r.id);
    const fresh = byId.get(key);
    // Gone from the server's answer: it has been left or deleted, and keeping
    // it would be showing a conversation that is not there.
    if (!fresh || used.has(key)) return;
    used.add(key);
    out.push(fresh);
  });
  next.forEach(r => {
    if (!r || r.id == null) { out.push(r); return; }
    if (!used.has(String(r.id))) out.push(r);
  });
  return out;
}
