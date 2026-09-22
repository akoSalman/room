// ── Where nine gigabytes went ────────────────────────────────────────────────
//
// Reported as: Android's app info says 9 GB, the profile screen says half a
// gigabyte. Both numbers were honest about what they measured, and what the
// profile screen measured was one directory out of six.
//
//   documentDirectory/media/   photos, voice notes, files      COUNTED, capped
//   documentDirectory/videos/  downloaded videos               not counted, NOT capped
//   documentDirectory/covers/  extracted video frames          not counted
//   documentDirectory/outbox-* media attached to a saved draft    not counted, never deleted
//   cacheDirectory/app-update.apk  the last update installed   not counted, never deleted
//   cacheDirectory/*           picked, pasted, tuned, saved    not counted, never deleted
//
// Videos are the size of it. A cached photo is a megabyte and there is a 2 GB
// cap on the directory holding them; a downloaded video is tens or hundreds of
// megabytes, nothing ever deleted one, and nothing counted them. A year of
// chat on a phone used for chat gets to nine gigabytes without anything going
// wrong — which is the worst kind of bug, because there is nothing to see.
//
// So: one place that knows every directory this app writes to. It reports the
// real total, and it sweeps.
//
// The sweep is deliberately conservative about what it considers rubbish.
// Deleting a file somebody is about to send, or the only copy of a photo they
// saved, would be a far worse bug than the one being fixed here, so the rules
// below are separated from the filesystem and tested on their own.
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { planPrune } from './mediaCache';

/** How much video may be kept on the phone. */
export const VIDEO_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * How long a scratch file is left alone.
 *
 * These are the working files of a paste, a re-encode, a save to the gallery.
 * One being written right now is seconds old; one from yesterday belongs to an
 * operation that finished, or failed, long ago.
 */
export const TEMP_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * …and how long a STAGED file is left alone, which is not the same question.
 *
 * `outbox-` files are the media attached to a saved draft. That draft is meant
 * to survive leaving the chat — it was a bug report in its own right — so
 * sweeping one on the same schedule as a paste would delete the photo out of a
 * draft somebody left over a weekend and call it housekeeping.
 *
 * `vid-` files in the cache directory are videos downloaded by builds that
 * used that directory; they are adopted into videos/ the next time the video
 * is opened. Deleting one costs a re-download of something already fetched.
 *
 * A week: long enough that nothing in use is touched, short enough that these
 * do not accumulate for a year, which is what they have been doing.
 */
export const STAGED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Names in the cache directory this app is responsible for.
 *
 * A prefix list rather than "everything in cacheDirectory": other libraries
 * keep their own working files in there — expo's image picker, the video
 * decoder — and deleting another library's scratch file mid-use is how you
 * turn a cleanup into a crash. Only what this app named itself.
 */
export const TEMP_PREFIXES = [
  'tuned-',        // photoTune, a re-encoded copy before sending
  'paste-',        // ChatScreen, an image pasted into the composer
  'chatroom-',     // ChatScreen, a photo on its way to the gallery
];

/** Prefixes on the longer clock. See STAGED_KEEP_MS. */
export const STAGED_PREFIXES = [
  'outbox-',       // ChatScreen, an upload staged out of the picker
  'vid-',          // videoDownloads, from the builds that used the cache dir
];

/** All of this app's own names, whichever clock they are on. */
export const OWN_PREFIXES = [...TEMP_PREFIXES, ...STAGED_PREFIXES];

/**
 * Is this file the app's own rubbish, and old enough to drop?
 *
 * Both halves matter. Name alone would delete an upload being staged this
 * second; age alone would delete another library's file that happened to be
 * sitting still.
 */
