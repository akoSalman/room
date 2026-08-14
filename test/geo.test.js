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

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
