// Sending a file (native-app/src/uploadSession.ts).
//
// Reported as: "when uploading files, sometimes it takes too long — the upload
// progress should be there with pause and cancel buttons."
//
// Pause is what forced the design. A whole-file POST can be cancelled but not
// paused, so pausing one would mean discarding every byte already sent. The
// file goes up in chunks against a server session that remembers how much it
// holds; pause stops the flow, resume asks the server where it got to.
//
// The arithmetic here is the part that silently corrupts a file when it is
// wrong — an off-by-one in the resume offset produces an upload that
// "succeeds" and is broken — so it is pinned down away from the network.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'uploadsession-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'uploadSession.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping upload-session tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const U = require(path.join(OUT, 'uploadSession.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Chunking ────────────────────────────────────────────────────────────────

test('a file is walked through in chunks, ending exactly at its size', () => {
  const total = 2500;
  let at = 0;
  const seen = [];
  let guard = 0;
  while (guard++ < 100) {
    const r = U.chunkRange(at, total, 1000);
    if (!r) break;
    seen.push([r.start, r.end]);
    at = r.end;
  }
  assert.deepStrictEqual(seen, [[0, 1000], [1000, 2000], [2000, 2500]]);
  // No gaps and no overlaps: either would corrupt the file on the server.
  assert.strictEqual(at, total);
});

test('there is no chunk left once the whole file is up', () => {
  assert.strictEqual(U.chunkRange(2500, 2500, 1000), null);
  // An offset past the end (a server that already had more than we thought)
  // must not produce a negative-length chunk.
  assert.strictEqual(U.chunkRange(3000, 2500, 1000), null);
});

test('an empty or unmeasurable file yields nothing to send', () => {
  assert.strictEqual(U.chunkRange(0, 0, 1000), null);
  assert.strictEqual(U.chunkRange(0, -5, 1000), null);
  assert.strictEqual(U.chunkCount(0), 0);
});

test('a last partial chunk still counts', () => {
  assert.strictEqual(U.chunkCount(2500, 1000), 3);
  assert.strictEqual(U.chunkCount(2000, 1000), 2);
});

// ── Resuming ────────────────────────────────────────────────────────────────

test('THE BUG THAT WOULD CORRUPT FILES: the server decides where to resume', () => {
  // The phone counts bytes handed to the network stack; the server counts
  // bytes that arrived. After a connection dies mid-chunk those differ, and
  // carrying on from the phone's number appends the tail of a chunk the server
  // never got — a hole in the middle of the file. It uploads "successfully"
  // and is broken.
  assert.strictEqual(U.resumeOffset(1000, 5000), 1000);
  // Never past the end, whatever the server claims.
  assert.strictEqual(U.resumeOffset(9999, 5000), 5000);
  // Nonsense means start over rather than seek to a negative offset.
  assert.strictEqual(U.resumeOffset(-1, 5000), 0);
  assert.strictEqual(U.resumeOffset(NaN, 5000), 0);
});

test('complete means every byte, not nearly every byte', () => {
  assert.strictEqual(U.isComplete(4999, 5000), false);
  assert.strictEqual(U.isComplete(5000, 5000), true);
  assert.strictEqual(U.isComplete(0, 0), false);
});

// ── Retrying ────────────────────────────────────────────────────────────────

test('a network failure is retried; a refusal is not', () => {
  assert.strictEqual(U.shouldRetry(0, undefined), true, 'network error not retried');
  assert.strictEqual(U.shouldRetry(0, 0), true);
  assert.strictEqual(U.shouldRetry(0, 500), true);
  assert.strictEqual(U.shouldRetry(0, 503), true);
  // The server understood and said no. Sending it again says the same thing.
  assert.strictEqual(U.shouldRetry(0, 400), false);
  assert.strictEqual(U.shouldRetry(0, 401), false);
  assert.strictEqual(U.shouldRetry(0, 413), false);
  // …except these two, which mean "come back".
  assert.strictEqual(U.shouldRetry(0, 429), true);
  assert.strictEqual(U.shouldRetry(0, 408), true);
});

test('retrying gives up eventually rather than hammering forever', () => {
  assert.strictEqual(U.shouldRetry(U.MAX_ATTEMPTS, 500), false);
  assert.strictEqual(U.shouldRetry(U.MAX_ATTEMPTS - 1, 500), true);
});

