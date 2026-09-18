// ── Video downloads ──────────────────────────────────────────────────────────
//
// Kept at module scope rather than in a component: a download must survive
// scrolling the bubble off screen, opening another chat, and coming back.
// Screens subscribe and read the state; they never own it.
import * as FileSystem from 'expo-file-system';
import { localNameFor } from './download';
// The SAME throttle rule the gallery save uses, imported rather than copied:
// the interval is a judgement about the JavaScript thread, not about either
// feature, and two of them would drift.
import { dueForEmit } from './saveProgress';

export type DownloadState = {
  /** Bytes written so far. */
  written: number;
  /** Total size, 0 until the server tells us. */
  total: number;
  status: 'downloading' | 'done' | 'failed';
  /** Where the finished file lives. */
  uri?: string;
};

const state = new Map<string, DownloadState>();
const tasks = new Map<string, FileSystem.DownloadResumable>();
const listeners = new Set<() => void>();
// Sizes are fetched at most once per file: a HEAD per bubble per render would
// be a lot of requests for a number that never changes.
const sizes = new Map<string, number>();
// When each download last redrew. Per key, so two downloads at once do not
// take turns being starved by each other's clock.
const lastEmitAt = new Map<string, number>();

function emit() { listeners.forEach(f => f()); }

/**
 * Progress reaching the screen, rationed.
 *
 * Reported as: while downloading a video, every other action in the app is
 * blocked. It was fixed once — in saveProgress, which is the gallery save, and
 * is not this. This is the path the play button uses, and it was still calling
 * every subscriber on every chunk.
 *
 * createDownloadResumable fires its callback once per network chunk, hundreds
 * of times a second on a large file. Each one re-rendered every video bubble
 * subscribed to this module, so the JavaScript thread spent itself redrawing a
 * progress bar and had nothing left for taps. The bytes arrived perfectly; the
 * app just could not answer.
 *
 * The state is still written on every single callback — only the redraw is
 * rationed — so get() is never stale and the value a screen reads is the truth
 * at that instant.
 */
function emitProgress(key: string, complete: boolean) {
  const now = Date.now();
  // The last chunk always draws, or the bar can stop at 97% and stay there.
  if (!complete && !dueForEmit(lastEmitAt.get(key) || 0, now)) return;
  lastEmitAt.set(key, now);
  emit();
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Cache key: the URL's path, so an expiring signature does not change it. */
export function keyFor(url: string): string {
  return localNameFor(url, 'vid-');
}

// documentDirectory, not cacheDirectory.
//
// Reported as: a downloaded video downloads again on every next open. It was
// being written to the cache directory, which Android empties whenever the
// device is short of space — and on a phone with a full gallery that is most
// of the time. The file was genuinely gone, so the bubble was right to offer
// the download again; it just should never have been somewhere the OS could
// take it away. The image cache next door already knew this and says so in a
// comment; the video downloads did not.
const DIR = FileSystem.documentDirectory + 'videos/';
let dirReady: Promise<any> | null = null;

function ensureDir(): Promise<any> {
  if (!dirReady) {
    dirReady = FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  }
  return dirReady;
}

function pathFor(url: string): string {
  return `${DIR}${keyFor(url)}`;
}

/** Where the old builds put it, so a file already on the device is adopted. */
function legacyPathFor(url: string): string {
  return `${FileSystem.cacheDirectory}${keyFor(url)}`;
}

export function get(url: string): DownloadState | null {
  return state.get(keyFor(url)) || null;
}

/** The local copy if there is one, otherwise null. Checks disk on first ask. */
export async function localUri(url: string): Promise<string | null> {
  const key = keyFor(url);
  const known = state.get(key);
  if (known?.status === 'done' && known.uri) return known.uri;
  const path = pathFor(url);
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists && (info as any).size > 0) {
      // A file left over from a previous run is still a finished download.
      state.set(key, { written: (info as any).size, total: (info as any).size, status: 'done', uri: path });
      emit();
      return path;
    }
  } catch {}
  // Downloaded by a build that still used the cache directory, and not yet
  // reclaimed. Move it rather than fetching it again.
  try {
    const old = legacyPathFor(url);
    const info = await FileSystem.getInfoAsync(old);
    if (info.exists && (info as any).size > 0) {
      await ensureDir();
      await FileSystem.moveAsync({ from: old, to: path });
      state.set(key, { written: (info as any).size, total: (info as any).size, status: 'done', uri: path });
      emit();
      return path;
    }
  } catch {}
  return null;
}

/** Content-Length, cached. Returns 0 when the server does not say. */
export async function sizeOf(url: string): Promise<number> {
  const key = keyFor(url);
  if (sizes.has(key)) return sizes.get(key)!;
  try {
    const r = await fetch(url, { method: 'HEAD' });
    const len = parseInt(r.headers.get('content-length') || '0', 10);
    const n = len > 0 ? len : 0;
    sizes.set(key, n);
    return n;
  } catch {
    return 0;
  }
}

export async function start(url: string): Promise<string | null> {
  const key = keyFor(url);
  const existing = state.get(key);
  if (existing?.status === 'downloading') return null;

  const already = await localUri(url);
  if (already) return already;

  const total = await sizeOf(url);
  // The directory has to exist before the download names a file inside it.
  await ensureDir();
  state.set(key, { written: 0, total, status: 'downloading' });
  lastEmitAt.delete(key);
  emit();

  const task = FileSystem.createDownloadResumable(
    url,
    pathFor(url),
    {},
    (p) => {
      const cur = state.get(key);
      if (!cur || cur.status !== 'downloading') return;
      // The callback's total is authoritative when HEAD said nothing.
      const known = cur.total || p.totalBytesExpectedToWrite || 0;
      state.set(key, { ...cur, written: p.totalBytesWritten, total: known });
      emitProgress(key, known > 0 && p.totalBytesWritten >= known);
    },
  );
  tasks.set(key, task);

  try {
    const res = await task.downloadAsync();
    tasks.delete(key);
    if (!res?.uri) throw new Error('no file');
    const cur = state.get(key);
    state.set(key, { written: cur?.written || 0, total: cur?.total || 0, status: 'done', uri: res.uri });
    lastEmitAt.delete(key);
    emit();
    return res.uri;
  } catch {
    tasks.delete(key);
    // A cancel lands here too; cancel() has already cleared the state, so only
    // a real failure is recorded.
    if (state.get(key)?.status === 'downloading') {
      state.set(key, { ...(state.get(key) as DownloadState), status: 'failed' });
      emit();
    }
    return null;
  }
}

export async function cancel(url: string) {
  const key = keyFor(url);
  const task = tasks.get(key);
  state.delete(key);
  tasks.delete(key);
  lastEmitAt.delete(key);
  emit();
  try { await task?.cancelAsync(); } catch {}
  // Leave no half-written file behind to be mistaken for a finished download.
  try { await FileSystem.deleteAsync(pathFor(url), { idempotent: true }); } catch {}
}

export async function remove(url: string) {
  const key = keyFor(url);
  state.delete(key);
  emit();
  try { await FileSystem.deleteAsync(pathFor(url), { idempotent: true }); } catch {}
}
