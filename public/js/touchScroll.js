// Which touch drags the page may swallow, and which belong to the page.
//
// Reported as: the emoji bar on the web cannot be swiped.
//
// The chat cancels document-level touch scrolling, because on a phone a drag
// that reaches the document bounces the whole app around behind a fixed
// layout. That was done with a list of four containers allowed to scroll:
//
//     if (e.target.closest('#messages, #room-list, .modal-overlay, #online-panel')) return;
//     e.preventDefault();
//
// Anything not on the list is frozen. The emoji bar is a horizontal strip with
// `overflow-x: auto` and more emojis than fit — so the CSS says scroll me and
// the handler says no, and the browser obeys the handler. It is not that the
// bar was built without scrolling; it is that scrolling it was cancelled.
//
// A list of names cannot be right, because it has to be added to every time
// anything scrollable is built, and nobody remembers. So the question is asked
// of the element itself: can this actually scroll in the direction the finger
// is going? If it can, the drag is its own and the page keeps its hands off.
(function (global) {
  'use strict';

  /** A scrollbar that never quite reaches zero, and sub-pixel layout. */
  var SLOP = 2;

  /**
   * Can this element scroll, and in which direction?
   *
   * `overflow` matters as much as the sizes: a container whose content is
   * larger but which is set to `hidden` is a clipped box, not a scroller, and
   * treating it as one would let a drag inside it move the page.
   */
  function scrollableAxes(el, styleOf) {
    var out = { x: false, y: false };
    if (!el || !el.getBoundingClientRect) return out;
    var st = styleOf ? styleOf(el) : null;
    var ox = st ? String(st.overflowX || st.overflow || '') : 'auto';
    var oy = st ? String(st.overflowY || st.overflow || '') : 'auto';
    var scrolls = function (o) { return o === 'auto' || o === 'scroll' || o === 'overlay'; };
    if (scrolls(ox) && (el.scrollWidth || 0) - (el.clientWidth || 0) > SLOP) out.x = true;
    if (scrolls(oy) && (el.scrollHeight || 0) - (el.clientHeight || 0) > SLOP) out.y = true;
    return out;
  }

  /**
   * Should the page cancel this touch move?
   *
   * Walks up from whatever was touched looking for something that can really
   * scroll. Stops at the root: past there is the page itself, which is exactly
   * what must not move.
   *
   * `axis` is which way the finger has actually gone so far. A vertical drag
   * inside a horizontal-only strip is NOT that strip's to keep — letting it
   * through would move the page — and the other way round too. When the
   * direction is not yet known, anything scrollable claims it, because
   * cancelling the first frames of a drag is what makes a scroller feel dead.
   */
  function cancelsMove(o) {
    var el = o && o.target;
    var axis = o && o.axis;
    var styleOf = o && o.styleOf;
    var root = (o && o.root) || null;
    var depth = 0;
    while (el && depth < 40) {
      var can = scrollableAxes(el, styleOf);
      if ((axis === 'x' && can.x) || (axis === 'y' && can.y) || (!axis && (can.x || can.y))) {
        return false;
      }
      if (el === root) break;
      el = el.parentElement;
      depth++;
    }
    return true;
  }

  /**
   * Which way a finger has gone, once it has gone far enough to say.
   *
   * Below the threshold the answer is null: the first pixels of a drag are
   * mostly noise, and committing to an axis from them picks the wrong one
   * often enough to be felt.
   */
  function axisOf(dx, dy, minPx) {
    var min = minPx === undefined ? 6 : minPx;
    var ax = Math.abs(Number(dx) || 0);
    var ay = Math.abs(Number(dy) || 0);
    if (ax < min && ay < min) return null;
    return ax > ay ? 'x' : 'y';
  }

  global.TouchScroll = {
    SLOP: SLOP,
    scrollableAxes: scrollableAxes,
    cancelsMove: cancelsMove,
    axisOf: axisOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).TouchScroll;
}
