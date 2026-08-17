// ── Making the phone ring when the app is not running ────────────────────────
//
// This is registration ONLY, and it lives in its own file so that `index.js`
// can run it before anything else.
//
// Why that matters. When a call arrives and the app has been closed, Android
// starts the JS bundle with no UI and delivers the push to whatever handlers
// have been registered by the time it lands. All of this used to sit at module
// scope in App.tsx — which does run on a background start, but only as the
// last step of evaluating App.tsx's entire import graph: the chat screen, the
// socket, WebRTC, the media cache, the player. Any one of those throwing in a
// headless context — where there is no UI, no window, and some native modules
// are not ready — takes the whole module down with it, and the registration
// that was going to answer the call never happens. There is no error anyone
// can see, either; the call simply does not ring.
//
// So the ringer is registered first and depends on almost nothing. It is the
// same reasoning that already puts the track-player service in index.js.
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import notifee, { EventType } from '@notifee/react-native';
import { ringIncoming, stopRinging, ensureCallChannel } from './incomingCall';

export const CALL_PUSH_TASK = 'chatroom-incoming-call';

let registered = false;

/** Register the background call handlers. Safe to call more than once. */
export function registerCallPush() {
  if (registered) return;
  registered = true;

  TaskManager.defineTask(CALL_PUSH_TASK, async ({ data }: any) => {
    try {
      // expo-notifications hands the FCM payload through in a couple of shapes
      // depending on Android version and whether the app was alive.
      const d = data?.notification?.data || data?.data || data || {};
      if (String(d.type) !== 'call') return;
      await ringIncoming(
        String(d.fromUsername || 'Someone'),
        d.kind === 'video' ? 'video' : 'voice',
        d.fromUserId,
      );
    } catch {}
  });
  Notifications.registerTaskAsync(CALL_PUSH_TASK).catch(() => {});

  // Accept/Decline pressed on the ringing notification while the app is in the
  // background or not running. Declining must not need the app to be opened.
  //
  // Notifee allows exactly one background event handler, so this is the only
  // place it may be set.
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    if (type !== EventType.ACTION_PRESS && type !== EventType.PRESS) return;

    // Stop sharing my live location, straight from the shade — the whole point
    // is not having to open the app to stop broadcasting.
    if (detail.pressAction?.id === 'stop-location') {
      try {
        const { stopSharing } = require('./locationManager');
        await stopSharing();
      } catch {}
      return;
    }

    await stopRinging();
    if (detail.pressAction?.id === 'decline') {
      // Best effort: the socket may not be up in a background process, so the
      // caller learns of it from the ring timing out if this does not land.
      try {
        const { declineCallInBackground } = require('./callManager');
        await declineCallInBackground(detail.notification?.data?.fromUserId);
      } catch {}
    }
  });

  // The channel has to exist before a notification can use it, and creating it
  // here means it exists on a background start too.
  ensureCallChannel().catch(() => {});
}
