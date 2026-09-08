// Finding the message that has new comments.
//
// Reported as: the chat shows a badge, you open it, and there is nothing new
// to see.
//
// And there wasn't — in the chat. The new thing was a COMMENT, which by design
// never appears in the conversation; it hangs off a message that may be a
// hundred messages back. The badge was telling the truth and there was no way
// to act on it, which is the same as it being wrong.
//
// So a comment now leaves two marks: a count inside the strip of the message
// it belongs to, and a chip at the top or bottom edge of the chat pointing the
// way to that message. The chip is what makes any of this findable — nobody
// scrolls a year of conversation on the chance that something changed.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'commentUnread.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cunread-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'commentUnread.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'commentUnread.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Counting ────────────────────────────────────────────────────────────────

test('THE ASK: a comment on a message is remembered against that message', () => {
  let u = W.noteComment({}, { parentId: 7 });
  u = W.noteComment(u, { parentId: 7 });
  u = W.noteComment(u, { parentId: 9 });
  assert.strictEqual(W.countFor(u, 7), 2);
  assert.strictEqual(W.countFor(u, 9), 1);
  assert.strictEqual(W.totalUnread(u), 3);
});

test('ids are compared as strings, because that is how they arrive', () => {
  const u = W.noteComment({}, { parentId: '7' });
  assert.strictEqual(W.countFor(u, 7), 1, 'a number id and a string id are different messages');
});

test('my own comment is not news to me', () => {
  const u = W.noteComment({}, { parentId: 7, mine: true });
  assert.strictEqual(W.countFor(u, 7), 0, 'writing a comment badged it for its author');
});

test('a comment in the thread I am looking at is already read', () => {
  const u = W.noteComment({}, { parentId: 7, threadOpenId: 7 });
  assert.strictEqual(W.countFor(u, 7), 0,
    'a comment arriving on screen left a badge saying it was unread');
  // A DIFFERENT thread being open says nothing about this one.
  assert.strictEqual(W.countFor(W.noteComment({}, { parentId: 7, threadOpenId: 8 }), 7), 1);
});

test('opening a thread clears only that thread', () => {
  let u = W.noteComment(W.noteComment({}, { parentId: 7 }), { parentId: 9 });
  u = W.clearFor(u, 7);
  assert.strictEqual(W.countFor(u, 7), 0);
  assert.strictEqual(W.countFor(u, 9), 1, 'reading one thread cleared another');
});

test('nothing is mutated in place', () => {
  // These maps are React state on one client and a module global on the other;
  // an edit in place is a badge that does not redraw.
  const before = { 7: 1 };
  W.noteComment(before, { parentId: 7 });
  W.clearFor(before, 7);
  assert.deepStrictEqual(before, { 7: 1 });
});

test('the badge caps rather than growing a message sideways', () => {
  assert.strictEqual(W.badgeLabel(0), '', 'a zero drew an empty circle');
  assert.strictEqual(W.badgeLabel(3), '3');
  assert.strictEqual(W.badgeLabel(W.BADGE_CAP), String(W.BADGE_CAP));
  assert.strictEqual(W.badgeLabel(W.BADGE_CAP + 1), W.BADGE_CAP + '+');
  assert.strictEqual(W.badgeLabel(-2), '');
});

// ── Which way to point ──────────────────────────────────────────────────────

const view = { first: 10, last: 20 };

test('THE POINT OF THE CHIP: it points at what is off screen', () => {
  const items = [{ id: 'a', index: 3, count: 1 }, { id: 'b', index: 30, count: 2 }];
  assert.deepStrictEqual(W.chooseJump(items, view), { id: 'b', dir: 'down', count: 2 });
});

test('down wins ties', () => {
  // The chat is read from the bottom and newer messages are below; sending the
  // reader backwards past things they have not reached is an interruption
  // rather than a shortcut.
  const items = [{ id: 'up', index: 9, count: 1 }, { id: 'down', index: 21, count: 1 }];
  assert.strictEqual(W.chooseJump(items, view).id, 'down');
});

test('the nearest one in that direction is chosen', () => {
  const below = [{ id: 'far', index: 90, count: 1 }, { id: 'near', index: 21, count: 1 }];
  assert.strictEqual(W.chooseJump(below, view).id, 'near');
  const above = [{ id: 'far', index: 0, count: 1 }, { id: 'near', index: 9, count: 1 }];
  assert.strictEqual(W.chooseJump(above, view).id, 'near');
});

test('what is already on screen is not offered', () => {
  // Its own strip carries the badge, right there; a chip pointing at what the
  // reader is looking at is noise.
  assert.strictEqual(W.chooseJump([{ id: 'a', index: 15, count: 4 }], view), null);
});

