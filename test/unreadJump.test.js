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
  assert.ok(/unreadInfo && unreadInfo\.anchorId === String\(msg\.id\)/.test(chatScreen),
    'the app draws no divider');
  // Drawn inside a row, so a row that never re-renders never grows one.
  // Matched against the extraData block rather than against one exact spelling
  // of it: this used to pin unreadInfo to being the LAST key, so adding
  // anything after it failed a test about the divider.
  // Matched to where the block actually ends rather than to a character
  // budget: the budget was 1600 and the block outgrew it, so this failed
  // over the size of a list rather than over anything it is about.
  const extra = /const rowExtraData = useMemo\([\s\S]*?\n  \);/.exec(chatScreen);
  assert.ok(extra, 'could not find rowExtraData');
  // The OBJECT specifically. Searching the whole block would be satisfied by
  // the dependency list below, which is a different thing: a dependency that
  // is never put in the object recomputes the memo without telling the rows
  // anything.
  const obj = /\(\s*\)\s*=>\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(extra[0]);
  assert.ok(obj, 'could not find the rowExtraData object');
  assert.ok(/\bunreadInfo\b/.test(obj[1]),
    'the app rows are not told where the seam is');
  // The LABEL travels with it, not just the position: passing only the anchor
  // means a row does not re-render when the count beneath it changes, which is
  // the stale label with extra steps.
  // Checked in the DEPENDENCY list specifically: being in the object alone
  // would mean the memo never recomputes, so the rows would still be handed
  // the stale label.
  const deps = /\]\s*,\s*\[([\s\S]*?)\]\s*,?\s*\)\s*;|\}\s*\)\s*,\s*\[([\s\S]*?)\]\s*,?\s*\)\s*;/.exec(extra[0]);
  assert.ok(deps, 'could not find the rowExtraData dependency list');
  assert.ok(/\bunreadInfo\b/.test(deps[1] || deps[2] || ''),
    'the rows are not redrawn when the count below the line changes');
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

// ── The label and the line have to agree ────────────────────────────────────
//
// Reported with a screenshot: "2 NEW MESSAGES" written on a line sitting
// BETWEEN the two messages it was counting — one above, one below. A divider
// that contradicts its own position is worse than none: the reader cannot tell
// which of the two answers is the truth.

/** The label's number, from whichever copy is being driven. */
function below(M, list, anchorId, me) {
  const info = M.unreadDivider(list, anchorId, me);
  return info ? info.count : 0;
}

test('THE BUG: the label counts what is below the line, not what a badge said', () => {
  const msgs = [
    { id: 10, username: 'ako' },
    { id: 11, username: 'soran' },
    { id: 12, username: 'soran' },
  ];
  // The reader had got to 11, so only 12 is new — whatever any other count
  // says. One message below the line, and the line says one.
  const first = W.firstUnread(msgs, 11, 'ako');
  assert.strictEqual(Number(first.id), 12);
  assert.strictEqual(below(W, msgs, first.id, 'ako'), 1);
  assert.strictEqual(W.unreadLabel(below(W, msgs, first.id, 'ako')), '1 new message');
});

test('two below the line say two', () => {
  const msgs = [
    { id: 10, username: 'ako' },
    { id: 11, username: 'soran' },
    { id: 12, username: 'soran' },
  ];
  const first = W.firstUnread(msgs, 10, 'ako');
  assert.strictEqual(Number(first.id), 11);
  assert.strictEqual(below(W, msgs, first.id, 'ako'), 2);
});

test('my own replies underneath are not new messages to me', () => {
  const msgs = [
    { id: 11, username: 'soran' },
    { id: 12, username: 'ako' },
    { id: 13, username: 'soran' },
  ];
  assert.strictEqual(below(W, msgs, 11, 'ako'), 2, 'the reader\'s own message was counted');
});

test('anything counted but NOT DRAWN cannot inflate the label', () => {
  // This is the bug's actual mechanism: the count came from every message
  // newer than the mark, the line from the list on screen — and those differ
  // once expired one-time messages, disappearing messages and messages
  // deleted for everyone have been dropped from it.
  const onScreen = [{ id: 11, username: 'soran' }, { id: 14, username: 'soran' }];
  assert.strictEqual(below(W, onScreen, 11, 'ako'), 2,
    'the label counts messages that are not in the list');
});

