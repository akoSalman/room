// Tests for the download helpers (native-app/src/download.ts).
//
// The cache key is the interesting one: media URLs carry an HMAC signature
// that expires, so the SAME file arrives under a different query string every
// time its URL is refreshed. A key that included the query would silently
// re-download every video the user had already saved.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'dltest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'download.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping download tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const D = require(path.join(OUT, 'download.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('byte sizes read the way a person would say them', () => {
  assert.strictEqual(D.fmtBytes(0), '0 B');
  assert.strictEqual(D.fmtBytes(512), '512 B');
  assert.strictEqual(D.fmtBytes(2048), '2 KB');
  assert.strictEqual(D.fmtBytes(1024 * 1024 * 12.4), '12.4 MB');
  assert.strictEqual(D.fmtBytes(1024 * 1024 * 1024 * 2), '2.00 GB');
  assert.strictEqual(D.fmtBytes(-5), '0 B');
  assert.strictEqual(D.fmtBytes(NaN), '0 B');
});

test('a signed URL and its re-signed twin share one cache key', () => {
  // Exactly the regression this exists to prevent: the signature changes every
  // time the URL is minted, the file does not.
  const a = 'https://chat.example.com/uploads/clip-99.mp4?e=1700000000&s=AAAA';
  const b = 'https://chat.example.com/uploads/clip-99.mp4?e=1799999999&s=ZZZZ';
  assert.strictEqual(D.localNameFor(a), D.localNameFor(b));
  assert.ok(D.localNameFor(a).includes('clip-99.mp4'), 'the real filename is unrecognisable');
});

test('different files never collide', () => {
  const a = D.localNameFor('https://x.test/uploads/one.mp4');
  const b = D.localNameFor('https://x.test/uploads/two.mp4');
  assert.notStrictEqual(a, b);
});

test('a name that a filesystem would reject is made safe', () => {
  const n = D.localNameFor('https://x.test/uploads/my video (1)&x.mp4');
  assert.ok(!/[^\w.\-]/.test(n.replace(/^dl-/, '')), `unsafe characters survived: ${n}`);
});

test('percent-escaped names settle on one spelling', () => {
  assert.strictEqual(
    D.localNameFor('https://x.test/uploads/a%20b.mp4'),
    D.localNameFor('https://x.test/uploads/a b.mp4'),
  );
});

test('a fragment is not part of the key either', () => {
  assert.strictEqual(
    D.localNameFor('https://x.test/uploads/v.mp4#t=10'),
    D.localNameFor('https://x.test/uploads/v.mp4'),
  );
});

test('a URL with no filename still produces a name', () => {
  assert.ok(D.localNameFor('https://x.test/').length > 0);
  assert.ok(D.localNameFor('').length > 0);
});

test('the prefix keeps different caches apart', () => {
  assert.notStrictEqual(
    D.localNameFor('https://x.test/uploads/v.mp4', 'vid-'),
    D.localNameFor('https://x.test/uploads/v.mp4', 'dl-'),
  );
});

test('progress is a clamped percentage, and zero until the size is known', () => {
  assert.strictEqual(D.progressPercent(0, 0), 0);
  assert.strictEqual(D.progressPercent(500, 0), 0, 'progress without a total is not knowable');
  assert.strictEqual(D.progressPercent(50, 200), 25);
  assert.strictEqual(D.progressPercent(300, 200), 100, 'over 100% leaked out');
  assert.strictEqual(D.progressPercent(-10, 200), 0);
});

// ── The button on a video ───────────────────────────────────────────────────

test('the download button on a video is an arrow, with no word beside it', () => {
  // Asked for directly: "that download button on video should be just an
  // arrow, remove the text Download." The word said nothing the arrow did not,
  // on the one part of the screen that is meant to be a picture — and the
  // size, which IS worth knowing before pressing, sits above it either way.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'components', 'VideoBubble.tsx'), 'utf8');
  assert.ok(!/>\s*Download\s*</.test(src) && !src.includes("'Download'"),
    'the video still has the word "Download" on it');
  assert.ok(!src.includes("'Retry'"), 'the failed state still carries a word');
  assert.ok(/name=\{status === 'failed' \? 'refresh' : 'arrow-down'\}/.test(src),
    'the arrow is gone');
  // Unlabelled controls must still say what they are to a screen reader.
  assert.ok(/accessibilityLabel=\{status === 'failed'/.test(src),
    'the icon-only button has no accessible name');
});

test('what the download is COSTING is still shown while it runs', () => {
  // Removing the label must not take the byte counter with it: a progress
  // display with no numbers is what started this whole line of work.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'components', 'VideoBubble.tsx'), 'utf8');
  assert.ok(src.includes('fmtBytes(dl!.written)'), 'the running download no longer says how far it is');
  assert.ok(src.includes('fmtBytes(total)'), 'the size before pressing is gone');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
