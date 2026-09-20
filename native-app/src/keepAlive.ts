// ── Keeping the socket alive, so notifications do not need Google ───────────
//
// Measured on the reporter's own phone, over the same set of messages:
//
//     delivered by Firebase ........  2
//     raised by the app's own socket  11
//
// Firebase lands about one time in six. When the app's process is alive the
// socket covers everything and notifications arrive in about a second; when
// Android freezes or kills the process the socket dies with it and Firebase is
// all that is left, which is the "sometimes nothing at all".
//
// A foreground service is the only thing that stops Android freezing the
// process. Asked for, after the numbers above.
//
// ── WHY THE LAST ATTEMPT CRASHED, AND WHAT IS DIFFERENT ─────────────────────
//
// It was started from watchAppState when the app went to the BACKGROUND.
// Android 12 and later forbid starting a foreground service from the
// background, and refuse it by throwing natively after displayNotification()
// returns — so the try/catch around it caught nothing and the process died.
// Tapping the media picker backgrounds the app, which is why it showed up as
// "the camera crashes the app".
//
// Two things are different here:
//
//   1. IT ONLY STARTS IN THE FOREGROUND. That is the one state in which
//      Android permits it. Going to the background does not start it — the
//      service is already running by then, which is the entire point. See
//      mayStart, which is a pure function precisely because this is the rule
//      that cost a release.
//   2. FOREGROUND_SERVICE_DATA_SYNC is declared. Its absence was the other
//      half of the original crash: a service with no permissible type is
//      refused exactly as firmly as one started from the background.
//
// And the canary stays: a flag is written before the start and cleared once
// the process has demonstrably survived it. A flag still present at the next
// launch means the start killed us, and the service is disabled on that
// handset permanently. Worst case for somebody it does not work on is one
// crash, once — not one per launch, which is what took the call version out.
import AsyncStorage from '@react-native-async-storage/async-storage';
import notifee, { AndroidImportance, AndroidForegroundServiceType } from '@notifee/react-native';

/** Written before a start attempt, cleared once the process has survived it. */
export const CANARY_KEY = 'keepalive-starting';
/** Set for good once a start has been shown to kill this device's app. */
export const DISABLED_KEY = 'keepalive-disabled';

export const CHANNEL_ID = 'connection-v1';
export const NOTIFICATION_ID = 'keepalive';

/**
 * How long the process must survive a start before it is called safe.
 *
 * The refusal arrives natively, just after displayNotification() resolves, so
 * "we are still running a moment later" is the only evidence available from
 * JavaScript that Android accepted it.
 */
export const SURVIVED_AFTER_MS = 4000;

/**
 * May the service be started right now?
 *
 * THE RULE THAT CRASHED THE APP LAST TIME, which is why it is a pure function
 * with tests rather than an `if` buried in an event handler.
 *
 * 'active' only. Not 'inactive' — that is the half-second of a transition, and
 * on the way out of the app it is followed by 'background', where a start is
 * refused. Not 'background' under any circumstances.
 */
export function mayStart(o: {
  appState: string | null | undefined;
  disabled: boolean;
  running: boolean;
}): boolean {
  if (!o) return false;
  if (o.disabled) return false;
  if (o.running) return false;
  return o.appState === 'active';
}

/**
 * Did the previous start kill the app?
 *
 * The canary was written before the start and should have been cleared
 * afterwards. Finding it at launch means the clearing never happened, and the
 * only thing that prevents it is the process dying in between.
 */
export function crashedOnLastStart(o: { canaryPresent: boolean }): boolean {
  return !!o && !!o.canaryPresent;
}

/** Is the service permanently off on this device? */
export function isDisabled(o: { disabledFlag: string | null | undefined }): boolean {
  return !!(o && o.disabledFlag);
}

let running = false;
let disabled = false;
let clearTimer: any = null;

/** Whether the service is currently up, for callers that need to know. */
export function isRunning(): boolean {
  return running;
}

/**
 * Read the canary at launch and decide whether this device may ever try again.
 *
 * Called once, before anything attempts a start.
 */
export async function init(): Promise<void> {
  try {
    const [canary, off] = await Promise.all([
      AsyncStorage.getItem(CANARY_KEY).catch(() => null),
      AsyncStorage.getItem(DISABLED_KEY).catch(() => null),
    ]);
    if (isDisabled({ disabledFlag: off })) { disabled = true; return; }
    if (crashedOnLastStart({ canaryPresent: !!canary })) {
      disabled = true;
      await AsyncStorage.setItem(DISABLED_KEY, '1').catch(() => {});
      await AsyncStorage.removeItem(CANARY_KEY).catch(() => {});
      console.warn('[keepAlive] a previous start killed the app; disabled on this device');
    }
  } catch {}
  try {
    notifee.registerForegroundService(() => new Promise(() => {}));
  } catch {}
}

async function ensureChannel(): Promise<void> {
  try {
    await notifee.createChannel({
      id: CHANNEL_ID,
      name: 'Connection',
      // The lowest that still permits a foreground service. This notification
      // is a requirement Android imposes, not something anybody wants to see,
      // so it makes no sound and sits at the bottom of the shade.
      importance: AndroidImportance.MIN,
    });
  } catch {}
}

/**
 * Start the service, if it is allowed right now.
 *
 * Safe to call repeatedly — it returns immediately when already running, and
 * when the app is not in the foreground.
 */
export async function start(appState: string | null | undefined): Promise<void> {
  if (!mayStart({ appState, disabled, running })) return;
  try {
    await ensureChannel();
    // Before, not after: if the process dies during the call below, this is
    // what the next launch finds.
    await AsyncStorage.setItem(CANARY_KEY, '1').catch(() => {});
    running = true;
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Connected',
      body: 'Messages arrive instantly while this is on.',
      android: {
        channelId: CHANNEL_ID,
        asForegroundService: true,
        // DATA_SYNC and nothing else. The call version asked for PHONE_CALL,
        // MICROPHONE and CAMERA, any of which Android 14 refuses without the
        // matching runtime permission — and a refused type is a dead process.
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
        importance: AndroidImportance.MIN,
        ongoing: true,
        autoCancel: false,
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
    // Still here: Android accepted it. The refusal would have arrived by now.
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      AsyncStorage.removeItem(CANARY_KEY).catch(() => {});
    }, SURVIVED_AFTER_MS);
  } catch (e: any) {
    running = false;
    await AsyncStorage.removeItem(CANARY_KEY).catch(() => {});
    console.warn('[keepAlive] start failed:', e?.message);
  }
}

/** Take it down — on sign-out, and nowhere else. */
export async function stop(): Promise<void> {
  clearTimeout(clearTimer);
  running = false;
  try { await notifee.stopForegroundService(); } catch {}
  try { await notifee.cancelNotification(NOTIFICATION_ID); } catch {}
  await AsyncStorage.removeItem(CANARY_KEY).catch(() => {});
}
