// Panning and pinching a map, on the web.
//
// Reported as: swiping on the map to move it closes the map instead, as though
// the swipe were a back button — and pinching to zoom does nothing.
//
// Both were true, and they are the same underlying fault: the map was never
// really taking the touch. It listened for touchstart/touchmove through inline
// HTML attributes, handled exactly one finger, and never told the browser it
// wanted the gesture. So a drag beginning near the side of the screen went to
// the browser's own edge-swipe, which navigates BACK — and back, in a
// single-page app, closes whatever was open. Two fingers were simply ignored.
//
// The maths here mirrors native-app/src/geo.ts, and a drift test compares the
// two: a pinch that lands on a different street on the phone than in the
// browser is a bug in whichever is behind.
(function (root) {
  'use strict';

  var TILE_SIZE = 256;
  var MIN_ZOOM = 3;
  var MAX_ZOOM = 18;

  function lngToWorldX(lng, zoom) {
    return ((lng + 180) / 360) * (TILE_SIZE * Math.pow(2, zoom));
  }

  function latToWorldY(lat, zoom) {
    var scale = TILE_SIZE * Math.pow(2, zoom);
    // Mercator is undefined at the poles; clamp to the standard cutoff.
    var clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    var s = Math.sin((clamped * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  }

  function worldXToLng(x, zoom) {
    return (x / (TILE_SIZE * Math.pow(2, zoom))) * 360 - 180;
  }

  function worldYToLat(y, zoom) {
    var scale = TILE_SIZE * Math.pow(2, zoom);
    var n = Math.PI - (2 * Math.PI * y) / scale;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function clampZoom(zoom) {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
  }

  /** The latitude/longitude under a pixel position in the viewport. */
  function screenToLatLng(pt, center, zoom, width, height) {
    var z = clampZoom(zoom);
    return {
      lng: worldXToLng(lngToWorldX(center.lng, z) + pt.x - width / 2, z),
      lat: worldYToLat(latToWorldY(center.lat, z) + pt.y - height / 2, z),
    };
  }

  /** How many zoom levels a pinch of this scale is worth. Doubling = one level. */
  function pinchZoomDelta(scale) {
    if (!(scale > 0)) return 0;
    return Math.log2(scale);
  }

  /**
   * The new centre after zooming about a fixed point on screen.
   *
   * Pinching on a street keeps THAT street under the fingers, instead of the
   * map flying off towards the middle of the view — which is the difference
   * between zooming in on what you are looking at and hunting for it again
   * afterwards.
   */
  function zoomAbout(center, zoom, newZoom, focal, width, height) {
    var z = clampZoom(newZoom);
    var anchor = screenToLatLng(focal, center, zoom, width, height);
    return {
      lng: worldXToLng(lngToWorldX(anchor.lng, z) - (focal.x - width / 2), z),
      lat: worldYToLat(latToWorldY(anchor.lat, z) - (focal.y - height / 2), z),
    };
  }

  /** The centre after dragging the map by (dx, dy) pixels. */
  function panCenter(center, zoom, dx, dy) {
    var z = clampZoom(zoom);
    return {
      lng: worldXToLng(lngToWorldX(center.lng, z) - dx, z),
      lat: worldYToLat(latToWorldY(center.lat, z) - dy, z),
    };
  }

  root.GeoZoom = {
    TILE_SIZE: TILE_SIZE,
    MIN_ZOOM: MIN_ZOOM,
    MAX_ZOOM: MAX_ZOOM,
    clampZoom: clampZoom,
    screenToLatLng: screenToLatLng,
    pinchZoomDelta: pinchZoomDelta,
    zoomAbout: zoomAbout,
    panCenter: panCenter,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).GeoZoom;
}
