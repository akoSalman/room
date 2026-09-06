// ── Opening a chat WHERE the unread messages are ─────────────────────────────
//
// Asked for as: direct me to where those messages are in the chat.
//
// A chat opens at the bottom, which is right when one message arrived and
// useless when thirty did: everything new is above the fold, the badge clears
// on the way in, and the reader is left scrolling backwards trying to work out
// where they had got to. Every other chat app answers this the same way — go
// to the first thing you have not read, and say so.
//
// Mirrored by public/js/unreadJump.js, compared function by function in
// test/unreadJump.test.js.

export type Msg = { id: number | string; username?: string | null };

/**
 * The first message the reader has not seen, or null.
 *
 * `lastReadId` is where they had got to, read BEFORE the chat marks itself
 * read — the position is consumed by opening, so anything that wants it has to
 * ask first.
 *
 * Own messages are skipped: sending something is not a reason to be sent back
 * up the conversation, and a chat where the last word was yours would open at
 * your own message every time.
 */
export function firstUnread(
  messages: Msg[] | null | undefined,
  lastReadId: number | string | null | undefined,
  me: string | null | undefined,
): Msg | null {
  const mark = Number(lastReadId) || 0;
  if (!mark) return null;   // nothing read yet is not the same as all unread
  const list = messages || [];
  for (const m of list) {
    const id = Number(m?.id);
    if (!Number.isFinite(id) || id <= mark) continue;
    if (me && m.username === me) continue;
    return m;
  }
  return null;
}

/**
 * Is jumping worth doing?
 *
 * Not for one message. The newest message is already on screen when a chat
 * opens at the bottom, so scrolling to it moves the view for no reason and
 * costs the reader the context underneath it.
 */
export const JUMP_MIN = 2;

export function worthJumping(unreadCount: number): boolean {
  return (Number(unreadCount) || 0) >= JUMP_MIN;
}

/** What the divider above the first unread message says. */
export function unreadLabel(count: number): string {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n <= 0) return '';
  return n === 1 ? '1 new message' : `${n} new messages`;
}

/**
 * How many unread messages the divider is actually standing above.
 *
 * Reported with a screenshot: the line said "2 NEW MESSAGES" and sat BETWEEN
 * the two messages it was counting — one above it, one below. A divider that
 * contradicts its own label is worse than no divider, because the reader
 * cannot tell which of the two answers to believe.
 *
 * It happened because the count and the position came from two different
 * lists: the count from every message newer than the read mark, the position
 * from the list actually on screen — which is not the same list once expired
 * one-time and disappearing messages have been dropped from it, or once a
 * message has been deleted for everyone. Anything counted but not drawn shows
 * up as a label one too high, and the line lands one message too low.
 *
 * So the label is counted from the ANCHOR down, over the same messages that
 * are rendered: whatever number this returns, that many rows follow the line.
 */
export function unreadBelow(
  messages: Msg[] | null | undefined,
  anchorId: number | string | null | undefined,
  me: string | null | undefined,
): number {
  // null is Number 0, and an anchor of 0 would count the whole chat as new —
  // a label of "148 new messages" over a line at the top of the screen.
  if (anchorId === null || anchorId === undefined || anchorId === '') return 0;
  const anchor = Number(anchorId);
  if (!Number.isFinite(anchor)) return 0;
  let n = 0;
  for (const m of messages || []) {
    const id = Number(m?.id);
    if (!Number.isFinite(id) || id < anchor) continue;
    if (me && m.username === me) continue;
    n++;
  }
  return n;
}
