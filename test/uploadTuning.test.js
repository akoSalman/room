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
      if (A) assert.strictEqual(W.shrinkAfterFailure(cur), A.shrinkAfterFailure(cur),
        `shrinkAfterFailure disagrees for ${cur}`);
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
  // Through report() now, which is what keeps the bar from going backwards
  // when the chunk those events belonged to has to be sent again.
  assert.ok(/report\(start \+ e\.loaded\)/.test(res), 'the events are ignored');
});

test('the rules are loaded by the page, before the uploader', () => {
  assert.ok(html.includes('/js/uploadTuning.js'), 'the page never loads the rules');
  assert.ok(html.indexOf('/js/uploadTuning.js') < html.indexOf('/js/resumable.js'),
    'the uploader is loaded before the rules it uses');
});

test('THE APP USES THESE RULES TOO, now that there is evidence about phones', () => {
  // This replaces a test that pinned the opposite decision. The app was
  // deliberately left on a fixed 512 KB because the only evidence was a
  // browser bug about a bar that did not move, which says nothing about how
  // big a piece a phone should send.
  //
  // The evidence now exists and points the other way: a photo on a poor
  // connection reaching about ten per cent and starting again. A chunk counts
  // only when it lands whole, so a large one on a link that drops every few
  // seconds may never land, and the upload spends data without advancing.
  const chunked = fs.readFileSync(path.join(NAT, 'src', 'chunkedUpload.ts'), 'utf8');
  assert.ok(/chunkBytes = FIRST_CHUNK_BYTES/.test(chunked),
    'the app still starts every upload with the old fixed chunk');
  assert.ok(/chunk = nextChunkBytes\(rate, chunk\)/.test(chunked),
    'the app never grows its chunk, so a large file pays for this');
  assert.ok(/chunk = shrinkAfterFailure\(chunk\)/.test(chunked),
    'a chunk that failed does not make the next one smaller');
  assert.ok(/chunkRange\(offset, total, chunk\)/.test(chunked),
    'the loop still slices by the fixed size');
  // And the reversal is written down where the rules live.
  const up = fs.readFileSync(path.join(NAT, 'src', 'uploadSession.ts'), 'utf8');
  assert.ok(/overtaken by a report from the app itself/.test(up),
    'nothing records why this decision changed');
});

test('A FAILED CHUNK HALVES, down to the floor and no further', () => {
  // nextChunkBytes only learns from chunks that SUCCEEDED, so on a connection
  // where the current size never completes it never adapts at all.
  assert.strictEqual(W.shrinkAfterFailure(512 * KB), 256 * KB);
  assert.strictEqual(W.shrinkAfterFailure(256 * KB), 128 * KB);
  assert.strictEqual(W.shrinkAfterFailure(W.CHUNK_MIN), W.CHUNK_MIN,
    'the chunk shrank below the point where per-chunk overhead dominates');
  assert.strictEqual(W.shrinkAfterFailure(0), W.CHUNK_MIN);
  assert.strictEqual(W.shrinkAfterFailure(NaN), W.FIRST_CHUNK_BYTES / 2);
  assert.ok(W.shrinkAfterFailure(99 * 1024 * KB) <= W.CHUNK_MAX, 'it exceeded the cap');
});

test('THE BAR IS NOT ALLOWED TO GO BACKWARDS', () => {
  // The reported symptom. Re-sending a chunk starts its byte count again, and
  // reporting that honestly is a bar that resets — while the bytes are still
  // on the server, which makes the lower number the less truthful one.
  assert.strictEqual(W.reportedSent(400, 100, 1000), 400, 'the bar was allowed to drop');
  assert.strictEqual(W.reportedSent(400, 700, 1000), 700, 'the bar stopped moving forwards');
  assert.strictEqual(W.reportedSent(0, 0, 1000), 0);
  // Never past the end, or the bar reads over 100%.
  assert.strictEqual(W.reportedSent(900, 5000, 1000), 1000);
  assert.strictEqual(W.reportedSent(2000, 100, 1000), 1000);
  // An unknown total is not a reason to report nothing.
  assert.strictEqual(W.reportedSent(100, 250, 0), 250);
});

// ── The last request ────────────────────────────────────────────────────────
//
// Reported: "sometimes on apk the upload progress hangs on the final stage and
// does not go ahead, i should close app and try again sending". Every byte had
// arrived — the bar sat at 100% — and the one request that turns the pieces
// into a file had no deadline and no retry on either client. A request that
// never settles is routine on a mobile network; nothing below it ever fires.

test('THE TWO COPIES AGREE ABOUT THE BAR AND ABOUT SHRINKING', () => {
  if (!A) return;
  for (const peak of [0, 100, 400, 2000]) {
    for (const sent of [0, 100, 700, 5000]) {
      for (const total of [0, 1000]) {
        assert.strictEqual(W.reportedSent(peak, sent, total), A.reportedSent(peak, sent, total),
          `reportedSent disagrees for ${peak}/${sent}/${total}`);
      }
    }
  }
  // Agreeing on something, not merely agreeing.
  assert.strictEqual(W.reportedSent(400, 100, 1000), 400);
  assert.strictEqual(W.shrinkAfterFailure(512 * KB), 256 * KB);
});

