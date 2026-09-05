// Opening a chat where the unread messages actually are.
//
// Reported together: "I see some unread messages but opening chat doesn't mark
// them as read", "first direct user to where those messages locate in chat",
// and "add a mark as read option to the chat list long press menu".
//
// The first of those was a real bug and it is tested in test/server.test.js: a
// message written while the recipient had the sender blocked is never shown by
// any list in this file, and it was still counted — so the badge counted a
// message that is not in the chat and could never be cleared by reading it.
//
// This file is the other two: where a chat opens, and what the list can do
// about a badge without opening anything.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'unreadJump.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ujump-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'unreadJump.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'unreadJump.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

const chat = [
  { id: 10, username: 'them' },
  { id: 11, username: 'me' },
  { id: 12, username: 'them' },
  { id: 13, username: 'them' },
];

// ── Where to open ───────────────────────────────────────────────────────────

test('THE ASK: the chat opens at the first message not yet seen', () => {
  assert.strictEqual(W.firstUnread(chat, 11, 'me').id, 12);
  assert.strictEqual(W.firstUnread(chat, 9, 'me').id, 10);
});

test('my own messages are not something to be sent back up to', () => {
  // A chat whose last word was mine would otherwise open at my own message
  // every single time.
  assert.strictEqual(W.firstUnread([{ id: 20, username: 'me' }, { id: 21, username: 'them' }],
    19, 'me').id, 21);
});

test('everything read means no jump at all', () => {
  assert.strictEqual(W.firstUnread(chat, 13, 'me'), null);
  assert.strictEqual(W.firstUnread(chat, 99, 'me'), null);
});

test('never having read anything is not "all of it is unread"', () => {
  // A chat opened for the first time — or one whose read position was never
  // written — must not be scrolled to its very first message ever sent.
  assert.strictEqual(W.firstUnread(chat, 0, 'me'), null);
  assert.strictEqual(W.firstUnread(chat, null, 'me'), null);
});

test('rubbish in, no jump out', () => {
  assert.strictEqual(W.firstUnread(null, 5, 'me'), null);
  assert.strictEqual(W.firstUnread([{ id: 'x', username: 'them' }], 5, 'me'), null);
  assert.strictEqual(W.firstUnread([], 5, 'me'), null);
});

test('ONE message does not move the view', () => {
  // It is already on screen: a chat opens at the bottom. Scrolling to it moves
  // the view for nothing and costs the reader the context under it.
  assert.strictEqual(W.worthJumping(1), false);
  assert.strictEqual(W.worthJumping(0), false);
  assert.strictEqual(W.worthJumping(2), true);
  assert.strictEqual(W.worthJumping(30), true);
});

test('the divider says how many, so the jump explains itself', () => {
  assert.strictEqual(W.unreadLabel(1), '1 new message');
  assert.strictEqual(W.unreadLabel(4), '4 new messages');
  assert.strictEqual(W.unreadLabel(0), '');
  assert.strictEqual(W.unreadLabel(-3), '');
});

