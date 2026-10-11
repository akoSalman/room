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

// ── A refusal is not a download ────────────────────────────────────────────
//
// Reported as: videos, after downloading, do not play at all.
//
// expo-file-system writes whatever the server sends and resolves whatever the
// status was. A media link is signed and lives a day or two, so an old one —
// from a chat restored off the device, or a message fetched long ago — comes
// back 403 with an empty body. That was written to disk as a zero-byte file
// and recorded as a FINISHED download: the tile said "downloaded", and
// playing it played nothing.

test('THE BUG: a 403 is not a downloaded video', () => {
  assert.strictEqual(D.downloadUsable({ status: 403, size: 0 }), false);
  assert.strictEqual(D.downloadUsable({ status: 403, size: 120 }), false,
    'a refusal with a body in it is still a refusal');
  assert.strictEqual(D.downloadUsable({ status: 404, size: 500 }), false);
  assert.strictEqual(D.downloadUsable({ status: 500, size: 0 }), false);
});

test('…AND NEITHER IS AN EMPTY FILE WITH A 200 ON IT', () => {
  // Either check alone lets the other through.
  assert.strictEqual(D.downloadUsable({ status: 200, size: 0 }), false);
  assert.strictEqual(D.downloadUsable({ status: 200, size: 1 }), true);
  assert.strictEqual(D.downloadUsable({ status: 206, size: 9000 }), true);
});

test('A BUILD THAT REPORTS NO STATUS STILL DOWNLOADS', () => {
  // Older expo versions do not report one. Refusing on that basis would
  // break every download on those builds, which is far worse than the bug.
  assert.strictEqual(D.downloadUsable({ size: 100 }), true);
  assert.strictEqual(D.downloadUsable({ status: 0, size: 100 }), true);
  assert.strictEqual(D.downloadUsable({ status: 'x', size: 100 }), true);
  // A size that could not be read is not evidence of emptiness either.
  assert.strictEqual(D.downloadUsable({ status: 200 }), true);
  assert.strictEqual(D.downloadUsable({}), true);
  assert.strictEqual(D.downloadUsable(null), true);
});

test('AN EXPIRED LINK SAYS WHAT TO DO ABOUT IT', () => {
  // The one failure somebody can act on: the chat re-fetches its links when
  // it opens, so reopening it fixes this.
  assert.ok(/expired/i.test(D.downloadFailureText(403)));
  assert.ok(/open the chat/i.test(D.downloadFailureText(403)));
  assert.ok(/expired/i.test(D.downloadFailureText(410)));
  assert.notStrictEqual(D.downloadFailureText(404), D.downloadFailureText(403));
  assert.ok(D.downloadFailureText(500).length > 0, 'an unknown failure says nothing at all');
});

test('THE STORE ACTUALLY CHECKS BEFORE CALLING IT DONE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'native-app', 'src',
    'videoDownloads.ts'), 'utf8');
  assert.ok(/if \(!downloadUsable\(\{ status: \(res as any\)\.status, size \}\)\)/.test(src),
    'a refusal is still recorded as a finished download');
  // The empty file must go, or localUri finds it later and the tile lies
  // again on the next open.
  const guard = /if \(!downloadUsable\([\s\S]*?\n    \}/.exec(src);
  assert.ok(guard && /deleteAsync\(pathFor\(url\), \{ idempotent: true \}\)/.test(guard[0]),
    'the unusable file is left on disk to be mistaken for a download');
  assert.ok(guard && /status: 'failed'/.test(guard[0]), 'it is recorded as finished anyway');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
