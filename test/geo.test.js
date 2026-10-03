// Tests for the map maths (native-app/src/geo.ts).
//
// The Web Mercator projection drives every pixel on the map: which tiles get
// fetched, and where each person's marker lands. Getting it slightly wrong
// puts markers in the wrong place in a way that is very hard to spot by eye on
// a device, so it is checked here against known reference values instead.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'geotest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'geo.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping geo tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const G = require(path.join(OUT, 'geo.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tolerance ${tol})`);

const TEHRAN = { lat: 35.6892, lng: 51.3890 };
const LONDON = { lat: 51.5074, lng: -0.1278 };

// The canonical slippy-map formulas from the OSM wiki, written a DIFFERENT way
// from the implementation (asinh/tan rather than log of the sine ratio). They
// are mathematically equivalent, so agreement is a real cross-check rather
// than the implementation grading its own homework.
function refTileX(lng, z) { return ((lng + 180) / 360) * Math.pow(2, z); }
function refTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * Math.pow(2, z);
}

test('the projection agrees with the canonical slippy-map formulas', () => {
  for (const z of [3, 8, 12, 16]) {
    for (const p of [TEHRAN, LONDON, { lat: -33.86, lng: 151.21 }, { lat: 0, lng: 0 }]) {
      near(G.lngToWorldX(p.lng, z) / G.TILE_SIZE, refTileX(p.lng, z), 1e-9,
        `tile x at z${z} for ${p.lat},${p.lng}`);
      near(G.latToWorldY(p.lat, z) / G.TILE_SIZE, refTileY(p.lat, z), 1e-9,
        `tile y at z${z} for ${p.lat},${p.lng}`);
    }
  }
});

test('projection round-trips', () => {
  for (const z of [3, 10, 16]) {
    for (const p of [TEHRAN, LONDON, { lat: 0, lng: 0 }, { lat: -33.86, lng: 151.21 }]) {
      near(G.worldXToLng(G.lngToWorldX(p.lng, z), z), p.lng, 1e-9, `lng round-trip z${z}`);
      near(G.worldYToLat(G.latToWorldY(p.lat, z), z), p.lat, 1e-9, `lat round-trip z${z}`);
    }
  }
});

test('the equator sits halfway down the world, and the prime meridian halfway across', () => {
  const z = 5;
  const scale = G.TILE_SIZE * Math.pow(2, z);
  near(G.latToWorldY(0, z), scale / 2, 1e-6, 'equator');
  near(G.lngToWorldX(0, z), scale / 2, 1e-6, 'prime meridian');
});

test('latitude is clamped at the Mercator cutoff rather than going infinite', () => {
  const y = G.latToWorldY(90, 10);
  assert.ok(isFinite(y), 'north pole produced a non-finite pixel');
  assert.ok(isFinite(G.latToWorldY(-90, 10)), 'south pole produced a non-finite pixel');
});

test('distance matches known separations', () => {
  // Tehran → London is about 4400 km.
  const d = G.distanceMeters(TEHRAN, LONDON);
  near(d / 1000, 4400, 60, 'Tehran to London km');
  assert.strictEqual(Math.round(G.distanceMeters(TEHRAN, TEHRAN)), 0, 'zero distance');
  // One degree of latitude is ~111 km anywhere.
  near(G.distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) / 1000, 111.19, 0.5, 'one degree lat');
});

test('distance formatting reads naturally', () => {
  assert.strictEqual(G.formatDistance(0), '0 m');
  assert.strictEqual(G.formatDistance(940), '940 m');
  assert.strictEqual(G.formatDistance(1500), '1.5 km');
  assert.strictEqual(G.formatDistance(42000), '42 km');
});

test('the centre point lands in the middle of the viewport', () => {
  const p = G.pointToScreen(TEHRAN, TEHRAN, 14, 300, 200);
  near(p.x, 150, 1e-6, 'centre x');
  near(p.y, 100, 1e-6, 'centre y');
});

test('a point east and north of centre draws right and up', () => {
  const other = { lat: TEHRAN.lat + 0.01, lng: TEHRAN.lng + 0.01 };
  const p = G.pointToScreen(other, TEHRAN, 14, 300, 200);
  assert.ok(p.x > 150, 'further east should be further right');
  assert.ok(p.y < 100, 'further north should be higher up');
});

