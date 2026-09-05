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
