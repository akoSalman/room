// ── Finding the message that has new comments ────────────────────────────────
//
// Reported as: the chat is badged for a new message, you open it, and there is
// nothing new to see.
//
// Because there wasn't — in the chat. The new thing was a COMMENT, which by
// design never appears in the conversation; it lives in a thread hanging off a
// message that may be a hundred messages back. The badge was telling the truth
// and there was no way to act on it.
//
// So a comment now leaves two marks, the way a mention does:
//
//   • on the message it belongs to — a count inside its comments strip, which
//     is where somebody looking at that message would expect it;
//   • at the top or bottom edge of the chat — a chip saying there is something
//     new that way, which scrolls to the message when tapped.
//
// The chip is what makes the feature findable at all: the message may be far
// off screen, and nobody scrolls a year of chat on the chance that something
// changed.
//
// Mirrored by public/js/commentUnread.js, compared function by function in
// test/commentUnread.test.js.

export type Counts = Record<string, number>;

/** More than this and the badge says "99+" — the exact number stops mattering. */
export const BADGE_CAP = 99;

/**
 * A comment arrived. Returns a NEW map.
 *
 * Not counted when it is the user's own — writing a comment is not news to its
 * author — nor when that thread is open on screen, where it is already visible
 * and would leave a badge for something just read.
 */
export function noteComment(counts: Counts | null | undefined, o: {
  parentId: number | string;
  mine?: boolean;
  threadOpenId?: number | string | null;
}): Counts {
  const next: Counts = { ...(counts || {}) };
  const key = String(o.parentId ?? '');
  if (!key) return next;
  if (o.mine) return next;
  if (o.threadOpenId != null && String(o.threadOpenId) === key) return next;
  next[key] = (Number(next[key]) || 0) + 1;
  return next;
}

/** Everything about this message has been seen. Returns a NEW map. */
export function clearFor(counts: Counts | null | undefined, parentId: number | string): Counts {
  const next: Counts = { ...(counts || {}) };
  delete next[String(parentId ?? '')];
  return next;
}

/** How many are waiting on one message. */
export function countFor(counts: Counts | null | undefined, parentId: number | string): number {
  return Number((counts || {})[String(parentId ?? '')]) || 0;
}

export function totalUnread(counts: Counts | null | undefined): number {
  return Object.keys(counts || {}).reduce((n, k) => n + (Number((counts as Counts)[k]) || 0), 0);
}

/** The number drawn inside a message's comments strip. Empty when there is none. */
export function badgeLabel(count: number): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return '';
  return n > BADGE_CAP ? `${BADGE_CAP}+` : String(n);
}

export type Jump = { id: string; dir: 'up' | 'down'; count: number };

/**
 * Which message to offer to jump to, and which way it lies.
 *
 * DOWN WINS TIES, and deliberately: the chat is read from the bottom, newer
 * messages are below, and a chip that sends the reader backwards past unread
 * things they have not reached yet is an interruption rather than a shortcut.
 *
 * Something already on screen is not offered. The badge in its own strip is
 * right there, and a chip pointing at what the user is looking at is noise.
 *
 * A message that is not loaded at all (index < 0) is skipped rather than
 * guessed at — jumping to a position we do not know is worse than not
 * offering.
 */
export function chooseJump(
  items: Array<{ id: number | string; index: number; count: number }> | null | undefined,
  view: { first: number; last: number },
): Jump | null {
  const list = (items || []).filter(x => x && Number.isFinite(x.index) && x.index >= 0);
  // Nothing measured yet is NOT "the top of the list": Number(undefined) is
  // NaN but Number(null) is 0, and a missing view read as 0..0 pointed the
  // chip downwards at whatever happened to be second in the chat.
  if (!view || typeof view.first !== 'number' || typeof view.last !== 'number') return null;
  const first = view.first;
  const last = view.last;
  if (!list.length || !Number.isFinite(first) || !Number.isFinite(last)) return null;
  const below = list.filter(x => x.index > last).sort((a, b) => a.index - b.index)[0];
  if (below) return { id: String(below.id), dir: 'down', count: Number(below.count) || 0 };
  const above = list.filter(x => x.index < first).sort((a, b) => b.index - a.index)[0];
  if (above) return { id: String(above.id), dir: 'up', count: Number(above.count) || 0 };
  return null;
}

/** What the chip says: an arrow the way it will move, and how many are waiting. */
export function jumpLabel(jump: Jump | null | undefined): string {
  if (!jump) return '';
  const n = Math.max(0, Math.floor(Number(jump.count) || 0));
  const arrow = jump.dir === 'up' ? '↑' : '↓';
  return `${arrow} 💬 ${n > BADGE_CAP ? `${BADGE_CAP}+` : n}`;
}