test('tiles cover the whole viewport with none missing', () => {
  const W = 400, H = 300;
  const tiles = G.tilesForViewport(TEHRAN, 14, W, H);
  assert.ok(tiles.length > 0, 'no tiles produced');
  // Every pixel of the viewport must fall inside some tile.
  for (const [px, py] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [W / 2, H / 2]]) {
    const hit = tiles.some(t =>
      px >= t.left && px < t.left + G.TILE_SIZE && py >= t.top && py < t.top + G.TILE_SIZE);
    assert.ok(hit, `viewport pixel ${px},${py} is not covered by any tile`);
  }
});

test('tile indices stay inside the world at every zoom', () => {
  for (const z of [3, 8, 14, 18]) {
    const n = Math.pow(2, z);
    for (const t of G.tilesForViewport(TEHRAN, z, 400, 300)) {
      assert.ok(t.x >= 0 && t.x < n, `tile x ${t.x} out of range at z${z}`);
      assert.ok(t.y >= 0 && t.y < n, `tile y ${t.y} out of range at z${z}`);
    }
  }
});

test('panning moves the map the way a finger expects', () => {
  // Dragging the map to the right (positive dx) should reveal what is WEST,
  // i.e. the centre longitude decreases.
  const moved = G.panCenter(TEHRAN, 14, 100, 0);
  assert.ok(moved.lng < TEHRAN.lng, 'dragging right did not move west');
  const up = G.panCenter(TEHRAN, 14, 0, -100);
  assert.ok(up.lat < TEHRAN.lat, 'dragging up did not move south');
});

test('panning then panning back returns to the start', () => {
  const there = G.panCenter(TEHRAN, 14, 120, -80);
  const back = G.panCenter(there, 14, -120, 80);
  near(back.lat, TEHRAN.lat, 1e-9, 'lat did not return');
  near(back.lng, TEHRAN.lng, 1e-9, 'lng did not return');
});

test('zoomToFit keeps both points on screen', () => {
  const z = G.zoomToFit([TEHRAN, LONDON], 400, 300);
  const a = G.pointToScreen(TEHRAN, G.centerOf([TEHRAN, LONDON]), z, 400, 300);
  const b = G.pointToScreen(LONDON, G.centerOf([TEHRAN, LONDON]), z, 400, 300);
  for (const p of [a, b]) {
    assert.ok(p.x >= 0 && p.x <= 400, `x ${p.x} off screen at zoom ${z}`);
    assert.ok(p.y >= 0 && p.y <= 300, `y ${p.y} off screen at zoom ${z}`);
  }
});

test('tiles are requested from our own server, not a foreign one', () => {
  // Foreign tile hosts are blocked for users in Iran; the chat server is not.
  const u = G.tileUrl(3, 4, 5, 'https://chat.example.com');
  assert.strictEqual(u, 'https://chat.example.com/tiles/5/3/4.png');
  assert.ok(!/openstreetmap\.org/.test(u), 'the tile URL still points straight at OSM');
});

test('location payloads are parsed, and rubbish is rejected', () => {
  assert.deepStrictEqual(G.parseLocation('{"lat":35.1,"lng":51.2}'), { lat: 35.1, lng: 51.2 });
  assert.strictEqual(G.parseLocation('not json'), null);
  assert.strictEqual(G.parseLocation('{"lat":"35","lng":51}'), null, 'string lat accepted');
  assert.strictEqual(G.parseLocation('{"lat":95,"lng":51}'), null, 'impossible latitude accepted');
  assert.strictEqual(G.parseLocation('{"lat":35,"lng":200}'), null, 'impossible longitude accepted');
  assert.strictEqual(G.parseLocation(null), null);
});

test('live shares expire', () => {
  const now = 1_000_000;
  assert.strictEqual(G.isLiveNow({ lat: 1, lng: 1, liveUntil: now + 1000 }, now), true);
  assert.strictEqual(G.isLiveNow({ lat: 1, lng: 1, liveUntil: now - 1 }, now), false);
  assert.strictEqual(G.isLiveNow({ lat: 1, lng: 1 }, now), false, 'a plain pin is not live');
});