test('an anchor that is not in the list counts nothing rather than everything', () => {
  const msgs = [{ id: 11, username: 'soran' }];
  assert.strictEqual(below(W, msgs, null, 'ako'), 0);
  assert.strictEqual(below(W, msgs, undefined, 'ako'), 0);
  assert.strictEqual(below(W, null, 11, 'ako'), 0);
});

test('the app and the web count the same way', () => {
  if (!A) return;
  // The lists here are deliberately NOT all sorted by id. A sorted list is the
  // one case where counting by id comparison and counting by list order agree,
  // so a drift check built only on sorted data passes against the very bug
  // being fixed — which is what the first version of this test did.
  const lists = [
    [{ id: 10, username: 'ako' }, { id: 11, username: 'soran' },
     { id: 12, username: 'ako' }, { id: 13, username: 'soran' }],
    // Out of id order: the shape that put a counted message above the line.
    [{ id: 9, username: 'soran' }, { id: 4, username: 'soran' },
     { id: 10, username: 'soran' }],
    // An optimistic send with a temporary string id in the middle.
    [{ id: 5, username: 'soran' }, { id: 'tmp-9', username: 'ako' },
     { id: 6, username: 'soran' }],
  ];
  let checked = 0;
  for (const msgs of lists) {
    for (const anchor of [...msgs.map(m => m.id), 99, null, '10']) {
      assert.strictEqual(below(W, msgs, anchor, 'ako'), below(A, msgs, anchor, 'ako'),
        `unreadBelow diverges at ${anchor} in ${JSON.stringify(msgs)}`);
      checked++;
    }
  }
  assert.ok(checked >= 18, `the drift check only ran ${checked} times`);
});

test('the APP copy holds the invariant too, not just the web one', () => {
  // The tests above all drive W, the web copy. Without this the app could be
  // reverted on its own and every one of them would still pass.
  if (!A) return;
  const list = [{ id: 9, username: 'soran' }, { id: 4, username: 'soran' }];
  assert.strictEqual(below(A, list, 4, 'ako'), 1,
    'the app counts a message that is drawn above the divider');
  assert.strictEqual(below(A, list, 9, 'ako'), 2);
  assert.strictEqual(below(A, [{ id: 7, username: 'soran' }], '7', 'ako'), 1,
    'the app fails to match a string id against a number one');
});

