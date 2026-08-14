// ── Ringing for an incoming call, with the app closed ────────────────────────
//
// An ordinary push notification cannot ring. Android plays a notification
// channel's sound ONCE, for a second or two, and then stops — which is why a
// call arriving with the app closed was easy to miss entirely.
//
// A real phone call is three things a notification is not:
//   - it rings continuously until answered, declined or the caller gives up;
//   - it takes over the screen rather than sliding a banner past;
//   - it stays put instead of being swiped away by accident.
//
// Notifee provides all three (looping sound, full-screen intent, ongoing), and
// crucially can be driven from a background task, so it works when the app is
// not running.
//
// Every entry point is wrapped: if the native module is unavailable — an old
// build, Expo Go — ringing degrades to the plain notification that was there
// before rather than throwing inside a background task, where a crash would be
// invisible and would lose the call entirely.
import notifee, {
  AndroidCategory, AndroidImportance, AndroidVisibility, EventType,
} from '@notifee/react-native';

export const CALL_CHANNEL = 'calls-v2';
/** One notification id, so a second offer replaces the first rather than stacking. */
export const CALL_NOTIFICATION_ID = 'incoming-call';

/**
 * The ringing channel.
 *
 * A channel's settings are FIXED once Android has created it — changing the
 * sound or importance in code does nothing to an existing one. That is why
 * this is versioned: 'calls-v2' is a new channel, so the looping-call settings
 * actually apply on devices that already had the old one.
 */
export async function ensureCallChannel(): Promise<void> {
  try {
    await notifee.createChannel({
      id: CALL_CHANNEL,
      name: 'Incoming calls',
      importance: AndroidImportance.HIGH,
      sound: 'ring',
      vibration: true,
      vibrationPattern: [0, 800, 400, 800],
      visibility: AndroidVisibility.PUBLIC,
      bypassDnd: false,
    });
  } catch {}
}

/** Ring. Returns false if the native ringer is unavailable. */
export async function ringIncoming(
  fromUsername: string, kind: 'voice' | 'video', fromUserId: number | string,
): Promise<boolean> {
  try {
    await ensureCallChannel();
    await notifee.displayNotification({
      id: CALL_NOTIFICATION_ID,
      title: fromUsername,
      body: kind === 'video' ? 'Incoming video call' : 'Incoming voice call',
      data: { type: 'call', kind, fromUserId: String(fromUserId) },
      android: {
        channelId: CALL_CHANNEL,
        category: AndroidCategory.CALL,
        importance: AndroidImportance.HIGH,
        // Keeps ringing instead of a single chime.
        loopSound: true,
        // Takes over the screen the way a phone call does. On a locked device
        // this shows the full-screen UI; unlocked, it appears as a heads-up
        // banner that stays.
        fullScreenAction: { id: 'default' },
        // Not dismissable by a swipe — a call is not a message.
        ongoing: true,
        autoCancel: false,
        pressAction: { id: 'default', launchActivity: 'default' },
        actions: [
          { title: 'Accept', pressAction: { id: 'accept', launchActivity: 'default' } },
          { title: 'Decline', pressAction: { id: 'decline' } },
        ],
        timeoutAfter: 45000,   // stop ringing if nobody ever picks up
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Stop ringing — answered here, answered elsewhere, cancelled, or timed out. */
export async function stopRinging(): Promise<void> {
  try { await notifee.cancelNotification(CALL_NOTIFICATION_ID); } catch {}
}

export { EventType };
