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
  for (const ev of events) {
    const r = S.reduceSelection(state, last, ev);
    state = r.state; last = r.last;
    actions.push(r.action);
  }
  return { state, actions };
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

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