test('both clients label the divider from that count', () => {
  const ROOT = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const chat = fs.readFileSync(
    path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const fn = app.slice(app.indexOf('function showUnreadFrom('),
    app.indexOf('function showUnreadFrom(') + 1400);
  assert.ok(/UnreadJump\.unreadDivider\(msgs, first\.id, username\)/.test(fn),
    'the web still labels the line with the room badge');
  // THE THIRD REPORT: the app froze the count in a ref while the chat was
  // loading, so the label described the list as it was then for the rest of
  // the visit. It must be derived from the messages being drawn.
  assert.ok(/unreadDivider\(messages, unreadFrom, me\)/.test(chat),
    'the app labels the line with a count taken once, which goes stale');
  assert.ok(!/unreadCountOnEntry/.test(chat),
    'the remembered count is back, and with it a label that stops matching its rows');
  // THE WHOLE POINT, and the one thing a reader would not think to check: the
  // label is only live because `messages` is in the dependency list. Drop it
  // and the call still looks right, still reads `messages`, and never runs
  // again — the stale count exactly as before, with no ref to give it away.
  assert.ok(/unreadDivider\(messages, unreadFrom, me\),\s*\n\s*\[messages, unreadFrom, me\]/.test(chat),
    'the label is not recomputed when the message list changes, so it goes stale');
  assert.ok(/unreadInfo\.anchorId === String\(msg\.id\)/.test(chat),
    'the app matches the anchor with Number(), which no string id can equal');
});

// ── The divider must not contradict itself, a second time ───────────────────
//
// Reported twice from the same screenshot: "2 NEW MESSAGES" with one message
// ABOVE the line and one below.
//
// The first fix counted from the anchor down by comparing ids. But the anchor
// is chosen by walking the list in array order, and the list is drawn in array
// order — so id comparison agrees with the drawing only while the array
// happens to be sorted by id. An optimistic send carries a temporary string id,
// a page merged from the offline cache is concatenated rather than merged in
// order, a forward can arrive with a lower id. The moment they disagree, a
// message counted as "after the anchor" is drawn BEFORE it.

/** What the screen actually shows: rows from the divider to the end. */
function rowsBelow(list, anchorId, me) {
  const at = list.findIndex(m => String(m.id) === String(anchorId));
  if (at < 0) return 0;
  return list.slice(at).filter(m => m.username !== me).length;
}

test('THE INVARIANT: the label equals the rows drawn beneath the line', () => {
  // Whatever else is true, these two must agree — that is the whole bug.
  const cases = [
    // Sorted, the easy case.
    [{ id: 1, username: 'me' }, { id: 2, username: 'them' }, { id: 3, username: 'them' }],
    // An optimistic send sitting in the middle with a temporary string id.
    [{ id: 5, username: 'them' }, { id: 'tmp-9', username: 'me' }, { id: 6, username: 'them' }],
    // Out of id order, which is what made the label and the line disagree.
    [{ id: 9, username: 'them' }, { id: 4, username: 'them' }, { id: 10, username: 'them' }],
    // Every row is the user's own after the anchor.
    [{ id: 2, username: 'them' }, { id: 3, username: 'me' }, { id: 4, username: 'me' }],
  ];
  let checked = 0;
  for (const list of cases) {
    for (const m of list) {
      assert.strictEqual(
        below(W, list, m.id, 'me'), rowsBelow(list, m.id, 'me'),
        `label disagrees with the rows drawn, anchored at ${m.id} in ${JSON.stringify(list)}`);
      checked++;
    }
  }
  assert.ok(checked >= 12, 'the invariant check did not actually run');
});

test('THE REPORTED CASE: two from them, anchored at the first', () => {
  // The screenshot. Anchored at the first of the two, the label must say 2 and
  // both must be below. Anchored at the second, it must say 1 — not 2 with one
  // message stranded above the line.
  const list = [
    { id: 100, username: 'me' },
    { id: 101, username: 'them' },
    { id: 102, username: 'them' },
  ];
  assert.strictEqual(below(W, list, 101, 'me'), 2);
  assert.strictEqual(below(W, list, 102, 'me'), 1,
    'the line sits above the last message while claiming to count two');
});

test('ids out of order no longer count a message drawn ABOVE the line', () => {
  // The exact shape of the failure: id 4 is drawn before id 9, so anchoring at
  // 9 must not count it — even though 4 is not "less than" it in list order.
  const list = [{ id: 9, username: 'them' }, { id: 4, username: 'them' }];
  assert.strictEqual(below(W, list, 4, 'me'), 1,
    'a message drawn above the divider is counted below it');
  assert.strictEqual(below(W, list, 9, 'me'), 2);
});

test('an anchor that is no longer in the list labels nothing', () => {
  // It expired, or was deleted between being chosen and being drawn. There is
  // no line, so a count would be a label with no divider under it.
  const list = [{ id: 1, username: 'them' }, { id: 2, username: 'them' }];
  assert.strictEqual(below(W, list, 99, 'me'), 0);
  assert.strictEqual(below(W, list, null, 'me'), 0);
  assert.strictEqual(below(W, null, 1, 'me'), 0);
});

test('a string id and a number id are the same anchor', () => {
  // The id arrives as a number over the socket and as a string from a
  // notification payload. Comparing them strictly would find no anchor at all.
  const list = [{ id: 7, username: 'them' }, { id: 8, username: 'them' }];
  assert.strictEqual(below(W, list, '7', 'me'), 2);
  assert.strictEqual(below(W, list, 7, 'me'), 2);
});

// ── The divider must not contradict itself, a THIRD time ────────────────────
//
// Reported with a screenshot: "3 NEW MESSAGES" sitting after the first of the
// three. Both earlier fixes were real and neither was enough, because both
// left the same shape alone — the count was taken once, into a ref, while the
// chat was still loading, and the row it labelled went on re-rendering for the
// rest of the visit.

test('THE THIRD BUG: the label follows the list when it changes underneath', () => {
  // A message under the line is deleted. A label worked out beforehand still
  // says three; one worked out from the rows says two, because two is what is
  // there. This is the case a stored count cannot get right, however careful
  // the arithmetic that produced it.
  const before = [
    { id: 1, username: 'me' },
    { id: 2, username: 'them' }, { id: 3, username: 'them' }, { id: 4, username: 'them' },
  ];
  assert.strictEqual(below(W, before, 2, 'me'), 3);
  const after = before.filter(m => m.id !== 3);
  assert.strictEqual(below(W, after, 2, 'me'), 2,
    'the label still counts a message that is no longer drawn');
});

test('…and a message arriving after the line was drawn is counted too', () => {
  const list = [{ id: 1, username: 'me' }, { id: 2, username: 'them' }, { id: 3, username: 'them' }];
  assert.strictEqual(below(W, list, 2, 'me'), 2);
  assert.strictEqual(below(W, [...list, { id: 4, username: 'them' }], 2, 'me'), 3,
    'a message that arrived under the line is not in the label');
});

test('a line with nothing left below it is no line at all', () => {
  // Everything under it was the reader's own, or was deleted. A divider over
  // an empty stretch is worse than none.
  assert.strictEqual(W.unreadDivider([{ id: 5, username: 'me' }], 5, 'me'), null);
  assert.strictEqual(W.unreadDivider([{ id: 1, username: 'them' }], 99, 'me'), null,
    'the anchor is gone but a line is still claimed');
  assert.strictEqual(W.unreadDivider(null, 1, 'me'), null);
  assert.strictEqual(W.unreadDivider([{ id: 1, username: 'them' }], null, 'me'), null);
});

test('the anchor comes back as a string, so a number id can still match it', () => {
  // The app compares unreadInfo.anchorId with String(msg.id). If this returned
  // the number it was given, that comparison would fail for every numeric id
  // and the line would never be drawn at all.
  const info = W.unreadDivider([{ id: 7, username: 'them' }], 7, 'me');
  assert.strictEqual(info.anchorId, '7');
  assert.strictEqual(W.unreadDivider([{ id: 7, username: 'them' }], '7', 'me').anchorId, '7');
});

test('the APP copy answers identically, object and all', () => {
  if (!A) return;
  const lists = [
    [{ id: 1, username: 'me' }, { id: 2, username: 'them' }, { id: 3, username: 'them' }],
    [{ id: 9, username: 'them' }, { id: 4, username: 'them' }, { id: 10, username: 'them' }],
    [{ id: 5, username: 'them' }, { id: 'tmp-9', username: 'me' }, { id: 6, username: 'them' }],
    [{ id: 2, username: 'me' }],
  ];
  let checked = 0;
  for (const list of lists) {
    for (const anchor of [...list.map(m => m.id), 99, null, '10', '']) {
      assert.deepStrictEqual(
        W.unreadDivider(list, anchor, 'me'), A.unreadDivider(list, anchor, 'me'),
        `unreadDivider diverges at ${anchor} in ${JSON.stringify(list)}`);
      checked++;
    }
  }
  assert.ok(checked >= 20, `the drift check only ran ${checked} times`);
});

test('the web keeps its label honest from the rows themselves', () => {
  // The web inserts the divider into the DOM once. Counting from the message
  // list at that moment has the same staleness, so it recounts from the rows
  // that follow the line — which ARE what the reader is counting.
  const ROOT = path.join(__dirname, '..');
  const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const fn = web.slice(web.indexOf('function refreshUnreadDivider('),
    web.indexOf('function refreshUnreadDivider(') + 900);
  assert.ok(fn.length > 200, 'refreshUnreadDivider is gone');
  assert.ok(/nextElementSibling/.test(fn), 'it does not walk the rows below the line');
  assert.ok(/divider\.remove\(\)/.test(fn), 'a line with nothing under it is left on screen');
  // …and it is actually called when a message disappears, or it is decoration.
  assert.ok(/wrapper\?\.remove\(\);\n\s*\/\/[^\n]*\n\s*refreshUnreadDivider\(\)/.test(web),
    'deleting a message leaves the label counting it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