test('a message that is not loaded is skipped, not guessed at', () => {
  assert.strictEqual(W.chooseJump([{ id: 'a', index: -1, count: 4 }], view), null,
    'the chip offered to jump to a position nobody knows');
  // …but a loaded one beside it is still offered.
  assert.strictEqual(
    W.chooseJump([{ id: 'a', index: -1, count: 4 }, { id: 'b', index: 30, count: 1 }], view).id, 'b');
});

test('nothing to say when there is nothing unread', () => {
  assert.strictEqual(W.chooseJump([], view), null);
  assert.strictEqual(W.chooseJump(null, view), null);
  assert.strictEqual(W.chooseJump([{ id: 'a', index: 1, count: 1 }], null), null,
    'a chip was drawn before anything had been measured');
});

test('THE CHIP SAYS IT IN WORDS, and points with its own arrow', () => {
  // It used to read "↑ 💬 2": two symbols and a number to decode, in a chip
  // that also MOVED between the top and bottom edges of the screen depending
  // on which way it pointed. Being told where to look is one job; being able
  // to find the thing that tells you is another, and a control that moves is
  // one the eye has to hunt for every time.
  assert.strictEqual(W.jumpLabel({ id: 'a', dir: 'down', count: 3 }), '3 new comments');
  assert.strictEqual(W.jumpLabel({ id: 'a', dir: 'up', count: 1 }), '1 new comment');
  assert.strictEqual(W.jumpLabel({ id: 'a', dir: 'up', count: 150 }), '99+ new comments');
  assert.strictEqual(W.jumpLabel(null), '');
  // The direction is still there — as an arrow of its own, so the chip can put
  // it where it reads as the action rather than as decoration on the sentence.
  assert.strictEqual(W.jumpArrow({ dir: 'up' }), '↑');
  assert.strictEqual(W.jumpArrow({ dir: 'down' }), '↓');
  assert.strictEqual(W.jumpArrow(null), '');
});

