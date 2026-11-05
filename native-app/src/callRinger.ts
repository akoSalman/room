// ── The socket's ring, attached the way the socket's notifications are ───────
//
// The decision lives in callRing.ts; this is the wiring, and it is deliberately
// the same shape as socketNotifier.ts because the lesson that file documents
// applies here word for word:
//
//   • attached ONCE, outside React, and never torn down by a screen
//     unmounting. The ring has to work with the app closed, which is precisely
//     when there is no React tree;
//
//   • onAny rather than on('call_offer'), because socket.io's off() with no
//     handler removes EVERY listener for that event. Two screens already do
//     that to 'message_received' and took socketNotifier's listener with them,
//     from files that had never heard of it. Nothing does it to a call event
//     today; onAny means nothing added later can.
//
// It draws the SAME notification the FCM task draws — ringIncoming(), one
// notification id, the same data payload — so everything downstream of the
// ring is unchanged: Accept still arms auto-accept through App.tsx, Decline
// still works from the shade without opening the app, and the two routes
// cannot stack because they claim through callRing.
import { AppState } from 'react-native';
import { ringIncoming, stopRinging } from './incomingCall';
import * as callRing from './callRing';

let attachedTo: any = null;

/** Exposed for the test, so it checks the real state rather than a copy. */
export function _state(): { attached: boolean } {
  return { attached: !!attachedTo };
}

/**
 * Attach to the socket. Idempotent; a genuinely new socket (a reconnect that
 * replaced it, or a re-login) gets the listeners and the old one is let go.
 *
 * Called from the same onSocket subscription that attaches the message
 * notifier, because being handed one socket and left there is the bug that
 * has been found four separate times in this app.
 */
export function attach(socket: any): void {
  if (!socket || attachedTo === socket) return;
  attachedTo = socket;

  socket.onAny((event: string, payload: any) => {
    // ── The caller hung up, or gave up ──────────────────────────────────────
    //
    // Needed here and not only in callManager, which is the thing that may not
    // be running. With the app closed and no React tree, callManager's
    // listeners are not bound, nothing calls stopRinging, and the phone goes
    // on ringing until the notification's own 45-second timeout — so a caller
    // who dialled by mistake and hung up immediately left a phone ringing in
    // somebody's pocket for the full three quarters of a minute.
    if (event === 'call_end') {
      stopRinging().catch(() => {});
      return;
    }
    if (event !== 'call_offer') return;

    const fromUserId = payload?.fromUserId;
    const decision = callRing.claimRing({
      event,
      fromUserId,
      roomId: payload?.roomId,
      appState: AppState.currentState,
    });
    // Reported either way. "It did not ring" has had several different causes
    // this week and they are indistinguishable from outside; the reason says
    // which rule answered, and it reaches the server rather than a screen
    // somebody has to photograph.
    report(socket, decision.reason);
    if (!decision.ring) return;

    ringIncoming(
      String(payload?.fromUsername || 'Someone'),
      payload?.kind === 'video' ? 'video' : 'voice',
      fromUserId,
    ).then(rang => {
      if (!rang) {
        // The native ringer is unavailable — an old build, or Expo Go. Give
        // the claim back rather than holding it, so the FCM route, which may
        // still be able to draw it, is not refused as a duplicate of a
        // notification that does not exist.
        callRing.releaseRing();
        report(socket, 'ring-failed');
        return;
      }
      // ── Tell the caller their phone is actually ringing ──────────────────
      //
      // callManager emits this from onOffer, and callManager is exactly what
      // is not running in the case this file exists for. Without it the
      // caller's screen has only the server's delivery ack to go on, and sat
      // on "Connecting…" while the other phone was ringing in front of
      // somebody — which is what was reported.
      try { socket.emit('call_ringing', { toUserId: fromUserId }); } catch {}
    }, () => {
      callRing.releaseRing();
      report(socket, 'ring-threw');
    });
  });
}

/**
 * One line to the server about what this device did with an offer.
 *
 * On the existing call_diag channel, which strips everything it prints: no
 * username, no address, and the reason goes through the same word() filter as
 * every other field. The server's logs are read into a repository that has
 * been public.
 */
function report(socket: any, reason: string): void {
  try { socket.emit('call_diag', { what: 'ring', reason }); } catch {}
}

/** Sign-out, and nowhere else. */
export function detach(): void {
  attachedTo = null;
  callRing.releaseRing();
}
