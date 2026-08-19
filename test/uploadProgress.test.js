// Where an upload's progress lives (native-app/src/uploadProgress.ts).
//
// It used to live in ChatScreen's state, listed in the message list's
// extraData. Every progress report re-rendered every mounted row in the chat —
// and during a video transcode there are hundreds of reports, on the same CPU
// the encoder is using. That is a measurable part of "processing videos takes
// too long", and it is why the store moved out of React.
//
// What is tested here is the delivery rule (a report reaches ONE subscriber,
// not all of them) and the phase rules, which are what make the pause and
// cancel buttons mean what they say.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'uploadprogress-'));
const ROOT = path.join(__dirname, '..', 'native-app', 'src');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping upload-progress tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [
  path.join(ROOT, 'uploadProgress.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
], { stdio: 'pipe' });
const P = require(path.join(OUT, 'uploadProgress.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const reset = () => P._reset();

test('THE POINT: a report reaches only the message it belongs to', () => {
  // The whole reason this exists. With progress in the list's extraData, a
  // report about one upload re-rendered every bubble in the chat.
  reset();
  const heard = { a: 0, b: 0 };
  P.begin('a', false);
  P.begin('b', false);
  P.subscribe('a', () => heard.a++);
  P.subscribe('b', () => heard.b++);
  P.report('a', 'uploading', 0.5, 500, 1000);
  assert.strictEqual(heard.a, 1);
  assert.strictEqual(heard.b, 0, 'an unrelated bubble was told about someone else\'s upload');
});

test('unsubscribing stops the reports', () => {
  reset();
  let n = 0;
  P.begin('a', false);
  const off = P.subscribe('a', () => n++);
  P.report('a', 'uploading', 0.5, 500, 1000);
  off();
  P.report('a', 'uploading', 0.9, 900, 1000);
  assert.strictEqual(n, 1, 'a removed listener kept being called');
});

test('a transcoding send shares its bar; a plain one does not', () => {
  reset();
  P.begin('vid', true);
  P.report('vid', 'processing', 1);
  assert.strictEqual(P.get('vid').percent, 40);
  P.report('vid', 'uploading', 0);
  assert.strictEqual(P.get('vid').percent, 40, 'the bar jumped backwards between stages');

  P.begin('pic', false);
  P.report('pic', 'uploading', 0.5, 5, 10);
  assert.strictEqual(P.get('pic').percent, 50);
});

test('THE BUG A LATE PACKET WOULD CAUSE: a pause is not undone by a report in flight', () => {
  // Pressing pause is a decision. A progress callback from a request that was
  // already in the air must not drag the bubble back to "uploading" and put
  // the pause button back where the resume button just appeared.
  reset();
  P.begin('a', false);
  P.report('a', 'uploading', 0.3, 300, 1000);
  P.pause('a');
  assert.strictEqual(P.get('a').phase, 'paused');
  P.report('a', 'uploading', 0.31, 310, 1000);
  assert.strictEqual(P.get('a').phase, 'paused', 'a late report un-paused the upload');
  assert.strictEqual(P.get('a').sent, 300, 'a late report moved a paused upload along');
});

test('a cancelled send stays cancelled', () => {
  reset();
  P.begin('a', false);
  P.cancel('a');
  P.report('a', 'uploading', 0.9, 900, 1000);
  assert.strictEqual(P.get('a').phase, 'cancelled');
});

test('resuming lets reports through again', () => {
  reset();
  P.begin('a', false);
  P.pause('a');
  P.resume('a');
  P.report('a', 'uploading', 0.4, 400, 1000);
  assert.strictEqual(P.get('a').phase, 'uploading');
  assert.strictEqual(P.get('a').sent, 400);
});

test('the buttons actually reach the upload', () => {
  reset();
  const called = [];
  P.begin('a', false);
  P.attach('a', {
    pause: () => called.push('pause'),
    resume: () => called.push('resume'),
    cancel: () => called.push('cancel'),
  });
  P.pause('a'); P.resume('a'); P.cancel('a');
  assert.deepStrictEqual(called, ['pause', 'resume', 'cancel']);
});

test('the upload takes over the cancel button from the transcode', () => {
  reset();
  const called = [];
  P.begin('a', true);
  P.attach('a', { cancel: () => called.push('stop-transcode') });
  P.attach('a', { pause: () => called.push('pause'), cancel: () => called.push('stop-upload') });
  P.cancel('a');
  assert.deepStrictEqual(called, ['stop-upload'],
    'cancelling during the upload stopped the transcode instead');
});

test('attaching one control does not drop the others', () => {
  // The two stages register different controls at different times. Replacing
  // rather than merging would silently disconnect a button that still applies.
  reset();
  const called = [];
  P.begin('a', true);
  P.attach('a', { cancel: () => called.push('cancel') });
  P.attach('a', { pause: () => called.push('pause') });
  P.pause('a');
  P.cancel('a');
  assert.deepStrictEqual(called, ['pause', 'cancel'],
    'a control attached earlier was thrown away by a later attach');
});

test('a paused upload stops claiming a speed', () => {
  reset();
  P.begin('a', false);
  P.report('a', 'uploading', 0.1, 100, 1000);
  P.report('a', 'uploading', 0.2, 200, 1000);
  P.pause('a');
  assert.strictEqual(P.get('a').bytesPerSec, 0,
    'a paused upload still reported a transfer speed');
});

test('time spent paused does not count against the speed on resume', () => {
  // The samples from before the pause describe a different situation. Kept,
  // they average the transfer over minutes of sitting still, and a resumed
  // upload reports a crawl it is not actually doing.
  reset();
  P.begin('a', false);
  P.report('a', 'uploading', 0.1, 100_000, 1_000_000, 1_000);
  P.report('a', 'uploading', 0.2, 200_000, 1_000_000, 2_000);
  const before = P.get('a').bytesPerSec;
  assert.ok(before > 0, 'no speed measured before the pause');

  P.pause('a');
  P.resume('a');
  // Ten minutes later, going at the same rate as before.
  P.report('a', 'uploading', 0.3, 300_000, 1_000_000, 602_000);
  P.report('a', 'uploading', 0.4, 400_000, 1_000_000, 603_000);
  const after = P.get('a').bytesPerSec;
  assert.ok(after >= before * 0.5,
    `speed collapsed from ${Math.round(before)} to ${Math.round(after)} B/s across a pause`);
});

test('finishing clears everything, and tells the bubble it is over', () => {
  reset();
  let last = 'unset';
  P.begin('a', false);
  P.subscribe('a', v => { last = v; });
  P.finish('a');
  assert.strictEqual(P.get('a'), null);
  assert.strictEqual(last, null, 'the bubble was not told the upload had finished');
  // A report after the end must not resurrect it.
  P.report('a', 'uploading', 0.5, 5, 10);
  assert.strictEqual(P.get('a'), null);
});

test('reports for a send that was never begun are ignored', () => {
  reset();
  P.report('ghost', 'uploading', 0.5, 5, 10);
  assert.strictEqual(P.get('ghost'), null);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