test('remaining time reads naturally', () => {
  const now = 1_000_000;
  assert.strictEqual(G.formatRemaining(now + 45 * 1000, now), '45s left');
  assert.strictEqual(G.formatRemaining(now + 5 * 60 * 1000, now), '5m left');
  assert.strictEqual(G.formatRemaining(now + 2.5 * 3600 * 1000, now), '2h 30m left');
  assert.strictEqual(G.formatRemaining(now - 1, now), 'ended');
});


// ── Pinch to zoom ────────────────────────────────────────────────────────────

test('a pinch scale converts to whole zoom levels', () => {
  // Doubling the distance between the fingers is exactly one zoom level.
  assert.strictEqual(G.pinchZoomDelta(2), 1);
  assert.strictEqual(G.pinchZoomDelta(4), 2);
  assert.strictEqual(G.pinchZoomDelta(0.5), -1);
  assert.strictEqual(G.pinchZoomDelta(1), 0);
  // A nonsense scale must not produce NaN and send the map to nowhere.
  assert.strictEqual(G.pinchZoomDelta(0), 0);
  assert.strictEqual(G.pinchZoomDelta(-3), 0);
});

test('screen position round-trips back to the same place', () => {
  const center = { lat: 35.6892, lng: 51.389 };  // Tehran
  const W = 360, H = 640;
  const pt = { x: 90, y: 500 };
  const ll = G.screenToLatLng(pt, center, 14, W, H);
  const back = G.pointToScreen(ll, center, 14, W, H);
  assert.ok(Math.abs(back.x - pt.x) < 1e-6, `x drifted to ${back.x}`);
  assert.ok(Math.abs(back.y - pt.y) < 1e-6, `y drifted to ${back.y}`);
});

test('the centre of the screen is the map centre', () => {
  const center = { lat: 35.6892, lng: 51.389 };
  const ll = G.screenToLatLng({ x: 180, y: 320 }, center, 14, 360, 640);
  assert.ok(Math.abs(ll.lat - center.lat) < 1e-9);
  assert.ok(Math.abs(ll.lng - center.lng) < 1e-9);
});

test('pinching keeps the place under your fingers under your fingers', () => {
  // The behaviour that makes a map feel like a map: zoom in on a corner and
  // that corner must not fly off towards the middle.
  const center = { lat: 35.6892, lng: 51.389 };
  const W = 360, H = 640;
  const focal = { x: 60, y: 120 };   // well away from the centre
  const before = G.screenToLatLng(focal, center, 14, W, H);
  const newCenter = G.zoomAbout(center, 14, 16, focal, W, H);
  const after = G.screenToLatLng(focal, newCenter, 16, W, H);
  assert.ok(Math.abs(after.lat - before.lat) < 1e-9, `lat moved by ${after.lat - before.lat}`);
  assert.ok(Math.abs(after.lng - before.lng) < 1e-9, `lng moved by ${after.lng - before.lng}`);
});

test('pinching about the centre leaves the centre alone', () => {
  const center = { lat: 35.6892, lng: 51.389 };
  const c2 = G.zoomAbout(center, 14, 17, { x: 180, y: 320 }, 360, 640);
  assert.ok(Math.abs(c2.lat - center.lat) < 1e-9);
  assert.ok(Math.abs(c2.lng - center.lng) < 1e-9);
});

// ── One pin per person ───────────────────────────────────────────────────────
//
// Reported as: after a live location expires, the map shows two or three
// "You". Every share is its own message, and an expired one stays frozen where
// the sharing stopped while looking exactly as current as a live one.

const pin = (id, username, payload, mine = false) => ({ id, username, payload, mine });
const NOW = 1_700_000_000_000;

test('THE BUG: expired shares from the same person collapse to one pin', () => {
  const out = G.dedupePins([
    pin(1, 'ako', { lat: 1, lng: 1, liveUntil: NOW - 60_000, updatedAt: NOW - 70_000 }, true),
    pin(2, 'ako', { lat: 2, lng: 2, liveUntil: NOW - 30_000, updatedAt: NOW - 40_000 }, true),
    pin(3, 'ako', { lat: 3, lng: 3, liveUntil: NOW - 10_000, updatedAt: NOW - 20_000 }, true),
  ], null, NOW);
  assert.strictEqual(out.length, 1, `showed ${out.length} pins for one person`);
  assert.strictEqual(out[0].id, 3, 'kept an older pin instead of the most recent');
});

