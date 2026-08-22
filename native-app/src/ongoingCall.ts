// ── Keeping a call alive when the app is not on screen ───────────────────────
//
// Asked for as: while calling, the user should be able to work — with or
// without the app on the device.
//
// Leaving the app used to end the call in every way but name. Android is free
// to freeze a process that has nothing keeping it in the foreground, and a
// frozen app is a call whose audio stops and whose socket quietly dies; the
// other person hears silence and neither side is told anything. Answering a
// call and then opening the browser to look something up is an ordinary thing
// to do, and it broke the call.
//
// A foreground service is the thing Android provides for exactly this: a
// process that may keep running because the user can SEE that it is running.
// The ongoing notification is not decoration, it is the price and the point —
// it is also the way back into the call, and a way to hang up without going
// back at all.
//
// Every entry point is wrapped: on a build without the native module this
// degrades to a call that behaves as it did before rather than throwing
// somewhere nothing is watching.
import notifee, {
  AndroidCategory, AndroidForegroundServiceType, AndroidImportance,
  AndroidVisibility, EventType,
} from '@notifee/react-native';
import { ongoingText, showsChronometer, CallPhase } from './callWindow';

export const ONGOING_CHANNEL = 'call-ongoing';
export const ONGOING_ID = 'ongoing-call';
export const END_ACTION = 'end-call';

let running = false;
let endHandler: (() => void) | null = null;

/** Called when the user taps "End call" in the shade. */
export function onEndFromShade(fn: (() => void) | null) { endHandler = fn; }

/**
 * The channel this lives on.
 *
 * LOW importance, no sound, no vibration: this notification exists to keep the
 * process alive and to offer a way back, not to announce anything. A call that
 * pinged every time it started would be unbearable.
 */
async function ensureChannel(): Promise<void> {
  await notifee.createChannel({
    id: ONGOING_CHANNEL,
    name: 'Ongoing calls',
    importance: AndroidImportance.LOW,
    sound: undefined,
    vibration: false,
    visibility: AndroidVisibility.PUBLIC,
  });
}

/**
 * Register the service body. Must run once, at import time.
 *
 * Notifee requires the task to be registered before any foreground-service
 * notification is displayed — registering it lazily, when a call starts, is
 * too late and Android kills the service on the spot. The promise is
 * deliberately never resolved: it resolves when the service should stop, and
 * that is what stopOngoing() is for.
 */
export function registerCallService(): void {
  try {
    notifee.registerForegroundService(() => new Promise(() => {}));
  } catch {}
}

export type OngoingInfo = {
  title: string;
  kind: 'voice' | 'video';
  phase: CallPhase;
  connected: boolean;
  /** When the call connected, for the shade's own timer. */
  connectedAt?: number | null;
};

/**
 * Show (or update) the ongoing-call notification, starting the service.
 *
 * Called again on every state change — Android replaces a notification with
 * the same id, so this is both "start" and "update", and the call's state in
 * the shade never lags behind the call.
 */
export async function startOngoing(info: OngoingInfo): Promise<void> {
  try {
    await ensureChannel();
    await notifee.displayNotification({
      id: ONGOING_ID,
      title: info.title,
      body: ongoingText({ phase: info.phase, kind: info.kind, connected: info.connected }),
      android: {
        channelId: ONGOING_CHANNEL,
        // The declaration that keeps the process alive.
        asForegroundService: true,
        // PHONE_CALL is what this is; MICROPHONE is what it uses. From
        // Android 14 a service must declare the types it actually needs or the
        // system refuses to start it — and a video call needs the camera too.
        foregroundServiceTypes: [
          AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
          AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE,
          ...(info.kind === 'video'
            ? [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_CAMERA] : []),
        ],
        category: AndroidCategory.CALL,
        importance: AndroidImportance.LOW,
        // Not dismissable: swiping away a live call would leave it running
        // with nothing on screen to say so, and no way back to it.
        ongoing: true,
        autoCancel: false,
        colorized: true,
        color: '#3b7dd8',
        // Android draws the duration itself. A timer re-posted from JavaScript
        // every second would be wasteful and visibly jumpy.
        showChronometer: showsChronometer(info.connected),
        timestamp: info.connectedAt || undefined,
        pressAction: { id: 'default', launchActivity: 'default' },
        actions: [{ title: 'End call', pressAction: { id: END_ACTION } }],
      },
    });
    running = true;
  } catch {}
}

/** Take the notification down and let the service stop. */
export async function stopOngoing(): Promise<void> {
  if (!running) return;
  running = false;
  try { await notifee.stopForegroundService(); } catch {}
  try { await notifee.cancelNotification(ONGOING_ID); } catch {}
}

export function isRunning(): boolean { return running; }

/**
 * Handle a press on the notification.
 *
 * Returns true when the event was ours, so the app's other handlers can ignore
 * it rather than each having to know about this notification.
 */
export function handleNotifeeEvent(
  type: EventType, detail: { notification?: any; pressAction?: { id?: string } },
): boolean {
  const id = detail?.notification?.id;
  if (id !== ONGOING_ID) return false;
  if (type === EventType.ACTION_PRESS && detail?.pressAction?.id === END_ACTION) {
    endHandler?.();
  }
  // A plain press just brings the app forward, which launchActivity already
  // did; there is nothing else to do and nothing else should act on it.
  return true;
}