test('backoff grows, is capped, and is jittered', () => {
  const mid = () => 0.5;
  assert.ok(U.retryDelay(1, mid) > U.retryDelay(0, mid), 'backoff does not grow');
  assert.ok(U.retryDelay(20, mid) <= 30_000, 'backoff is not capped');
  // Jitter is not decoration: without it every phone that lost the same
  // connection comes back at the same instant.
  assert.notStrictEqual(U.retryDelay(3, () => 0), U.retryDelay(3, () => 1));
});

// ── One bar, two waits ──────────────────────────────────────────────────────

test('a transcode and an upload share the one progress bar', () => {
  const p = (stage, fraction) => U.overallPercent({ stage, fraction, hasProcessing: true });
  assert.strictEqual(p('processing', 0), 0);
  assert.strictEqual(p('processing', 1), 40);
  assert.strictEqual(p('uploading', 0), 40);
  assert.strictEqual(p('uploading', 1), 100);
});

test('with no transcode the upload gets the whole bar', () => {
  // Otherwise a photo would show a bar that begins already 40% done.
  const p = (fraction) => U.overallPercent({ stage: 'uploading', fraction, hasProcessing: false });
  assert.strictEqual(p(0), 0);
  assert.strictEqual(p(0.5), 50);
  assert.strictEqual(p(1), 100);
});

test('a nonsense fraction cannot push the bar off either end', () => {
  const o = (f) => U.overallPercent({ stage: 'uploading', fraction: f, hasProcessing: false });
  assert.strictEqual(o(-1), 0);
  assert.strictEqual(o(5), 100);
  assert.strictEqual(o(NaN), 0);
});

// ── What the buttons may do ─────────────────────────────────────────────────

test('THE FEATURE: an upload in flight can be paused and cancelled', () => {
  assert.strictEqual(U.canPause('uploading'), true);
  assert.strictEqual(U.canCancel('uploading'), true);
});

test('a transcode can be cancelled but NOT paused', () => {
  // The native encoder offers cancel and nothing else, so a pause button
  // during it would be a button that does nothing.
  assert.strictEqual(U.canPause('processing'), false);
  assert.strictEqual(U.canCancel('processing'), true);
});

test('a paused upload offers resume, and still offers cancel', () => {
  assert.strictEqual(U.canResume('paused'), true);
  assert.strictEqual(U.canCancel('paused'), true);
  assert.strictEqual(U.canPause('paused'), false);
});

test('a failed upload can be retried or abandoned', () => {
  assert.strictEqual(U.canResume('failed'), true);
  assert.strictEqual(U.canCancel('failed'), true);
});

test('nothing is offered on a send that is over', () => {
  for (const phase of ['done', 'cancelled']) {
    assert.strictEqual(U.canPause(phase), false, phase);
    assert.strictEqual(U.canResume(phase), false, phase);
    assert.strictEqual(U.canCancel(phase), false, phase);
    assert.strictEqual(U.isActive(phase), false, phase);
  }
});

// ── Telling the user how it is going ────────────────────────────────────────

test('speed is measured over the recent past, not since the beginning', () => {
  // "It has averaged 200 KB/s since you pressed send" is not what someone
  // whose signal just died needs to be told.
  const rate = U.rateFrom([{ at: 1000, sent: 0 }, { at: 3000, sent: 200_000 }]);
  assert.strictEqual(rate, 100_000);
});

test('one sample is not a speed', () => {
  assert.strictEqual(U.rateFrom([{ at: 1000, sent: 5 }]), 0);
  assert.strictEqual(U.rateFrom([]), 0);
});

test('the sample window forgets what is too old to be about now', () => {
  let s = [];
  for (let t = 0; t <= 10_000; t += 1000) s = U.pushSample(s, t, t * 100, 5000);
  assert.ok(s.length <= 7, `window kept ${s.length} samples`);
  assert.ok(s[s.length - 1].at === 10_000);
  // The one just before the window is kept, so a crawling upload can still
  // produce a rate instead of reporting a stall.
  assert.ok(s[0].at <= 5000, `window starts at ${s[0].at}, too late to span it`);
});

test('a slow upload still reports a speed rather than looking stalled', () => {
  // One report in the last ten seconds. Trimming strictly to the window would
  // leave a single sample and therefore a speed of zero.
  let s = U.pushSample([], 0, 0, 5000);
  s = U.pushSample(s, 10_000, 50_000, 5000);
  assert.ok(U.rateFrom(s) > 0, 'a slow but moving upload reported as stalled');
});

