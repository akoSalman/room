// ── Placing the pin on a map, then sending it (web) ─────────────────────────
//
// The web could render a location message and had no way to send one. Now it
// can, and it goes through the map first for the same reason the app does: a
// browser's fix is a guess, and on a desktop with no GPS it is derived from
// wifi and IP and can be the wrong side of a city.
//
// The pin does not move; the MAP does. A marker you drag is a marker your
// cursor is covering at the moment you need to see it, and it gets harder to
// place as you zoom in rather than easier. A fixed crosshair over a map you
// push around is the pattern every map app settled on.
//
// The rules — where it opens, whether the pin counts as moved, what the
// payload may claim — are in locationPick.js, shared with the app and checked
// against it.
(function () {
  'use strict';

  var TILE = 256;
  var center = { lat: 0, lng: 0 };
  var zoom = 5;
  var fix = null;            // where the browser thinks we are, or null
  var locating = false;
  var drag = null;

  function $(id) { return document.getElementById(id); }

  // ── Web Mercator, the same projection the location cards already use ──────
  function lngToX(lng, z) { return ((lng + 180) / 360) * Math.pow(2, z); }
  function latToY(lat, z) {
    var r = lat * Math.PI / 180;
    return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * Math.pow(2, z);
  }
  function xToLng(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
  function yToLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  async function open() {
    if (!window.currentRoomId) return;
    fix = null;
    locating = true;
    var view = window.LocationPick.openingView(null, nearbyPins());
    center = view.center; zoom = view.zoom;
    $('loc-modal').classList.remove('hidden');
    bindMap();
    draw();
    // The map goes up FIRST and the fix arrives into it. Waiting would mean a
    // blank dialog for however long the browser takes — and a browser that
    // never gets a fix used to mean no location could be shared at all, which
    // is the worst outcome for somebody who knows perfectly well where they
    // are.
    locate(true);
  }

  function close() { $('loc-modal').classList.add('hidden'); }

  /** Places already pinned in this chat: somewhere sensible when there is no fix. */
  function nearbyPins() {
    var out = [];
    document.querySelectorAll('#messages .loc-card').forEach(function (el) {
      var lat = parseFloat(el.dataset.lat), lng = parseFloat(el.dataset.lng);
      if (isFinite(lat) && isFinite(lng)) out.push({ lat: lat, lng: lng });
    });
    return out;
  }

  function locate(recentre) {
    if (!navigator.geolocation) { locating = false; draw(); return; }
    locating = true;
    draw();
    navigator.geolocation.getCurrentPosition(function (pos) {
      locating = false;
      fix = {
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy != null ? pos.coords.accuracy : null,
      };
      if (recentre) {
        center = { lat: fix.lat, lng: fix.lng };
        zoom = Math.max(zoom, window.LocationPick.PICK_ZOOM);
      }
      draw();
    }, function () {
      locating = false;
      draw();
    // enableHighAccuracy: a rough fix is the thing being complained about, and
    // this is one reading rather than continuous tracking.
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function draw() {
    var map = $('loc-map');
    var w = map.clientWidth || 320, h = map.clientHeight || 260;
    map.innerHTML = '';

    var z = Math.round(zoom);
    var n = Math.pow(2, z);
    var cx = lngToX(center.lng, z) * TILE;
    var cy = latToY(center.lat, z) * TILE;
    var x0 = Math.floor((cx - w / 2) / TILE), x1 = Math.floor((cx + w / 2) / TILE);
    var y0 = Math.floor((cy - h / 2) / TILE), y1 = Math.floor((cy + h / 2) / TILE);

    for (var ty = y0; ty <= y1; ty++) {
      for (var tx = x0; tx <= x1; tx++) {
        if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
        var img = document.createElement('img');
        // Our own proxy, not tile.openstreetmap.org — foreign map services are
        // unreachable for the people this app is for.
        img.src = '/tiles/' + z + '/' + tx + '/' + ty + '.png';
        img.className = 'loc-tile';
        img.draggable = false;
        img.style.left = (tx * TILE - cx + w / 2) + 'px';
        img.style.top = (ty * TILE - cy + h / 2) + 'px';
        map.appendChild(img);
      }
    }

    // The fix, as an ordinary dot, so the two can be told apart: blue is where
    // the browser thinks you are, the crosshair is where the pin will land.
    if (fix) {
      var dot = document.createElement('div');
      dot.className = 'loc-me';
      dot.style.left = (lngToX(fix.lng, z) * TILE - cx + w / 2) + 'px';
      dot.style.top = (latToY(fix.lat, z) * TILE - cy + h / 2) + 'px';
      map.appendChild(dot);
    }

    $('loc-label').textContent = locating && !fix
      ? 'Finding you…'
      : window.LocationPick.chosenLabel(fix, center);
    $('loc-live-note').classList.toggle('hidden', window.LocationPick.canShareLive(fix));
  }

  // ── Moving the map under the pin ──────────────────────────────────────────
  //
  // Reported as: swiping the map to move it closes the map, as though the
  // swipe were the back button — and pinching does nothing.
  //
  // Both came from the same thing: the map never really took the touch. It
  // listened through inline HTML attributes, handled exactly one finger, and
  // never told the browser it wanted the gesture, so a drag starting anywhere
  // near the side of the screen was taken by the browser's own edge swipe —
  // which navigates BACK, and back in a single-page app closes whatever is
  // open. Two fingers were ignored outright.
  //
  // Now the handlers are registered from JavaScript with { passive: false } so
  // preventDefault actually applies (an inline attribute handler cannot be
  // relied on to be non-passive), the first move is claimed on touchSTART
  // rather than after the browser has already begun its own gesture, and two
  // fingers pinch about their midpoint. `touch-action: none` and
  // `overscroll-behavior: none` on the map say the same thing to the browser
  // declaratively — belt and braces, because this is the difference between a
  // map and a way to leave the page by accident.

  /** Two fingers: the distance between them, and their midpoint on the map. */
  function touchPair(e, rect) {
    var a = e.touches[0], b = e.touches[1];
    var dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
    return {
      dist: Math.sqrt(dx * dx + dy * dy) || 1,
      fx: (a.clientX + b.clientX) / 2 - rect.left,
      fy: (a.clientY + b.clientY) / 2 - rect.top,
    };
  }

  function mapRect() {
    var el = $('loc-map');
    return el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 320, height: 260 };
  }

  function onDown(e) {
    var rect = mapRect();
    if (e.touches && e.touches.length >= 2) {
      var p = touchPair(e, rect);
      drag = {
        kind: 'pinch', dist: p.dist, fx: p.fx, fy: p.fy,
        baseZoom: Math.round(zoom), lat: center.lat, lng: center.lng,
        w: rect.width, h: rect.height,
      };
    } else {
      var t = e.touches ? e.touches[0] : e;
      drag = {
        kind: 'pan', x: t.clientX, y: t.clientY,
        lat: center.lat, lng: center.lng, w: rect.width, h: rect.height,
      };
    }
    // Ours now. Without this the browser starts its own scroll or edge-swipe
    // on the very same touch.
    if (e.cancelable) e.preventDefault();
  }

  function onMove(e) {
    if (!drag) return;
    if (e.cancelable) e.preventDefault();
    var rect = mapRect();

    // A second finger landing mid-drag becomes a pinch, rather than the map
    // lurching sideways to follow whichever finger the browser reports first.
    if (e.touches && e.touches.length >= 2) {
      var p = touchPair(e, rect);
      if (drag.kind !== 'pinch') {
        drag = {
          kind: 'pinch', dist: p.dist, fx: p.fx, fy: p.fy,
          baseZoom: Math.round(zoom), lat: center.lat, lng: center.lng,
          w: rect.width, h: rect.height,
        };
        return;
      }
      var want = window.GeoZoom.clampZoom(
        drag.baseZoom + window.GeoZoom.pinchZoomDelta(p.dist / drag.dist));
      if (want !== Math.round(zoom)) {
        // About the fingers, so the street between them stays between them.
        center = window.GeoZoom.zoomAbout(
          center, Math.round(zoom), want, { x: p.fx, y: p.fy }, rect.width, rect.height);
        zoom = want;
        draw();
      }
      return;
    }

    if (drag.kind !== 'pan') return;
    var t = e.touches ? e.touches[0] : e;
    var z = Math.round(zoom);
    var dx = t.clientX - drag.x, dy = t.clientY - drag.y;
    center = {
      lng: xToLng(lngToX(drag.lng, z) - dx / TILE, z),
      lat: yToLat(latToY(drag.lat, z) - dy / TILE, z),
    };
    draw();
  }

  function onUp(e) {
    // One finger lifting out of a pinch must not become a pan from wherever
    // that finger happens to be — it would fling the map across the city.
    if (e && e.touches && e.touches.length === 1 && drag && drag.kind === 'pinch') {
      var rect = mapRect();
      drag = {
        kind: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY,
        lat: center.lat, lng: center.lng, w: rect.width, h: rect.height,
      };
      return;
    }
    drag = null;
  }

  /**
   * Wire the map up from JavaScript.
   *
   * Not from inline onto*= attributes: those cannot be registered
   * { passive: false }, and a passive touchmove listener is forbidden from
   * calling preventDefault — so the browser goes on with its own gesture no
   * matter what the handler does.
   */
  function bindMap() {
    var el = $('loc-map');
    if (!el || el.__geoBound) return;
    el.__geoBound = true;
    // Safari zooms the PAGE on a pinch unless its own gesture events are
    // swallowed — see js/mapGestures.js. Without this the pinch below never
    // gets to run, which is the "the map does not zoom" report.
    window.MapGestures.blockPageZoom($('loc-map-wrap') || el);
    el.addEventListener('touchstart', onDown, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onUp, { passive: false });
    el.addEventListener('touchcancel', onUp, { passive: false });
    el.addEventListener('mousedown', onDown);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseup', onUp);
    el.addEventListener('mouseleave', onUp);
    // A trackpad or a mouse wheel zooms, about the pointer.
    el.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var rect = mapRect();
      var want = window.GeoZoom.clampZoom(Math.round(zoom) + (ev.deltaY < 0 ? 1 : -1));
      if (want === Math.round(zoom)) return;
      center = window.GeoZoom.zoomAbout(
        center, Math.round(zoom), want,
        { x: ev.clientX - rect.left, y: ev.clientY - rect.top }, rect.width, rect.height);
      zoom = want;
      draw();
    }, { passive: false });
  }

  function zoomBy(d) {
    zoom = window.GeoZoom.clampZoom(Math.round(zoom) + d);
    draw();
  }

  /** Send what is under the crosshair. `liveMinutes` 0 = a one-off pin. */
  function send(liveMinutes) {
    var liveUntil = liveMinutes > 0 ? Date.now() + liveMinutes * 60000 : null;
    if (liveUntil && !window.LocationPick.canShareLive(fix)) {
      alert('Live location needs to know where you are. Allow location access and try again.');
      return;
    }
    var payload = window.LocationPick.locationPayload({
      chosen: center, fix: fix, liveUntil: liveUntil, now: Date.now(),
    });
    window.socket.emit('send_message', {
      roomId: window.currentRoomId, type: 'location', content: JSON.stringify(payload),
    });
    close();
  }

  window.LocPicker = {
    open: open, close: close, send: send, zoomBy: zoomBy,
    recentre: function () { locate(true); },
    onDown: onDown, onMove: onMove, onUp: onUp,
  };
})();
