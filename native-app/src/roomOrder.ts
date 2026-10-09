// ── Keeping the saved chat list in the right order while nobody is looking ──
//
// Reported four times: the chat list moves as you reach for a conversation
// and the wrong one opens.
//
// Each previous round treated the MOVEMENT as the thing to control — hold it,
// delay it, allow it only when the list has settled. Every one of those
// leaves the same shape in place: the first thing drawn is out of date, and
// something has to correct it while a person is already reaching. There is no
// moment at which correcting it is safe, because the correction IS the bug.
//
// So the first paint has to be right. The chat list is thrown away while a
// chat is open and rebuilt from the copy on the device — and that copy was
// last written before the chat was opened, so it is missing everything that
// arrived since. This keeps it current while the list is closed, which is
// exactly when nobody can be reaching for it.
//
// onAny, not on('message_received'), for the reason written out at length in
// socketNotifier.ts: two screens call off('message_received') with no handler
// when they unmount, and socket.io's off() with no handler removes EVERY
// listener for that event — including one belonging to a file neither of them
// has heard of.
import * as offline from './offlineStore';

/** The socket this is listening to, so attaching twice is not two listeners. */
let attached: any = null;

export function attach(socket: any): void {
  if (!socket || attached === socket) return;
  attached = socket;
  socket.onAny((event: string, msg: any) => {
    if (event !== 'message_received') return;
    // Not awaited: nothing is waiting on it, and a failed write costs one
    // list that opens in yesterday's order rather than a lost message.
    offline.bumpRoom(msg?.room_id).catch(() => {});
  });
}

/** Only for tests, and for a sign-out that should forget the socket. */
export function detach(): void {
  attached = null;
}
