// The floating button at the bottom of a chat (native-app/src/scrollFab.ts).
//
// Reported as: tapping the new-message badge scrolls down, but the badge and
// the button are still there afterwards.
//
// The count and the button were cleared only by the scroll handler, and that
// handler is throttled to one event per 100ms. A programmatic scroll finishes
// between two ticks, so the last position ever reported is part-way there —
// the button stays up over a chat that is already at the bottom, with a count
// of messages the user is now looking at.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollfab-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'scrollFab.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping scroll-fab tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const F = require(path.join(OUT, 'scrollFab.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const mode = (o) => F.fabMode({ backStackSize: 0, atEndOfWindow: false, hasNewer: false, ...o });

test('scrolled up in a normal chat, the button offers the bottom', () => {
  assert.strictEqual(mode({ atEndOfWindow: false }), 'bottom');
});

test('at the bottom of a normal chat, there is nothing to offer', () => {
  assert.strictEqual(mode({ atEndOfWindow: true }), 'hidden');
});

test('THE BUG: tapping the go-to-bottom button clears the unseen count', () => {
  // Without this the count waits for a scroll event that may never arrive with
  // the final position, and sits over messages the user is already reading.
  assert.strictEqual(F.clearsUnseenOnTap('bottom'), true);
});

test('walking back to a previous message does NOT clear the count', () => {
  // That tap goes to an OLD message. Clearing would hide the fact that
  // something new is still waiting at the bottom.
  assert.strictEqual(F.clearsUnseenOnTap('back'), false);
  assert.strictEqual(F.clearsUnseenOnTap('hidden'), false);
});

test('the end of the WINDOW is not the present when more follows it', () => {
  // After a jump the loaded window sits in the middle of the chat, so the end
  // of the list still has history beyond it.
  assert.strictEqual(F.atPresent({ atEndOfWindow: true, hasNewer: true }), false);
  assert.strictEqual(F.atPresent({ atEndOfWindow: true, hasNewer: false }), true);
  assert.strictEqual(F.atPresent({ atEndOfWindow: false, hasNewer: false }), false);
});

test('at the end of a jumped-to window, the button still offers the present', () => {
  // Otherwise the way back to the newest messages disappears exactly where the
  // user most needs it.
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: true }), 'bottom');
});

test('a trail of jumps takes priority over everything', () => {
  // The trail is the one thing the user cannot reconstruct by hand, so it is
  // offered even while sitting at the bottom.
  assert.strictEqual(mode({ backStackSize: 1, atEndOfWindow: true }), 'back');
  assert.strictEqual(mode({ backStackSize: 3, atEndOfWindow: false }), 'back');
  assert.strictEqual(mode({ backStackSize: 2, atEndOfWindow: true, hasNewer: true }), 'back');
});

test('once the trail is exhausted the button goes back to meaning "bottom"', () => {
  assert.strictEqual(mode({ backStackSize: 0, atEndOfWindow: false }), 'bottom');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
