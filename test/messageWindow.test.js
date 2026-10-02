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

// ── Following the conversation ──────────────────────────────────────────────
//
// Reported as: on a new message arriving, the auto scroll down is not
// happening.
//
// It was not, and the cause was a fix for something else. The list is
// INVERTED, so an arriving message is inserted at index 0 — the start of the
// content — and maintainVisibleContentPosition exists precisely to stop what
// is on screen from moving when that happens. Anchoring unconditionally did
// exactly what it promises: it held the view still and left the new message
// just off the bottom edge.

test('THE BUG: at the present the list does NOT anchor, so it can follow', () => {
  assert.strictEqual(W.anchorsContent({ hasNewer: false }), false,
    'the view is pinned at the present, so an arriving message cannot push it');
});

test('parked mid-history it DOES anchor, which is what stopped the hopping', () => {
  // Newer pages are inserted above the reader there; without an anchor the
  // view slides by however wrong the list's guess at their height was.
  assert.strictEqual(W.anchorsContent({ hasNewer: true }), true);
});

test('a message arriving while reading the newest end is followed', () => {
  assert.strictEqual(W.followsNewMessage(
    { atEnd: true, fromMe: false, windowAcceptsLive: true }), true);
});

test('somebody reading back through yesterday is not yanked to the bottom', () => {
  // That is what the unseen badge is for.
  assert.strictEqual(W.followsNewMessage(
    { atEnd: false, fromMe: false, windowAcceptsLive: true }), false);
});

test('but pressing send always takes you to the bottom', () => {
  // Sending IS a request to be at the newest end, wherever you were reading.
  assert.strictEqual(W.followsNewMessage(
    { atEnd: false, fromMe: true, windowAcceptsLive: true }), true);
});

test('nothing is followed into a window that will not show it', () => {
  // Parked after a jump, the message is not appended at all — scrolling to the
  // bottom of THIS window would land on a message from March.
  assert.strictEqual(W.followsNewMessage(
    { atEnd: true, fromMe: true, windowAcceptsLive: false }), false);
  assert.strictEqual(W.followsNewMessage(
    { atEnd: true, fromMe: false, windowAcceptsLive: false }), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('the screen uses the rule for both halves', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/maintainVisibleContentPosition=\{\s*\n?\s*win\.anchorsContent/.test(src),
    'the list anchors unconditionally again, which is the bug');
  assert.ok(src.includes('win.followsNewMessage({'),
    'the arrival path decides for itself whether to follow');
});

test('what the anchor depends on is STATE, or the prop can never change', () => {
  // A ref does not re-render, so an anchor driven by one would keep whatever
  // value it had when the list last happened to render.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/anchorsContent\(\{ hasNewer: hasMoreNewer \}\)/.test(src),
    'the anchor reads something other than the rendered state');
  assert.ok(/const \[hasMoreNewer, setHasMoreNewerState\] = useState/.test(src),
    'there is no state behind it');
  // And the two must be written together, or they drift.
  assert.ok(!/hasMoreNewerRef\.current = (?!v;)/.test(src),
    'the ref is assigned directly somewhere, so the state can fall out of step');
});

test('the follow happens AFTER the row exists, not during the socket handler', () => {
  // Scrolling to the bottom before React has rendered the new row scrolls to
  // where the bottom already was, which is nowhere.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const fn = src.slice(src.indexOf('const followNewMessage'), src.indexOf('useEffect(() => { messagesRef'));
  assert.ok(fn.includes('requestAnimationFrame'), 'the scroll is still attempted in the same tick');
  // The delayed correction must exist and must still be CONDITIONAL on the
  // user being at the bottom — scrolling someone who has read back up to an
  // old message down to the end is worse than not following at all. Matched
  // on those two facts rather than on one exact spelling of the callback,
  // which is how this failed when a line was added inside it.
  const delayed = /setTimeout\(\(\) => \{([\s\S]*?)\},\s*\d+\)/.exec(fn);
  assert.ok(delayed, 'nothing corrects a row whose height settles later — an image, a reply preview');
  assert.ok(/isNearBottomRef\.current/.test(delayed[1]),
    'the delayed scroll is unconditional, so it drags the user away from what they were reading');
  assert.ok(/scrollBottom\(\)/.test(delayed[1]),
    'the delayed correction does not actually scroll');
  assert.ok((fn.match(/isNearBottomRef\.current/g) || []).length >= 2,
    'the deferred scroll does not re-check that the user is still at the bottom');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
