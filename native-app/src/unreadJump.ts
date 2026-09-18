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

// The two fixes before the one below, kept because they are the reason it is
// shaped the way it is:
//
//   1. The label said "2 NEW MESSAGES" and sat BETWEEN the two messages it was
//      counting. It counted by comparing ids.
//   2. Reported again from the same screenshot. Comparing ids is wrong because
//      the anchor is chosen by walking the list in ARRAY order and the list is
//      DRAWN in array order, and the two agree only while the array happens to
//      be sorted by id — which an optimistic send, a page merged in from the
//      offline cache, or a forward all break. Counting moved to array order.
//
// Both were real, and neither was enough. See unreadDivider.

/**
 * Where the divider goes and what it says, from ONE pass over the array that
 * is actually being drawn.
 *
 * Reported a THIRD time, with a screenshot: "3 NEW MESSAGES" sitting after the
 * first of the three. The two fixes before this one were both real and neither
 * was enough, because both left the same shape in place — the position and the
 * label were worked out separately, and only had to agree at the instant the
 * chat opened.
 *
 * The label was computed once, into a ref, while the chat was loading. The row
 * it labels then re-renders for the rest of the visit. Anything that changes
 * the list afterwards — a message deleted or hidden, an older page merged in,
 * a message that was still arriving when the count was taken — moves the rows
 * without moving the number, and the line starts describing a list that no
 * longer exists. No amount of care inside the counting rule can fix that,
 * because by the time it is wrong the counting rule has long since run.
 *
 * So there is no stored count. The anchor is a position, and this recomputes
 * the label from the rows that follow it every time the list changes. The
 * number is therefore a description of what is on screen rather than a memory
 * of what was on screen, and "the label disagrees with the rows" stops being
 * reachable — not because the arithmetic got better, but because there is
 * nowhere left for the two to drift apart.
 *
 * Returns null when there is no line to draw, so the caller has one thing to
 * check instead of a position and a count that can each be absent separately.
 */
export function unreadDivider(
  rendered: Msg[] | null | undefined,
  anchorId: number | string | null | undefined,
  me: string | null | undefined,
): { anchorId: string; count: number } | null {
  if (anchorId === null || anchorId === undefined || anchorId === '') return null;
  const list = rendered || [];
  // As strings throughout: an id is a number from the socket, a string from an
  // optimistic send or a notification payload, and `5 !== '5'` would silently
  // draw no line at all.
  const key = String(anchorId);
  const at = list.findIndex(m => m && String(m.id) === key);
  // The anchor is gone — deleted, or aged out of the page being drawn. There
  // is no row to hang the line on, so there is no line.
  if (at < 0) return null;
  let count = 0;
  for (let i = at; i < list.length; i++) {
    const m = list[i];
    if (me && m && m.username === me) continue;
    count++;
  }
  // The line is drawn above the anchor, so the anchor is itself one of the
  // messages below it. A line with nothing under it is only ever noise.
  if (count < 1) return null;
  return { anchorId: key, count };
}