export function isSweepableTemp(
  f: { name: string; modified?: number | null }, now: number,
  keepMs = TEMP_KEEP_MS, stagedKeepMs = STAGED_KEEP_MS,
): boolean {
  if (!f || !f.name) return false;
  const staged = STAGED_PREFIXES.some(p => f.name.startsWith(p));
  const temp = TEMP_PREFIXES.some(p => f.name.startsWith(p));
  if (!staged && !temp) return false;
  // An unknown modification time is NOT treated as old. getInfoAsync returns 0
  // for it on some Android versions, and `0` would date the file to 1970 and
  // sweep a file that might be in use — the one outcome worth avoiding here.
  const m = Number(f.modified);
  if (!Number.isFinite(m) || m <= 0) return false;
  return now - m >= (staged ? stagedKeepMs : keepMs);
}

/**
 * Should the downloaded update APK be deleted?
 *
 * The record says which version was downloaded. If the app is now running that
 * version or newer, the installer did its job and the file is forty megabytes
 * of nothing. If it is still older, the download is waiting to be installed —
 * the user backed out of Android's installer, which is easy to do by accident —
 * and deleting it would make them fetch it again over a connection that made
 * it worth resuming in the first place.
 */
export function updateApkIsSpent(o: {
  downloadedVersion?: number | null; currentVersion?: number | null;
}): boolean {
  const downloaded = Number(o?.downloadedVersion);
  const current = Number(o?.currentVersion);
  if (!Number.isFinite(downloaded) || downloaded <= 0) return false;
  // An unknown current version is not evidence of an install. Saying "no" here
  // keeps a file; saying "yes" costs somebody a re-download.
  if (!Number.isFinite(current) || current <= 0) return false;
  return current >= downloaded;
}

// ── The filesystem half ─────────────────────────────────────────────────────

const DOC = () => FileSystem.documentDirectory || '';
const CACHE = () => FileSystem.cacheDirectory || '';

async function sizeOfDir(dir: string): Promise<number> {
  try {
    const names = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
    let total = 0;
    for (const name of names) {
      const info: any = await FileSystem.getInfoAsync(dir + name).catch(() => null);
      if (!info?.exists) continue;
      // A directory reports no size of its own; recurse rather than count 0.
      total += info.isDirectory ? await sizeOfDir(dir + name + '/') : (info.size || 0);
    }
    return total;
  } catch { return 0; }
}

/**
 * Everything this app is holding, in bytes.
 *
 * What the profile screen should have been showing all along. It will not
 * match Android's app info exactly — that figure includes the installed APK,
 * the WebView's own store and the database — but it accounts for the part
 * that grows, which is the part a person can do something about.
 */
export async function usage(): Promise<number> {
  const [doc, cache] = await Promise.all([sizeOfDir(DOC()), cacheOwnUsage()]);
  return doc + cache;
}

/** Only the cache files this app named. See TEMP_PREFIXES. */
async function cacheOwnUsage(): Promise<number> {
  try {
    const names = await FileSystem.readDirectoryAsync(CACHE()).catch(() => [] as string[]);
    let total = 0;
    for (const name of names) {
      if (!OWN_PREFIXES.some(p => name.startsWith(p)) && name !== 'app-update.apk') continue;
      const info: any = await FileSystem.getInfoAsync(CACHE() + name).catch(() => null);
      if (info?.exists) total += info.size || 0;
    }
    return total;
  } catch { return 0; }
}

/** The video directory alone, so a cap can be applied to it. */
export async function videoUsage(): Promise<number> {
  return sizeOfDir(DOC() + 'videos/');
}

/**
 * Delete the update APK once the version it holds is installed.
 *
 * Called at start-up, where the running version is known for certain — the
 * install cannot report its own success, because a successful install replaces
 * the process that would have done the reporting.
 */
export async function sweepUpdateApk(currentVersion: number): Promise<number> {
  let freed = 0;
  try {
    const raw = await AsyncStorage.getItem('appUpdateDownloaded');
    const rec = raw ? JSON.parse(raw) : null;
    const spent = updateApkIsSpent({
      downloadedVersion: rec?.version, currentVersion,
    });
    // No record at all still means a stale APK may be sitting in the cache
    // from a build that predates the record, so the file is checked either
    // way — but it is only deleted when nothing is waiting to be installed.
    if (rec && !spent) return 0;
    const path = CACHE() + 'app-update.apk';
    const info: any = await FileSystem.getInfoAsync(path).catch(() => null);
    if (info?.exists) {
      freed = info.size || 0;
      await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
    }
    if (rec) await AsyncStorage.removeItem('appUpdateDownloaded').catch(() => {});
  } catch {}
  return freed;
}

