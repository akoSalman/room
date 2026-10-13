// ── The gallery with no connection, second time of asking ──────────────────
//
// Reported twice. The second time: "still gallery is not loaded after closing
// app and turning off internet and opening app again — gallery should keep
// downloaded files and images as download even after closing app several
// times".
//
// The first round fixed the LIST, which used to live in a Map that died with
// the process. That was necessary and not sufficient: a list of photographs is
// not photographs. Every tile in the grid asks the server to render
// /thumb/<name> on demand, so with no connection the grid is empty however
// many of those pictures the phone is holding — and it IS holding them, in
// mediaCache, every full-size one the person has looked at.
//
// The tile now falls back to that copy. The test that matters most here is the
// one about the trap: the obvious fix is to cache the thumbnails too, and it
// would quietly destroy every photo in the app.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping gallery offline tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'galleryoffline-'));
execFileSync(TSC, [path.join(NAT, 'src', 'galleryOffline.ts'), path.join(NAT, 'src', 'download.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const { fullImageUrl, tileUri, shouldLookLocally } = require(path.join(OUT, 'galleryOffline.js'));
const { localNameFor } = require(path.join(OUT, 'download.js'));

const BROWSER = fs.readFileSync(path.join(NAT, 'src', 'components', 'MediaBrowser.tsx'), 'utf8');
const CHAT = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

const BASE = 'https://chat.bistbarg.com';

test('THE TRAP: a thumbnail and its full photo share one cache key', () => {
  // This is why the gallery does NOT simply cache its thumbnails. mediaCache
  // keys on the basename with the query stripped, so writing a 96-pixel
  // thumbnail would overwrite the full-size photo under the same name, and
  // every bubble in the chat would start showing a blurred square.
  //
  // Nothing in the app does this today. The test exists so that the next
  // person who reaches for the obvious fix finds out here rather than from a
  // chat full of ruined pictures.
  const full = `${BASE}/uploads/1760-12.jpg?e=1760000000&s=abc&u=ali`;
  const thumb = `${BASE}/thumb/1760-12.jpg?w=96&e=1760000000&s=abc&u=ali`;
  assert.strictEqual(localNameFor(thumb, 'md-'), localNameFor(full, 'md-'),
    'thumb and full no longer collide — if that is deliberate, caching thumbnails is now safe and this comment is stale');
  // And the app still does not do it.
  assert.ok(!/fetchAndKeep\(\s*thumb/.test(BROWSER) && !/mediaCache\.fetchAndKeep\([^)]*thumb/i.test(CHAT),
    'something caches a thumbnail through mediaCache, which overwrites the full photo');
});

test('THE FIX: a tile falls back to the picture the device already has', () => {
  assert.strictEqual(tileUri({ thumb: 't.jpg', local: 'file:///x.jpg' }), 'file:///x.jpg',
    'the local copy is ignored, so the grid stays blank offline');
  assert.strictEqual(tileUri({ thumb: 't.jpg', local: null }), 't.jpg',
    'the thumbnail is not used when there is one');
  assert.strictEqual(tileUri({ thumb: null, local: null }), null,
    'something is drawn when there is nothing to draw');
});

test('…and only AFTER the thumbnail has failed', () => {
  // Asking up front would be a disk check for every tile in a grid of two
  // thousand, during the open the person is already waiting through — and
  // online the answer is never needed, because thumbnails do not fail.
  assert.strictEqual(shouldLookLocally({ failed: false, have: null }), false,
    'the device is searched before anything has gone wrong');
  assert.strictEqual(shouldLookLocally({ failed: true, have: null }), true,
    'a failed thumbnail never falls back, which is the whole bug');
  assert.strictEqual(shouldLookLocally({ failed: true, have: 'file:///x.jpg' }), false,
    'the device is searched again for a picture already found');
});

test('THE FULL PICTURE IS FOUND WHERE THE ITEM SAYS IT IS', () => {
  assert.strictEqual(fullImageUrl('/uploads/x.jpg?e=1&s=a', BASE), `${BASE}/uploads/x.jpg?e=1&s=a`);
  // A trailing slash on the base must not produce a double one, which is a
  // different URL and therefore a different cache key.
  assert.strictEqual(fullImageUrl('/uploads/x.jpg', `${BASE}/`), `${BASE}/uploads/x.jpg`);
  assert.strictEqual(fullImageUrl('uploads/x.jpg', BASE), `${BASE}/uploads/x.jpg`);
});

test('…and one that is already somewhere is left alone', () => {
  // A file already on this device must not have a host glued to the front of
  // it, and another origin's picture is not ours to rewrite.
  assert.strictEqual(fullImageUrl('file:///data/x.jpg', BASE), 'file:///data/x.jpg');
  assert.strictEqual(fullImageUrl('https://other.example/x.jpg', BASE), 'https://other.example/x.jpg');
});

test('NOTHING IS NOT A URL', () => {
  for (const [p, b] of [[null, BASE], ['', BASE], ['   ', BASE], ['/uploads/x.jpg', ''], [undefined, undefined]]) {
    assert.strictEqual(fullImageUrl(p, b), null, `${JSON.stringify(p)} with ${JSON.stringify(b)} produced a url`);
  }
});

// ── And that the grid actually uses it ──────────────────────────────────────

test('THE TILE ASKS, AND ONLY ONCE', () => {
  const cell = BROWSER.slice(BROWSER.indexOf('const Cell = memo('), BROWSER.indexOf('const Row = memo('));
  assert.ok(/onError=\{onFailed\}/.test(cell), 'a thumbnail that fails is simply left blank');
  assert.ok(/if \(asked\.current \|\| !offlineUri\) return;/.test(cell),
    'every failed render asks the disk again, for a tile that is recycled while scrolling');
  assert.ok(/asked\.current = true;/.test(cell), 'nothing records that it has already asked');
  assert.ok(/source=\{local \? \{ uri: local \} : mediaSource\(uri \|\| ''\)\}/.test(cell),
    'the local copy is fetched and never drawn');
});

test('…and the chat hands it the right picture', () => {
  const fn = /const offlineTileUri = useCallback\(async \(item: \{ url: string \}\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(CHAT);
  assert.ok(fn, 'nothing resolves a tile to the device');
  assert.ok(/fullImageUrl\(item\?\.url, BASE_URL\)/.test(fn[1]), 'the item is not turned into a url');
  assert.ok(/mediaCache\.peek\(full\)/.test(fn[1]),
    'it downloads rather than peeking, which with no connection is the bug again');
  assert.ok(!/fetchAndKeep/.test(fn[1]),
    'the fallback writes to the cache, under the key the full photo uses');
  assert.ok(/offlineUri=\{offlineTileUri\}/.test(CHAT), 'the resolver never reaches the browser');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
