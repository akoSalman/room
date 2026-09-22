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
// Fixed here, and one thing NOT fixed, which is why this ships switched off:
//
//   1. IT ONLY STARTS IN THE FOREGROUND. That is the one state in which
//      Android permits it. Going to the background does not start it — the
//      service is already running by then, which is the entire point. See
//      foregroundOnly, a pure function precisely because this is the rule
//      that cost a release.
//   2. NOT FIXED: the service's manifest type. This file first said
//      "FOREGROUND_SERVICE_DATA_SYNC is declared, so the other half is
//      handled" — and shipped a build that crashed on launch. Declaring the
//      PERMISSION is not declaring the TYPE. notifee's manifest carries no
//      android:foregroundServiceType at all, and on Android 14
//      startForeground() with an undeclared type throws natively and kills
//      the process. See KEEP_ALIVE_SERVICE.
//
// And the canary stays: a flag is written before the start and cleared once
// the process has demonstrably survived it. A flag still present at the next
// launch means the start killed us, and the service is disabled on that
// handset permanently. Worst case for somebody it does not work on is one
// crash, once — not one per launch, which is what took the call version out.
import AsyncStorage from '@react-native-async-storage/async-storage';
import notifee, {
  AndroidImportance, AndroidForegroundServiceType, AndroidVisibility,
} from '@notifee/react-native';

/** Written before a start attempt, cleared once the process has survived it. */
export const CANARY_KEY = 'keepalive-starting';
/** Set for good once a start has been shown to kill this device's app. */
export const DISABLED_KEY = 'keepalive-disabled';

/**
 * 'connection-v2', and the suffix is load-bearing.
 *
 * Android caches a channel's settings FOREVER — importance and lock-screen
 * visibility cannot be changed by the app once the channel exists. v1 was
 * created without a visibility, so it defaulted to PRIVATE and the service
 * notification appeared on the lock screen, which is where it was reported
 * from. Setting SECRET on v1 would change nothing on any phone that already
 * has it. A new id is the only way to ship a different channel, which is why
 * MESSAGES_CHANNEL carries a version too.
 */
export const CHANNEL_ID = 'connection-v2';
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
 * On, and only because the manifest now agrees with it.
 *
 * The first build carrying this crashed the app on launch. Unpacking
 * notifee's own AAR showed why:
 *
 *   <service android:name="app.notifee.core.ForegroundService"
 *            android:foregroundServiceType="shortService" />
 *
 * notifee declares shortService; this code asks for DATA_SYNC. On Android 14
 * startForeground() with an undeclared type throws
 * MissingForegroundServiceTypeException natively, after the JavaScript call
 * has returned, and the process dies. I had added the PERMISSION
 * FOREGROUND_SERVICE_DATA_SYNC and called that the fix — but the permission
 * says the app may ask, and the manifest attribute says what the service IS.
 *
 * Nor would switching this to shortService do: Android caps a shortService at
 * roughly three minutes and then kills the app. A socket that dies after
 * three minutes is not a socket being kept alive.
 *
 * So plugins/withNotifeeDataSync.js overrides the attribute in the merged
 * manifest, with tools:replace to say the override is deliberate. This
 * constant stays here so that one line switches the feature off again if the
 * device disagrees — as CALL_FOREGROUND_SERVICE does next door.
 */
export const KEEP_ALIVE_SERVICE = true;

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
export function foregroundOnly(appState: string | null | undefined): boolean {
  return appState === 'active';
}

/**
 * …and everything else that has to be true as well.
 *
 * Kept separate from foregroundOnly so the state rule stays under test while
 * the feature is switched off. A kill switch that also hides the rule it
 * guards means nothing checks the rule until somebody re-enables it, which is
 * the worst possible moment to discover it drifted.
 */
export function mayStart(o: {
  appState: string | null | undefined;
  disabled: boolean;
  running: boolean;
}): boolean {
  if (!KEEP_ALIVE_SERVICE) return false;
  if (!o) return false;
  if (o.disabled) return false;
  if (o.running) return false;
  return foregroundOnly(o.appState);
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
 * What this device's keep-alive is actually doing, in one word.
 *
 * A BLIND SPOT, and an expensive one. The phone shows "Connected — messages
 * arrive instantly while this is on", which is drawn natively and says
 * nothing about whether the service is running; and this module can disable
 * itself PERMANENTLY on a handset whose previous start killed the app, which
 * one earlier build did to everybody. A device in that state can never
 * notify from its socket again, and nothing on any screen said so — so the
 * diagnostics reported permission, channel and token as fine and the
 * notifications were unreachable for a reason nobody could see.
 *
 *   'off'      the feature is switched off in this build
 *   'blocked'  disabled on THIS device, for good, after a start killed it
 *   'running'  started and Android accepted it
 *   'idle'     allowed, but not started yet
 */
export function status(): 'off' | 'blocked' | 'running' | 'idle' {
  if (!KEEP_ALIVE_SERVICE) return 'off';
  if (disabled) return 'blocked';
  return running ? 'running' : 'idle';
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
      // OFF THE LOCK SCREEN. Asked for after a photo of it sitting on the
      // lock screen: "don't show that connected status but keep socket
      // alive". The app cannot remove it altogether — Android kills a
      // foreground service that has no notification — but SECRET keeps it out
      // of the one place it was actually in the way. MIN alone does not: it
      // governs sound and position in the shade, not lock-screen visibility,
      // which defaults to PRIVATE.
      visibility: AndroidVisibility.SECRET,
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
        // Set on the notification as well as the channel. The channel's value
        // is fixed at creation and applies to phones installing fresh; this
        // one applies now, including to anyone whose channel already exists.
        visibility: AndroidVisibility.SECRET,
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
