// ── Image send quality ───────────────────────────────────────────────────────
//
// Phone cameras produce 12-megapixel, 4-8 MB JPEGs. Sent as-is over a slow
// connection that is the multi-second upload people notice. "Standard"
// re-encodes to something that still looks right on a phone screen and is
// typically five to ten times smaller; "HD" sends the original file untouched,
// for when the detail actually matters.
//
// The maths lives here, away from the native image library, so the resizing
// rules can be unit tested.

export type Quality = 'standard' | 'hd';

/** Longest edge, in pixels, that "standard" resizes down to. */
export const STANDARD_MAX_EDGE = 1600;
/** JPEG quality for "standard" (0..1). */
export const STANDARD_JPEG_QUALITY = 0.7;

/**
 * How to resize an image of this size.
 *
 * Returns null when nothing should change — HD always, and any picture already
 * smaller than the limit, because re-encoding a small image makes it LARGER as
 * often as not while still costing quality.
 */
export function resizeTarget(
  width: number, height: number, quality: Quality,
): { width: number; height: number } | null {
  if (quality === 'hd') return null;
  if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;

  const longest = Math.max(width, height);
  if (longest <= STANDARD_MAX_EDGE) return null;

  // Scale the longest edge to the limit and keep the aspect ratio. Rounded to
  // whole pixels, and never to zero for extremely thin images.
  const scale = STANDARD_MAX_EDGE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Whether this file is worth re-encoding at all. */
export function shouldCompress(mime: string, quality: Quality): boolean {
  if (quality === 'hd') return false;
  if (!mime.startsWith('image/')) return false;
  // GIFs are usually animated and re-encoding would freeze them to one frame.
  // SVG is vector — resizing it is meaningless.
  if (/gif|svg/i.test(mime)) return false;
  return true;
}

/** Label for the toggle in the composer. */
export function qualityLabel(q: Quality): string {
  return q === 'hd' ? 'HD' : 'Standard';
}
