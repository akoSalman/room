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

// ── What actually rings, and when ────────────────────────────────────────────
//
// The RING itself no longer depends on any of this. A call arrives as an
// ordinary high-importance notification on the calls channel, and Android
// plays it the moment it lands — with the app closed, force-stopped, or never
// opened since boot. That path runs no JavaScript at all, which is the whole
// point: expo-notifications hands data messages to JS through Android's
// JobScheduler, and a deferrable job cannot ring a phone.
//
// What the code below adds, WHEN JavaScript happens to be alive, is everything
// a plain notification cannot do: a looping ring, a full-screen intent, and
// Accept/Decline without opening the app. It is an upgrade on top of a ring
// that has already started, not the thing responsible for starting it.

export const CALL_PUSH_TASK = 'chatroom-incoming-call';

/** The tag the server puts on the plain call notification. */
const SERVER_CALL_TAG = 'incoming-call';

/** Take down the server's plain notification once notifee is ringing. */
async function dismissPlainCallNotification(): Promise<void> {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(shown
      .filter(n => {
        const d: any = n.request?.content?.data || {};
        return String(d.type) === 'call' || String(d.tag) === SERVER_CALL_TAG;
      })
      .map(n => Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {})));
  } catch {}
}

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
      const rang = await ringIncoming(
        String(d.fromUsername || 'Someone'),
        d.kind === 'video' ? 'video' : 'voice',
        d.fromUserId,
      );
      // Notifee has taken over with the looping, full-screen version, so the
      // plain notification Android already put up has to go — otherwise the
      // two ring over each other and there are two entries in the shade for
      // one call. Only once the replacement is actually up: dismissing it
      // after a failed ring would leave nothing at all.
      if (rang) await dismissPlainCallNotification();
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

  // The channel has to exist before a notification can use it — including
  // before the SERVER's notification can use it, which is now what rings. A
  // channel Android has never heard of falls back to the default one, with the
  // default sound and no ring at all.
  ensureCallChannel().catch(() => {});
}
