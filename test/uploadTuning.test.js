// How big a chunk should be, and how long to wait for one.
//
// Reported from an iPhone, with a screenshot: sending an image, the progress
// bar only advances if you pause and resume — it does not move by itself.
//
// The bar was telling the truth. Progress is only KNOWN when a chunk lands:
// the server counts the bytes it holds, and `express.raw` discards a chunk
// that arrives incomplete, so a chunk in flight is worth exactly nothing until
// its last byte is in. At half a megabyte, and the 13 KB/s in that screenshot,
// that is forty seconds of a bar that does not move followed by a jump.
// Pausing and resuming asks the server for its offset and repaints, which is
// why it felt like the thing making progress happen.
//
// Two consequences, and the second is worse than the cosmetic one: the stall
// watchdog could not tell that silence from a dead connection, and aborting a
// healthy chunk means the server discards the partial and the retry sends the
// same bytes again — an upload that never advances at all.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
require(path.join(ROOT, 'public', 'js', 'uploadTuning.js'));
const W = global.window.UploadTuning;

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'uptune-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'uploadSession.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'uploadSession.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

const KB = 1024;

// ── The size of a chunk ─────────────────────────────────────────────────────

test('THE REPORT: at 13 KB/s a chunk is seconds of work, not forty of them', () => {
  // The connection in the screenshot. A 512 KB chunk there takes 40 seconds,
  // and the bar cannot move until it lands.
  const size = W.nextChunkBytes(13 * KB, 512 * KB);
  assert.ok(size <= 128 * KB, `still ${Math.round(size / KB)} KB on a 13 KB/s link`);
  const seconds = size / (13 * KB);
  assert.ok(seconds <= 12, `a chunk still takes ${Math.round(seconds)}s to land`);
});

test('a fast connection settles back at the size it has always used', () => {
  // This change exists to fix a bar that does not move. Making chunks LARGER
  // than they have ever been would be a different change, with its own risks:
  // a longer re-send after a failure and a slower pause.
  assert.strictEqual(W.nextChunkBytes(5 * 1024 * KB, 512 * KB), 512 * KB);
  assert.strictEqual(W.CHUNK_MAX, 512 * KB);
});

test('it never shrinks to something absurd', () => {
  // Per-chunk overhead — a round trip, a header, a file append — would start
  // to cost more than the bytes.
  assert.strictEqual(W.nextChunkBytes(1, 512 * KB), 64 * KB);
  assert.strictEqual(W.nextChunkBytes(0.0001, 64 * KB), 64 * KB);
  assert.strictEqual(W.CHUNK_MIN, 64 * KB);
});

test('the FIRST chunk is small, because it is the measurement', () => {
  // Nothing is known about the connection yet, and on a bad link this is the
  // difference between a bar that moves within seconds and one that sits at
  // zero for a minute before anyone can tell the upload is working.
  assert.ok(W.FIRST_CHUNK_BYTES <= 128 * KB, 'the first chunk is a gamble on a good connection');
  assert.ok(W.FIRST_CHUNK_BYTES >= W.CHUNK_MIN);
  // With no measurement, nothing changes.
  assert.strictEqual(W.nextChunkBytes(0, 256 * KB), 256 * KB);
  assert.strictEqual(W.nextChunkBytes(NaN, 256 * KB), 256 * KB);
  assert.strictEqual(W.nextChunkBytes(-5, 256 * KB), 256 * KB);
});

test('it grows carefully — one quick chunk is not a promise', () => {
  // A flaky connection produces one fast chunk and then nothing; jumping
  // straight to half a megabyte on that evidence is how the bar freezes again.
  assert.strictEqual(W.nextChunkBytes(5 * 1024 * KB, 64 * KB), 128 * KB);
  assert.strictEqual(W.nextChunkBytes(5 * 1024 * KB, 128 * KB), 256 * KB);
});

test('the size settles instead of jittering with every sample', () => {
  // Rounded to 32 KB: two nearly identical measurements must not produce two
  // different chunk sizes.
  assert.strictEqual(W.nextChunkBytes(30 * KB, 256 * KB), W.nextChunkBytes(31 * KB, 256 * KB));
  assert.strictEqual(W.nextChunkBytes(30 * KB, 256 * KB) % (32 * KB), 0);
});

test('a nonsense current size does not produce a nonsense next one', () => {
  for (const cur of [0, -1, NaN, undefined, 1e12]) {
    const n = W.nextChunkBytes(100 * KB, cur);
    assert.ok(n >= W.CHUNK_MIN && n <= W.CHUNK_MAX, `${cur} → ${n}`);
  }
});

// ── How long to wait for one ────────────────────────────────────────────────

test('THE DANGEROUS HALF: a healthy chunk is never mistaken for a dead link', () => {
  // A browser that reports nothing until the chunk lands makes forty seconds
  // of silence look exactly like a stall. Aborting there is worse than
  // useless: the server discards the partial, the retry sends the same bytes,
  // and the upload never advances.
  const chunk = 512 * KB;
  const slow = 13 * KB;                       // the connection in the report
  const expected = (chunk / slow) * 1000;     // ~40 seconds
  assert.ok(W.stallTimeoutMs(chunk, slow) > expected,
    'a chunk that is simply slow would be aborted and re-sent forever');
});