test('the time left comes from the rate, and is honest when there is none', () => {
  assert.strictEqual(U.etaSeconds(0, 1000, 100), 10);
  assert.strictEqual(U.etaSeconds(1000, 1000, 100), 0);
  assert.strictEqual(U.etaSeconds(0, 1000, 0), null);
  assert.strictEqual(U.formatEta(null), '');
  assert.strictEqual(U.formatEta(45), '45s left');
  assert.strictEqual(U.formatEta(90), '1m 30s left');
});

test('sizes read as sizes', () => {
  assert.strictEqual(U.formatBytes(0), '0 B');
  assert.strictEqual(U.formatBytes(512), '512 B');
  assert.strictEqual(U.formatBytes(2048), '2 KB');
  assert.strictEqual(U.formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('the line under the bar answers "is this stuck?"', () => {
  // A percentage alone does not. Bytes and a speed do.
  const line = U.statusLine({ phase: 'uploading', sent: 1024 * 1024, total: 4 * 1024 * 1024, bytesPerSec: 512 * 1024 });
  assert.ok(line.includes('1.0 MB'), line);
  assert.ok(line.includes('4.0 MB'), line);
  assert.ok(line.includes('512 KB/s'), line);
  assert.ok(/left/.test(line), line);
});

test('no speed is claimed before the first chunk lands', () => {
  const line = U.statusLine({ phase: 'uploading', sent: 0, total: 4 * 1024 * 1024, bytesPerSec: 0 });
  assert.ok(!line.includes('/s'), `invented a speed: ${line}`);
  assert.ok(line.includes('4.0 MB'), line);
});

test('a paused upload says how far it got, not how fast it is going', () => {
  const line = U.statusLine({ phase: 'paused', sent: 1024 * 1024, total: 4 * 1024 * 1024, bytesPerSec: 999 });
  assert.ok(/^Paused/.test(line), line);
  assert.ok(!line.includes('/s'), `a paused upload claimed a speed: ${line}`);
});

// ── Nothing to draw a bar from yet ──────────────────────────────────────────
//
// Reported with a screenshot: a 20-second voice message sitting at "0%" with
// the status line squeezed down to a bare ellipsis. Two separate faults — the
// 0% is this one.

test('THE BUG: before the first byte lands there is no bar to draw', () => {
  assert.strictEqual(U.uploadDeterminate({ phase: 'uploading', sent: 0, total: 239000 }), false,
    '0% claims the upload has started and got nowhere; only a spinner is honest here');
});

test('once bytes are reported the bar is real', () => {
  assert.strictEqual(U.uploadDeterminate({ phase: 'uploading', sent: 1, total: 239000 }), true);
  assert.strictEqual(U.uploadDeterminate({ phase: 'uploading', sent: 239000, total: 239000 }), true);
});

test('a file of unknown size never gets a bar', () => {
  assert.strictEqual(U.uploadDeterminate({ phase: 'uploading', sent: 100, total: 0 }), false);
});

test('transcoding keeps its bar — the encoder reports properly from the start', () => {
  assert.strictEqual(U.uploadDeterminate({ phase: 'processing', sent: 0, total: 0 }), true);
});

test('a paused upload that never sent a byte still has no bar', () => {
  // The status line says "Paused · 0 B of 239 KB", which is the whole story;
  // a bar at 0% would add a claim nobody can support.
  assert.strictEqual(U.uploadDeterminate({ phase: 'paused', sent: 0, total: 239000 }), false);
});

// ── The status line has to fit ──────────────────────────────────────────────

test('THE BUG: the status line is not squeezed in beside the buttons', () => {
  // A voice bubble is about as wide as the words "Voice message". With the
  // status sharing a row with the percentage and two 26px buttons there was
  // room for roughly one character, and it rendered as "…".
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'components', 'UploadOverlay.tsx'), 'utf8');
  const row = src.slice(src.indexOf('<View style={s.row}>'), src.indexOf('</View>', src.indexOf('accessibilityLabel="Cancel upload"')));
  assert.ok(!row.includes('statusLine('),
    'the status line is back inside the button row, where it has no room');
  assert.ok(/<Text style=\{s\.status\}[\s\S]*statusLine\(/.test(src),
    'the status line is not rendered at all');
});

test('the overlay asks uploadDeterminate rather than deciding for itself', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'components', 'UploadOverlay.tsx'), 'utf8');
  assert.ok(src.includes('uploadDeterminate(view)'), 'the overlay no longer uses the rule');
  assert.ok(/determinate \? \(/.test(src), 'the bar is drawn regardless of the rule');
  assert.ok(/\{determinate && <Text style=\{s\.pct\}/.test(src),
    'the percentage is shown even when there is no byte count behind it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
