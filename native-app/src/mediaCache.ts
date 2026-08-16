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

const DIR = FileSystem.cacheDirectory + 'media/';

/** Roughly how much of the phone's storage this may hold. */
export const MAX_BYTES = 400 * 1024 * 1024;

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

/** The local copy, if we already have one. Never downloads. */
export async function peek(url: string): Promise<string | null> {
  if (!cacheable(url)) return null;
  const key = keyFor(url);
  const known = have.get(key);
  if (known) return known;
  try {
    const info = await FileSystem.getInfoAsync(pathFor(url));
    if (info.exists && (info as any).size > 0) {
      have.set(key, info.uri);
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
      const res = await FileSystem.downloadAsync(url, tmp);
      if (!res?.uri || (res.status && res.status >= 400)) throw new Error(`bad status ${res?.status}`);
      const info = await FileSystem.getInfoAsync(res.uri);
      if (!info.exists || !(info as any).size) throw new Error('empty');
      await FileSystem.moveAsync({ from: res.uri, to: pathFor(url) });
      const final = pathFor(url);
      have.set(key, final);
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
      if (info?.exists) files.push({ name, size: info.size || 0, modified: info.modificationTime || 0 });
    }
    for (const name of planPrune(files, maxBytes)) {
      have.delete(name);
      await FileSystem.deleteAsync(DIR + name, { idempotent: true }).catch(() => {});
    }
  } catch {}
}

/** Everything, gone — for a "clear cache" action. */
export async function clear() {
  have.clear();
  try { await FileSystem.deleteAsync(DIR, { idempotent: true }); } catch {}
  dirReady = null;
}
