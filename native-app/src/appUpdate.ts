// ── Downloading an app update ────────────────────────────────────────────────
//
// At MODULE scope on purpose. This used to live inside the profile screen, so
// closing that screen unmounted the component and the download went with it —
// tapping Update and then navigating away meant starting over.
//
// Now the download owns itself: leaving the screen, or backgrounding the app,
// does not touch it. Progress shows in the notification shade so it is visible
// with the app closed, and a partly-finished download is RESUMED on next
// launch rather than restarted, because an APK is tens of megabytes and these
// users are not on generous connections.
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';
import notifee, { AndroidImportance } from '@notifee/react-native';

const RESUME_KEY = 'appUpdateResume';
const CHANNEL = 'updates-v1';
const NOTIFICATION_ID = 'app-update';

export type UpdateState = {
  progress: number;          // 0..1
  status: 'downloading' | 'done' | 'failed' | 'idle';
  uri?: string;
};

let state: UpdateState = { progress: 0, status: 'idle' };
let task: FileSystem.DownloadResumable | null = null;
const listeners = new Set<() => void>();

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function emit() { listeners.forEach(f => f()); }
export function current(): UpdateState { return state; }

function dest() { return FileSystem.cacheDirectory + 'app-update.apk'; }

async function notify(progress: number) {
  try {
    await notifee.createChannel({
      id: CHANNEL, name: 'App updates', importance: AndroidImportance.LOW, vibration: false,
    });
    await notifee.displayNotification({
      id: NOTIFICATION_ID,
      title: 'Downloading update',
      body: `${Math.round(progress * 100)}%`,
      android: {
        channelId: CHANNEL,
        importance: AndroidImportance.LOW,
        onlyAlertOnce: true,
        ongoing: true,
        autoCancel: false,
        // A real bar in the shade, not just a percentage in text.
        progress: { max: 100, current: Math.round(progress * 100) },
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
  } catch {}
}

async function clearNotification() {
  try { await notifee.cancelNotification(NOTIFICATION_ID); } catch {}
}

/** Hand the finished file to Android's package installer. */
export async function install(uri: string) {
  const contentUri = await FileSystem.getContentUriAsync(uri);
  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
  });
}

/**
 * Start (or resume) the download. Safe to call twice — the second call is a
 * no-op while one is running.
 */
export async function start(url: string): Promise<void> {
  if (state.status === 'downloading') return;
  state = { progress: 0, status: 'downloading' };
  emit();

  const onProgress = (p: FileSystem.DownloadProgressData) => {
    if (p.totalBytesExpectedToWrite > 0) {
      state = { ...state, progress: p.totalBytesWritten / p.totalBytesExpectedToWrite };
      emit();
      // The shade is updated less often than the UI: a notification per frame
      // is throttled by Android anyway and just burns battery.
      if (Math.round(state.progress * 100) % 5 === 0) notify(state.progress);
    }
  };

  try {
    // Resume a previous attempt when one was interrupted.
    const saved = await AsyncStorage.getItem(RESUME_KEY);
    if (saved) {
      try {
        const snapshot = JSON.parse(saved);
        if (snapshot?.url === url) {
          task = new FileSystem.DownloadResumable(
            snapshot.url, snapshot.fileUri, snapshot.options, onProgress, snapshot.resumeData,
          );
        }
      } catch {}
    }
    if (!task) task = FileSystem.createDownloadResumable(url, dest(), {}, onProgress);

    await notify(0);
    const res = await (task.resumeAsync ? task.resumeAsync() : task.downloadAsync());
    await AsyncStorage.removeItem(RESUME_KEY);
    task = null;
    await clearNotification();

    if (!res?.uri) throw new Error('no file');
    state = { progress: 1, status: 'done', uri: res.uri };
    emit();
    await install(res.uri);
  } catch {
    // Keep enough to resume: an interrupted 40 MB download should not start
    // again from zero next time.
    try {
      const snapshot = await task?.savable();
      if (snapshot) await AsyncStorage.setItem(RESUME_KEY, JSON.stringify(snapshot));
    } catch {}
    task = null;
    await clearNotification();
    state = { ...state, status: 'failed' };
    emit();
  }
}

export async function cancel() {
  const t = task;
  task = null;
  state = { progress: 0, status: 'idle' };
  emit();
  try { await t?.cancelAsync(); } catch {}
  await AsyncStorage.removeItem(RESUME_KEY);
  await clearNotification();
  try { await FileSystem.deleteAsync(dest(), { idempotent: true }); } catch {}
}

/** True when a previous run left something worth resuming. */
export async function hasResumable(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  return !!(await AsyncStorage.getItem(RESUME_KEY).catch(() => null));
}