test('the web and the app agree', () => {
  if (!A) return;
  assert.strictEqual(W.JUMP_MIN, A.JUMP_MIN);
  let checked = 0;
  for (const mark of [null, 0, 9, 10, 11, 12, 13, 99]) {
    const w = W.firstUnread(chat, mark, 'me');
    const a = A.firstUnread(chat, mark, 'me');
    assert.deepStrictEqual(w, a, `first-unread diverges at mark ${mark}`);
    checked++;
  }
  for (let n = 0; n < 5; n++) {
    assert.strictEqual(W.worthJumping(n), A.worthJumping(n));
    assert.strictEqual(W.unreadLabel(n), A.unreadLabel(n));
    checked++;
  }
  assert.ok(checked >= 12, `the drift check only ran ${checked} times`);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const chatScreen = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');

test('THE ORDER MATTERS: the position is read before it is consumed', () => {
  // Opening a chat marks it read. Asking afterwards would always answer "you
  // have read everything", and the jump would never happen.
  const from = app.indexOf('const waiting = unreadCounts[roomId] || 0;');
  assert.ok(from > 0, 'the web no longer reads how many were waiting');
  // Searched FORWARD from there: `showUnreadFrom(msgs, lastReadId, waiting)` is
  // also the function's own signature, which appears earlier in the file — and
  // slicing to that gave an empty string that passed nothing but a length check.
  const web = app.slice(from, app.indexOf('showUnreadFrom(msgs, lastReadId, waiting)', from));
  assert.ok(web.length > 0, 'the web no longer reads its position — this check is vacuous');
  assert.ok(web.indexOf("api('/read-position/' + roomId)") < web.indexOf("socket.emit('mark_read'"),
    'the web asks where it had got to only after marking everything read');

  const native = chatScreen.slice(chatScreen.indexOf('const [msgs, u, sock, pos] = await Promise.all(['),
    chatScreen.indexOf('offline.saveMessages(room.id, msgs)'));
  assert.ok(native.length > 0, 'the app no longer reads its position — this check is vacuous');
  assert.ok(native.indexOf('/read-position/') < native.indexOf("sock.emit('mark_read'"),
    'the app asks where it had got to only after marking everything read');
});

test('both clients jump through the rule, and mark the seam', () => {
  assert.ok(/UnreadJump\.firstUnread\(msgs, lastReadId, username\)/.test(app),
    'the web picks the message to jump to by hand');
  assert.ok(/UnreadJump\.worthJumping\(waiting\)/.test(app),
    'the web jumps even for a single message that is already on screen');
  assert.ok(/unread-divider/.test(app), 'the web jumps with no explanation of why');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  assert.ok(/\.unread-divider \{/.test(css), 'the divider has no style, so it is invisible');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/src="\/js\/unreadJump\.js"/.test(html),
    'unreadJump.js is never loaded, so UnreadJump is undefined and opening a chat throws');

  assert.ok(/firstUnread\(msgs, lastRead, u \|\| ''\)/.test(chatScreen), 'the app picks by hand');
  assert.ok(/worthJumping\(waiting\)/.test(chatScreen), 'the app jumps for a single message');
  assert.ok(/jumpToMessage\(Number\(target\.id\)\)/.test(chatScreen), 'the app never moves');
  assert.ok(/unreadFrom === Number\(msg\.id\)/.test(chatScreen), 'the app draws no divider');
  // Drawn inside a row, so a row that never re-renders never grows one.
  assert.ok(/selectMode, e2ePhase, unreadFrom \}\)/.test(chatScreen),
    'the app rows are not told where the seam is');
});

test('MARK AS READ is offered by both lists, and only when it would do something', () => {
  assert.ok(/function addRoomMenu\(/.test(app), 'the web chat list still has no menu at all');
  assert.ok(/addRoomMenu\(li, room\.id, room\.name\)/.test(app), 'rooms have no menu');
  assert.ok(/addRoomMenu\(li, room\.id, otherUsername\)/.test(app), 'direct chats have no menu');
  const menu = app.slice(app.indexOf('function addRoomMenu('), app.indexOf('function markRoomRead('));
  assert.ok(/unreadCounts\[roomId\] \|\| 0\) > 0/.test(menu),
    'a chat with nothing unread is offered "mark as read"');
  assert.ok(/addLongPress\(li, open\)/.test(menu) && /oncontextmenu/.test(menu),
    'the menu cannot be opened by long press, or not by right-click');

  assert.ok(/Mark as read/.test(rooms), 'the app sheet does not offer it');
  assert.ok(/\(unread\[clearing\.id\] \|\| 0\) > 0/.test(rooms),
    'the app offers it on a chat with nothing unread');
});

test('the badge is set from the SERVER\'s answer, not from an assumption', () => {
  // Marking a room read also marks its threads read. A client that assumed
  // zero would disagree with the list the moment anything else was unread.
  const web = app.slice(app.indexOf('function markRoomRead('), app.indexOf('function isRoomOwner('));
  assert.ok(/unreadCounts\[res\.roomId\] = res\.unread/.test(web),
    'the web assumes what the count became');
  assert.ok(/if \(!res \|\| !res\.ok\)/.test(web), 'a failure is treated as a success');
  const nat = rooms.slice(rooms.indexOf('async function markRoomRead('), rooms.indexOf('const load = useCallback'));
  assert.ok(/\[res\.roomId\]: res\.unread/.test(nat), 'the app assumes what the count became');
  assert.ok(/if \(!res \|\| !res\.ok\)/.test(nat), 'a failure is treated as a success');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
