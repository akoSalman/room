// ── When a message counts as read ───────────────────────────────────────────
//
// Reported three times, each time as the unread divider being in the wrong
// place: "3 NEW MESSAGES" with the line sitting after the first of them.
//
// Twice I treated that as an arithmetic problem and fixed the counting. The
// counting was not wrong. The divider was drawn exactly where the app believed
// the unread messages began — and that belief was wrong, because the app had
// already told the server those messages were read.
//
// The chat screen marks a message read the moment it arrives. That is right
// when somebody is looking at the chat, and it is wrong in two situations that
// are not rare at all:
//
//   • THE POCKET. Backgrounding the app emits leave_room, so notifications
//     resume — but the screen stays mounted and its socket handler keeps
//     running. Every message arriving while the phone is locked was marked
//     read. The user never saw them; the server was told otherwise.
//   • SCROLLED UP. Reading back through history is not reading what is
//     arriving at the bottom, and the app knows the difference — it already
//     tracks whether the list is near the end, to decide whether to follow new
//     messages. Marking them read anyway is claiming the user saw something
//     that never came on screen.
//
// So the divider was honest and its input was not. This is the input.
//
// Mirrored by public/js/readPosition.js, compared function by function in
// test/readPosition.test.js.

export type ReadContext = {
  /** Is the app in the foreground? A locked phone is not reading anything. */
  appActive: boolean;
  /** Is the list at the end, where an arriving message actually appears? */
  atBottom: boolean;
  /** Did the reader send it? Then it is theirs and it is on screen. */
  fromMe?: boolean;
};

/**
 * May an arriving message move the read position?
 *
 * Only when it actually reached the reader's eyes: the app in front of them,
 * and the list at the end where the message lands.
 *
 * Deliberately conservative. Failing to mark something read costs an unread
 * line the reader dismisses in a second; marking it read wrongly destroys the
 * position they were coming back to, silently, with nothing on screen to say
 * it happened. The two mistakes are not the same size.
 */
export function marksRead(ctx: ReadContext): boolean {
  if (!ctx) return false;
  // Your own message is on screen because sending it put it there.
  if (ctx.fromMe) return true;
  return !!ctx.appActive && !!ctx.atBottom;
}

/**
 * The furthest message id that may be recorded as read.
 *
 * Returns null when nothing may be — the caller then sends nothing at all,
 * rather than sending a lower id and moving the position backwards.
 */
export function readUpTo(
  lastMessageId: number | string | null | undefined,
  ctx: ReadContext,
): number | string | null {
  if (lastMessageId === null || lastMessageId === undefined || lastMessageId === '') return null;
  if (!marksRead(ctx)) return null;
  return lastMessageId;
}

/**
 * Opening the chat is the one moment reading IS the whole point.
 *
 * Kept separate from marksRead rather than folded into it with a flag: this
 * one is a deliberate act by the user, and the other is an event arriving on a
 * socket. Naming them the same thing is how the socket case borrowed the
 * permission that belongs to this one.
 *
 * Still refuses when the app is not in front of the user, because a chat can
 * be re-opened by a refresh that fires while the phone is locked.
 */
export function opensAsRead(ctx: { appActive: boolean }): boolean {
  return !!ctx && !!ctx.appActive;
}
