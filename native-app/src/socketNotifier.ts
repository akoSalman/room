// ── The socket's notifications must outlive the screen ─────────────────────
//
// Reported as: the socket notification works with the app open, and not with
// the app closed. That is exactly what the previous arrangement guaranteed.
//
// The listener that turns an incoming message into a notification lived inside
// a React useEffect in App.tsx, with the ordinary cleanup:
//
//     return () => {
//       if (sock && handler) sock.off('message_received', handler);
//     };
//
// The keep-alive foreground service keeps the SOCKET alive when the app is
// closed — that is its whole purpose, and it works. But the socket's lifetime
// and the listener's lifetime were owned by different things: the socket by a
// foreground service, the listener by a mounted React tree. Close the app and
// React tears the listener off a socket that is still connected and still
// receiving messages. Nobody is listening, so nothing is drawn.
//
// It re-attached the moment the app was reopened, which is precisely why this
// looked like "works when open, not when closed" rather than like a bug.
//
// So the listener is attached ONCE, here, outside React, and is never removed
// except on sign-out. What the UI still owns — which room is on screen — is
// pushed in as a value rather than captured in a closure, because a closure
// over React state is the same lifetime mistake wearing a different hat.
import notifee, { AndroidImportance } from '@notifee/react-native';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import * as pushReg from './pushRegistration';
import * as notifyDiag from './notifyDiag';

/** The channel the server names in every push. Kept in step with App.tsx. */
export const MESSAGES_CHANNEL = 'messages-v3';

/**
 * Should this message become a notification on this device?
 *
 * Pure, and separated from the socket wiring on purpose: this is the decision
 * that has been got wrong repeatedly, and an `if` inside an event handler
 * cannot be tested without a phone, a server and a second person to type.
 */
export function shouldRaise(o: {
  /** Who sent it. */
  msgUsername?: string | null;
  /** Who I am. Never notify me about my own message. */
  me?: string | null;
  /** 'active' means the user is looking at the app right now. */
  appState?: string | null;
  /** The room whose messages are on screen, or null when none is. */
  viewingRoomId?: string | number | null;
  msgRoomId?: string | number | null;
  msgId?: string | number | null;
  /** Whether this device is registered for push. Accepted and ignored. */
  pushRegistered?: boolean;
}): boolean {
  if (!o) return false;
  // No id means no tag, and without the tag this and the server's push are two
  // separate notifications rather than one replacing the other.
  if (!pushReg.socketRaiseAllowed({ msgId: o.msgId, pushRegistered: o.pushRegistered })) return false;
  if (o.msgUsername && o.me && o.msgUsername === o.me) return false;
  // In front of the user: the in-app badges do the signalling, and a popup
  // over the conversation being read is noise.
  if (o.appState === 'active') return false;
  // Reading this very room — checked as strings, because a room id arrives as
  // a number from the socket and is held as a string in navigation state, and
  // 7 !== '7' would have notified somebody about the chat they were reading.
  if (o.viewingRoomId != null && o.msgRoomId != null
      && String(o.viewingRoomId) === String(o.msgRoomId)) return false;
  return true;
}

/** The one-line body: what KIND of message, never its content. */
export function bodyFor(type: string | null | undefined): string {
  switch (type) {
    case 'text': return '💬 New message';
    case 'audio': return '🎙 Voice message';
    case 'image': return '🖼 Photo';
    case 'gallery': return '🖼 Photos';
    case 'video': return '🎥 Video';
    case 'music': return '🎵 Audio file';
    case 'invite': return '🔒 Room invitation';
    default: return '📄 File';
  }
}

// ── What the UI owns, handed over rather than captured ──────────────────────

let me: string | null = null;
let viewingRoomId: string | null = null;
let attachedTo: any = null;

/** Called on sign-in, once the username is known. */
export function setMe(username: string | null): void {
  me = username || null;
}

/**
 * Called whenever navigation changes.
 *
 * A setter rather than a closure: the listener below is created once and must
 * not be re-created to learn where the user is, or it is back to being owned
 * by the screen.
 */
export function setViewing(roomId: string | number | null | undefined): void {
  viewingRoomId = roomId == null ? null : String(roomId);
}

/** Exposed for the test, so it checks the real state rather than a copy. */
export function _state() {
  return { me, viewingRoomId, attached: !!attachedTo };
}

/**
 * Attach to the socket. Idempotent, and deliberately never undone by React.
 *
 * Re-attaching to the SAME socket is a no-op; a genuinely new socket (a
 * re-login) gets the listeners and the old one is let go.
 */
export function attach(socket: any, opts?: { pushRegistered?: () => boolean }): void {
  if (!socket || attachedTo === socket) return;
  attachedTo = socket;

  socket.on('message_received', (msg: any) => {
    if (!shouldRaise({
      msgUsername: msg?.username,
      me,
      appState: AppState.currentState,
      viewingRoomId,
      msgRoomId: msg?.room_id,
      msgId: msg?.id,
      pushRegistered: opts?.pushRegistered ? opts.pushRegistered() : false,
    })) return;
    notifee.displayNotification({
      // The same tag the server puts on its push, so whichever arrives first
      // is shown and the other replaces it rather than stacking.
      id: pushReg.notificationTag(msg.id),
      title: msg.username,
      body: bodyFor(msg?.type),
      android: {
        channelId: MESSAGES_CHANNEL,
        tag: pushReg.notificationTag(msg.id),
        importance: AndroidImportance.HIGH,
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    }).then(
      () => notifyDiag.record('socket-raised'),
      (e: any) => notifyDiag.record('socket-failed', undefined, e?.message || String(e)),
    );
  });

  socket.on('message_deleted', ({ messageId }: any) => {
    // Both libraries: the notification may have been posted by notifee from
    // here, or drawn by Android from the server's push payload.
    notifee.cancelNotification(pushReg.notificationTag(messageId)).catch(() => {});
    Notifications.dismissNotificationAsync(pushReg.notificationTag(messageId)).catch(() => {});
  });
}

/** Sign-out, and nowhere else. */
export function detach(): void {
  attachedTo = null;
  me = null;
  viewingRoomId = null;
}
