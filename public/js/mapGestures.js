// ── Stopping Safari from zooming the PAGE when you pinch the map ────────────
//
// Reported three times, the last two angrily: the map does not zoom or move.
// Every check I ran said it did — because I ran them in Chromium, and this is
// a WebKit-only problem.
//
// On iOS, a two-finger pinch fires WebKit's own `gesturestart` /
// `gesturechange` events and Safari zooms the WHOLE PAGE. `touch-action: none`
// does not stop it — that property governs scrolling and panning, not Safari's
// pinch-to-zoom — and neither does `user-scalable=no`, which iOS has ignored
// since iOS 10. The only thing that stops it is calling preventDefault on
// those gesture events, and nothing in this app did.
//
// So on an iPhone: pinching the map zoomed the page instead of the map, and
// once the page was zoomed, dragging panned the zoomed page instead of the
// map. One cause, both symptoms — and invisible in every other browser,
// because `gesturestart` does not exist outside WebKit. Chromium reported the
// map panning and zooming perfectly, every time I asked it.
//
// Web only. The app draws its maps with a PanResponder inside a native view;
// there is no page to zoom.
(function (global) {
  'use strict';

  /**
   * WebKit's pinch events. All three are swallowed, not just the first:
   * preventing `gesturestart` alone still lets Safari act on the ones that
   * follow in some versions, and there is nothing here that wants any of them.
   */
  var GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'];

  /**
   * Keep a pinch (and a double-tap) inside this element instead of the page.
   *
   * Returns whether it bound anything, so a caller can be tested and so
   * binding twice — the picker is opened over and over — cannot stack
   * listeners on the same element.
   */
  function blockPageZoom(el) {
    if (!el || el.__mapGestureBound) return false;
    el.__mapGestureBound = true;
    var swallow = function (e) { if (e.cancelable) e.preventDefault(); };
    // Non-passive, or preventDefault is ignored and the listener is decoration.
    GESTURE_EVENTS.forEach(function (type) {
      el.addEventListener(type, swallow, { passive: false });
    });
    // Safari zooms on a double-tap too, which over a map is nearly always a
    // double-tap meant FOR the map.
    el.addEventListener('dblclick', swallow, { passive: false });
    return true;
  }

  global.MapGestures = {
    GESTURE_EVENTS: GESTURE_EVENTS,
    blockPageZoom: blockPageZoom,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).MapGestures;
}