test('…but a genuinely dead connection is still given up on', () => {
  assert.strictEqual(W.stallTimeoutMs(64 * KB, 1024 * KB), W.STALL_FLOOR_MS,
    'a fast link waits longer than it needs to');
  assert.ok(W.STALL_FLOOR_MS >= 20000, 'a slow connection is called dead too readily');
  assert.ok(W.STALL_FLOOR_MS <= 90000, 'a hung request leaves the upload stuck for too long');
});

test('with no measured speed, the floor is what is used', () => {
  assert.strictEqual(W.stallTimeoutMs(512 * KB, 0), W.STALL_FLOOR_MS);
  assert.strictEqual(W.stallTimeoutMs(512 * KB, NaN), W.STALL_FLOOR_MS);
});

test('the app and the web agree, connection by connection', () => {
  if (!A) return;
  let checked = 0;
  const speeds = [0, -1, NaN, 1, 13 * KB, 50 * KB, 200 * KB, 1024 * KB, 8 * 1024 * KB];
  const sizes = [64 * KB, 128 * KB, 256 * KB, 512 * KB];
  for (const bps of speeds) {
    for (const cur of sizes) {
      assert.strictEqual(W.nextChunkBytes(bps, cur), A.nextChunkBytes(bps, cur),
        `nextChunkBytes disagrees for ${bps} / ${cur}`);
      assert.strictEqual(W.stallTimeoutMs(cur, bps), A.stallTimeoutMs(cur, bps),
        `stallTimeoutMs disagrees for ${cur} / ${bps}`);
      checked++;
    }
  }
  assert.strictEqual(checked, speeds.length * sizes.length, 'the drift check did not actually run');
  for (const k of ['CHUNK_MIN', 'CHUNK_MAX', 'TARGET_CHUNK_MS', 'FIRST_CHUNK_BYTES', 'STALL_FLOOR_MS']) {
    assert.strictEqual(W[k], A[k], `${k} differs between the app and the web`);
  }
});

// ── The wiring ──────────────────────────────────────────────────────────────

const res = fs.readFileSync(path.join(ROOT, 'public', 'js', 'resumable.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('the uploader no longer has a fixed chunk size', () => {
  assert.ok(!/var CHUNK = 512 \* 1024;/.test(res), 'the half-megabyte chunk is back');
  assert.ok(res.includes('UploadTuning.FIRST_CHUNK_BYTES'), 'the first chunk is hand-sized');
  assert.ok(/var end = Math\.min\(offset \+ chunk, total\)/.test(res),
    'the loop still slices a constant-sized chunk');
});

test('the size is recomputed from what each chunk actually managed', () => {
  const fn = res.slice(res.indexOf('async function pump()'), res.indexOf('start();'));
  assert.ok(fn.length > 0, 'pump is gone — this check would be vacuous');
  assert.ok(fn.includes('UploadTuning.nextChunkBytes(rate, chunk)'), 'the chunk size never changes');
  assert.ok(/rate \* 0\.6 \+ observed \* 0\.4/.test(fn),
    'the rate follows one sample exactly, so the size chases every hiccup');
  assert.ok(fn.includes('chunkStartedAt'), 'nothing measures how long a chunk took');
});

test('the watchdog waits longer than the chunk it is watching', () => {
  assert.ok(res.includes('UploadTuning.stallTimeoutMs(end - start, rate)'),
    'the stall timeout is a constant again, so a slow chunk is aborted and re-sent forever');
  assert.ok(!/var STALL_MS = 45000;/.test(res), 'the fixed stall timeout is back');
});

test('progress is still reported within a chunk where the browser allows it', () => {
  // Smaller chunks are the floor under this, not a replacement for it.
  assert.ok(/xhr\.upload\.onprogress = function/.test(res), 'within-chunk progress was dropped');
  assert.ok(/cb\.onProgress\(start \+ e\.loaded, total\)/.test(res), 'the events are ignored');
});

test('the rules are loaded by the page, before the uploader', () => {
  assert.ok(html.includes('/js/uploadTuning.js'), 'the page never loads the rules');
  assert.ok(html.indexOf('/js/uploadTuning.js') < html.indexOf('/js/resumable.js'),
    'the uploader is loaded before the rules it uses');
});

test('the app was deliberately left alone, and says so', () => {
  // Its progress events do arrive, so its bar moves within a chunk; changing
  // the size of the pieces a phone sends on the strength of a browser bug is
  // a different decision.
  const up = fs.readFileSync(path.join(NAT, 'src', 'uploadSession.ts'), 'utf8');
  assert.ok(/The app keeps its fixed 512 KB/.test(up),
    'nothing records why the app does not use these rules');
  const chunked = fs.readFileSync(path.join(NAT, 'src', 'chunkedUpload.ts'), 'utf8');
  assert.ok(/chunkBytes = CHUNK_BYTES/.test(chunked), 'the app quietly changed its chunk size too');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
