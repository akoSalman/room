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
import * as notificationIcon from './notificationIcon';
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';
import * as pushReg from './pushRegistration';
import * as notifyDiag from './notifyDiag';
import * as notifyOnce from './notifyOnce';

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
  /** Has this person muted the room it arrived in? Stamped by the server. */
  muted?: boolean;
  /**
   * Is another of this person's own devices reading this chat right now?
   * Stamped by the server, which is the only place that can know.
   */
  seenElsewhere?: boolean;
}): RaiseDecision {
  if (!o) return { raise: false, reason: 'no-message' };
  // ── A muted room is muted HERE too ──────────────────────────────────────
  //
  // Reported as: a muted room still rings.
  //
  // Muting filtered the PUSH — the path that reaches a phone with the app
  // closed. This is the other path, the one the app draws itself from the
  // socket, and it is the one you get whenever the app is open or its
  // keep-alive service is running. Two pieces of code draw a notification for
  // one message and only one of them had ever heard of mutes.
  //
  // First, before anything else: nothing about who sent it or where you are
  // changes the answer once you have asked for a room to be quiet.
  if (o.muted) return { raise: false, reason: 'muted' };
  // ── Somebody is already reading this, on another of their own devices ────
  //
  // Only the server can know this, so it says so on the delivery. Without it,
  // reading a conversation on a laptop made the phone in your pocket buzz for
  // every message you had just read.
  //
  // It sits beside the mute rather than further down because, like the mute,
  // it is a fact about the person and not about this device: nothing about
  // which screen is in front of you changes the answer.
  if (o.seenElsewhere) return { raise: false, reason: 'read-elsewhere' };
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

  // ── onAny, NOT on('message_received') ──────────────────────────────────────
  //
  // This is why the notifier was deaf, and it is nothing to do with the socket
  // or with Android. Two screens tear down their own listeners like this:
  //
  //     socketRef.current?.off('message_received');     // ChatScreen
  //     sock?.off('message_received');                  // RoomsScreen
  //
  // socket.io's off() WITH NO HANDLER removes EVERY listener for that event,
  // not just the caller's. So opening a chat and leaving it — or closing the
  // app, which unmounts the screen — removed this module's listener too, from
  // a file that has never heard of it. The socket stayed connected, the
  // diagnostics stayed green, and "messages reaching the app" sat at 0.
  //
  // That also explains the shape of the report: it worked for the first
  // seconds after a fresh start and then stopped, and differed between phones
  // depending on whether a chat had been opened yet.
  //
  // Fixing the two call sites is necessary and NOT sufficient: any screen
  // added later does the same blunt thing, and it fails silently in a
  // different file from the one that breaks. onAny cannot be removed by an
  // off('message_received') from anywhere, so this listener is safe from code
  // that does not know it exists.
  socket.onAny((event: string, msg: any) => {
    if (event !== 'message_received') return;

    // Recorded BEFORE any rule runs, so "the listener never fired" and "it
    // fired and refused everything" stop looking identical from outside.
    notifyDiag.record('socket-msg');
    const decision = raiseDecision({
      msgUsername: msg?.username,
      // The server stamps this per recipient, because a mute is one person's
      // decision and the phone's copy of the room list can be hours stale.
      muted: !!msg?.muted,
      // Another of this person's devices has this chat open.
      seenElsewhere: !!msg?.seenElsewhere,
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
    // The push may already have drawn this one.
    //
    // The shared tag was supposed to make them collapse and cannot: expo posts
    // with the Android id 0 and notifee with String.hashCode(), and Android
    // keys a notification by (tag, id). So the two routes agree here instead —
    // whichever asks first draws it. See notifyOnce.ts.
    if (!notifyOnce.claim(msg.id)) {
      notifyDiag.record('socket-skipped', undefined, 'already-notified');
      return;
    }
    notifee.displayNotification({
      // Still the server's tag, so a delete can pull it from the tray by name
      // whichever route drew it.
      id: pushReg.notificationTag(msg.id),
      title: msg.username,
      body: bodyFor(msg?.type),
      // Which chat this is about. Without it, tapping this notification only
      // launched the app, which then restored whatever chat was last open —
      // so a message from one conversation opened a different one.
      data: {
        type: 'message',
        roomId: String(msg?.room_id ?? ''),
        msgId: String(msg?.id ?? ''),
      },
      android: {
        ...notificationIcon.iconFields(),
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

  // Same reasoning: ChatScreen's cleanup calls off('message_deleted') with no
  // handler, which would take this with it.
  socket.onAny((event: string, payload: any) => {
    if (event !== 'message_deleted') return;
    const messageId = payload && payload.messageId;
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
