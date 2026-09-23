// ── Download helpers ─────────────────────────────────────────────────────────
//
// Pure functions only, so the parts that are easy to get quietly wrong — the
// cache key and the byte formatting — can be unit tested.

/** Human-readable byte count: "812 KB", "12.4 MB". */
export function fmtBytes(b: number): string {
  if (!isFinite(b) || b <= 0) return '0 B';
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * A stable local filename for a remote media URL.
 *
 * Media URLs are HMAC-signed and expire, so the same file is served under a
 * DIFFERENT query string every time it is refreshed. Keying the cache on the
 * whole URL would therefore re-download a video the user already has, every
 * time its signature was renewed — so the query is dropped and only the path
 * identifies the file.
 */
export function localNameFor(url: string, prefix = 'dl-'): string {
  const noQuery = String(url || '').split('?')[0].split('#')[0];
  const base = noQuery.split('/').filter(Boolean).pop() || 'file';
  // Everything a filesystem might object to becomes an underscore. The name is
  // decoded first so an %-escaped upload keeps one stable spelling.
  let decoded = base;
  try { decoded = decodeURIComponent(base); } catch {}
  const safe = decoded.replace(/[^\w.\-]/g, '_').slice(-120);
  return `${prefix}${safe || 'file'}`;
}

/** 0–100, clamped, and 0 when the total size is not known yet. */
export function progressPercent(written: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (written / total) * 100));
}

// ── Tapping a video that is not on the phone yet ────────────────────────────
//
// Reported as: "when tapping play video that is not downloaded it will
// download and play but when closing video the download button is still there
// and it's marked as new not downloaded video."
//
// Both halves of that were true, and the second followed from a design this
// file's neighbour states plainly: tapping the tile STREAMED the video and
// kept nothing, while the button beside it was "for keeping it". So the bytes
// were spent, the video played, and the tile went back to offering a download
// of the thing that had just been watched — and offered it again on every
// rewatch.
//
// For somebody on a metered connection that is the wrong trade twice over. So
// a tap now downloads, with the progress the tile already knows how to draw,
// and opens the player by itself when the file is there. The data is spent
// once and the phone keeps what it paid for.

/** What a tap on a video tile should do. */
export type VideoTapAction = 'play-local' | 'start-download' | 'wait';

/**
 * Tapping a video tile: play it, fetch it, or let a running fetch finish.
 *
 * `status` is the download state; `hasFile` says whether a local copy is
 * actually recorded, because a status of 'done' with no uri is a record of
 * something that is no longer on disk.
 */
export function videoTapAction(o: {
  status?: string | null; hasFile?: boolean;
}): VideoTapAction {
  if (o && o.status === 'done' && o.hasFile) return 'play-local';
  // Already fetching: a second tap must not start it again, and must not be
  // taken as the user changing their mind.
  if (o && (o.status === 'downloading' || o.status === 'paused')) return 'wait';
  return 'start-download';
}

/**
 * Has a download the user was waiting on just finished?
 *
 * Only ever true once per wait: the player opening is an interruption, and
 * one that arrives twice — or after the user has gone somewhere else — is
 * worse than none.
 */
export function shouldAutoOpen(o: {
  waiting?: boolean; status?: string | null; hasFile?: boolean;
}): boolean {
  return !!(o && o.waiting && o.status === 'done' && o.hasFile);
}
