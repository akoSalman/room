// ── "… is typing" belongs to ONE conversation ────────────────────────────────
//
// Reported with a screenshot from the iOS web version: a DM with one person on
// screen, and under it "sahardenizz2@gmail.com is typing" — somebody typing in
// a completely different chat.
//
// Both clients trusted the server's routing entirely: whatever `user_typing`
// arrived was drawn, wherever it came from. The server does route these by the
// room each socket is CURRENTLY looking at, which is why this is rare rather
// than constant — but "currently" is a fact the server learns when the client
// says `join_room`, and the web said it late: after opening a DM it fetched the
// peer's key first, a network round trip with a retry ladder behind it. For
// that whole window the server still believed the socket was in the PREVIOUS
// chat, so typing from that chat was delivered and drawn into the new one.
//
// Two fixes, and this file is the second: the client now says which room it
// joined before it does anything else, AND every presence event carries the
// room it happened in so a client can refuse one that is not about the
// conversation on screen. The first fix alone would close today's window; this
// one makes any future routing slip harmless rather than visible.
//
// Mirrored by public/js/presence.js, compared function by function in
// test/presence.test.js.

/**
 * Is this typing/recording event about the chat that is open?
 *
 * A MISSING roomId is accepted, deliberately. The two clients and the server
 * are deployed separately — an app on someone's phone is updated whenever they
 * get round to it — so an older server that sends no room at all must not have
 * its typing indicators silently stop working. It is the case this rule cannot
 * improve on, not a case worth breaking.
 */
export function isForRoom(
  eventRoomId: number | string | null | undefined,
  openRoomId: number | string | null | undefined,
): boolean {
  if (eventRoomId === null || eventRoomId === undefined || eventRoomId === '') return true;
  if (openRoomId === null || openRoomId === undefined || openRoomId === '') return false;
  // Compared as strings: ids arrive as numbers from one path and as strings
  // from another, and 12 !== '12' would drop every event on one of them.
  return String(eventRoomId) === String(openRoomId);
}
