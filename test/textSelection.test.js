// Tests for native-text-selection tracking (native-app/src/textSelection.ts).
//
// The bug this exists to prevent: after double-tapping to select a word,
// tapping anywhere else popped the message menu instead of clearing the
// selection. A tap outside a selection must dismiss it and do nothing more.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'seltest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'textSelection.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping text-selection tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const S = require(path.join(OUT, 'textSelection.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// A tiny driver mirroring how the screen threads the reducer's output back in.
function run(events) {
  let state = S.initialSelection;
  let last = null;
  const actions = [];
  const cleared = [];
  for (const ev of events) {
    const r = S.reduceSelection(state, last, ev);
    state = r.state; last = r.last;
    actions.push(r.action);
    cleared.push(r.clearId);
  }
  return { state, actions, cleared };
}

test('an ordinary tap opens the message menu', () => {
  const { actions, state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
  ]);
  assert.deepStrictEqual(actions, [null, 'menu']);
  assert.strictEqual(state.selecting, null);
});

test('a double tap starts a selection', () => {
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1000 + S.DOUBLE_TAP_MS - 50 },
  ]);
  assert.strictEqual(state.selecting, 1);
});

test('THE BUG: a tap after a double tap dismisses, and does not open the menu', () => {
  const { actions, state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // double tap → selecting
    { type: 'tap' },                     // tap somewhere outside
  ]);
  assert.strictEqual(actions[3], 'dismiss', 'the tap outside the selection opened the menu');
  assert.strictEqual(state.selecting, null, 'the selection was not cleared');
});

test('the very next tap after dismissing works normally again', () => {
  const { actions } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },
    { type: 'tap' },                     // dismiss
    { type: 'down', id: 2, at: 5000 },
    { type: 'tap' },                     // menu again
  ]);
  assert.deepStrictEqual(actions.slice(3), ['dismiss', null, 'menu']);
});

test('two slow taps are two taps, not a double tap', () => {
  const { state, actions } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1000 + S.DOUBLE_TAP_MS + 1 },
    { type: 'tap' },
  ]);
  assert.strictEqual(state.selecting, null);
  assert.deepStrictEqual(actions, [null, 'menu', null, 'menu']);
});

test('taps on two DIFFERENT messages are never a double tap', () => {
  // Otherwise tapping quickly down a list would arm a phantom selection and
  // swallow the next tap.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 2, at: 1100 },
  ]);
  assert.strictEqual(state.selecting, null);
});

test('a held touch starts a selection', () => {
  // The long-press case: the touch went down and no tap ever followed.
  const { state } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
  ]);
  assert.strictEqual(state.selecting, 7);
});

test('a stale hold for a touch we are no longer waiting on is ignored', () => {
  // A late timer from an earlier message must not arm a selection on it.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },                  // resolved: nothing pending
    { type: 'held', id: 1 },
  ]);
  assert.strictEqual(state.selecting, null);
});

test('a hold for a different message than the pending one is ignored', () => {
  const { state } = run([
    { type: 'down', id: 2, at: 1000 },
    { type: 'held', id: 1 },
  ]);
  assert.strictEqual(state.selecting, null);
});

test('a tap after a long-press selection also dismisses', () => {
  const { actions } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
    { type: 'tap' },
  ]);
  assert.strictEqual(actions[2], 'dismiss');
});

test('clear drops the selection without asking for any action', () => {
  const { state, actions } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
    { type: 'clear' },
  ]);
  assert.strictEqual(state.selecting, null);
  assert.strictEqual(actions[2], null);
  assert.strictEqual(state.pendingId, null);
});

// ── Selecting a word on a SECOND message ─────────────────────────────────────
//
// Reported as: double-tap works on the first message, then stops working on
// every message after it, until you tap outside several times. The cause is
// that the OS spends the first tap dismissing the selection that is still up
// on the previous message, so the double-tap is read as dismiss + single tap.

test('THE BUG: touching another message clears the selection still up on the first', () => {
  const { cleared, actions } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // double tap → message 1 is selected
    { type: 'down', id: 2, at: 5000 },   // now reach for message 2
  ]);
  assert.strictEqual(cleared[3], 1,
    'message 1 kept its selection, so the OS will spend the next tap dismissing it');
  assert.strictEqual(actions[3], 'dismiss');
});

test('and a double tap on that second message then selects it first time', () => {
  const { state, cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // message 1 selected
    { type: 'down', id: 2, at: 5000 },   // first tap of the double on message 2
    { type: 'down', id: 2, at: 5150 },   // second tap
  ]);
  assert.strictEqual(state.selecting, 2, 'the second message never got selected');
  // And the clear happened once, on the way in — not again on the second tap.
  assert.deepStrictEqual(cleared, [null, null, null, 1, null]);
});

