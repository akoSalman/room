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
 * Reported a SECOND time, from the same screenshot: "2 NEW MESSAGES" with one
 * message above the line and one below. So the first fix was not enough, and
 * this is why.
 *
 * It counted by comparing ids — every message whose id was at or after the
 * anchor's. But the anchor is chosen by walking the list in ARRAY order, and
 * the list is drawn in array order too. Those two agree only while the array
 * happens to be sorted by id, and it is not always: a message sent optimistically
 * carries a temporary string id until the server answers, a page merged in from
 * the offline cache is concatenated rather than merged in id order, and a
 * forward arrives with an id below the one before it. The moment they disagree,
 * a message counted as "after the anchor" is DRAWN BEFORE IT — the label says
 * two, the line has one beneath it, and both halves believe they are right.
 *
 * So it no longer compares ids at all. It finds the anchor in the list and
 * counts the rows from there to the end, which is the same traversal that put
 * the line where it is. Whatever this returns, that many rows follow the line —
 * by construction rather than by coincidence.
 */
export function unreadBelow(
  messages: Msg[] | null | undefined,
  anchorId: number | string | null | undefined,
  me: string | null | undefined,
): number {
  if (anchorId === null || anchorId === undefined || anchorId === '') return 0;
  const list = messages || [];
  // Compared as strings: an id arrives as a number from the socket and as a
  // string from a notification payload or an optimistic send, and `5 !== '5'`
  // would find no anchor and label the divider with nothing.
  const at = list.findIndex(m => m && String(m.id) === String(anchorId));
  // The anchor is not in the list being drawn — it expired, or was deleted
  // between being chosen and being rendered. There is no line, so there is
  // nothing to label.
  if (at < 0) return 0;
  let n = 0;
  for (let i = at; i < list.length; i++) {
    const m = list[i];
    if (me && m && m.username === me) continue;
    n++;
  }
  return n;
}
