// Tests for the edge-swipe-to-go-back gesture (native-app/src/edgeBack.ts).
//
// The gesture shares the screen with swipe-to-reply and with the message
// list's own scrolling. Claiming a drag it should not have claimed is the
// failure that matters: it silently breaks replying and scrolling, and it is
// miserable to debug on a device. Those cases are asserted directly.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ebtest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'edgeBack.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping edge-back tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const E = require(path.join(OUT, 'edgeBack.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const W = 400;   // a phone-ish screen width

test('dragging right from the left edge starts a back', () => {
  assert.strictEqual(E.edgeFor(5, 40, 0, W), 'left');
});

test('dragging left from the right edge starts a back', () => {
  // The mirror gesture, for right-handed habit and for RTL.
  assert.strictEqual(E.edgeFor(W - 5, -40, 0, W), 'right');
});

test('a drag that starts in the MIDDLE is ignored — that is swipe-to-reply', () => {
  // The regression this exists to prevent: stealing the reply gesture.
  assert.strictEqual(E.edgeFor(200, 60, 0, W), null);
  assert.strictEqual(E.edgeFor(200, -60, 0, W), null);
});

test('a vertical drag is ignored — that is the message list scrolling', () => {
  assert.strictEqual(E.edgeFor(5, 20, 100, W), null, 'a mostly-vertical drag was claimed');
  assert.strictEqual(E.edgeFor(5, 20, 20, W), null, 'a diagonal drag was claimed');
});

test('dragging the WRONG way from an edge does nothing', () => {
  // Pulling left from the left edge is not a back gesture.
  assert.strictEqual(E.edgeFor(5, -40, 0, W), null);
  assert.strictEqual(E.edgeFor(W - 5, 40, 0, W), null);
});

test('a tiny twitch does not claim the gesture', () => {
  assert.strictEqual(E.edgeFor(5, 3, 0, W), null);
  assert.strictEqual(E.edgeFor(5, E.START_SLOP - 1, 0, W), null);
});

test('a long drag completes, from either edge', () => {
  assert.strictEqual(E.shouldComplete('left', 100, 0), true);
  assert.strictEqual(E.shouldComplete('right', -100, 0), true);
});

test('a short slow drag does NOT complete', () => {
  assert.strictEqual(E.shouldComplete('left', 20, 0.05), false);
  assert.strictEqual(E.shouldComplete('right', -20, -0.05), false);
});

test('a short fast flick completes', () => {
  assert.strictEqual(E.shouldComplete('left', 30, 1.2), true);
  assert.strictEqual(E.shouldComplete('right', -30, -1.2), true);
});

test('flicking back to cancel does not go back', () => {
  // Dragged out a little, then flicked hard the OTHER way to abandon it.
  // Travel is still positive, so the `travel <= 0` guard does not catch this —
  // only judging velocity by direction rather than magnitude does. Comparing
  // |velocity| would treat the cancel as a confident back.
  assert.strictEqual(E.shouldComplete('left', 30, -1.5), false,
    'a leftward flick completed a left-edge back gesture');
  assert.strictEqual(E.shouldComplete('right', -30, 1.5), false,
    'a rightward flick completed a right-edge back gesture');
  // And the same small travel WITH a forward flick does complete.
  assert.strictEqual(E.shouldComplete('left', 30, 1.5), true);
  assert.strictEqual(E.shouldComplete('right', -30, -1.5), true);
});

test('nothing completes when no edge was claimed', () => {
  assert.strictEqual(E.shouldComplete(null, 500, 5), false);
});

test('progress runs 0 to 1 and is clamped at both ends', () => {
  assert.strictEqual(E.backProgress('left', 0), 0);
  assert.strictEqual(E.backProgress('left', E.COMPLETE_DISTANCE), 1);
  assert.strictEqual(E.backProgress('left', 10000), 1, 'progress ran past 1');
  assert.strictEqual(E.backProgress('left', -50), 0, 'a backwards drag gave negative progress');
  // The right edge measures its own direction.
  assert.strictEqual(E.backProgress('right', -E.COMPLETE_DISTANCE), 1);
  assert.strictEqual(E.backProgress(null, 50), 0);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