test('touching the SAME selected message again does not clear it', () => {
  // Adjusting your own selection with the handles must not wipe it.
  const { cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // selected
    { type: 'down', id: 1, at: 9000 },   // touch it again, slowly
  ]);
  assert.strictEqual(cleared[3], null);
});

test('with nothing selected, touching a message clears nothing', () => {
  const { cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'down', id: 2, at: 5000 },
  ]);
  assert.deepStrictEqual(cleared, [null, null]);
});

test('after the stale selection is cleared, the next tap opens the menu', () => {
  // If `selecting` were left pointing at the old message, this tap would be
  // eaten as another dismiss and the menu would never open.
  const { actions } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // message 1 selected
    { type: 'down', id: 2, at: 5000 },   // clears message 1
    { type: 'tap' },
  ]);
  assert.strictEqual(actions[4], 'menu');
});

test('a tap outside reports WHICH message to wipe', () => {
  const { cleared } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
    { type: 'tap' },
  ]);
  assert.strictEqual(cleared[2], 7);
});

test('clear reports the message to wipe as well', () => {
  const { cleared } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
    { type: 'clear' },
  ]);
  assert.strictEqual(cleared[2], 7);
});

// ── Swiping to reply with a finger that started on the text ──────────────────
//
// Reported as: swiping right to reply sometimes selects the text instead.
//
// The swipe only claims the gesture after ten pixels of sideways movement, and
// the OS starts its long-press timer the moment the finger lands. Rest briefly
// before pulling, or pull slowly, and the timer wins: a word is selected, the
// handles and the copy bar appear, and they are still there once the reply box
// has opened. Nothing can un-fire that timer, so the selection is wiped.

test('THE BUG: a swipe wipes the selection the OS started under the finger', () => {
  const { cleared, state } = run([
    { type: 'down', id: 4, at: 1000 },   // finger lands on the text
    { type: 'swipe', id: 4 },            // and pulls sideways
  ]);
  assert.strictEqual(cleared[1], 4,
    'the word the OS selected mid-swipe was left highlighted');
  assert.strictEqual(state.selecting, null);
  assert.strictEqual(state.pendingId, null, 'the touch is still pending after becoming a swipe');
});

test('a swipe also wipes a selection left on another message', () => {
  const { cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // message 1 selected
    { type: 'swipe', id: 9 },            // swipe a different message
  ]);
  assert.strictEqual(cleared[3], 1);
});

test('a swipe with nothing to wipe does not remount anything', () => {
  // Remounting on every swipe would flicker the text of every message anyone
  // ever replies to.
  const { cleared } = run([
    { type: 'swipe', id: 4 },
  ]);
  assert.strictEqual(cleared[0], null);
});

test('a swipe on a message OTHER than the pending touch wipes nothing', () => {
  const { cleared } = run([
    { type: 'down', id: 4, at: 1000 },
    { type: 'swipe', id: 5 },
  ]);
  assert.strictEqual(cleared[1], null);
});

test('the touch that became a swipe cannot go on to be a tap', () => {
  // The gesture ends when the finger lifts. Without forgetting it, that lift
  // arrives as a tap and opens the message menu on top of the reply box.
  const { actions } = run([
    { type: 'down', id: 4, at: 1000 },
    { type: 'swipe', id: 4 },
    { type: 'tap' },
  ]);
  assert.strictEqual(actions[2], 'menu',
    'a tap after a swipe should be an ordinary tap, not a dismiss');
});

test('a swipe cannot leave a stale double-tap primed', () => {
  // `last` is forgotten, so the next touch on this message is a first tap
  // rather than the second half of a double tap that never happened.
  const { state } = run([
    { type: 'down', id: 4, at: 1000 },
    { type: 'swipe', id: 4 },
    { type: 'down', id: 4, at: 1100 },   // would be "double" if last survived
  ]);
  assert.strictEqual(state.selecting, null,
    'the swipe left a half-finished double tap behind, so the next touch selected a word');
});

test('a late hold timer after a swipe is ignored', () => {
  // The long-press timer is still running when the swipe takes over; it must
  // not arm a selection behind the reply box.
  const { state } = run([
    { type: 'down', id: 4, at: 1000 },
    { type: 'swipe', id: 4 },
    { type: 'held', id: 4 },
  ]);
  assert.strictEqual(state.selecting, null);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
