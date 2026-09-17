// ── Holding the chat connection open while the app is away ───────────────────
//
// The mechanism behind stayConnected.ts. Why it exists, why a foreground
// service is the only thing that works here, and why this one is allowed to
// exist when ongoingCall.ts's is not, are all written out there; this file is
// the moving parts.
//
// The short version: the notification is raised off the app's own socket the
// moment a message lands, which is minutes faster than FCM for these users —
// but only while that socket is alive, and in the background Android suspends
// it. A foreground service is what stops that, and the canary is what makes
// starting one safe on a handset where it might not be allowed.
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import notifee, {
  AndroidCategory, AndroidForegroundServiceType, AndroidImportance, AndroidVisibility,
} from '@notifee/react-native';
import * as stay from './stayConnected';

let running = false;
let allowed: boolean | null = null;

/**
 * The channel this lives on.
 *
 * MIN importance, no sound, no vibration, no badge. This notification is rent
 * paid to Android for the right to keep a socket open — it announces nothing
 * and must never make a noise. On Android 8+ a foreground service always shows
 * something; the most that can be done is to make it as quiet and as far down
 * the shade as the system allows.
 */
async function ensureChannel(): Promise<void> {
  await notifee.createChannel({
    id: stay.SERVICE_CHANNEL,
    name: 'Background connection',
    description: 'Keeps the app connected so messages arrive immediately.',
    importance: AndroidImportance.MIN,
    sound: undefined,
    vibration: false,
    badge: false,
    visibility: AndroidVisibility.SECRET,
  });
}

/**
 * Has a previous launch already proved this device cannot run the service?
 *
 * Read once and cached: it is consulted on every AppState change, and this is
 * a decision about the handset, not about the moment.
 */
async function isAllowed(): Promise<boolean> {
  if (allowed !== null) return allowed;
  let canaryPending = false;
  let previouslyDisabled = false;
  try {
    canaryPending = !!(await AsyncStorage.getItem(stay.CANARY_KEY));
    previouslyDisabled = !!(await AsyncStorage.getItem(stay.DISABLED_KEY));
  } catch {}
  // THE CANARY HAS FIRED. The last launch wrote "about to start the service"
  // and never lived to clear it, which means the start killed the process.
  // Nothing in JavaScript could catch that when it happened; this is the
  // catch, one launch late. It is recorded permanently so the device never
  // tries again, and the flag is cleared so a later launch does not read the
  // same death twice.
  if (canaryPending) {
    try {
      await AsyncStorage.setItem(stay.DISABLED_KEY, '1');
      await AsyncStorage.removeItem(stay.CANARY_KEY);
    } catch {}
    previouslyDisabled = true;
  }
  allowed = stay.serviceAllowed({
    canaryPending: false, previouslyDisabled, platform: Platform.OS,
  });
  return allowed;
}

/**
 * Start the service, if this device has not already proved it cannot.
 *
 * The canary is written BEFORE the call and cleared after. Everything between
 * those two lines is the window in which Android may kill the process without
 * giving JavaScript a chance to react.
 */
export async function start(): Promise<void> {
  if (running || Platform.OS !== 'android') return;
  if (!(await isAllowed())) return;
  running = true;
  try {
    await ensureChannel();
    // The canary. If the next statement takes the process down, this is what
    // is still here at the next launch.
    await AsyncStorage.setItem(stay.CANARY_KEY, String(Date.now()));
    await notifee.displayNotification({
      id: stay.SERVICE_ID,
      title: stay.SERVICE_TITLE,
      body: stay.SERVICE_BODY,
      android: {
        channelId: stay.SERVICE_CHANNEL,
        asForegroundService: true,
        // DATA_SYNC only. The types that were implicated in the crash this
        // design works around — PHONE_CALL, MICROPHONE, CAMERA — each require
        // a permission Android checks as the service starts. This one is a
        // normal permission, granted at install from the manifest, so there is
        // nothing for the system to refuse at runtime.
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
        category: AndroidCategory.SERVICE,
        ongoing: true,
        onlyAlertOnce: true,
        showTimestamp: false,
        // Tapping it opens the app rather than doing nothing.
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
    // Survived. Whatever happens from here, it was not the start that did it.
    await AsyncStorage.removeItem(stay.CANARY_KEY);
  } catch {
    // A refusal this side of the native boundary — the channel, storage, a
    // notifee error. Not the uncatchable kind, so the canary is cleared: this
    // device has not proved anything and may try again next time.
    running = false;
    try { await AsyncStorage.removeItem(stay.CANARY_KEY); } catch {}
  }
}

/** Take the service down. Safe to call when it is not running. */
export async function stop(): Promise<void> {
  if (!running) return;
  running = false;
  try { await notifee.stopForegroundService(); } catch {}
  try { await notifee.cancelNotification(stay.SERVICE_ID); } catch {}
}

/**
 * Follow the app in and out of the background.
 *
 * Returns its own unsubscribe, and is safe to call more than once only in the
 * sense that the caller must not: one subscription, owned by App.tsx.
 */
export function watchAppState(signedIn: () => boolean): () => void {
  const apply = async (state: string) => {
    const want = stay.shouldRunService({
      allowed: await isAllowed(), signedIn: signedIn(), appState: state,
    });
    if (want) await start(); else await stop();
  };
  const sub = AppState.addEventListener('change', st => { apply(String(st)).catch(() => {}); });
  // The app may already be in the background by the time this runs.
  apply(String(AppState.currentState)).catch(() => {});
  return () => {
    sub.remove();
    stop().catch(() => {});
  };
}

/** For the settings screen, and for tests: has this device given up on it? */
export async function disabledOnThisDevice(): Promise<boolean> {
  return !(await isAllowed());
}
