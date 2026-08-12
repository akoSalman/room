// ── Playback controls in the notification shade ──────────────────────────────
//
// While audio is playing and the user leaves the app, this posts an ongoing
// notification carrying the track title and Play/Pause · Next · Stop buttons,
// wired straight into audioManager.
//
// Scope, honestly: this is a NOTIFICATION-based player, not Android's
// MediaSession. It gives you the top-bar/shade controls asked for, but not the
// lock-screen media widget, Bluetooth/headset button handling, or the system
// volume "media" slider integration — those genuinely require a native media
// session (react-native-track-player or a custom module + foreground service).
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { audioManager } from './audioManager';

const CHANNEL_ID = 'media-v1';
const CATEGORY_ID = 'media_controls';
const NOTIF_ID = 'media-playback';

let started = false;
let lastKey = '';        // what we last rendered, so we don't re-post identically
let shownId: string | null = null;

export async function setup() {
  if (started || Platform.OS !== 'android') return;
  started = true;

  // A LOW-importance channel: the controls should appear silently, never buzz.
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Playback controls',
    importance: Notifications.AndroidImportance.LOW,
    sound: null,
    vibrationPattern: null,
    showBadge: false,
  }).catch(() => {});

  await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
    { identifier: 'playpause', buttonTitle: '⏯ Play/Pause', options: { opensAppToForeground: false } },
    { identifier: 'next', buttonTitle: '⏭ Next', options: { opensAppToForeground: false } },
    { identifier: 'stop', buttonTitle: '✕ Stop', options: { opensAppToForeground: false } },
  ]).catch(() => {});

  // Button taps arrive here even while the app is in the background (the JS
  // runtime stays alive because playback keeps it awake).
  Notifications.addNotificationResponseReceivedListener(res => {
    // Only react to OUR notification — the app has other listeners (calls,
    // messages) reading the same stream.
    if (res?.notification?.request?.identifier !== NOTIF_ID) return;
    const action = res.actionIdentifier;
    if (action === 'playpause') audioManager.toggle();
    else if (action === 'next') audioManager.next();
    else if (action === 'stop') audioManager.stop();
  });

  // Re-render whenever playback state changes, and whenever the app moves
  // between foreground and background.
  audioManager.subscribe(() => sync());
  // Pass the state the event carries. sync() used to read
  // AppState.currentState itself, which has NOT necessarily been updated yet
  // at the moment the change event fires — so the one call that matters, the
  // transition to background, could still read 'active', dismiss, and never
  // post the controls at all.
  AppState.addEventListener('change', (next) => sync(next));
  sync();
}

async function dismiss() {
  lastKey = '';
  if (!shownId) return;
  shownId = null;
  await Notifications.dismissNotificationAsync(NOTIF_ID).catch(() => {});
}

function sync(stateOverride?: string) {
  if (Platform.OS !== 'android') return;
  const { currentId, label, playing, queue, queueIndex } = audioManager;
  const appState = stateOverride || AppState.currentState;

  // Nothing loaded, or the user is looking at the app anyway — no notification.
  if (currentId === null || appState === 'active') { dismiss(); return; }

  const position = queue.length > 1 ? `  ·  ${queueIndex + 1}/${queue.length}` : '';
  const key = `${currentId}|${playing}|${position}`;
  if (key === lastKey) return; // already showing exactly this
  lastKey = key;
  shownId = NOTIF_ID;

  Notifications.scheduleNotificationAsync({
    identifier: NOTIF_ID,
    content: {
      title: String(label || 'Audio').replace(/^🎵\s*/, '🎵 '),
      body: (playing ? 'Playing' : 'Paused') + position,
      categoryIdentifier: CATEGORY_ID,
      data: { mediaControls: true },  // lets the app-wide handler let this through
      sticky: true,        // ongoing: can't be swiped away while playing
      autoDismiss: false,
      sound: null,
      priority: Notifications.AndroidNotificationPriority.LOW,
    },
    // A bare { channelId } is expo-notifications' CHANNEL trigger: posted
    // immediately, on our channel. The previous version passed a date 1ms out
    // to carry the channelId, which made it a DATE trigger — routed through
    // Android's alarm scheduler instead of being posted directly. An alarm
    // that close is unreliable at the best of times, and this fires exactly
    // when the app is being backgrounded, so it frequently never arrived —
    // which is why the controls kept not showing up.
    trigger: { channelId: CHANNEL_ID },
  }).catch(() => {});
}
