// Tests for the disappearing-message countdown ring
// (native-app/src/expiryRing.ts).
//
// The fraction drives what the user sees of a message's remaining life, so it
// has to be right at the edges: a message that has just been seen must read as
// full, and one past its deadline as empty, never as something in between or
// as NaN.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ringtest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'expiryRing.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping expiry-ring tests (native-app deps not installed)');
  process.exit(0);
}
// Compiled with JSX stripped to plain calls; only the exported maths is used.
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck'], { stdio: 'pipe' });
const R = require(path.join(OUT, 'expiryRing.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);

test('a message just seen shows a full ring', () => {
  const now = 1_000_000;
  near(R.remainingFraction(now + 30_000, 30, now), 1, 1e-9, 'full');
});

test('halfway through, the ring is half', () => {
  const now = 1_000_000;
  near(R.remainingFraction(now + 15_000, 30, now), 0.5, 1e-9, 'half');
});

test('at and past the deadline the ring is empty, never negative', () => {
  const now = 1_000_000;
  assert.strictEqual(R.remainingFraction(now, 30, now), 0);
  assert.strictEqual(R.remainingFraction(now - 99_000, 30, now), 0,
    'a long-dead message produced a negative ring');
});

test('a clock skew cannot push the ring past full', () => {
  // The deadline is computed on the server; a phone whose clock is behind
  // would otherwise render more than 100%.
  const now = 1_000_000;
  assert.strictEqual(R.remainingFraction(now + 60_000, 30, now), 1);
});

test('a message with no timer reads as full rather than as NaN', () => {
  assert.strictEqual(R.remainingFraction(0, 0), 1);
  assert.strictEqual(R.remainingFraction(null, 30), 1);
  assert.strictEqual(R.remainingFraction(123456, 0), 1);
  assert.strictEqual(R.remainingFraction(123456, -5), 1);
});

test('the repaint rate suits the timer length', () => {
  // A 30-second ring must visibly move; a week-long one must not wake the
  // device twice a second to redraw something that has not changed.
  assert.ok(R.tickInterval(30) <= 500, 'a short timer repaints too slowly to look alive');
  assert.ok(R.tickInterval(3600) >= 1000, 'an hour-long timer repaints too often');
  assert.ok(R.tickInterval(604800) >= 10000, 'a week-long timer repaints far too often');
  assert.ok(R.tickInterval(0) > 0, 'a zero timer produced a non-positive interval');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
