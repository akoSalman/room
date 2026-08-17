// The loaded slice of a chat (native-app/src/messageWindow.ts).
//
// Reported as two things, which turn out to be the same thing:
//   • "Show in chat" does not land on the message
//   • after landing, scrolling down loads the whole history at once
//
// A chat is normally shown from its newest message backwards, so the only
// direction that can run out is older. Jumping to a message from months ago
// breaks that: the loaded messages become a window in the MIDDLE, with more in
// both directions. The old code merged the jump's window into whatever was
// already on screen and sorted by id, which produces a list with a hole in it —
// March directly above August, nothing marking the join, and scrolling down
// from the jump silently skipping everything between.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'msgwin-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'messageWindow.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping message-window tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const W = require(path.join(OUT, 'messageWindow.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const PAGE = 50;
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i }));

test('a full newest page has more behind it and nothing ahead', () => {
  const win = W.atBottom(range(51, 100), PAGE);
  assert.strictEqual(win.hasOlder, true);
  assert.strictEqual(win.hasNewer, false);
});

test('a short newest page is the whole chat', () => {
  const win = W.atBottom(range(1, 10), PAGE);
  assert.strictEqual(win.hasOlder, false);
  assert.strictEqual(win.hasNewer, false);
});

test('THE BUG: jumping REPLACES the window rather than merging', () => {
  // Merging the jump's window into the recent block gives one array with a
  // hole: message 120 sitting directly above 900. Nothing downstream can tell
  // where the join is, so scrolling past it skips 780 messages in one step.
  const recent = W.atBottom(range(900, 949), PAGE);
  const jumped = W.aroundMessage(range(100, 120), true, true);
  assert.deepStrictEqual(jumped.messages.map(m => m.id), range(100, 120).map(m => m.id));
  assert.ok(!jumped.messages.some(m => m.id >= 900),
    'the recent block survived into the jumped window, re-creating the hole');
  assert.strictEqual(jumped.hasNewer, true, 'the window does not know more follows it');
  assert.strictEqual(recent.hasNewer, false);
});

test('a jump to a message near the start knows there is nothing older', () => {
  const win = W.aroundMessage(range(1, 20), false, true);
  assert.strictEqual(win.hasOlder, false);
  assert.strictEqual(win.hasNewer, true);
});

test('loading a page forward keeps the window contiguous', () => {
  let win = W.aroundMessage(range(100, 120), true, true);
  win = W.appendNewer(win, range(121, 170), PAGE);
  assert.deepStrictEqual(
    win.messages.map(m => m.id),
    range(100, 170).map(m => m.id),
    'the forward page did not join on cleanly',
  );
  assert.strictEqual(win.hasNewer, true, 'a full page means there is probably more');
});

test('a short page forward means the window has caught up to the present', () => {
  let win = W.aroundMessage(range(100, 120), true, true);
  win = W.appendNewer(win, range(121, 130), PAGE);
  assert.strictEqual(win.hasNewer, false);
});

test('an empty page forward also means caught up', () => {
  const win = W.appendNewer(W.aroundMessage(range(1, 5), false, true), [], PAGE);
  assert.strictEqual(win.hasNewer, false);
});

test('loading a page backwards works the same way', () => {
  let win = W.atBottom(range(51, 100), PAGE);
  win = W.prependOlder(win, range(1, 50), PAGE);
  assert.deepStrictEqual(win.messages.map(m => m.id), range(1, 100).map(m => m.id));
  assert.strictEqual(win.hasOlder, true);
  win = W.prependOlder(win, [], PAGE);
  assert.strictEqual(win.hasOlder, false);
});

test('paging does not duplicate a message that is already loaded', () => {
  // Pages can overlap by one when a boundary message is included in both.
  let win = W.aroundMessage(range(100, 120), true, true);
  win = W.appendNewer(win, range(120, 130), PAGE);
  const ids = win.messages.map(m => m.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'a message appears twice');
});

test('loading forward leaves the older flag alone', () => {
  const win = W.appendNewer(W.aroundMessage(range(100, 120), true, true), range(121, 170), PAGE);
  assert.strictEqual(win.hasOlder, true, 'walking forward forgot there was history behind');
});

// ── Live messages while a jump is open ───────────────────────────────────────

test('a live message is accepted when the window reaches the present', () => {
  assert.strictEqual(W.acceptsLive(W.atBottom(range(1, 10), PAGE)), true);
});

test('THE OTHER HALF: a live message is NOT appended into a jumped window', () => {
  // Reading a message from March, a message arriving now belongs thousands
  // later. Appending it would draw it directly beneath March as though it were
  // the next thing said.
  assert.strictEqual(W.acceptsLive(W.aroundMessage(range(100, 120), true, true)), false);
});

test('once caught up, live messages are accepted again', () => {
  const win = W.appendNewer(W.aroundMessage(range(100, 120), true, true), range(121, 125), PAGE);
  assert.strictEqual(W.acceptsLive(win), true);
});

// ── Ends, and trimming ───────────────────────────────────────────────────────

test('the ends of the window are reported for asking what lies beyond', () => {
  const win = W.aroundMessage(range(100, 120), true, true);
  assert.strictEqual(W.oldestId(win), 100);
  assert.strictEqual(W.newestId(win), 120);
});

test('an empty window has no ends', () => {
  assert.strictEqual(W.oldestId(W.emptyWindow), null);
  assert.strictEqual(W.newestId(W.emptyWindow), null);
});

test('membership is checked as strings', () => {
  // An unacknowledged message carries a temporary string id.
  const win = W.aroundMessage([{ id: '7' }, { id: 8 }], false, false);
  assert.strictEqual(W.contains(win, 7), true);
  assert.strictEqual(W.contains(win, '8'), true);
  assert.strictEqual(W.contains(win, 9), false);
});

test('trimming keeps the end being read and admits the rest can be refetched', () => {
  // Walking forward through months would otherwise hold every page in memory.
  const win = W.aroundMessage(range(1, 300), false, false);
  const kept = W.trim(win, 100, 'older');
  assert.strictEqual(kept.messages.length, 100);
  assert.strictEqual(kept.messages[0].id, 201, 'trimmed the wrong end');
  assert.strictEqual(kept.hasOlder, true, 'dropped history without saying it could be reloaded');
});

test('trimming the newer end keeps the older messages', () => {
  const win = W.aroundMessage(range(1, 300), false, false);
  const kept = W.trim(win, 100, 'newer');
  assert.strictEqual(kept.messages[0].id, 1);
  assert.strictEqual(kept.messages[99].id, 100);
  assert.strictEqual(kept.hasNewer, true);
});

test('a window shorter than the limit is left alone', () => {
  const win = W.aroundMessage(range(1, 10), false, false);
  assert.strictEqual(W.trim(win, 100, 'older'), win);
});

test('inverted gives newest first without disturbing the window', () => {
  const win = W.aroundMessage(range(1, 3), false, false);
  assert.deepStrictEqual(W.inverted(win).map(m => m.id), [3, 2, 1]);
  assert.deepStrictEqual(win.messages.map(m => m.id), [1, 2, 3], 'the window was mutated');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
