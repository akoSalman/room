// ── Where map tiles come from ───────────────────────────────────────────────
//
// Reported three times as "the location picker does not work on zoom and
// pinch and move", and three times the gesture code was read and found
// correct — because it is correct. The tiles were not arriving. The map state
// changed on every gesture and not one pixel did, which from the outside is
// identical to a map that ignores your fingers.
//
// These tests are about the two things that let that happen: one upstream for
// the whole feature, and a failure that drew nothing and said nothing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../mapTiles');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THERE IS MORE THAN ONE PLACE TO GET A TILE', () => {
  // A single upstream is a single point of failure for the entire map, and
  // the people who use this app are behind a network that blocks things.
  assert.ok(M.DEFAULT_UPSTREAMS.length >= 2,
    'one unreachable host still takes the whole map with it');
  assert.ok(M.DEFAULT_UPSTREAMS.every(M.isTemplate),
    'a default upstream is not a usable tile template');
});

test('A CONFIGURED UPSTREAM REPLACES the defaults, never adds to them', () => {
  // An operator who has named a mirror they can reach does not want this
  // quietly falling back to a host their network drops.
  const one = M.upstreamsFrom({ TILE_UPSTREAM: 'https://mine.example/{z}/{x}/{y}.png' });
  assert.deepStrictEqual(one, ['https://mine.example/{z}/{x}/{y}.png']);
  const many = M.upstreamsFrom({ TILE_UPSTREAMS: 'https://a.example/{z}/{x}/{y}.png, https://b.example/{z}/{x}/{y}.png' });
  assert.strictEqual(many.length, 2);
  // TILE_UPSTREAMS wins over the older single setting.
  const both = M.upstreamsFrom({
    TILE_UPSTREAMS: 'https://a.example/{z}/{x}/{y}.png',
    TILE_UPSTREAM: 'https://old.example/{z}/{x}/{y}.png',
  });
  assert.deepStrictEqual(both, ['https://a.example/{z}/{x}/{y}.png']);
});

test('...and nonsense falls back rather than breaking the map', () => {
  // An empty or malformed setting must not leave the server with no upstream
  // at all, which would turn a typo into "no maps for anybody".
  assert.deepStrictEqual(M.upstreamsFrom({ TILE_UPSTREAM: '   ' }), M.DEFAULT_UPSTREAMS);
  assert.deepStrictEqual(M.upstreamsFrom({ TILE_UPSTREAM: 'not-a-url' }), M.DEFAULT_UPSTREAMS);
  assert.deepStrictEqual(M.upstreamsFrom({}), M.DEFAULT_UPSTREAMS);
  assert.deepStrictEqual(M.upstreamsFrom(null), M.DEFAULT_UPSTREAMS);
});

test('A TEMPLATE MISSING A COORDINATE IS REFUSED', () => {
  // It would return the same picture for every tile: a map of one place that
  // never changes, which is worse than no map because it looks like it works.
  assert.strictEqual(M.isTemplate('https://x.example/{z}/{x}.png'), false);
  assert.strictEqual(M.isTemplate('https://x.example/{x}/{y}.png'), false);
  assert.strictEqual(M.isTemplate('https://x.example/{z}/{y}.png'), false);
  assert.strictEqual(M.isTemplate('ftp://x.example/{z}/{x}/{y}.png'), false);
  assert.strictEqual(M.isTemplate('https://x.example/{z}/{x}/{y}.png'), true);
});

test('EVERY COORDINATE IS SUBSTITUTED', () => {
  assert.strictEqual(
    M.tileUrlFrom('https://x.example/{z}/{x}/{y}.png', 15, 21061, 12900),
    'https://x.example/15/21061/12900.png');
});

test('THE PROXY STAYS BOUNDED — it must never fetch an arbitrary URL', () => {
  // The reason this endpoint is strict at all. Loosening it to fix a map is
  // how a chat server becomes an open proxy.
  assert.strictEqual(M.tileInRange(15, 21061, 12900, 19), true);
  assert.strictEqual(M.tileInRange(20, 1, 1, 19), false, 'zoom above the cap was allowed');
  assert.strictEqual(M.tileInRange(-1, 0, 0, 19), false);
  assert.strictEqual(M.tileInRange(1, 2, 0, 19), false, 'x beyond the world was allowed');
  assert.strictEqual(M.tileInRange(1, 0, 2, 19), false, 'y beyond the world was allowed');
  assert.strictEqual(M.tileInRange(1.5, 0, 0, 19), false, 'a fractional zoom was allowed');
  assert.strictEqual(M.tileInRange(NaN, 0, 0, 19), false);
});

test('THE SERVER TRIES THEM ALL, and says so when none works', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/for \(const template of TILE_UPSTREAMS\)/.test(server),
    'the proxy still uses a single upstream');
  assert.ok(/\[tiles\]/.test(server),
    'a map that cannot load anything still fails silently');
  // The old single-host constant must be gone, or it is still the one in use.
  assert.ok(!/TILE_UPSTREAM\.replace/.test(server), 'the old single-upstream path is still live');
  // The request must be bounded, like every other outbound fetch here.
  assert.ok(/AbortSignal\.timeout\(\d+\)/.test(server),
    'a tile fetch that never settles holds the map open for ever');
});

test('THE LOG LINE NAMES NO HOST AND NO USER', () => {
  // It goes into a log that is read into a repository that has been public.
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const line = /\[tiles\][\s\S]{0,400}?\);/.exec(server);
  assert.ok(line, 'could not find the tile log line');
  assert.ok(!/username|token/i.test(line[0]), 'the tile log line carries a name or a token');
  assert.ok(!/https?:\/\//.test(line[0]), 'the tile log line names an upstream host');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
