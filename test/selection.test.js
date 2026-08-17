// Tests for message multi-select (native-app/src/selection.ts).
//
// Multi-select was reported as slow. The cause was that the selected ids lived
// in React state and were handed to the list as `extraData`: every tick made a
// new Set, and a new Set re-renders every mounted row — twenty-odd bubbles with
// their images and players — in order to tint one of them.
//
// Moving the set outside React fixes that, but only if the notifications are
// right: a listener that is not called leaves a stale tick on screen, and a
// listener called for nothing puts the re-render straight back.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'seltest2-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'selection.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping selection tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const SRC_JS = path.join(OUT, 'selection.js');

// Module state is deliberately module-scope, so each test gets a fresh copy.
function fresh() {
  delete require.cache[require.resolve(SRC_JS)];
  return require(SRC_JS);
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('ticking and unticking a message', () => {
  const S = fresh();
  assert.strictEqual(S.has(1), false);
  S.toggle(1);
  assert.strictEqual(S.has(1), true);
  assert.strictEqual(S.size(), 1);
  S.toggle(1);
  assert.strictEqual(S.has(1), false);
  assert.strictEqual(S.size(), 0);
});

test('every change notifies listeners exactly once', () => {
  // The whole point of the change: one notification per tick, so one row
  // updates rather than the whole list.
  const S = fresh();
  let calls = 0;
  S.subscribe(() => { calls += 1; });
  S.toggle(1);
  assert.strictEqual(calls, 1);
  S.toggle(2);
  assert.strictEqual(calls, 2);
  S.toggle(2);
  assert.strictEqual(calls, 3);
});

test('unsubscribing stops the notifications', () => {
  // Rows unmount as they scroll out of view; a listener left behind would keep
  // a dead component alive and be called for ever.
  const S = fresh();
  let calls = 0;
  const off = S.subscribe(() => { calls += 1; });
  S.toggle(1);
  off();
  S.toggle(2);
  assert.strictEqual(calls, 1);
});

test('one listener throwing does not stop the others', () => {
  const S = fresh();
  const seen = [];
  S.subscribe(() => { throw new Error('boom'); });
  S.subscribe(() => { seen.push('second'); });
  S.toggle(1);
  assert.deepStrictEqual(seen, ['second']);
});

test('beginning a selection replaces whatever was ticked', () => {
  const S = fresh();
  S.toggle(1); S.toggle(2);
  S.begin(9);
  assert.deepStrictEqual(S.all(), [9]);
});

test('clearing an empty selection notifies nobody', () => {
  // Leaving a chat clears the selection whether or not anything was ticked; a
  // notification for nothing is a re-render for nothing.
  const S = fresh();
  let calls = 0;
  S.subscribe(() => { calls += 1; });
  S.clear();
  assert.strictEqual(calls, 0);
  S.toggle(1);
  S.clear();
  assert.strictEqual(calls, 2);
});

test('ids that are no longer in the chat are dropped', () => {
  // A selected message can be deleted by its sender while ticked. Acting on an
  // id the user can no longer see is worse than dropping it.
  const S = fresh();
  S.toggle(1); S.toggle(2); S.toggle(3);
  const emptied = S.retain([1, 3]);
  assert.deepStrictEqual(S.all().sort(), [1, 3]);
  assert.strictEqual(emptied, false);
});

test('retain reports when it has emptied the selection', () => {
  // The caller uses this to leave select mode; without it the toolbar stays up
  // over an empty selection.
  const S = fresh();
  S.toggle(1);
  assert.strictEqual(S.retain([2, 3]), true);
  assert.strictEqual(S.size(), 0);
});

test('retain compares ids as strings', () => {
  // Optimistic messages carry a temporary string id and are renumbered when the
  // server answers. Comparing 7 with "7" by identity would drop the selection
  // the instant a message was acknowledged.
  const S = fresh();
  S.toggle('7');
  assert.strictEqual(S.retain([7]), false);
  assert.strictEqual(S.size(), 1);
});

test('retain notifies only when it actually removed something', () => {
  const S = fresh();
  S.toggle(1);
  let calls = 0;
  S.subscribe(() => { calls += 1; });
  S.retain([1]);
  assert.strictEqual(calls, 0, 'retaining everything still forced a re-render');
  S.retain([]);
  assert.strictEqual(calls, 1);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
