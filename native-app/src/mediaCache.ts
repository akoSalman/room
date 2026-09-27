// ── Keeping media on the phone after the first download ──────────────────────
//
// Photos, thumbnails, voice notes, music and files were fetched again every
// single time they came back on screen. For users on slow or metered
// connections that is the difference between a chat that opens instantly and
// one that reloads its whole history over the network.
//
// Two things had to be true for a cache to work at all:
//
//  1. The URL has to stay the same. Media URLs are HMAC-signed and used to
//     carry `now + TTL` as their expiry, so the same file arrived under a
//     different URL on every fetch and nothing could ever hit. That is fixed
//     on the server (see signPath), and here the key drops the query string
//     anyway, so even a re-signed link maps to the same local file.
//  2. Something has to keep the bytes. Relying on the platform's own image
//     cache covers images only, and evicts on its own terms — voice notes and
//     documents were never covered at all.
//
// So: one download per file, kept on disk, shared by every screen.
import * as FileSystem from 'expo-file-system';
import { localNameFor } from './download';
import { mediaHeaders } from './mediaSource';

// documentDirectory, not cacheDirectory: Android empties the cache directory
// whenever the device is short of space, which would silently undo the whole
// point of keeping media. This is storage the OS does not reclaim behind our
// back, so what has been downloaded stays downloaded.
const DIR = FileSystem.documentDirectory + 'media/';

/**
 * How much media may be kept. Nothing expires on a timer — a file is only
 * evicted when the cache is over this, and then the least recently used goes
 * first, so the photos and voice notes someone actually revisits survive and
 * the ones they opened once a year ago are what make room.
 */
export const MAX_BYTES = 2 * 1024 * 1024 * 1024;

// url-key -> local uri. Only holds files confirmed to exist on disk.
const have = new Map<string, string>();
// url-key -> the download in flight, so ten bubbles asking at once fetch once.
const inFlight = new Map<string, Promise<string | null>>();
let dirReady: Promise<void> | null = null;

export function keyFor(url: string): string {
  return localNameFor(url, 'md-');
}

function pathFor(url: string): string {
  return DIR + keyFor(url);
}

async function ensureDir() {
  if (!dirReady) {
    dirReady = FileSystem.makeDirectoryAsync(DIR, { intermediates: true })
      .catch(() => {});   // already there
  }
  return dirReady;
}

/** Only cache what we serve ourselves; a data: or file: uri is already local. */
function cacheable(url: string): boolean {
  return /^https?:\/\//i.test(url || '');
}

// Last time each file was actually used, so eviction can be least-recently-USED
// rather than oldest-downloaded. A photo from last year that is opened weekly
// should outlive one downloaded yesterday and never looked at again.
const usedAt = new Map<string, number>();

/** The local copy, if we already have one. Never downloads. */
export async function peek(url: string): Promise<string | null> {
  if (!cacheable(url)) return null;
  const key = keyFor(url);
  const known = have.get(key);
  if (known) { usedAt.set(key, Date.now()); return known; }
  try {
    const info = await FileSystem.getInfoAsync(pathFor(url));
    if (info.exists && (info as any).size > 0) {
      have.set(key, info.uri);
      usedAt.set(key, Date.now());
      return info.uri;
    }
  } catch {}
  return null;
}

/**
 * Fetch and keep the file, returning where it landed.
 *
 * Downloads to a temporary name and moves it into place, so an interrupted
 * download can never be picked up later as a complete file — a half-written
 * photo that never repairs itself is worse than no cache at all.
 */
export async function fetchAndKeep(url: string): Promise<string | null> {
  if (!cacheable(url)) return null;
  const key = keyFor(url);
  const already = await peek(url);
  if (already) return already;

  const running = inFlight.get(key);
  if (running) return running;

  const job = (async () => {
    await ensureDir();
    const tmp = `${DIR}tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const res = await FileSystem.downloadAsync(url, tmp,
        { headers: mediaHeaders(url) });
      if (!res?.uri || (res.status && res.status >= 400)) throw new Error(`bad status ${res?.status}`);
      const info = await FileSystem.getInfoAsync(res.uri);
      if (!info.exists || !(info as any).size) throw new Error('empty');
      await FileSystem.moveAsync({ from: res.uri, to: pathFor(url) });
      const final = pathFor(url);
      have.set(key, final);
      usedAt.set(key, Date.now());
      return final;
    } catch {
      try { await FileSystem.deleteAsync(tmp, { idempotent: true }); } catch {}
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, job);
  return job;
}

/**
 * What a view should display right now.
 *
 * Returns the local copy when there is one. Otherwise it returns the remote
 * URL so nothing is delayed, and pulls the file down in the background so the
 * NEXT time is free. Showing a spinner while we populate a cache would trade
 * the user's time for the cache's convenience.
 */
export async function resolve(url: string): Promise<string> {
  if (!cacheable(url)) return url;
  const local = await peek(url);
  if (local) return local;
  fetchAndKeep(url).catch(() => {});
  return url;
}

/** Which files to delete to get back under the cap: oldest first. */
export function planPrune(
  files: { name: string; size: number; modified: number }[], maxBytes: number,
): string[] {
  const total = files.reduce((a, f) => a + (f.size || 0), 0);
  if (total <= maxBytes) return [];
  // Oldest goes first — the least likely to be looked at again.
  const oldestFirst = [...files].sort((a, b) => a.modified - b.modified);
  const doomed: string[] = [];
  let freed = 0;
  for (const f of oldestFirst) {
    if (total - freed <= maxBytes) break;
    doomed.push(f.name);
    freed += f.size || 0;
  }
  return doomed;
}

/** Bring the cache back under its cap. Cheap enough to run at app start. */
export async function prune(maxBytes = MAX_BYTES) {
  try {
    const names = await FileSystem.readDirectoryAsync(DIR).catch(() => [] as string[]);
    const files = [];
    for (const name of names) {
      const info: any = await FileSystem.getInfoAsync(DIR + name);
      if (info?.exists) {
        files.push({
          name,
          size: info.size || 0,
          // A recent use beats the file's age on disk.
          modified: usedAt.get(name) || (info.modificationTime || 0) * 1000,
        });
      }
    }
    for (const name of planPrune(files, maxBytes)) {
      have.delete(name);
      usedAt.delete(name);
      await FileSystem.deleteAsync(DIR + name, { idempotent: true }).catch(() => {});
    }
  } catch {}
}

/**
 * Forget one file.
 *
 * Called when the message it belongs to is destroyed: a disappearing photo
 * must not survive on disk just because it was once on screen.
 */
export async function forget(url: string) {
  const key = keyFor(url);
  have.delete(key);
  usedAt.delete(key);
  try { await FileSystem.deleteAsync(DIR + key, { idempotent: true }); } catch {}
}

/** Bytes currently held, for showing the user what this costs them. */
export async function usage(): Promise<number> {
  try {
    const names = await FileSystem.readDirectoryAsync(DIR).catch(() => [] as string[]);
    let total = 0;
    for (const name of names) {
      const info: any = await FileSystem.getInfoAsync(DIR + name);
      if (info?.exists) total += info.size || 0;
    }
    return total;
  } catch {
    return 0;
  }
}

/** Everything, gone — for a "clear cache" action. */
export async function clear() {
  have.clear();
  try { await FileSystem.deleteAsync(DIR, { idempotent: true }); } catch {}
  dirReady = null;
}