/** Delete this app's own stale temporary files. */
export async function sweepTemp(now = Date.now()): Promise<number> {
  let freed = 0;
  for (const dir of [CACHE(), DOC()]) {
    try {
      const names = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
      for (const name of names) {
        const info: any = await FileSystem.getInfoAsync(dir + name).catch(() => null);
        if (!info?.exists || info.isDirectory) continue;
        const modified = info.modificationTime ? info.modificationTime * 1000 : 0;
        if (!isSweepableTemp({ name, modified }, now)) continue;
        freed += info.size || 0;
        await FileSystem.deleteAsync(dir + name, { idempotent: true }).catch(() => {});
      }
    } catch {}
  }
  return freed;
}

/**
 * Bring the video directory under its cap, least recently modified first.
 *
 * Videos had no cap at all, which is most of the nine gigabytes. The same
 * planner as the media cache, because the decision is the same one and it is
 * already tested.
 */
export async function pruneVideos(maxBytes = VIDEO_MAX_BYTES): Promise<number> {
  const dir = DOC() + 'videos/';
  let freed = 0;
  try {
    const names = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
    const files: { name: string; size: number; modified: number }[] = [];
    for (const name of names) {
      const info: any = await FileSystem.getInfoAsync(dir + name).catch(() => null);
      if (info?.exists && !info.isDirectory) {
        files.push({
          name, size: info.size || 0,
          modified: (info.modificationTime || 0) * 1000,
        });
      }
    }
    const doomed = new Set(planPrune(files, maxBytes));
    for (const f of files) {
      if (!doomed.has(f.name)) continue;
      freed += f.size;
      await FileSystem.deleteAsync(dir + f.name, { idempotent: true }).catch(() => {});
    }
  } catch {}
  return freed;
}

/**
 * The whole sweep, for app start-up.
 *
 * Every part is independent and every part swallows its own failures: this
 * runs on the path to the user's chats, and housekeeping must never be the
 * reason the app does not open.
 */
export async function sweep(currentVersion: number): Promise<number> {
  const results = await Promise.all([
    sweepUpdateApk(currentVersion).catch(() => 0),
    sweepTemp().catch(() => 0),
    pruneVideos().catch(() => 0),
  ]);
  return results.reduce((a, b) => a + b, 0);
}

/**
 * Everything this app is holding, gone — for the "Clear" button.
 *
 * Deliberately NOT a call to mediaCache.clear() alone, which is what that
 * button used to do: it emptied one directory out of six while the number
 * beside it counted all six, so a person with nine gigabytes of video tapped
 * Clear, watched the figure barely move, and reasonably concluded the button
 * was broken.
 *
 * Drafts survive. An `outbox-` file is the photo attached to a message
 * somebody has written and not yet sent, and losing that to a button labelled
 * "clear downloaded media" would be indefensible.
 */
export async function clearAll(): Promise<void> {
  for (const dir of ['media/', 'videos/', 'covers/']) {
    await FileSystem.deleteAsync(DOC() + dir, { idempotent: true }).catch(() => {});
  }
  try {
    const names = await FileSystem.readDirectoryAsync(CACHE()).catch(() => [] as string[]);
    for (const name of names) {
      const own = OWN_PREFIXES.some(p => name.startsWith(p)) || name === 'app-update.apk';
      // The one exception, and the reason this is not a loop over OWN_PREFIXES:
      // a staged draft is not downloaded media.
      if (!own || name.startsWith('outbox-')) continue;
      await FileSystem.deleteAsync(CACHE() + name, { idempotent: true }).catch(() => {});
    }
  } catch {}
}