test('a live share wins over a newer expired one', () => {
  // Freshness is not the point — being true right now is.
  const out = G.dedupePins([
    pin(1, 'ako', { lat: 1, lng: 1, liveUntil: NOW + 600_000, updatedAt: NOW - 500_000 }, true),
    pin(2, 'ako', { lat: 2, lng: 2, liveUntil: NOW - 1, updatedAt: NOW - 10 }, true),
  ], null, NOW);
  assert.deepStrictEqual(out.map(p => p.id), [1]);
});

test('different people each keep their own pin', () => {
  const out = G.dedupePins([
    pin(1, 'ako', { lat: 1, lng: 1, updatedAt: 10 }),
    pin(2, 'soran', { lat: 2, lng: 2, updatedAt: 20 }),
    pin(3, 'sahar', { lat: 3, lng: 3, updatedAt: 30 }),
  ], null, NOW);
  assert.strictEqual(out.length, 3);
});

test('my own pins collapse together however they are named', () => {
  // `mine` is the fact that matters; the username on an old message may differ.
  const out = G.dedupePins([
    pin(1, 'ako', { lat: 1, lng: 1, updatedAt: 10 }, true),
    pin(2, 'ako.old', { lat: 2, lng: 2, updatedAt: 20 }, true),
  ], null, NOW);
  assert.deepStrictEqual(out.map(p => p.id), [2]);
});

test('the pin the user actually tapped is never hidden', () => {
  // Opening the map from an old location message must show that message.
  const out = G.dedupePins([
    pin(1, 'ako', { lat: 1, lng: 1, updatedAt: 10 }, true),
    pin(2, 'ako', { lat: 2, lng: 2, updatedAt: 99 }, true),
  ], 1, NOW);
  assert.deepStrictEqual(out.map(p => p.id), [1, 2]);
});

test('pins come back in the order they were given', () => {
  const out = G.dedupePins([
    pin(5, 'zed', { lat: 1, lng: 1, updatedAt: 10 }),
    pin(6, 'amy', { lat: 2, lng: 2, updatedAt: 20 }),
  ], null, NOW);
  assert.deepStrictEqual(out.map(p => p.id), [5, 6]);
});

test('pins with no timestamps at all still collapse to one', () => {
  const out = G.dedupePins([
    pin(1, 'ako', { lat: 1, lng: 1 }, true),
    pin(2, 'ako', { lat: 2, lng: 2 }, true),
  ], null, NOW);
  assert.strictEqual(out.length, 1);
});

test('zooming a level at a time lands where zooming straight there would', () => {
  // The map now commits each zoom level DURING the pinch instead of saving the
  // whole gesture for the release, so the picture sharpens as the fingers
  // move. That is only safe if stepping 14→15→16 about a focal point puts the
  // map exactly where 14→16 in one go would — otherwise the map creeps a
  // little further off target with every level a pinch happens to cross.
  const center = { lat: 35.6892, lng: 51.389 };
  const W = 360, H = 640;
  const focal = { x: 60, y: 120 };

  const direct = G.zoomAbout(center, 14, 16, focal, W, H);
  const step1 = G.zoomAbout(center, 14, 15, focal, W, H);
  const stepped = G.zoomAbout(step1, 15, 16, focal, W, H);

  assert.ok(Math.abs(stepped.lat - direct.lat) < 1e-9,
    `lat drifted by ${stepped.lat - direct.lat} when zooming in steps`);
  assert.ok(Math.abs(stepped.lng - direct.lng) < 1e-9,
    `lng drifted by ${stepped.lng - direct.lng} when zooming in steps`);
});

test('zooming back out about the same point returns to the start', () => {
  // Pinch in past a level and back out again — a very ordinary thing to do
  // mid-gesture — and the map must not have wandered.
  const center = { lat: 35.6892, lng: 51.389 };
  const W = 360, H = 640;
  const focal = { x: 300, y: 500 };
  const inOne = G.zoomAbout(center, 14, 15, focal, W, H);
  const back = G.zoomAbout(inOne, 15, 14, focal, W, H);
  assert.ok(Math.abs(back.lat - center.lat) < 1e-9, `lat off by ${back.lat - center.lat}`);
  assert.ok(Math.abs(back.lng - center.lng) < 1e-9, `lng off by ${back.lng - center.lng}`);
});

