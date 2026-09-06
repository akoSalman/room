// ── Keeping your place while older messages are added above you ─────────────
//
// Reported on the iOS web version: scrolling up to load older messages jumps —
// "it hops a couple of messages up immediately" instead of carrying on
// smoothly.
//
// Prepending into a scroll container moves everything below down by however
// tall the new content is, so the position has to be corrected by exactly that
// amount. The old correction measured the container's scrollHeight before and
// after the insert, in the same tick — and that measurement is a LIE whenever
// the new messages contain a photo. An <img> with height:auto is zero pixels
// tall until the file has loaded, so a page of twenty messages containing four
// photos measures as a few hundred pixels, gets corrected by a few hundred
// pixels, and then grows by another thousand as the photos arrive. All of that
// growth is above the reader, which pushes what they were reading down the
// screen — seen as the view suddenly hopping up by a couple of messages.
//
// The fix is to stop measuring the total height at all and to pin one ELEMENT
// instead: remember where the message that was at the top is sitting, and put
// it back there — not once, but every time something above it changes size,
// until the new page has settled.
//
// The arithmetic and the policy live here so they can be tested; the measuring
// stays in app.js, where the DOM is.
//
// Web only, deliberately: the app's message list is an inverted FlatList, which
// grows away from the reader by construction and has never had this problem.
(function (global) {
  'use strict';

  /**
   * How long to keep putting the anchor back after a page is added.
   *
   * Long enough for photos on a slow connection to arrive and take up their
   * real height; short enough that it cannot fight a deliberate scroll a
   * moment later. Every correction is also conditional on the anchor having
   * actually MOVED, so an idle hold costs nothing.
   */
  var SETTLE_MS = 4000;

  /**
   * Movement smaller than this is not worth a correction.
   *
   * Sub-pixel differences come out of rounding and zoom, and writing scrollTop
   * on iOS during a momentum scroll interrupts the fling — so a correction
   * that would move nothing must not be made at all.
   */
  var MIN_SHIFT = 1;

  /**
   * How far the anchor has drifted from where it was.
   *
   * Both numbers are the anchor's distance from the top edge of the scroll
   * container, so they are unaffected by how far the list has been scrolled —
   * only by content changing size above it.
   */
  function shiftFor(before, now) {
    // null and '' are Number 0, and a missing measurement read as "the anchor
    // is at the very top" would correct by the whole distance — a jump of its
    // own, from code that exists to prevent jumps.
    if (before === null || before === undefined || now === null || now === undefined) return 0;
    var a = Number(before), b = Number(now);
    if (!isFinite(a) || !isFinite(b)) return 0;
    return b - a;
  }

  function worthCorrecting(shift) {
    return isFinite(shift) && Math.abs(shift) >= MIN_SHIFT;
  }

  /** Where the container should be scrolled to undo that drift. */
  function nextTop(currentTop, shift) {
    var t = Number(currentTop) + Number(shift || 0);
    if (!isFinite(t)) return Number(currentTop) || 0;
    // Never past the top: a negative scrollTop is clamped by the browser
    // anyway, and asking for one on iOS bounces the list.
    return Math.max(0, t);
  }

  /** Is this hold still in force? */
  function stillHolding(startedAt, now, settleMs) {
    var ms = typeof settleMs === 'number' ? settleMs : SETTLE_MS;
    return Number(now) - Number(startedAt) < ms;
  }

  /**
   * Is the reader far enough from the top to load another page?
   *
   * The load threshold was a bare `scrollTop < 80`, which fires again the
   * instant a correction lands near the top — so a slow page could load two or
   * three more before the first was corrected, and each one jumped.
   */
  function shouldLoadOlder(o) {
    var s = o || {};
    if (s.loading || s.done) return false;
    return Number(s.scrollTop) < (typeof s.threshold === 'number' ? s.threshold : 80);
  }

  global.ScrollAnchor = {
    SETTLE_MS: SETTLE_MS,
    MIN_SHIFT: MIN_SHIFT,
    shiftFor: shiftFor,
    worthCorrecting: worthCorrecting,
    nextTop: nextTop,
    stillHolding: stillHolding,
    shouldLoadOlder: shouldLoadOlder,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).ScrollAnchor;
}
