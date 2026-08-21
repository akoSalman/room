// ── Choosing where the pin goes (web) ───────────────────────────────────────
//
// Mirrors native-app/src/locationPick.ts, and checked against it by a test.
//
// A browser's fix is a guess with an error bar, and on a desktop with no GPS
// it can be the wrong side of a city — it is derived from wifi and IP. So the
// pin is placed by hand on a map, starting from the fix so that when the fix
// is right it costs one extra click.
//
// Two of the rules here exist to stop the feature putting a false claim into a
// message somebody relies on to find a person or a place.
(function (root) {
  'use strict';

  var PICK_ZOOM = 17;      // close enough to place a pin on the right street
  var UNKNOWN_ZOOM = 5;    // "we have no idea where you are" — a whole region
  // A pin within this of the fix counts as NOT moved: a map cannot be held
  // perfectly still and the centre is a float, so an untouched map drifts by a
  // metre or two. Anything inside ordinary GPS noise is the fix, not a
  // decision.
  var PIN_MOVED_M = 15;

  /** Metres between two points. */
  function distanceMeters(a, b) {
    var R = 6371000;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var la = a.lat * Math.PI / 180, lb = b.lat * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(la) * Math.cos(lb);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function formatDistance(m) {
    if (!isFinite(m) || m < 0) return '';
    if (m < 1000) return Math.round(m) + ' m';
    if (m < 10000) return (m / 1000).toFixed(1) + ' km';
    return Math.round(m / 1000) + ' km';
  }

  function formatCoords(p) {
    return p.lat.toFixed(4) + ', ' + p.lng.toFixed(4);
  }

  /**
   * Where the map opens: on the fix, else near anything already pinned in this
   * chat, else nowhere in particular and zoomed out far enough to pan.
   */
  function openingView(fix, nearby) {
    nearby = nearby || [];
    if (fix) return { center: { lat: fix.lat, lng: fix.lng }, zoom: PICK_ZOOM };
    if (nearby.length) return { center: { lat: nearby[0].lat, lng: nearby[0].lng }, zoom: 13 };
    return { center: { lat: 0, lng: 0 }, zoom: UNKNOWN_ZOOM };
  }

  function pinMoved(fix, chosen, tolerance) {
    if (tolerance === undefined) tolerance = PIN_MOVED_M;
    if (!fix) return true;                  // nothing to have moved away FROM
    return distanceMeters({ lat: fix.lat, lng: fix.lng }, chosen) > tolerance;
  }

  /**
   * The payload for the message.
   *
   * 1. ACCURACY IS DROPPED once the pin has been moved. `accuracy` describes
   *    the error bar on a measurement; carrying it over to a point somebody
   *    placed by hand attaches a measured uncertainty to a number that was
   *    never measured — and backwards at that, since the hand-placed pin is
   *    usually the better of the two.
   * 2. A LIVE SHARE ALWAYS USES THE FIX. Live means "follow me", and the
   *    tracker overwrites the coordinates within seconds. A hand-placed start
   *    would show a position that was never true and then quietly correct
   *    itself.
   */
  function locationPayload(o) {
    var live = (o.liveUntil && o.liveUntil > o.now) ? o.liveUntil : null;
    var at = (live && o.fix) ? { lat: o.fix.lat, lng: o.fix.lng } : o.chosen;
    var moved = pinMoved(o.fix, at);
    return {
      lat: at.lat,
      lng: at.lng,
      accuracy: moved ? null : ((o.fix && o.fix.accuracy) != null ? o.fix.accuracy : null),
      liveUntil: live,
      updatedAt: o.now,
    };
  }

  function canShareLive(fix) { return !!fix; }

  /**
   * The line under the map: which of the two things is about to be sent, and —
   * once the pin has been moved — how far it is from where the browser thinks
   * you are. That distance is the only honest feedback available without
   * street names about whether you have landed on the right building.
   */
  function chosenLabel(fix, chosen) {
    if (!fix) return 'Chosen point · ' + formatCoords(chosen);
    if (!pinMoved(fix, chosen)) {
      var acc = (fix.accuracy && fix.accuracy > 0)
        ? ' · accurate to about ' + formatDistance(fix.accuracy) : '';
      return 'Your current position' + acc;
    }
    return 'Chosen point · ' + formatDistance(distanceMeters({ lat: fix.lat, lng: fix.lng }, chosen))
      + ' from your position';
  }

  root.LocationPick = {
    PICK_ZOOM: PICK_ZOOM,
    UNKNOWN_ZOOM: UNKNOWN_ZOOM,
    PIN_MOVED_M: PIN_MOVED_M,
    openingView: openingView,
    pinMoved: pinMoved,
    locationPayload: locationPayload,
    canShareLive: canShareLive,
    chosenLabel: chosenLabel,
    distanceMeters: distanceMeters,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).LocationPick;
}
