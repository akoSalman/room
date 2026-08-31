// A tap on a link or a number is not a tap on the message.
//
// Reported, for the third time: tapping a link or a number pops up the message
// menu. The first two fixes — one for numbers, one for a tapped reply — both
// worked the same way: the token's handler set a flag, and the bubble's
// release handler checked the flag before scheduling the menu.
//
// That only holds if the events arrive in the order the code assumed. On a
// real phone they do not. Android dispatches a Text press separately from the
// touch that carried it, so when the list is long and the JS thread is busy —
// exactly when somebody is scrolling a chat hunting for a number to copy — the
// press can land AFTER the 300 ms double-tap window has expired and opened the
// menu. Setting a flag then, and clearing a timer that has already fired,
// changes nothing.
//
// So the question became one about TIME, asked by both sides whenever they run
// — including the half that can take back a menu the same touch just opened,
// which is the only half that works when the press comes last.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping token-tap tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tokentap-'));
execFileSync(TSC, [path.join(NAT, 'src', 'tokenTap.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const T = require(path.join(OUT, 'tokenTap.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const NOW = 10_000_000;

// ── Not opening the menu ────────────────────────────────────────────────────

test('THE POINT: a menu about to open right after a token press does not', () => {
  assert.strictEqual(T.spentByToken({ pressedAt: NOW - 50, now: NOW }), true);
});

test('and it still does not when the press was slower than the menu\'s own wait', () => {
  // This is the case the old flag could not cover: the menu waits 300 ms for a
  // second tap, and the press can arrive after that.
  assert.strictEqual(T.spentByToken({ pressedAt: NOW - 320, now: NOW }), true,
    'a press that arrived after the double-tap window stopped counting');
  assert.strictEqual(T.spentByToken({ pressedAt: NOW - 550, now: NOW }), true);
});

test('but a deliberate tap a moment later DOES open the menu', () => {
  // The grace cannot be so long that tapping the bubble after using a link
  // silently does nothing.
  assert.strictEqual(T.spentByToken({ pressedAt: NOW - 900, now: NOW }), false);
  assert.strictEqual(T.spentByToken({ pressedAt: NOW - 60_000, now: NOW }), false);
});

test('a message that was never tapped is not silenced', () => {
  assert.strictEqual(T.spentByToken({ pressedAt: null, now: NOW }), false);
  assert.strictEqual(T.spentByToken({ pressedAt: 0, now: NOW }), false);
  assert.strictEqual(T.spentByToken({ pressedAt: undefined, now: NOW }), false);
});

test('a timestamp from the future does not silence the menu forever', () => {
  // A clock that moved, or a stale value carried in from another chat.
  assert.strictEqual(T.spentByToken({ pressedAt: NOW + 5000, now: NOW }), false);
});

test('the window is bounded, and stated', () => {
  assert.ok(T.TOKEN_GRACE_MS > 300, 'the grace is shorter than the wait it has to outlast');
  assert.ok(T.TOKEN_GRACE_MS <= 1000, 'the grace is long enough to swallow taps people meant');
  // Exactly at the edge still counts; past it does not.
  assert.strictEqual(T.spentByToken({ pressedAt: NOW - T.TOKEN_GRACE_MS, now: NOW }), true);
  assert.strictEqual(T.spentByToken({ pressedAt: NOW - T.TOKEN_GRACE_MS - 1, now: NOW }), false);
});

// ── Taking back a menu that was never meant ─────────────────────────────────

test('THE OTHER HALF: a menu opened a moment ago is closed by the press that follows', () => {
  // Nothing but this touch can have opened it — the finger was on the link.
  assert.strictEqual(T.menuWasStrayTap({ menuOpenedAt: NOW - 20, now: NOW }), true);
  assert.strictEqual(T.menuWasStrayTap({ menuOpenedAt: NOW - 310, now: NOW }), true);
});

test('a menu the user opened themselves is left alone', () => {
  // Long-pressed a minute ago, then a link tapped underneath: not the same
  // touch, and closing it would be taking away what they asked for.
  assert.strictEqual(T.menuWasStrayTap({ menuOpenedAt: NOW - 5000, now: NOW }), false);
  assert.strictEqual(T.menuWasStrayTap({ menuOpenedAt: null, now: NOW }), false);
  assert.strictEqual(T.menuWasStrayTap({ menuOpenedAt: NOW + 100, now: NOW }), false);
});

// ── The wiring, which is where the bug actually lived ───────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('the old order-dependent flag is gone', () => {
  assert.ok(!/const spentByToken = useRef\(/.test(chat),
    'the flag that only worked when the events arrived in the right order is still there');
  assert.ok(chat.includes("from '../tokenTap'"), 'the rule is not used at all');
});

test('a token press records WHEN, and takes back a stray menu', () => {
  const fn = chat.slice(chat.indexOf('function tokenPress('), chat.indexOf('const tokenPressedAt'));
  assert.ok(fn.includes('tokenPressedAt.current = now'), 'nothing records when the token was pressed');
  assert.ok(fn.includes('menuWasStrayTap({'), 'a menu the same touch opened is left on screen');
  assert.ok(fn.includes('setActionsMsg(null)'), 'the stray menu is never actually closed');
  assert.ok(fn.indexOf('setActionsMsg(null)') < fn.indexOf('action()'),
    'the menu is closed after the action, so the action re-opens under it');
});

test('every path that can open the menu asks first', () => {
  // Three of them, and the report came back because only one asked.
  const release = chat.slice(chat.indexOf('function noteTextRelease'), chat.indexOf('/** Wipe the on-screen selection'));
  assert.ok(release.includes('if (menuSpentByToken()) return;'),
    'the release handler no longer checks');
  // The delayed menu, asked AGAIN at the moment it fires.
  assert.ok(/tapTimer\.current = setTimeout\(\(\) => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(menuSpentByToken\(\)\) return;/.test(release),
    'the 300ms timer opens the menu without re-checking, which is the reported bug');
  const tap = chat.slice(chat.indexOf('function onMessageTap('), chat.indexOf('function onMessageTap(') + 700);
  assert.ok(tap.includes('if (menuSpentByToken()) return;'),
    'the row-wide press catcher opens the menu without asking');
});

test('the menu records when it opened, or nothing can take it back', () => {
  const fn = chat.slice(chat.indexOf('function openMenuFor('), chat.indexOf('function openMenuFor(') + 300);
  assert.ok(fn.includes('menuOpenedAt.current = Date.now()'), 'the menu does not record when it opened');
});

test('a fresh touch does not wipe a press that is still on its way', () => {
  // Clearing the timestamp outright on every touch-down would put the bug
  // straight back: the late press would find nothing to explain the menu.
  assert.ok(/if \(!menuSpentByToken\(\)\) tokenPressedAt\.current = null;/.test(chat),
    'the timestamp is cleared unconditionally on the next touch');
});

test('every tappable thing inside a bubble still goes through tokenPress', () => {
  // The fix is worth nothing to a token that answers the touch its own way.
  const render = chat.slice(chat.indexOf('function renderTextWithLinks'), chat.indexOf('async function openMentionedUser'));
  const presses = render.match(/onPress=\{/g) || [];
  const wrapped = render.match(/onPress=\{\(\) => tokenPress\(/g) || [];
  assert.strictEqual(presses.length, wrapped.length,
    'a token inside a message answers a tap without marking it spent');
  assert.ok(wrapped.length >= 3, 'links, numbers and mentions are not all wired up');
  // The two outside that function: the reply quote and the link preview card.
  assert.ok(chat.includes('tokenPress(() => jumpToMessage('), 'a tapped reply is unprotected again');
  assert.ok(/onPress=\{run => tokenPress\(run\)\}/.test(chat), 'the link card is unprotected');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
