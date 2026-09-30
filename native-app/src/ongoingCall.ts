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
import { Platform, PermissionsAndroid } from 'react-native';
import { ongoingText, showsChronometer, CallPhase } from './callWindow';
import * as notificationIcon from './notificationIcon';

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
/**
 * Which foreground-service types this app may legally ask for, right now.
 *
 * Reported as: tapping call and, at the first ring, the app crashes.
 *
 * From Android 14 a foreground service must declare what it is for, and the
 * system CHECKS that the app holds the permission behind each type at the
 * moment the service starts. It does not fail softly: it throws
 * SecurityException on the main thread, which is a process death, not an
 * exception this file could catch — the try/catch around displayNotification
 * cannot help, because the service is started natively after it returns.
 *
 * Two of the three types were being asked for without their permission:
 *
 *   • PHONE_CALL requires MANAGE_OWN_CALLS, which was not in app.json at all.
 *     That is every Android 14 device, every call, first ring.
 *   • MICROPHONE requires RECORD_AUDIO to be GRANTED — not merely declared.
 *     An outgoing call reaches this before the microphone has been asked for
 *     the first time, and a ringing incoming call reaches it before the user
 *     has answered, so on a fresh install it is not granted yet.
 *
 * So the types are chosen from what is actually held. A call with no type at
 * all still runs: the notification is then an ordinary one, the process is not
 * protected from being frozen in the background, and that is a far smaller
 * failure than the app disappearing mid-ring.
 */
async function allowedTypes(kind: 'voice' | 'video'): Promise<AndroidForegroundServiceType[]> {
  if (Platform.OS !== 'android') return [];
  const types: AndroidForegroundServiceType[] = [];
  const has = async (p: any) => {
    try { return await PermissionsAndroid.check(p); } catch { return false; }
  };
  // MANAGE_OWN_CALLS is a normal permission: declaring it in the manifest is
  // holding it, and there is nothing to ask the user. It cannot be checked
  // with PermissionsAndroid.check (which only knows dangerous permissions),
  // so this asks Android whether the app was granted it at install time.
  if (await hasManageOwnCalls()) {
    types.push(AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_PHONE_CALL);
  }
  if (await has(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) {
    types.push(AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_MICROPHONE);
  }
  if (kind === 'video' && await has(PermissionsAndroid.PERMISSIONS.CAMERA)) {
    types.push(AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_CAMERA);
  }
  return types;
}

/**
 * Is MANAGE_OWN_CALLS actually granted?
 *
 * Normal permissions are granted at install time from the manifest, so this is
 * really asking "was it declared in the build that is installed" — which is
 * exactly the question, because a build made before it was added to app.json
 * will answer no and must not ask for the PHONE_CALL type.
 */
async function hasManageOwnCalls(): Promise<boolean> {
  try {
    return await PermissionsAndroid.check('android.permission.MANAGE_OWN_CALLS' as any);
  } catch {
    return false;
  }
}

/**
 * Whether a call may start a foreground service at all. Currently: no.
 *
 * "On tapping call, at the first ring, the app crashes" has now been reported
 * TWICE, the second time on a build carrying my fix for it — so the fix was
 * wrong, and this is the honest response to that.
 *
 * The fix assumed the crash was Android 14 refusing a service type whose
 * permission the app did not hold, and gated the types on what is actually
 * granted. It still asks for a service whenever ANY type qualifies, so if the
 * refusal comes from anywhere else — the service element notifee declares, the
 * device's own policy, the OEM's — the crash survives unchanged. And it cannot
 * be caught here: the service starts natively after displayNotification()
 * returns, so the try/catch around it is decoration. Nothing in JavaScript can
 * turn that into a handled error.
 *
 * So the whole mechanism is off. What is lost is real but small: a call is no
 * longer protected from being frozen when the app is in the background, which
 * is the thing the service was added for. What is gained is that the call
 * connects. An app that dies at the first ring has no background behaviour
 * worth protecting.
 *
 * The notification itself is unaffected — it still shows, still says who and
 * how long, and still offers End call.
 *
 * This goes back on only when there is a crash log saying what Android
 * actually objected to. Guessing at it once has already cost a release.
 */
export const CALL_FOREGROUND_SERVICE = false;

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
    const types = await allowedTypes(info.kind);
    // See CALL_FOREGROUND_SERVICE: currently always off.
    const wantsService = CALL_FOREGROUND_SERVICE && types.length > 0;
    await notifee.displayNotification({
      id: ONGOING_ID,
      title: info.title,
      body: ongoingText({ phase: info.phase, kind: info.kind, connected: info.connected }),
      android: {
        // The app's icon. Missing here entirely, so the call bar — the one
        // notification that sits on screen for the whole call — was the only
        // thing in the shade with no icon on it.
        ...notificationIcon.iconFields(),
        channelId: ONGOING_CHANNEL,
        // The declaration that keeps the process alive — but ONLY when a type
        // can be backed up. A foreground service with no valid type is
        // refused by Android 14 just as firmly as one with the wrong type, so
        // with nothing to declare this stays an ordinary notification and the
        // call simply loses its protection from being frozen.
        asForegroundService: wantsService,
        foregroundServiceTypes: wantsService ? types : undefined,
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