test('half a zoom level of pinch is enough to move a level', () => {
  // The old behaviour rounded the whole gesture at release, so anything short
  // of a full 2x pinch rounded back to the level it started on and the pinch
  // did nothing at all. ~1.41x is half a level and must round up.
  assert.strictEqual(G.clampZoom(14 + G.pinchZoomDelta(1.5)), 15);
  assert.strictEqual(G.clampZoom(14 + G.pinchZoomDelta(0.67)), 13);
  // And a nudge really is still a nudge.
  assert.strictEqual(G.clampZoom(14 + G.pinchZoomDelta(1.1)), 14);
});

test('zoom never leaves the range the tile server serves', () => {
  assert.strictEqual(G.clampZoom(99), G.MAX_ZOOM);
  assert.strictEqual(G.clampZoom(-4), G.MIN_ZOOM);
  assert.strictEqual(G.clampZoom(14.4), 14);
  assert.strictEqual(G.clampZoom(14.6), 15);
});

// ── The web map ─────────────────────────────────────────────────────────────
//
// Reported as: swiping the map to move it closes the map, as though the swipe
// were the back button — and pinching to zoom does nothing.
//
// Both came from the same fault: the map never really took the touch. It
// listened through inline HTML attributes (which cannot be registered
// { passive: false }, so preventDefault is ignored), handled exactly one
// finger, and left the browser free to run its own edge-swipe — which
// navigates BACK, and back in a single-page app closes whatever is open.

global.window = global;
require(path.join(__dirname, '..', 'public', 'js', 'geoZoom.js'));
const Z = global.window.GeoZoom;

const WEB = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'locpicker.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');

test('THE BUG: the map claims the touch instead of leaving it to the browser', () => {
  // A passive touchmove listener may not call preventDefault, so the browser
  // carries on with its own gesture whatever the handler does.
  assert.ok(/addEventListener\('touchstart', onDown, \{ passive: false \}\)/.test(WEB),
    'touchstart is not bound non-passively');
  assert.ok(/addEventListener\('touchmove', onMove, \{ passive: false \}\)/.test(WEB),
    'touchmove is not bound non-passively — the swipe still goes to the browser');
  assert.ok(!/ontouchstart="LocPicker/.test(HTML) && !/ontouchmove="LocPicker/.test(HTML),
    'the inline attribute handlers are back, and they cannot be non-passive');
  assert.ok(WEB.includes('bindMap()'), 'nothing ever binds the map');
});

test('and it says so declaratively as well', () => {
  // BOTH elements: the wrapper is the one that scrolls and overscrolls, and
  // the inner map is the one the finger actually lands on. Checking a slice
  // spanning the two passes when either has the properties, which is exactly
  // the mistake that lets one of them lose them.
  const blockFor = (sel) => {
    const i = CSS.indexOf(sel + ' {');
    assert.ok(i > -1, `${sel} is gone — this check would be vacuous`);
    return CSS.slice(i, CSS.indexOf('}', i));
  };
  for (const sel of ['#loc-map-wrap', '#loc-map']) {
    const block = blockFor(sel);
    assert.ok(/touch-action: none/.test(block), `${sel} does not claim the gesture in CSS`);
    assert.ok(/overscroll-behavior: none/.test(block),
      `${sel} still lets a horizontal drag become the browser's swipe-to-go-back`);
  }
});

test('the drag is prevented from the FIRST event, not after the browser has begun', () => {
  const down = WEB.slice(WEB.indexOf('function onDown('), WEB.indexOf('function onMove('));
  assert.ok(down.includes('preventDefault()'),
    'the browser gets a head start on its own gesture before we object');
});

