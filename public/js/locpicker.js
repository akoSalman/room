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

  // ── Dragging the map under the pin ────────────────────────────────────────
  function onDown(e) {
    var p = e.touches ? e.touches[0] : e;
    drag = { x: p.clientX, y: p.clientY, lat: center.lat, lng: center.lng };
  }
  function onMove(e) {
    if (!drag) return;
    e.preventDefault();
    var p = e.touches ? e.touches[0] : e;
    var z = Math.round(zoom);
    var dx = p.clientX - drag.x, dy = p.clientY - drag.y;
    center = {
      lng: xToLng(lngToX(drag.lng, z) - dx / TILE, z),
      lat: yToLat(latToY(drag.lat, z) - dy / TILE, z),
    };
    draw();
  }
  function onUp() { drag = null; }

  function zoomBy(d) {
    zoom = Math.max(3, Math.min(18, Math.round(zoom) + d));
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
