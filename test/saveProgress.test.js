// Saving something to the device (native-app/src/saveProgress.ts).
//
// Reported as: tapping Download does nothing for a couple of seconds, then
// "file saved to device" appears. For anything bigger than a photo that is
// long enough to assume the tap missed — so people tap again, and a 40 MB
// video downloads twice.
//
// The arithmetic is worth pinning down because a progress indicator that is
// wrong is worse than none at all: it is a promise about how long this will
// take, and a bar that sits at 0 or restarts from 0 repeatedly reads as a
// download that has stalled or gone wrong.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'saveprog-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'saveProgress.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping save-progress tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const S = require(path.join(OUT, 'saveProgress.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const reset = () => S._reset();

// ── Acknowledging the tap ───────────────────────────────────────────────────

test('THE BUG: something is on screen before a single byte arrives', () => {
  // The complaint was never that it was slow. It was that nothing said it had
  // started, so the tap looked like it had missed.
  reset();
  let seen = null;
  S.subscribe(s => { seen = s; });
  S.begin(1);
  assert.ok(seen, 'nothing was shown when the download started');
  assert.strictEqual(S.saveLabel(seen), 'Saving…');
});

test('a subscriber is told when it is over, and when it is cleared', () => {
  reset();
  const seen = [];
  S.subscribe(s => seen.push(s ? (s.done || 'running') : null));
  S.begin(1);
  S.report(5, 10);
  S.finish('saved');
  S.clear();
  assert.deepStrictEqual(seen, ['running', 'running', 'saved', null]);
});

// ── The bar ─────────────────────────────────────────────────────────────────

test('one file: the bar follows the bytes', () => {
  reset();
  S.begin(1);
  S.report(0, 100);
  assert.strictEqual(S.overallPercent(S.get()), 0);
  S.report(50, 100);
  assert.strictEqual(S.overallPercent(S.get()), 50);
  S.report(100, 100);
  assert.strictEqual(S.overallPercent(S.get()), 100);
});

test('THE ONE THAT READS AS BROKEN: a gallery runs 0-100 ONCE, not once per photo', () => {
  // Ten photos each showing their own percentage would run 0 to 100 ten times
  // over, which looks like ten separate downloads rather than one that is a
  // tenth done.
  reset();
  S.begin(10);
  S.advance(0); S.report(100, 100);
  assert.strictEqual(S.overallPercent(S.get()), 10, 'one photo of ten is not 10%');
  S.advance(5); S.report(50, 100);
  assert.strictEqual(S.overallPercent(S.get()), 55);
  S.advance(9); S.report(100, 100);
  assert.strictEqual(S.overallPercent(S.get()), 100);
});

test('the bar never runs past its ends', () => {
  reset();
  S.begin(1);
  // A server that lies about the total, or reports more than it promised.
  S.report(150, 100);
  assert.strictEqual(S.overallPercent(S.get()), 100);
  S.report(-10, 100);
  assert.strictEqual(S.overallPercent(S.get()), 0);
});

test('no state at all is 0%, not a crash', () => {
  reset();
  assert.strictEqual(S.overallPercent(null), 0);
  assert.strictEqual(S.saveLabel(null), '');
  assert.strictEqual(S.isDeterminate(null), false);
});

// ── Being honest about not knowing ──────────────────────────────────────────

test('a server that gives no size gets a spinner, not a bar stuck at zero', () => {
  // Content-Length is optional. A bar frozen at 0 looks like a download that
  // has stalled; a spinner is honest about not knowing how long this is.
  reset();
  S.begin(1);
  S.report(4096, 0);
  assert.strictEqual(S.isDeterminate(S.get()), false);
});

test('but a gallery is measurable even without sizes — the files can be counted', () => {
  reset();
  S.begin(7);
  S.report(4096, 0);
  assert.strictEqual(S.isDeterminate(S.get()), true);
  S.advance(3);
  assert.strictEqual(S.overallPercent(S.get()), 43);
});

// ── What it says ────────────────────────────────────────────────────────────

test('a gallery counts the files, one-based, the way a person would', () => {
  reset();
  S.begin(7);
  S.advance(0);
  assert.strictEqual(S.saveLabel(S.get()), 'Saving 1 of 7…');
  S.advance(6);
  assert.strictEqual(S.saveLabel(S.get()), 'Saving 7 of 7…');
});

test('the count cannot run past the total', () => {
  // An index off the end would read as "Saving 8 of 7", which is nonsense the
  // moment anybody sees it.
  reset();
  S.begin(7);
  S.advance(20);
  assert.strictEqual(S.saveLabel(S.get()), 'Saving 7 of 7…');
});

test('the end says what happened, and says it in the plural when it should', () => {
  reset();
  S.begin(1); S.finish('saved');
  assert.strictEqual(S.saveLabel(S.get()), 'Saved to your device');
  reset();
  S.begin(4); S.finish('saved');
  assert.strictEqual(S.saveLabel(S.get()), '4 files saved');
  reset();
  S.begin(1); S.finish('failed');
  assert.strictEqual(S.saveLabel(S.get()), 'Could not save');
});

