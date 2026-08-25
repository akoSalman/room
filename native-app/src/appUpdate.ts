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
import * as connection from './connection';
import {
  DownloadPhase, phaseOnNetworkChange, shouldAutoResume, snapshotMatches, canContinue,
} from './updateResume';
// Re-exported so callers have one place to look.
export { installChoice, UpdateChoice } from './updateChoice';

const RESUME_KEY = 'appUpdateResume';
/** A download that finished but was never installed. */
const DOWNLOADED_KEY = 'appUpdateDownloaded';
const CHANNEL = 'updates-v1';
const NOTIFICATION_ID = 'app-update';

export type UpdateState = {
  progress: number;          // 0..1
  /**
   * 'paused' is the one that matters here.
   *
   * Losing the connection is not a failure: the bytes on disk are fine and the
   * download is going to carry on by itself. Calling it a failure is what
   * invited people to start a forty-megabyte download again from zero.
   */
  status: DownloadPhase;
  uri?: string;
  /** Whether resuming will really continue, or start over. See updateResume. */
  continues?: boolean;
};

let state: UpdateState = { progress: 0, status: 'idle' };
let task: FileSystem.DownloadResumable | null = null;
const listeners = new Set<() => void>();
/** What is being downloaded, so the watcher can resume it without being told. */
let currentUrl: string | null = null;
let currentVersion: number | undefined;
let watching = false;

/**
 * Pause the moment the connection goes, resume the moment it returns.
 *
 * The pause is the whole point: expo's `savable()` only carries `resumeData`
 * if the task was PAUSED, so a download that merely died of a network error
 * left a snapshot that restarts at byte zero. Pausing while the task is still
 * alive is what makes the snapshot worth having.
 */
function watchConnection() {
  if (watching) return;
  watching = true;
  connection.subscribe(async (net) => {
    const online = net === 'online';
    const next = phaseOnNetworkChange(state.status, online);
    if (next === state.status) return;

    if (next === 'paused') {
      const t = task;
      task = null;
      try {
        await t?.pauseAsync();
        const snapshot = await t?.savable();
        if (snapshot) await AsyncStorage.setItem(RESUME_KEY, JSON.stringify(snapshot));
        state = { ...state, status: 'paused', continues: canContinue(snapshot as any) };
      } catch {
        state = { ...state, status: 'paused', continues: false };
      }
      emit();
      return;
    }

    if (shouldAutoResume({
      phase: state.status, online, hasSnapshot: !!(await AsyncStorage.getItem(RESUME_KEY)),
    }) && currentUrl) {
      // Straight back to work, without asking. Somebody who tapped Update once
      // has said what they want; a connection coming back is not a new
      // decision for them to make.
      start(currentUrl, currentVersion).catch(() => {});
    }
  });
}

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
 * A finished download waiting to be installed, if the file is still there.
 *
 * The cache directory is the OS's to reclaim, so the record is only trusted
 * when the file it names actually exists — otherwise the button would offer to
 * install something that had been swept away.
 */
export async function downloaded(): Promise<{ version: number; uri: string } | null> {
  if (Platform.OS !== 'android') return null;
  try {
    const raw = await AsyncStorage.getItem(DOWNLOADED_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (typeof rec?.version !== 'number' || typeof rec?.uri !== 'string') return null;
    const info = await FileSystem.getInfoAsync(rec.uri);
    if (!info.exists || !info.size) { await forgetDownloaded(); return null; }
    return rec;
  } catch { return null; }
}

/** Drop the record — after a successful install, or when it is superseded. */
export async function forgetDownloaded(): Promise<void> {
  try { await AsyncStorage.removeItem(DOWNLOADED_KEY); } catch {}
}

/**
 * Start (or resume) the download. Safe to call twice — the second call is a
 * no-op while one is running.
 *
 * `version` is what is being downloaded, remembered so that a download the user
 * never installed can be offered as Install rather than downloaded again.
 */
export async function start(url: string, version?: number): Promise<void> {
  if (state.status === 'downloading') return;
  currentUrl = url;
  currentVersion = version;
  watchConnection();
  // The progress already made is kept: this may be a resume, and zeroing the
  // bar here is what made a continuing download look like a fresh one.
  state = { ...state, progress: state.status === 'paused' ? state.progress : 0, status: 'downloading' };
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
        if (snapshotMatches(snapshot, url)) {
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
    // Remembered BEFORE the installer is opened, because the user may well
    // back out of it — and that is exactly the case this record exists for.
    if (typeof version === 'number') {
      try {
        await AsyncStorage.setItem(DOWNLOADED_KEY, JSON.stringify({ version, uri: res.uri }));
      } catch {}
    }
    await install(res.uri);
  } catch {
    // Keep enough to resume: an interrupted 40 MB download should not start
    // again from zero next time.
    let snapshot: any = null;
    try {
      snapshot = await task?.savable();
      if (snapshot) await AsyncStorage.setItem(RESUME_KEY, JSON.stringify(snapshot));
    } catch {}
    task = null;
    await clearNotification();
    // Offline is a PAUSE, not a failure — even when it arrived as an error,
    // because the watcher may not have seen the drop before the socket did.
    // The difference is whether the user is asked to do something: a pause
    // continues on its own, a failure waits for a tap.
    state = connection.isOnline()
      ? { ...state, status: 'failed', continues: canContinue(snapshot) }
      : { ...state, status: 'paused', continues: canContinue(snapshot) };
    emit();
  }
}

export async function cancel() {
  const t = task;
  task = null;
  currentUrl = null;
  currentVersion = undefined;
  state = { progress: 0, status: 'idle' };
  emit();
  try { await t?.cancelAsync(); } catch {}
  await AsyncStorage.removeItem(RESUME_KEY);
  await clearNotification();
  await forgetDownloaded();
  try { await FileSystem.deleteAsync(dest(), { idempotent: true }); } catch {}
}

/** True when a previous run left something worth resuming. */
export async function hasResumable(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  return !!(await AsyncStorage.getItem(RESUME_KEY).catch(() => null));
}