test('THE WEB USES THEM TOO', () => {
  // The same report applies to the browser: it re-sends a chunk after a
  // failure, and its bar jumped backwards for the same reason.
  const r = fs.readFileSync(path.join(ROOT, 'public', 'js', 'resumable.js'), 'utf8');
  assert.ok(/chunk = UploadTuning\.shrinkAfterFailure\(chunk\)/.test(r),
    'a failed chunk does not make the next one smaller on the web');
  assert.ok(/UploadTuning\.reportedSent\(peak, sent, total\)/.test(r),
    'the web bar can still go backwards');
  // Every report goes through it, or the one that does not is the one that
  // resets the bar.
  const direct = (r.match(/cb\.onProgress\(/g) || []).length;
  assert.strictEqual(direct, 1,
    `${direct} places report progress directly, bypassing the rule`);
});

test('THE BUG: the finish request has a deadline at all', () => {
  assert.ok(W.FINISH_TIMEOUT_MS > 0, 'the finish can still hang forever');
  // Longer than a chunk's floor, because the server does real work here (a
  // rename, and on some filesystems a copy), but not open-ended.
  assert.ok(W.FINISH_TIMEOUT_MS >= W.STALL_FLOOR_MS,
    `${W.FINISH_TIMEOUT_MS}ms is shorter than a chunk's own floor`);
  assert.ok(W.FINISH_TIMEOUT_MS <= 120000, 'the deadline is long enough to feel like no deadline');
  if (A) assert.strictEqual(W.FINISH_TIMEOUT_MS, A.FINISH_TIMEOUT_MS,
    'the app and the web wait for different lengths of time');
});

test('the app retries the finish, and only where retrying is safe', () => {
  if (!A) return;
  // Same rules as a chunk: a network failure is what retrying is for, a
  // refusal is not.
  assert.strictEqual(A.shouldRetryFinish(0, 0), true, 'a lost reply is given up on');
  assert.strictEqual(A.shouldRetryFinish(0, undefined), true);
  assert.strictEqual(A.shouldRetryFinish(0, 500), true);
  assert.strictEqual(A.shouldRetryFinish(0, 400), false, 'a refusal is retried forever');
  assert.strictEqual(A.shouldRetryFinish(A.MAX_ATTEMPTS, 0), false, 'the retries never stop');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const REPO = path.join(__dirname, '..');
const chunked = fs.readFileSync(
  path.join(REPO, 'native-app', 'src', 'chunkedUpload.ts'), 'utf8');
const resumable = fs.readFileSync(path.join(REPO, 'public', 'js', 'resumable.js'), 'utf8');

test('THE BUG: the app finally puts a deadline on each CHUNK too', () => {
  // stallTimeoutMs existed, was tested, and was used by the web — and the app
  // never called it. `ontimeout` was handled and could not fire, because
  // nothing set a timeout.
  assert.ok(/xhr\.timeout = timeoutMs/.test(chunked), 'an app chunk can still hang forever');
  assert.ok(/stallTimeoutMs\(range\.end - range\.start, rate\)/.test(chunked),
    'the deadline is a fixed guess rather than measured from this connection');
  assert.ok(/rate = \(\(range\.end - range\.start\) \/ took\) \* 1000/.test(chunked),
    'the rate is never measured, so the deadline can only ever be the floor');
});

test('both clients retry the finish behind a deadline', () => {
  for (const [src, who] of [[chunked, 'the app'], [resumable, 'the web']]) {
    assert.ok(/FINISH_TIMEOUT_MS/.test(src), `${who} waits forever for the finish`);
    assert.ok(/AbortController/.test(src), `${who} has no way to give up on it`);
    assert.ok(/finishOnce\(/.test(src), `${who} does not retry the finish`);
  }
  // The app's loop, specifically: it must stop on a refusal and on pause.
  const loop = chunked.slice(chunked.indexOf('let last:'), chunked.indexOf('/** One attempt at the finish'));
  assert.ok(/if \(stopped \|\| paused\) return;/.test(loop), 'cancelling mid-retry keeps retrying');
  assert.ok(/if \(!shouldRetryFinish\(fa, last\.status\)\) break;/.test(loop),
    'a refusal is retried until the attempts run out');
  assert.ok(/if \(last\.url\) \{ cb\.onDone/.test(loop), 'a successful finish is not reported');
});

test('the server makes that retry safe', () => {
  const server = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
  const fin = server.slice(server.indexOf("app.post('/upload/session/:id/finish'"),
    server.indexOf("app.delete('/upload/session/:id'"));
  assert.ok(/donePath\(rawId\)/.test(fin),
    'a repeated finish is answered with "no such upload", so a retry loses a file that arrived');
  assert.ok(/done\.userId === req\.user\.id/.test(fin),
    'knowing a session id is enough to be handed somebody else\'s upload');
  // Written before the reply, or a retry that overtakes it finds nothing.
  const wrote = fin.indexOf('fs.writeFileSync(donePath(s.id)');
  const replied = fin.indexOf("res.json({ url: '/uploads/' + filename");
  assert.ok(wrote > -1 && replied > wrote, 'the record is written after the reply it protects');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
