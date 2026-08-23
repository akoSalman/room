// ── The picture on a video message ───────────────────────────────────────────
//
// Asked for as: a preview of the video should be the cover of videos.
//
// A video arrived as a flat dark rectangle with a play triangle on it —
// identical for every video anyone had ever sent, so a chat full of them was a
// column of identical tiles and the only way to tell which was which was to
// open them one at a time.
//
// A frame from the video answers that at a glance, which is what every other
// messenger shows. It has to be EXTRACTED, though: the server stores the file
// as it was uploaded and there is no poster image anywhere, so the first frame
// is pulled out on the device.
//
// The rules that matter are here, away from the extractor:
//   • which frame to take (not the first one, which is often black),
//   • never doing the same work twice, including the failures,
//   • never doing it at all for a video too big to be worth the wait over a
//     bad connection.

/**
 * How far into the video to take the frame, in milliseconds.
 *
 * Not zero. A video very often opens on a black or half-exposed frame — the
 * camera is still settling, or the clip fades in — and a black thumbnail is no
 * better than the flat rectangle this replaces. A second in, something is
 * usually happening.
 */
export const FRAME_AT_MS = 1000;

/**
 * Above this, don't fetch a remote video just for its cover.
 *
 * Extracting from a remote URL means the decoder streams part of the file, and
 * on a slow connection that is real data spent on a picture nobody asked for.
 * The tile falls back to the plain one, which is what it was before.
 * A video already downloaded to the device is read locally and this does not
 * apply to it.
 */
export const MAX_REMOTE_BYTES = 25 * 1024 * 1024;

export type CoverState =
  | { status: 'none' }
  | { status: 'working' }
  | { status: 'done'; uri: string }
  /** Tried, and it did not work. Remembered so it is not tried again. */
  | { status: 'failed' };

/**
 * Is it worth extracting a cover for this video?
 *
 * A local file always is: it is on the device already and the read is fast.
 * A remote one only if it is small enough that streaming a chunk of it is not
 * an imposition — and never while offline, where it would fail slowly and
 * repeatedly.
 */
export function shouldExtract(o: {
  local: boolean; sizeBytes?: number; online?: boolean; state?: CoverState;
}): boolean {
  const st = o.state?.status;
  // Done, in flight, or already known to fail: nothing to do. Remembering the
  // failure is the point — without it every re-render of a video that cannot
  // be decoded starts the decoder again.
  if (st === 'done' || st === 'working' || st === 'failed') return false;
  if (o.local) return true;
  if (o.online === false) return false;
  const size = typeof o.sizeBytes === 'number' ? o.sizeBytes : 0;
  // Size unknown yet: wait for it rather than guessing. It arrives from the
  // same HEAD the download button already makes.
  if (!(size > 0)) return false;
  return size <= MAX_REMOTE_BYTES;
}

/**
 * The cache key for a video's cover.
 *
 * Keyed on the URL's PATH, so the same video does not get a second thumbnail
 * every time its signed URL is reissued — and so a local copy and the remote
 * original share one cover rather than extracting it twice.
 */
export function coverKey(url: string): string {
  const clean = String(url || '').split('?')[0].split('#')[0];
  const tail = clean.split('/').filter(Boolean).pop() || clean;
  return tail.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
}

/** What the tile should draw right now. */
export function coverToShow(state: CoverState | undefined): string | null {
  return state && state.status === 'done' ? state.uri : null;
}
