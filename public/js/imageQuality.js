// ── Image send quality (web) ────────────────────────────────────────────────
//
// Mirrors native-app/src/imageQuality.ts, and checked against it by a test.
//
// A phone camera produces 12-megapixel, 4–8 MB JPEGs, and a photo dragged into
// the browser from a camera roll is no smaller. Sent as-is over a slow
// connection that is the multi-second upload people notice. "Standard"
// re-encodes to something that still looks right on a screen and is typically
// five to ten times smaller; "HD" sends the original file untouched, for when
// the detail actually matters.
(function (root) {
  'use strict';

  /** Longest edge, in pixels, that "standard" resizes down to. */
  var STANDARD_MAX_EDGE = 1600;
  /** JPEG quality for "standard" (0..1). */
  var STANDARD_JPEG_QUALITY = 0.7;

  /**
   * How to resize an image of this size.
   *
   * Null when nothing should change — HD always, and any picture already
   * smaller than the limit, because re-encoding a small image makes it LARGER
   * as often as not while still costing quality.
   */
  function resizeTarget(width, height, quality) {
    if (quality === 'hd') return null;
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;

    var longest = Math.max(width, height);
    if (longest <= STANDARD_MAX_EDGE) return null;

    var scale = STANDARD_MAX_EDGE / longest;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  /** Whether this file is worth re-encoding at all. */
  function shouldCompress(mime, quality) {
    if (quality === 'hd') return false;
    if (!String(mime || '').startsWith('image/')) return false;
    // GIFs are usually animated and re-encoding would freeze them to one
    // frame. SVG is vector — resizing it is meaningless.
    if (/gif|svg/i.test(mime)) return false;
    return true;
  }

  function qualityLabel(q) { return q === 'hd' ? 'HD' : 'Standard'; }

  root.ImageQuality = {
    STANDARD_MAX_EDGE: STANDARD_MAX_EDGE,
    STANDARD_JPEG_QUALITY: STANDARD_JPEG_QUALITY,
    resizeTarget: resizeTarget,
    shouldCompress: shouldCompress,
    qualityLabel: qualityLabel,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).ImageQuality;
}
