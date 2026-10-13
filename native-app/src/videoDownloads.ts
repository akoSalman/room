// ── Video downloads ──────────────────────────────────────────────────────────
//
// Kept at module scope rather than in a component: a download must survive
// scrolling the bubble off screen, opening another chat, and coming back.
// Screens subscribe and read the state; they never own it.
import * as FileSystem from 'expo-file-system';
import { localNameFor, downloadUsable, downloadFailureText } from './download';
// The SAME throttle rule the gallery save uses, imported rather than copied:
// the interval is a judgement about the JavaScript thread, not about either
// feature, and two of them would drift.
import { dueForEmit } from './saveProgress';
import { mediaHeaders } from './mediaSource';

export type DownloadState = {
  /** Bytes written so far. */
  written: number;
  /** Total size, 0 until the server tells us. */
  total: number;
  status: 'downloading' | 'done' | 'failed';
  /** Where the finished file lives. */
  uri?: string;
  /** Why it failed, for a tile that has to say something useful. */
  reason?: string;
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

/**
 * The local copy if there is one, otherwise null.
 *
 * VERIFIED, not remembered. This used to return the remembered path the moment
 * the state said "done", and check the disk only on the first ask — so a file
 * that went away afterwards left the app certain it still had it.
 *
 * Things do take it away. A phone short of space reclaims; the cleaners these
 * devices ship with are used, and used often; and this app's own startup sweep
 * caps the video directory. None of that reaches this map, which lives for as
 * long as the process does.
 *
 * What it produced was a video that said "Saved on this device" in the player
 * and would not play — the one honest-looking state in which nothing works,
 * and reported as exactly that. Being wrong here is worse than being slow: a
 * stat is cheap, and the alternative is a file:// path to nothing.
 */
export async function localUri(url: string): Promise<string | null> {
  const key = keyFor(url);
  const known = state.get(key);
  if (known?.status === 'done' && known.uri) {
    if (await stillThere(known.uri)) return known.uri;
    // Gone. Forgetting it is what puts the download back on the bubble
    // instead of leaving a tile that claims to be ready.
    state.delete(key);
    emit();
  }
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
    { headers: mediaHeaders(url) },
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
    // ── Did the server actually send the file? ─────────────────────────────
    //
    // expo writes whatever came back and resolves whatever the status was. A
    // media link is signed and lives a day or two, so an old one comes back
    // 403 with an empty body — which was written as a zero-byte file and
    // recorded as a finished download. The tile then said "downloaded" and
    // playing it played nothing, which is exactly how this was reported.
    let size = 0;
    try { size = ((await FileSystem.getInfoAsync(res.uri)) as any)?.size || 0; } catch {}
    // `total` came from a HEAD before the download started. A file shorter
    // than that is a download that stopped early — which on these networks
    // is the ordinary way one ends, and leaves a playable-looking header
    // over frames that are not there.
    const short = total > 0 && size > 0 && size < total;
    if (!downloadUsable({ status: (res as any).status, size, expected: total })) {
      // Nothing usable is left behind to be mistaken for a finished download.
      try { await FileSystem.deleteAsync(pathFor(url), { idempotent: true }); } catch {}
      state.set(key, {
        written: 0, total: state.get(key)?.total || 0, status: 'failed',
        reason: downloadFailureText((res as any).status, short),
      });
      lastEmitAt.delete(key);
      emit();
      return null;
    }
    const cur = state.get(key);
    state.set(key, { written: cur?.written || size, total: cur?.total || size, status: 'done', uri: res.uri });
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

/**
 * A file this device already has IS the download.
 *
 * Reported as: my own sent videos should not need downloading, because I sent
 * them from this device.
 *
 * They did, because the only thing that made a video "downloaded" was having
 * fetched it from the server — so the one person guaranteed to own the bytes
 * already was the one asked to pay for them again. This copies the local file
 * under the key the finished url will have, so the bubble shows it as held
 * the moment the upload lands.
 *
 * COPIED, not linked: the file that was uploaded is a temporary one, and the
 * sender's copy has to outlive it.
 *
 * `canKeep` is false for a disappearing or one-time video, and then nothing
 * is kept — the same rule every other store here obeys. Sending one does not
 * entitle the sender to a permanent copy the receiver was promised would not
 * exist.
 */
export async function adopt(localUri: string, remoteUrl: string, canKeep = true): Promise<boolean> {
  if (!canKeep) return false;
  if (typeof localUri !== 'string' || !localUri) return false;
  if (typeof remoteUrl !== 'string' || !remoteUrl) return false;
  const key = keyFor(remoteUrl);
  const dest = pathFor(remoteUrl);
  try {
    // Already held — an earlier send of the same file, or a download.
    if (await localUri2(dest)) return true;
    await ensureDir();
    await FileSystem.copyAsync({ from: localUri, to: dest });
    const size = ((await FileSystem.getInfoAsync(dest)) as any)?.size || 0;
    if (!size) {
      try { await FileSystem.deleteAsync(dest, { idempotent: true }); } catch {}
      return false;
    }
    state.set(key, { written: size, total: size, status: 'done', uri: dest });
    sizes.set(key, size);
    emit();
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the file still where it was left, with bytes in it?
 *
 * Both halves matter. A zero-byte file is what an interrupted copy leaves
 * behind, and it exists — so existence alone would keep saying yes to
 * something no player can open.
 */
async function stillThere(uri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return !!(info.exists && (info as any).size > 0);
  } catch {
    // Unreadable is the same as absent for every purpose here.
    return false;
  }
}

/** Does this exact path already hold bytes? */
async function localUri2(path: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    return !!(info.exists && (info as any).size > 0);
  } catch {
    return false;
  }
}