test('the chip lives in ONE place, above the composer', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  const rule = /\.comment-jump \{([^}]*)\}/.exec(css);
  assert.ok(rule, '.comment-jump has no rule — this check would be vacuous');
  assert.ok(!/\.comment-jump\.up \{/.test(css) && !/\.comment-jump\.down \{/.test(css),
    'the chip still hops between the top and bottom edges');
  assert.ok(/bottom:/.test(rule[1]), 'the chip is not anchored above the composer');
  assert.ok(/left: 50%/.test(rule[1]) && /translateX\(-50%\)/.test(rule[1]),
    'the chip is not centred');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/id="comment-jump-arrow"/.test(html) && /id="comment-jump-text"/.test(html),
    'the chip is one blob of text again, so the arrow cannot be styled apart');

  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(!/commentJumpTop|commentJumpBottom/.test(chat),
    'the app chip still moves between the edges');
  assert.ok(/jumpArrow\(commentJump\)/.test(chat), 'the app chip lost its direction');
  // chipBottom, which is the buttons' own offset PLUS a lift — never minus.
  // Placing it by subtracting is what put it behind the composer.
  assert.ok(/style=\{\[s\.commentJump, \{ bottom: chipBottom\(/.test(chat),
    'the app chip is not placed with the same rule as the buttons beside it');
});

// ── The two copies ──────────────────────────────────────────────────────────

test('the web and the app decide identically', () => {
  if (!A) return;
  assert.strictEqual(W.BADGE_CAP, A.BADGE_CAP);
  let checked = 0;
  const cases = [
    { parentId: 1 }, { parentId: 1, mine: true }, { parentId: 2, threadOpenId: 2 },
    { parentId: 2, threadOpenId: 3 }, { parentId: '2' }, { parentId: '' },
  ];
  let cw = {}, ca = {};
  for (const c of cases) {
    cw = W.noteComment(cw, c); ca = A.noteComment(ca, c);
    assert.deepStrictEqual(cw, ca, `counts diverged on ${JSON.stringify(c)}`);
    checked++;
  }
  const items = [
    { id: 'a', index: 3, count: 1 }, { id: 'b', index: 15, count: 2 },
    { id: 'c', index: 30, count: 7 }, { id: 'd', index: -1, count: 9 },
  ];
  for (let f = 0; f < 40; f += 5) {
    for (let l = f; l < f + 30; l += 7) {
      assert.deepStrictEqual(W.chooseJump(items, { first: f, last: l }),
        A.chooseJump(items, { first: f, last: l }), `jumps diverged at ${f}..${l}`);
      checked++;
    }
  }
  for (const n of [0, 1, 99, 100, 1000]) {
    assert.strictEqual(W.badgeLabel(n), A.badgeLabel(n));
    assert.strictEqual(W.jumpLabel({ id: 'x', dir: 'up', count: n }),
      A.jumpLabel({ id: 'x', dir: 'up', count: n }));
    checked++;
  }
  assert.ok(checked > 40, `the drift check only ran ${checked} times`);
});

// ── The wiring, which the rules above cannot see ────────────────────────────

const webApp = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('both clients count an arriving comment and clear it when it is opened', () => {
  assert.ok(/noteComment\(/.test(webApp) && /clearUnreadComments\(msgId\)/.test(webApp),
    'the web never counts, or never clears');
  const webEvt = webApp.slice(webApp.indexOf("socket.on('comment_added'"));
  assert.ok(/noteUnreadComment\(ev\)/.test(webEvt.slice(0, 400)),
    'an arriving comment leaves no mark on the web');

  assert.ok(/noteComment\(u, \{/.test(chat), 'the app never counts an arriving comment');
  assert.ok(/mine: msg\?\.username === meRef\.current/.test(chat),
    'the app badges the author for their own comment');
  assert.ok(/threadOpenId: commentParentRef\.current/.test(chat),
    'the app badges a comment that arrived on screen');
  const open = chat.slice(chat.indexOf('async function openComments('));
  assert.ok(/clearFor\(u, m\.id\)/.test(open.slice(0, 600)), 'the app never clears a read thread');
});

test('both clients draw the count where the message is', () => {
  assert.ok(/comment-bar-new/.test(webApp), 'the web strip has no slot for what is new');
  assert.ok(/paintUnreadComments\(bar, CommentUnread\.countFor/.test(webApp),
    'the web draws a stale count, or none');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/src="\/js\/commentUnread\.js"/.test(html),
    'commentUnread.js is never loaded, so CommentUnread is undefined and the chat throws');
  assert.ok(/id="comment-jump"/.test(html), 'the web has no chip to point with');

  assert.ok(/unreadBadge\(msg\.id\)/.test(chat), 'the app strip never shows what is new');
  assert.ok(/commentBarBadge/.test(chat), 'the app badge has no style');
});

test('the chip is recomputed as the view moves, and points from real positions', () => {
  // A direction decided once, when the counts changed, is wrong the moment the
  // user scrolls past the message.
  const scroll = webApp.slice(webApp.indexOf("getElementById('messages').addEventListener('scroll'"));
  assert.ok(/refreshCommentJump\(\)/.test(scroll.slice(0, 400)),
    'the web chip keeps pointing whichever way it pointed when it appeared');
  assert.ok(/getBoundingClientRect\(\)/.test(webApp.slice(webApp.indexOf('function refreshCommentJump'))),
    'the web decides the direction without measuring anything');

  assert.ok(/refreshJumpRef\.current\(\)/.test(chat), 'the app chip is never recomputed');
  // THE INVERSION. The app's list is inverted, so its index 0 is the NEWEST
  // message at the visual bottom. Feeding those numbers in raw points the chip
  // the wrong way every single time.
  const vis = chat.slice(chat.indexOf('const onViewableItemsChanged = useRef('));
  assert.ok(/len - 1 - Math\.max\(\.\.\.idxs\)/.test(vis.slice(0, 1200))
    && /len - 1 - Math\.min\(\.\.\.idxs\)/.test(vis.slice(0, 1200)),
    'the app feeds inverted list indices straight in, so the chip points the wrong way');
});

test('a comment moves its chat up both clients\' lists', () => {
  // Asked for as: when a comment is added to a chat, the chat should reorder.
  // A comment never arrives as `message_received` — it must never be appended
  // to a conversation — so neither list heard about it at all.
  const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');
  assert.ok(/sock\.on\('comment_added'/.test(rooms), 'the app list never hears about comments');
  const handler = rooms.slice(rooms.indexOf("sock.on('comment_added'"),
    rooms.indexOf("sock.on('dm_activity'"));
  assert.ok(/bumpRoom\(ev\.roomId\)/.test(handler), 'the app hears it and does not move the chat');
  assert.ok(/ev\.comment\?\.username === uname/.test(handler),
    'the app badges the author for their own comment');
  // The ordinary path must keep working: one helper, two callers.
  assert.ok(/bumpRoom\(msg\.room_id\)/.test(rooms), 'an ordinary message no longer moves the chat');

  assert.ok(/bumpRoomInList\(ev\.roomId\)/.test(webApp), 'the web hears it and does not move the chat');
  assert.ok(/bumpRoomInList\(msg\.room_id\)/.test(webApp),
    'the web moves the chat for comments but not for messages');
  const fn = webApp.slice(webApp.indexOf('function bumpRoomInList('),
    webApp.indexOf('// ─── Unread badges'));
  assert.ok(/dm-divider/.test(fn),
    'a direct chat is moved above the DIRECT MESSAGES heading, into the rooms');
  assert.ok(/insertBefore/.test(fn), 'nothing actually moves');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
