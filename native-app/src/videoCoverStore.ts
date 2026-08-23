// The covers themselves: extraction, caching on disk, and who to tell.
//
// The decisions — which frame, when it is worth doing, what the key is — live
// in videoCover.ts and are tested there. This is the part that touches the
// decoder and the filesystem.
import * as FileSystem from 'expo-file-system';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { CoverState, FRAME_AT_MS, coverKey, shouldExtract } from './videoCover';

const state = new Map<string, CoverState>();
const listeners = new Set<() => void>();

// documentDirectory, not cacheDirectory: Android empties the cache whenever it
// is short of space, and re-extracting every cover after that means decoding
// every video in the chat again. The files are a few kilobytes each.
const DIR = FileSystem.documentDirectory + 'covers/';
let dirReady: Promise<any> | null = null;
function ensureDir(): Promise<any> {
  if (!dirReady) dirReady = FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  return dirReady;
}

function emit() { listeners.forEach(f => f()); }

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function get(url: string): CoverState {
  return state.get(coverKey(url)) || { status: 'none' };
}

function pathFor(url: string): string {
  return `${DIR}${coverKey(url)}.jpg`;
}

/**
 * Adopt a cover extracted on an earlier run.
 *
 * Without this, every cover in the chat is decoded again on every cold start —
 * the files are right there on disk, and the only thing missing is the map
 * entry pointing at them.
 */
export async function hydrate(url: string): Promise<void> {
  const key = coverKey(url);
  if (state.get(key)) return;
  const path = pathFor(url);
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists && (info as any).size > 0) {
      state.set(key, { status: 'done', uri: path });
      emit();
    }
  } catch {}
}

/**
 * Extract the cover for a video, once.
 *
 * `source` is a local file when there is one — reading from disk is both
 * faster and free — and the remote URL otherwise. Whether it is worth doing at
 * all is decided by shouldExtract, so a huge video over a bad connection is
 * left as the plain tile it always was.
 */
export async function ensureCover(o: {
  url: string; source: string; local: boolean; sizeBytes?: number; online?: boolean;
}): Promise<void> {
  const key = coverKey(o.url);
  await hydrate(o.url);
  if (!shouldExtract({
    local: o.local, sizeBytes: o.sizeBytes, online: o.online, state: state.get(key),
  })) return;

  state.set(key, { status: 'working' });
  emit();
  try {
    await ensureDir();
    const { uri } = await VideoThumbnails.getThumbnailAsync(o.source, {
      time: FRAME_AT_MS,
      quality: 0.6,
    });
    // The extractor writes into the cache directory, which is exactly where a
    // cover must not live — see DIR above.
    const dest = pathFor(o.url);
    try { await FileSystem.moveAsync({ from: uri, to: dest }); }
    catch { await FileSystem.copyAsync({ from: uri, to: dest }); }
    state.set(key, { status: 'done', uri: dest });
  } catch {
    // Remembered, so a video the decoder cannot read is not decoded again on
    // every re-render for the rest of the session.
    state.set(key, { status: 'failed' });
  }
  emit();
}

/** Tests and sign-out. */
export function _reset() {
  state.clear();
  emit();
}