test('a late report cannot wind a finished save backwards', () => {
  // A progress callback often lands after the file is already written. Letting
  // it through does not undo the "saved" state — but it DOES move the bar, so
  // the card finishes on a tick with a progress bar sliding back to 1%.
  reset();
  S.begin(1);
  S.report(100, 100);
  S.finish('saved');
  assert.strictEqual(S.overallPercent(S.get()), 100);

  S.report(1, 100);                       // the straggler
  assert.strictEqual(S.get().done, 'saved');
  assert.strictEqual(S.saveLabel(S.get()), 'Saved to your device');
  assert.strictEqual(S.overallPercent(S.get()), 100,
    'a late report wound the finished bar back');
});

test('reports for a save that never began are ignored', () => {
  reset();
  S.report(5, 10);
  S.finish('saved');
  assert.strictEqual(S.get(), null);
});

// ── Stopping it ─────────────────────────────────────────────────────────────
//
// Asked for: a cancel button or cross on the download progress. On these
// connections a video started by a mistaken tap is minutes of the only
// bandwidth there is, and there was no way out of it.

test('the cross is offered exactly while there is something to stop', () => {
  reset();
  assert.strictEqual(S.canCancel(null), false, 'a cross with nothing behind it');
  S.begin(1);
  assert.strictEqual(S.canCancel(S.get()), true);
  S.requestCancel();
  assert.strictEqual(S.canCancel(S.get()), false, 'the cross stayed after being pressed');
  reset();
  S.begin(1); S.finish('saved');
  assert.strictEqual(S.canCancel(S.get()), false, 'a finished save still offers a cross');
});

test('pressing it is visible immediately, before the bytes actually stop', () => {
  // The task keeps writing for a moment after cancelAsync(). If the card said
  // nothing in that gap the press would look ignored, and be pressed again.
  reset();
  let seen = 'never called';
  S.begin(1);
  S.subscribe(s => { seen = s; });
  S.requestCancel();
  assert.notStrictEqual(seen, 'never called', 'the overlay was not told');
  assert.strictEqual(seen.cancelling, true);
  assert.strictEqual(S.saveLabel(S.get()), 'Stopping…');
});

test('the downloader can read the request from anywhere', () => {
  // It lives in the screen, not in the overlay, so it needs a getter rather
  // than the state object.
  reset();
  assert.strictEqual(S.isCancelling(), false);
  S.begin(2);
  assert.strictEqual(S.isCancelling(), false);
  S.requestCancel();
  assert.strictEqual(S.isCancelling(), true);
  S.clear();
  assert.strictEqual(S.isCancelling(), false, 'the request outlived the download');
});

test('stopping on purpose is not reported as a failure', () => {
  reset();
  S.begin(1); S.requestCancel(); S.finish('cancelled');
  assert.strictEqual(S.saveLabel(S.get()), 'Download stopped');
  assert.notStrictEqual(S.saveLabel(S.get()), 'Could not save');
  assert.strictEqual(S.canCancel(S.get()), false);
});

test('a fresh download is not born already cancelled', () => {
  // begin() replaces the state rather than merging into it; if it did not, one
  // cancelled download would stop the next one on its first tick.
  reset();
  S.begin(1); S.requestCancel();
  S.begin(1);
  assert.strictEqual(S.isCancelling(), false);
  assert.strictEqual(S.canCancel(S.get()), true);
});

test('cancelling a finished save does nothing', () => {
  reset();
  S.begin(1); S.finish('saved');
  S.requestCancel();
  assert.strictEqual(S.get().done, 'saved');
  assert.strictEqual(S.get().cancelling, undefined);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const NAT = path.join(__dirname, '..', 'native-app', 'src');
const overlay = fs.readFileSync(path.join(NAT, 'components', 'SaveOverlay.tsx'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'screens', 'ChatScreen.tsx'), 'utf8');

test('the card actually shows a cross, and can be pressed', () => {
  assert.ok(/canCancel\(state\) && \(/.test(overlay), 'no cross on the progress card');
  assert.ok(/save\.requestCancel\(\)/.test(overlay), 'the cross does not ask for a stop');
  // The whole card used to ignore touches. A button inside something that
  // does would be there on screen and dead to the finger.
  assert.ok(!/pointerEvents="none"/.test(overlay),
    'the card swallows no touches — the cross cannot be pressed');
});

test('the download in flight is actually stopped, not just relabelled', () => {
  const fn = chat.slice(chat.indexOf('async function fetchWithProgress('),
    chat.indexOf('async function downloadMedia('));
  assert.ok(fn.length > 80, 'the download function moved');
  assert.ok(/isCancelling\(\)/.test(fn) && /cancelAsync\(\)/.test(fn),
    'the bytes keep coming after the cross is pressed');
});

test('a gallery stops at the next file rather than finishing the set', () => {
  const loop = chat.slice(chat.indexOf('async function downloadMedia('),
    chat.indexOf('async function downloadMedia(') + 3000);
  const check = loop.indexOf('save.isCancelling()');
  const advance = loop.indexOf('save.advance(');
  assert.ok(check > -1 && advance > -1, 'the loop never looks at the cancel flag');
  assert.ok(check < advance, 'the check happens after the next file has begun');
  assert.ok(/save\.finish\('cancelled'\)/.test(loop),
    "a stopped download never reports 'cancelled'");
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
