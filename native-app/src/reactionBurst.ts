// ── Which reaction just arrived, and is it worth animating ─────────────────
//
// Asked for: when somebody reacts to a message, show that emoji animated on
// the message itself for three seconds.
//
// The animation is the easy half. The part that decides whether to run it is
// not, because the only thing the server sends is the message's WHOLE list of
// reactions, every time any of them changes:
//
//     socket.on('reactions_updated', ({ messageId, reactions }) => …)
//
// So "somebody reacted" has to be worked out by comparing what the list was
// against what it now is. Get that wrong in the obvious ways and you get
// either nothing, or a screen full of emoji every time a chat is opened.
//
// Three cases have to be told apart, and only the first is an event:
//
//   ADDED     a reaction that was not there before  → animate
//   REMOVED   somebody taking theirs back           → nothing
//   FIRST     the list arriving for the first time  → nothing, ever
//
// That last one is the one that would be embarrassing: opening a chat loads
// every message's reactions at once, and treating those as new would burst
// every emoji in the history simultaneously.

/** How long the emoji stays on the message. Named in the request. */
export const BURST_MS = 3000;

export type Reaction = { emoji?: string | null; username?: string | null };

/**
 * The emoji somebody has just added, or null if nothing was.
 *
 * `prev` being undefined means this is the first time this message's
 * reactions have been seen — on opening a chat, or on a reconnect — and
 * nothing about it is news.
 *
 * When more than one appears at once (two people reacting inside the same
 * round trip, or a reconnect delivering a batch) the LAST new one is taken:
 * one emoji flying up says "somebody reacted" perfectly well, and three
 * overlapping ones say nothing at all.
 */
export function addedEmoji(o: {
  prev?: Reaction[] | null | undefined;
  next?: Reaction[] | null | undefined;
}): string | null {
  // Only null and undefined mean "never seen". An empty array is a message
  // KNOWN to have no reactions, which is exactly the state a first reaction
  // arrives into, and it must pass through.
  //
  // Written out rather than as `!o.prev` because the two are easy to confuse
  // and one of them is a bug waiting for a refactor: `![]` is false, so the
  // short form happens to be correct for arrays today — but it stops being
  // correct the moment this field is ever a string or a count, and nothing
  // would say so.
  if (!o || o.prev === undefined || o.prev === null) return null;
  const before = countByEmoji(o.prev);
  const after = countByEmoji(o.next);
  let found: string | null = null;
  for (const emoji of Object.keys(after)) {
    if (after[emoji] > (before[emoji] || 0)) found = emoji;
  }
  return found;
}

/**
 * Counted rather than compared as a set.
 *
 * Two people reacting with the same emoji is one entry in a set and two in
 * the list — and the second person's reaction is just as much an event as the
 * first's. A set would show nothing for it.
 */
function countByEmoji(list: Reaction[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    const e = r && typeof r.emoji === 'string' ? r.emoji : '';
    if (!e) continue;
    out[e] = (out[e] || 0) + 1;
  }
  return out;
}
