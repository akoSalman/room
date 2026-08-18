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

// ── A way out of a search ────────────────────────────────────────────────────
//
// Reported as: while searching there is no button to go to the end of the chat
// (the new messages), and none afterwards either once the search box has been
// cleared and the search area closed.
//
// Stepping through search results jumps to each one, and every jump is pushed
// onto the back trail — so the button turns into the back-walking one and STAYS
// that way after the search closes, because closing a search does not undo the
// jumps it made. Ten results in, the only way to the present is ten taps
// backwards through the ones already looked at.
const newest = (o) =>
  F.showsGoToNewest({ backStackSize: 0, atEndOfWindow: false, hasNewer: false, ...o });

test('THE BUG: a search jump offers a direct way to the newest messages', () => {
  // Window left in the middle of the chat by the jump, trail one deep.
  assert.strictEqual(newest({ backStackSize: 1, atEndOfWindow: true, hasNewer: true }), true);
});

test('and it is still offered after stepping through many results', () => {
  // This is the case the back button cannot serve: ten taps to walk out.
  assert.strictEqual(newest({ backStackSize: 10, atEndOfWindow: false, hasNewer: true }), true);
});

test('no second button when the ordinary one already means "bottom"', () => {
  // Two buttons doing one job is worse than one.
  assert.strictEqual(mode({ backStackSize: 0, atEndOfWindow: false }), 'bottom');
  assert.strictEqual(newest({ backStackSize: 0, atEndOfWindow: false }), false);
  assert.strictEqual(newest({ backStackSize: 0, atEndOfWindow: true, hasNewer: true }), false);
});

test('no second button once the chat is back at the present', () => {
  // Trail still there to walk, but there is nowhere newer to be taken.
  assert.strictEqual(mode({ backStackSize: 2, atEndOfWindow: true, hasNewer: false }), 'back');
  assert.strictEqual(newest({ backStackSize: 2, atEndOfWindow: true, hasNewer: false }), false);
});

test('a jump inside the loaded window still offers the way down', () => {
  // Jumping to a quoted message that was already loaded: nothing newer to
  // FETCH, but the list is scrolled up, so the present is still somewhere else.
  assert.strictEqual(newest({ backStackSize: 1, atEndOfWindow: false, hasNewer: false }), true);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
