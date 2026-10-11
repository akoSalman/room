// ── The screenshot just taken ────────────────────────────────────────────────
//
// Asked for as: after taking a screenshot on the device, it should be possible
// to paste it without opening the gallery to upload.
//
// Pasting an image already works, by two routes: the keyboard's image key
// (patches/react-native+0.74.5.patch tells the field to accept image/*) and
// the 📋 button on the options strip. Neither can help here, and both are
// right not to: A SCREENSHOT IS NOT ON THE CLIPBOARD. Android writes it to
// Pictures/Screenshots and shows a floating preview; unless the person taps
// "Copy" in that preview — and not every Android has that button — the
// clipboard is untouched. So every paste route correctly reports there is
// nothing to paste, and the gallery is the only way in. That is the gap.
//
// The media library CAN be asked for the newest screenshot. Which one, and
// whether to mention it at all, is decided here. It matters more than it
// looks: the offer puts a THUMBNAIL on screen, and a screenshot is very often
// of something private — a bank balance, somebody else's message. Offering the
// wrong picture is worse than offering none.
//
// Not mirrored into public/js: a browser has no screenshots folder, and the
// web already takes a pasted screenshot through the ordinary paste event.

/** As much of an asset as any decision here needs. */
export type Shot = {
  id: string;
  filename: string;
  /** Unix ms. */
  creationTime: number;
};

/**
 * How recent a screenshot has to be before it is worth mentioning.
 *
 * Long enough to take one, leave the app it was taken in, open this app, and
 * find the conversation. Short enough that opening the chat an hour later does
 * not put yesterday's screenshot on screen — which is the failure that would
 * make this feature feel like surveillance rather than help.
 */
export const FRESH_MS = 3 * 60 * 1000;

/**
 * Does this album hold screenshots?
 *
 * An album's name is the FOLDER's name on disk — Pictures/Screenshots on most
 * Androids, DCIM/Screenshots on Samsung — and a directory name is not
 * translated. The file inside it often IS: Android builds the filename from a
 * localized string, so on a Persian or Kurdish phone the screenshot can be
 * called «تصویر صفحه…» and any English name match would miss every one of
 * them. These are the app's users, so the album is the primary route and the
 * filename only a fallback.
 */
export function isScreenshotAlbum(title: string): boolean {
  const t = (title || '').trim().toLowerCase();
  if (!t) return false;
  // Singular on some Xiaomi builds. Anchored: an album somebody has made
  // called "Screenshots to send mum" is theirs, not the system's.
  return t === 'screenshots' || t === 'screenshot';
}

/**
 * Does this filename look like a screenshot?
 *
 * Only reached when there is no screenshots album to ask, so it is allowed to
 * be more generous than exact. Every vendor writes its own shape:
 *
 *   Screenshot_20260101-120000.png          AOSP, Pixel, OnePlus
 *   Screenshot_20260101-120000_Chrome.png   AOSP with the app's name
 *   Screenshot_20260101_120000.jpg          Samsung, Huawei
 *   Screenshot_2026-01-01-12-00-00-000.png  Xiaomi
 *   screen-20260101-120000.png              a few others
 *
 * What they share is the word at the START and a timestamp. The digits are
 * COUNTED rather than matched as a run, because Xiaomi separates every field
 * with a hyphen and the longest run of digits in its name is the four of the
 * year — a `\d{6}` would have quietly missed every MIUI phone. And some
 * timestamp is required, because "screenshot-tips.png" saved off a web page
 * is not a screenshot of this phone.
 */
export function isScreenshotName(filename: string): boolean {
  const n = (filename || '').trim().toLowerCase();
  if (!n) return false;
  if (!/^(screenshot|screen[-_ ]?shot|screen)[-_ ]/.test(n)) return false;
  return (n.match(/\d/g) || []).length >= 6;
}

/**
 * The screenshot to offer, if any.
 *
 * `handled` is the ones already sent or waved away. Without it, dismissing an
 * offer would bring it straight back on the next look — the chat is checked
 * again every time the app comes to the front, so a dismissal that did not
 * stick would be a chip that cannot be got rid of.
 *
 * The newest is chosen rather than the first: the caller asks the library for
 * newest-first, but a filename fallback scans a page of mixed photos, and
 * trusting the order there would offer whichever screenshot happened to come
 * back first.
 */
export function pickShot(o: {
  shots: Shot[];
  now: number;
  handled?: string[];
  freshMs?: number;
}): Shot | null {
  const fresh = typeof o.freshMs === 'number' ? o.freshMs : FRESH_MS;
  const handled = o.handled || [];
  let best: Shot | null = null;
  for (const s of o.shots || []) {
    if (!s || !s.id) continue;
    if (handled.includes(s.id)) continue;
    // A clock that has moved backwards, or an asset dated in the future,
    // would otherwise pass the age test for ever.
    const age = o.now - s.creationTime;
    if (age < 0 || age > fresh) continue;
    if (!best || s.creationTime > best.creationTime) best = s;
  }
  return best;
}