test('THE OTHER HALF: two fingers pinch, about their midpoint', () => {
  assert.ok(WEB.includes('touchPair('), 'two fingers are still ignored');
  assert.ok(WEB.includes('GeoZoom.pinchZoomDelta('), 'the pinch is not turned into zoom levels');
  assert.ok(/GeoZoom\.zoomAbout\(\s*\n?\s*center/.test(WEB),
    'zooming does not keep the place between the fingers where it was');
});

test('a second finger landing mid-drag becomes a pinch', () => {
  const move = WEB.slice(WEB.indexOf('function onMove('), WEB.indexOf('function onUp('));
  assert.ok(/if \(drag\.kind !== 'pinch'\)/.test(move),
    'a drag that grows a second finger goes on panning from one of them');
});

test('lifting one finger out of a pinch does not fling the map', () => {
  const up = WEB.slice(WEB.indexOf('function onUp('), WEB.indexOf('function bindMap('));
  assert.ok(up.includes("drag.kind === 'pinch'"),
    'the remaining finger continues the pan from wherever the pinch left it');
});

// ── The two maps must agree ─────────────────────────────────────────────────

test('the web zoom maths matches the app, everywhere it matters', () => {
  let checked = 0;
  const places = [TEHRAN, LONDON, { lat: -33.86, lng: 151.2 }, { lat: 0, lng: 0 }];
  const size = { w: 360, h: 300 };
  for (const c of places) {
    for (const z of [3, 8, 12, 15, 18]) {
      for (const nz of [z - 1, z, z + 1, z + 3]) {
        for (const focal of [{ x: 0, y: 0 }, { x: 180, y: 150 }, { x: 359, y: 299 }]) {
          const a = Z.zoomAbout(c, z, nz, focal, size.w, size.h);
          const b = G.zoomAbout(c, z, nz, focal, size.w, size.h);
          near(a.lat, b.lat, 1e-9, `zoomAbout lat drifted at z${z}→${nz}`);
          near(a.lng, b.lng, 1e-9, `zoomAbout lng drifted at z${z}→${nz}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 150, `the drift check only ran ${checked} times`);
  for (const s of [0.25, 0.5, 0.9, 1, 1.1, 2, 4, 0, -1]) {
    assert.strictEqual(Z.pinchZoomDelta(s), G.pinchZoomDelta(s), `pinchZoomDelta drifted at ${s}`);
  }
  for (const z of [-5, 0, 3, 3.4, 12.6, 18, 25]) {
    assert.strictEqual(Z.clampZoom(z), G.clampZoom(z), `clampZoom drifted at ${z}`);
  }
  assert.strictEqual(Z.MIN_ZOOM, G.MIN_ZOOM);
  assert.strictEqual(Z.MAX_ZOOM, G.MAX_ZOOM);
});

test('the projection itself agrees, or every tile would be in the wrong place', () => {
  for (const c of [TEHRAN, LONDON, { lat: 85, lng: 179 }, { lat: -85, lng: -179 }]) {
    for (const z of [3, 10, 18]) {
      const a = Z.screenToLatLng({ x: 40, y: 90 }, c, z, 360, 300);
      const b = G.screenToLatLng({ x: 40, y: 90 }, c, z, 360, 300);
      near(a.lat, b.lat, 1e-9, 'screenToLatLng lat drifted');
      near(a.lng, b.lng, 1e-9, 'screenToLatLng lng drifted');
    }
  }
});

// ── The app's own back gesture must not fight a map ─────────────────────────

test('the app never runs its edge-back gesture while a map is open', () => {
  const screen = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const gate = screen.slice(screen.indexOf('<EdgeBack'), screen.indexOf('<KeyboardAvoidingView'));
  assert.ok(gate.includes('openLocationId == null'), 'the fullscreen map can be swiped away');
  assert.ok(gate.includes('!showLocationPicker'), 'the picker can be swiped away mid-drag');
});

// ── The pin that was tapped is the pin that opens ───────────────────────────
//
// Reported as: "the map still is a solid image and could not be zoomed by
// pinching or moving around on map". The still preview in the bubble is meant
// to be a picture — tapping it opens the real map. What was NOT meant is that
// the real map could not find the message it was opened for: the chat screen
// dropped every static pin belonging to somebody who is sharing live, and the
// fullscreen view falls back to pins[0], or to nothing at all. With nothing to
// draw it renders null, the still preview stays on screen, and the map is
// exactly what it was reported as: an image that does not move.

test('THE BUG: the chat screen keeps the pin being opened, live share or not', () => {
  // The screen's own filter, reproduced: a static pin survives if its sender
  // is not sharing live OR it is the one being opened.
  const build = (messages, openId) => {
    const byUser = new Map();
    const loose = [];
    for (const m of messages) {
      const p = { id: m.id, username: m.username, payload: m.payload };
      if (G.isLiveNow(m.payload, NOW)) byUser.set(m.username, p);
      else loose.push(p);
    }
    return [...byUser.values(), ...loose.filter(p =>
      !byUser.has(p.username) || String(p.id) === String(openId))];
  };
  const messages = [
    { id: 7, username: 'ako', payload: { lat: 1, lng: 1 } },                        // an old pin
    { id: 9, username: 'ako', payload: { lat: 2, lng: 2, liveUntil: NOW + 60_000 } }, // sharing now
  ];
  const opened = build(messages, 7);
  assert.ok(opened.some(p => String(p.id) === '7'),
    'the tapped pin was dropped, so the fullscreen map had nothing to open');
  // And dedupePins, which the view applies next, keeps it too.
  const shown = G.dedupePins(opened.map(p => ({ ...p, mine: false })), 7, NOW);
  assert.ok(shown.some(p => String(p.id) === '7'), 'the view then dropped it again');
  // Nothing else changed: with no pin open, the old one still gives way.
  assert.deepStrictEqual(build(messages, null).map(p => p.id), [9]);

  // …and the screen really does filter that way, rather than this test having
  // proved a rule that lives only in this file.
  const chat = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const fn = chat.slice(chat.indexOf('const locationPins = useMemo'),
    chat.indexOf('const locationPins = useMemo') + 1600);
  assert.ok(/String\(p\.id\) === String\(openLocationId\)/.test(fn),
    'the screen still drops the pin the user tapped');
  assert.ok(/\}, \[messages, me, clockTick, openLocationId\]\)/.test(fn),
    'the list is not rebuilt when a different pin is opened, so it keeps the last one');
});

test('the still preview says the real map is one tap away', () => {
  const ROOT = path.join(__dirname, '..');
  const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  assert.ok(/locExpand/.test(chat), 'the app preview looks like a map but cannot be pinched, and says nothing');
  assert.ok(/loc-expand/.test(app), 'the web preview says nothing either');
  assert.ok(/\.loc-expand \{/.test(css), 'the badge has no style, so it is invisible');
  // And it must not eat the tap that opens the map.
  const rule = css.slice(css.indexOf('.loc-expand {'), css.indexOf('.loc-expand {') + 400);
  assert.ok(/pointer-events: none/.test(rule), 'the badge swallows the tap it exists to advertise');
});

// ── The live-location bar ───────────────────────────────────────────────────
//
// Asked for: "when tapping live location bar anywhere in any chat, user should
// be conducted to the exact message of location". The bar follows you into
// every chat — the share keeps running when you leave the conversation — but
// tapping it only jumped when the share happened to be in the chat already
// open, which is the one case where the message is easy to find by hand. From
// anywhere else it was a dead label.

test('THE BUG: the bar opens the share\'s own chat, from any other chat', () => {
  const ROOT = path.join(__dirname, '..');
  const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const at = chat.indexOf('{liveShare ? (() => {');
  assert.ok(at > -1, 'the live bar moved');
  const bar = chat.slice(at, chat.indexOf('})() : null}', at));

  assert.ok(/if \(here\) jumpToMessage\(target\);/.test(bar),
    'tapping the bar in the share\'s own chat no longer scrolls to the message');
  assert.ok(/else onOpenRoom!\(liveShare\.room, target\)/.test(bar),
    'from another chat the bar still does nothing');
  // The tap is only offered when it can actually land somewhere.
  assert.ok(/const canJump = Number\.isFinite\(target\) && \(here \|\| !!\(liveShare\.room && onOpenRoom\)\)/.test(bar),
    'the bar offers a jump it cannot make, or refuses one it can');
  assert.ok(/disabled=\{!canJump\}/.test(bar), 'the label is pressable when there is nowhere to go');
});

test('the chat is carried with the share, not looked up on the tap', () => {
  // An id alone would have to be fetched before anything could open, so the
  // first tap would do nothing at all.
  const ROOT = path.join(__dirname, '..');
  const lm = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'locationManager.ts'), 'utf8');
  const active = lm.slice(lm.indexOf('export function activeShare()'),
    lm.indexOf('export function activeShare()') + 300);
  assert.ok(/room: active\.room/.test(active), 'the share does not remember which chat it belongs to');
  assert.ok(/room: room \|\| null/.test(lm), 'startSharing throws the chat away');
  const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const call = chat.slice(chat.indexOf('locationManager.startSharing('),
    chat.indexOf('locationManager.startSharing(') + 400);
  assert.ok(/\n\s*room\)\.catch/.test(call), 'the chat is never passed in, so the bar has nothing to open');
});

test('the app knows how to open another chat on a given message', () => {
  const ROOT = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(ROOT, 'native-app', 'App.tsx'), 'utf8');
  const at = app.indexOf('onOpenRoom={');
  assert.ok(at > -1, 'ChatScreen is never given a way to open another chat');
  const prop = app.slice(at, at + 200);
  assert.ok(/setRoom\(r\)/.test(prop) && /setPendingJumpMsgId\(msgId\)/.test(prop)
    && /setScreen\('chat'\)/.test(prop),
    'the other chat opens without landing on the message, which is the point of the tap');
  const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/onOpenRoom\?: \(room: any, msgId: number\) => void;/.test(chat),
    'the prop is passed but not declared, so it is dropped');
  // The message is landed on when that chat mounts.
  assert.ok(/if \(initialJumpMsgId\) setTimeout\(\(\) => jumpToMessage\(initialJumpMsgId\)/.test(chat),
    'nothing acts on the pending jump, so the chat opens at the bottom');
});

test('A MAP WITH NO PICTURES SAYS SO', () => {
  // The whole reason this exists. Reported three times as "pinch and zoom and
  // move do not work"; they worked, and the map had nothing to draw. A grey
  // rectangle that does not move when pushed is indistinguishable from a map
  // that ignores your fingers, and sent three rounds of looking at the wrong
  // code.
  assert.strictEqual(G.tilesUnavailable({ failed: 3, loaded: 0 }), true);
  assert.strictEqual(G.tilesUnavailable({ failed: 40, loaded: 0 }), true);
});

test('...but ONE picture arriving means the map is fine', () => {
  // A gap at the coast, the edge of the world, a request that lost its race
  // with a pan -- those are holes in a working map, not a broken one. Crying
  // off then would be its own kind of lie.
  assert.strictEqual(G.tilesUnavailable({ failed: 40, loaded: 1 }), false);
  assert.strictEqual(G.tilesUnavailable({ failed: 3, loaded: 9 }), false);
});

test('...and it does not panic at the first miss', () => {
  assert.strictEqual(G.tilesUnavailable({ failed: 0, loaded: 0 }), false);
  assert.strictEqual(G.tilesUnavailable({ failed: 1, loaded: 0 }), false);
  assert.strictEqual(G.tilesUnavailable({ failed: 2, loaded: 0 }), false);
  // Nonsense is not an outage either.
  assert.strictEqual(G.tilesUnavailable({}), false);
  assert.strictEqual(G.tilesUnavailable(null), false);
});

test('THE MAP ACTUALLY COUNTS ITS TILES AND SHOWS THE NOTICE', () => {
  // The rule is worth nothing if nothing feeds it or nothing draws it.
  const map = fs.readFileSync(path.join(__dirname, '..',
    'native-app', 'src', 'components', 'TileMap.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/onError=\{\(\) => setTileCounts/.test(map), 'failed tiles are not counted');
  assert.ok(/onLoad=\{\(\) => setTileCounts/.test(map), 'loaded tiles are not counted');
  assert.ok(/tilesUnavailable\(tileCounts\)/.test(map), 'the rule is never consulted');
  assert.ok(/noTiles && \(/.test(map), 'the notice is never drawn');
  // It must not eat the gestures it exists to explain.
  assert.ok(/style=\{s\.noTiles\} pointerEvents="none"/.test(map),
    'the notice takes touches, so it would break the panning it is explaining');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
