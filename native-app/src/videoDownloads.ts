// ── Video downloads ──────────────────────────────────────────────────────────
//
// Kept at module scope rather than in a component: a download must survive
// scrolling the bubble off screen, opening another chat, and coming back.
// Screens subscribe and read the state; they never own it.
import * as FileSystem from 'expo-file-system';
import { localNameFor } from './download';

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

function emit() { listeners.forEach(f => f()); }

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Cache key: the URL's path, so an expiring signature does not change it. */
export function keyFor(url: string): string {
  return localNameFor(url, 'vid-');
}

function pathFor(url: string): string {
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
  state.set(key, { written: 0, total, status: 'downloading' });
  emit();

  const task = FileSystem.createDownloadResumable(
    url,
    pathFor(url),
    {},
    (p) => {
      const cur = state.get(key);
      if (!cur || cur.status !== 'downloading') return;
      state.set(key, {
        ...cur,
        written: p.totalBytesWritten,
        // The callback's total is authoritative when HEAD said nothing.
        total: cur.total || p.totalBytesExpectedToWrite || 0,
      });
      emit();
    },
  );
  tasks.set(key, task);

  try {
    const res = await task.downloadAsync();
    tasks.delete(key);
    if (!res?.uri) throw new Error('no file');
    const cur = state.get(key);
    state.set(key, { written: cur?.written || 0, total: cur?.total || 0, status: 'done', uri: res.uri });
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
