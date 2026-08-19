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
const mode = (o) => F.fabMode({ atEndOfWindow: false, hasNewer: false, unseen: 0, ...o });

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

// ── One button, one job ─────────────────────────────────────────────────────
//
// Reported as: after "show in chat" there is no need for a button that returns
// to where you were — the one that goes to the newest messages is enough; and
// the same while searching.
//
// The button used to turn into a back button after any jump and walk the trail
// in reverse. Stepping through ten search results left ten jumps on that trail,
// so leaving the search meant ten taps backwards through results already looked
// at — and the whole time the count of new messages was hidden, because the
// button was busy being something else.

test('THE CHANGE: a jump does not turn the button into a back button', () => {
  // There is no longer any mode but "go to the newest".
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: true }), 'bottom');
  assert.strictEqual(mode({ atEndOfWindow: false, hasNewer: false }), 'bottom');
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: false }), 'hidden');
});

test('every visible state of the button clears the count when tapped', () => {
  // It only ever goes to the newest messages now, so arriving there always
  // means the new messages have been reached.
  assert.strictEqual(F.clearsUnseenOnTap(mode({ atEndOfWindow: false })), true);
  assert.strictEqual(F.clearsUnseenOnTap(mode({ atEndOfWindow: true, hasNewer: true })), true);
});

// ── The count ───────────────────────────────────────────────────────────────
//
// Reported as: when new messages arrive while scrolled up, the button with the
// count does not act correctly.

test('THE BUG: something unseen always leaves somewhere to go', () => {
  // onScroll is throttled, so the last position it reported is not always
  // where the list actually came to rest. If that reading says "at the bottom"
  // while messages have arrived unseen, the button hides itself and takes the
  // count with it — a badge that vanishes over messages nobody has read.
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: false, unseen: 3 }), 'bottom');
});

test('nothing unseen and nothing beyond the end means no button', () => {
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: false, unseen: 0 }), 'hidden');
});

test('a missing count is not a count', () => {
  // The caller may simply not pass it; that must not read as "something is
  // waiting" and pin the button open forever.
  assert.strictEqual(F.fabMode({ atEndOfWindow: true, hasNewer: false }), 'hidden');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  \u2713 ${n}`); passed++; }
  catch (e) { console.error(`  \u2717 ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
