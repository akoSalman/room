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
export type RaiseDecision = { raise: boolean; reason: string };

/**
 * Whether to notify, AND WHY NOT.
 *
 * The reason is the point. A phone reported "Shown by the app itself: 0 ·
 * never" with the socket connected and the keep-alive running, which leaves
 * two possibilities that need opposite fixes and look identical from outside:
 * the listener never fired at all, or it fired and every message was refused.
 * Guessing between them has cost days, so the refusal now says which rule
 * turned it down and that reason travels to the server.
 */
export function raiseDecision(o: {
  msgUsername?: string | null;
  me?: string | null;
  appState?: string | null;
  viewingRoomId?: string | number | null;
  msgRoomId?: string | number | null;
  msgId?: string | number | null;
  pushRegistered?: boolean;
}): RaiseDecision {
  if (!o) return { raise: false, reason: 'no-message' };
  // No id means no tag, and without the tag this and the server's push are
  // two notifications rather than one replacing the other.
  if (!pushReg.socketRaiseAllowed({ msgId: o.msgId, pushRegistered: o.pushRegistered })) {
    return { raise: false, reason: 'no-id' };
  }
  if (o.msgUsername && o.me && o.msgUsername === o.me) {
    return { raise: false, reason: 'mine' };
  }
  // THE ONE THAT MATTERS: is the app in front of the user right now? In front
  // of them the in-app badges do the signalling; everywhere else, notify.
  if (o.appState === 'active') return { raise: false, reason: 'app-active' };
  // …and the open room only while the app is ACTIVE. Unguarded, this silenced
  // the conversation you closed the app from — viewingRoomId is set when a
  // chat opens and nothing clears it when the app goes away. Kept for the
  // case where AppState is momentarily stale during a transition.
  if (o.appState === 'active'
      && o.viewingRoomId != null && o.msgRoomId != null
      && String(o.viewingRoomId) === String(o.msgRoomId)) {
    return { raise: false, reason: 'reading-this-room' };
  }
  return { raise: true, reason: 'ok' };
}

/** The same decision as a boolean, for callers that only need yes or no. */
export function shouldRaise(o: Parameters<typeof raiseDecision>[0]): boolean {
  return raiseDecision(o).raise;
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
    // Recorded BEFORE any rule runs, so "the listener never fired" and "it
    // fired and refused everything" stop looking identical from outside.
    notifyDiag.record('socket-msg');
    const decision = raiseDecision({
      msgUsername: msg?.username,
      me,
      appState: AppState.currentState,
      viewingRoomId,
      msgRoomId: msg?.room_id,
      msgId: msg?.id,
      pushRegistered: opts?.pushRegistered ? opts.pushRegistered() : false,
    });
    if (!decision.raise) {
      notifyDiag.record('socket-skipped', undefined, decision.reason);
      return;
    }
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
