// Which side of the chat a message goes on.
//
// Reported with a screenshot: messages sent with no internet, which failed,
// come back on the LEFT — the other person's side — after closing the chat and
// opening it again.
//
// The side was one string comparison: `msg.username === me`. Right for
// anything the server sent back, fragile for the rows the app makes itself.
// A message being sent is stamped with whatever the screen believes the user
// is called at that instant — and a retry dispatched from a timer runs with
// whatever value its closure captured, which can be the empty string the
// screen starts with. That row is then PERSISTED with `username: ''`, so it is
// wrong for good, and fixing only the stamping would leave every message
// already sitting in somebody's outbox on the wrong side forever.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping message-side tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'msgside-'));
execFileSync(TSC, [path.join(NAT, 'src', 'messageSide.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const S = require(path.join(OUT, 'messageSide.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const ME = 'ako';

test('the ordinary case: the server says who wrote it', () => {
  assert.strictEqual(S.isMine({ id: 12, username: ME }, ME), true);
  assert.strictEqual(S.isMine({ id: 13, username: 'soran' }, ME), false);
});

test('THE BUG: a failed send stamped with no username is still MINE', () => {
  // This is the row in the screenshot: composed here, persisted, restored, and
  // drawn on the other person's side because the name never matched.
  const restored = { id: 'tmp-1712-abc', username: '', _uploadFailed: true };
  assert.strictEqual(S.isMine(restored, ME), true,
    'a failed send came back on the other side of the chat');
});

test('…and so is one still uploading', () => {
  assert.strictEqual(S.isMine({ id: 'tmp-9', username: '', _uploading: true }, ME), true);
});

test('the mark we put on it ourselves is enough on its own', () => {
  // Belt and braces for a row whose id has been replaced by a retry.
  assert.strictEqual(S.isMine({ _mine: true, username: '' }, ME), true);
  assert.strictEqual(S.isMine({ _mine: true, username: 'soran' }, ME), true);
});

test('THE TRAP: an empty username does not make somebody else\'s message mine', () => {
  // `'' === ''` is true, and `me` is empty for a moment on every cold start —
  // so a naive comparison puts the WHOLE CHAT on the right for that instant.
  assert.strictEqual(S.isMine({ id: 5, username: '' }, ''), false,
    'with no username known yet, a message was claimed as mine');
  assert.strictEqual(S.isMine({ id: 5, username: 'soran' }, ''), false);
});

test('a server message from someone else is never claimed', () => {
  // Numeric id, no local flags: nothing about it is ours.
  assert.strictEqual(S.isMine({ id: 77, username: 'soran' }, ME), false);
  assert.strictEqual(S.isMine({ id: 77, username: 'soran', _uploadFailed: true }, ME), false,
    'a numeric id is a server row — the failed flag cannot make it ours');
});

test('nothing at all is not mine', () => {
  assert.strictEqual(S.isMine(null, ME), false);
  assert.strictEqual(S.isMine(undefined, ME), false);
});

test('marking keeps the rest of the message intact', () => {
  const m = { id: 'tmp-3', content: 'hello', reply_to_id: 4 };
  const marked = S.markMine(m);
  assert.strictEqual(marked._mine, true);
  assert.strictEqual(marked.content, 'hello');
  assert.strictEqual(marked.reply_to_id, 4);
  assert.strictEqual(m._mine, undefined, 'the original was mutated');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('the screen decides the side with the rule, not a comparison', () => {
  assert.ok(!/const mine = msg\.username === me;/.test(chat),
    'the bare comparison is back, and with it the bug');
  assert.ok((chat.match(/const mine = isMine\(msg, me\);/g) || []).length >= 2,
    'not every place that decides a side uses the rule');
});

test('a message this device composes is marked as it is made', () => {
  const marks = chat.match(/markMine\(/g) || [];
  assert.ok(marks.length >= 4,
    `only ${marks.length} rows are marked — the optimistic rows and the restored ones both need it`);
});

test('THE OTHER HALF: the username comes from the ref, not the state', () => {
  // A retry dispatched from a timer runs with the value ITS closure captured.
  // The ref is the one that is always current.
  const stamps = chat.match(/username: [^,]+,/g) || [];
  const optimistic = stamps.filter(s => s.includes('meRef.current'));
  assert.ok(optimistic.length >= 2,
    'an optimistic row still stamps the username from the `me` state');
  assert.ok(!/username: me,/.test(chat),
    'a row is still stamped from the state, which is empty inside an early closure');
});

test('restored failed sends are marked on the way back in', () => {
  // Sliced FORWARD from the marker: `setLoading(false)` appears earlier in the
  // file too, and slicing to the first one gave an empty string — a check that
  // passed by measuring nothing.
  const from = chat.indexOf('// Still-uploading sends are shown');
  const restore = chat.slice(from, chat.indexOf('setLoading(false);', from));
  assert.ok(restore.length > 0, 'the restore block moved — this check would be vacuous');
  assert.ok((restore.match(/markMine\(/g) || []).length >= 2,
    'rows coming back from the outbox are not marked, so an old one stays on the wrong side');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
