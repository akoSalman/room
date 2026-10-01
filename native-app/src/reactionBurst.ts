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

/**
 * Is this burst still within its three seconds?
 *
 * The burst's lifetime belongs to the STATE, not to the component that draws
 * it, and this is the rule that decides it.
 *
 * It was the other way round and it leaked. The component started a
 * three-second timer whose callback removed the entry, and cleared that timer
 * on unmount — so a message scrolling out of a virtualised list took the only
 * thing that would ever have removed it. The entry stayed for the life of the
 * screen, and every time that message scrolled back into view the component
 * mounted again and started another three-second animation. A few reactions
 * and the list is animating continuously whenever it moves, which is reported
 * as the whole app being slow.
 *
 * A burst with no timestamp is over: something is wrong with it, and the safe
 * answer for a decoration is not to draw it.
 */
export function stillBursting(o: { at?: unknown; now?: unknown }): boolean {
  if (!o) return false;
  const at = Number(o.at);
  if (!Number.isFinite(at) || at <= 0) return false;
  const raw = Number(o.now);
  const now = Number.isFinite(raw) && raw > 0 ? raw : Date.now();
  // A timestamp from the future is a clock that moved, not a burst that has
  // expired — show it rather than swallowing it.
  if (at > now) return true;
  return now - at < BURST_MS;
}

/**
 * Are these two reaction lists the same set of reactions?
 *
 * The server announces a reaction twice: once on the room's channel, and once
 * on each member's personal channel so it reaches a phone whose app is in the
 * background and has left the room channel. Both arrive, a moment apart, on a
 * phone that is looking at the chat.
 *
 * The second one carries no news, but it used to be written into state
 * anyway, and `reactions` is part of what tells the message list its rows
 * have changed — so every reaction re-rendered every visible row twice
 * instead of once, for nothing.
 *
 * Order is ignored. Two announcements of the same state can list the same
 * reactions in either order, and treating that as a change is exactly the
 * mistake this is here to stop.
 */
export function sameReactions(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  // Keyed on WHO and WHAT. The server sends user_id alongside the username;
  // the username is the fallback, because a row that somehow lacks an id must
  // not collapse into every other row that lacks one.
  const key = (r: any) => `${(r && (r.user_id ?? r.username)) ?? ''}\u0000${(r && r.emoji) ?? ''}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
}
