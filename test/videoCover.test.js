// The picture on a video message.
//
// Asked for as: a preview of the video should be the cover of videos.
//
// Videos arrived as flat dark rectangles with a play triangle, identical for
// every video anyone had ever sent — so a chat full of them was a column of
// identical tiles and the only way to tell them apart was to open each one.
//
// The frame has to be extracted on the device (the server keeps the file as it
// was uploaded and there is no poster anywhere), which makes the interesting
// questions about cost: never doing the same work twice, never doing it at all
// when it would mean streaming a large file over a bad connection, and
// remembering the failures as well as the successes.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping video-cover tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'videocover-'));
execFileSync(TSC, [path.join(NAT, 'src', 'videoCover.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const V = require(path.join(OUT, 'videoCover.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE POINT: a video on the device gets a cover', () => {
  assert.strictEqual(V.shouldExtract({ local: true }), true);
});

test('the frame is not the very first one', () => {
  // Videos very often open on a black or half-exposed frame — the camera is
  // still settling, or the clip fades in — and a black thumbnail is no better
  // than the flat rectangle it replaces.
  assert.ok(V.FRAME_AT_MS > 0, 'the cover is taken from time zero, which is often black');
});

test('work already done, in flight, or known to fail is not repeated', () => {
  for (const status of ['done', 'working', 'failed']) {
    assert.strictEqual(
      V.shouldExtract({ local: true, state: { status, uri: 'x' } }), false,
      `a cover was extracted again while its state was "${status}"`);
  }
});

test('THE COST: a big remote video is left as a plain tile', () => {
  // Extracting from a URL streams part of the file. On a slow connection that
  // is real data spent on a picture nobody asked for.
  assert.strictEqual(
    V.shouldExtract({ local: false, sizeBytes: V.MAX_REMOTE_BYTES + 1, online: true }), false);
  assert.strictEqual(
    V.shouldExtract({ local: false, sizeBytes: V.MAX_REMOTE_BYTES, online: true }), true,
    'the limit is off by one');
});

test('a big video already downloaded is fine — it is read from disk', () => {
  assert.strictEqual(
    V.shouldExtract({ local: true, sizeBytes: V.MAX_REMOTE_BYTES * 10 }), true,
    'a local file was refused for its size, though nothing is downloaded to read it');
});

test('nothing is attempted while offline', () => {
  assert.strictEqual(V.shouldExtract({ local: false, sizeBytes: 1000, online: false }), false);
  // …but a local file needs no network at all.
  assert.strictEqual(V.shouldExtract({ local: true, online: false }), true);
});

test('an unknown size waits rather than guessing', () => {
  // The size arrives from the same HEAD the download button already makes.
  assert.strictEqual(V.shouldExtract({ local: false, online: true }), false);
  assert.strictEqual(V.shouldExtract({ local: false, sizeBytes: 0, online: true }), false);
});

test('a re-signed URL does not produce a second cover for the same video', () => {
  const a = V.coverKey('https://cdn.example.com/uploads/clip-9.mp4?sig=aaa&t=1');
  const b = V.coverKey('https://cdn.example.com/uploads/clip-9.mp4?sig=bbb&t=2');
  assert.strictEqual(a, b, 'the signature is part of the key, so every reissue re-extracts');
});

test('the local copy and the remote original share one cover', () => {
  const remote = V.coverKey('https://cdn.example.com/uploads/clip-9.mp4');
  const local = V.coverKey('file:///data/user/0/app/files/videos/clip-9.mp4');
  assert.strictEqual(remote, local, 'downloading a video re-extracts a cover it already had');
});

test('the key is safe to use as a filename', () => {
  const k = V.coverKey('https://x/y/../we ird%20name#frag?a=b');
  assert.ok(!/[^A-Za-z0-9._-]/.test(k), `"${k}" is not a usable filename`);
  assert.ok(k.length > 0 && k.length <= 120);
});

test('two different videos do not share a cover', () => {
  assert.notStrictEqual(V.coverKey('https://x/a.mp4'), V.coverKey('https://x/b.mp4'));
});

test('only a finished cover is drawn', () => {
  assert.strictEqual(V.coverToShow({ status: 'done', uri: 'file:///c.jpg' }), 'file:///c.jpg');
  for (const status of ['none', 'working', 'failed']) {
    assert.strictEqual(V.coverToShow({ status }), null, `"${status}" was drawn as a picture`);
  }
  assert.strictEqual(V.coverToShow(undefined), null);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const bubble = fs.readFileSync(path.join(NAT, 'src', 'components', 'VideoBubble.tsx'), 'utf8');
const store = fs.readFileSync(path.join(NAT, 'src', 'videoCoverStore.ts'), 'utf8');

test('the bubble draws the cover and asks for one', () => {
  assert.ok(bubble.includes('coverToShow('), 'the tile never draws a cover');
  assert.ok(bubble.includes('covers.ensureCover({'), 'nothing ever extracts one');
  assert.ok(/source: localUri \|\| url/.test(bubble),
    'the cover is pulled over the network even when the file is on the device');
});

test('the play mark stays visible over a real photograph', () => {
  assert.ok(/coverUri \? s\.playOnCover/.test(bubble),
    'the play triangle is drawn straight onto the frame, where it can vanish into it');
});

test('covers are kept where Android cannot delete them', () => {
  // The cache directory is emptied whenever the device is short of space, and
  // re-extracting means decoding every video in the chat again.
  assert.ok(/documentDirectory \+ 'covers\/'/.test(store), 'covers live in the cache directory');
  assert.ok(store.includes('moveAsync'), 'the extractor output is left in the cache');
});

test('a cover from an earlier run is adopted, not re-extracted', () => {
  assert.ok(/export async function hydrate/.test(store), 'nothing looks on disk first');
  assert.ok(store.includes('await hydrate(o.url)'), 'the disk is never consulted before working');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
