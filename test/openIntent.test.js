// Opening the chat a tapped notification was about.
//
// Reported as: sometimes on a new message, tapping the notification opens the
// app but it stays on the chat list and does not open the relevant chat.
//
// "Sometimes" is the word that matters — it was four separate failures wearing
// one symptom, and each of them ends in the same silence:
//
//   the RACE   — on a cold start the token read and the notification read
//                finish in whatever order the phone decides, and the token
//                read set the screen to the room list unconditionally;
//   the NETWORK— the push named only a room id, so the app had to fetch the
//                room list before it could open anything, over a connection
//                that has only just woken up;
//   the MATCH  — the lists were searched with === on an id the push sends as
//                a string;
//   the SILENCE— all three end on the room list with nothing said and nothing
//                retried.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping open-intent tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'openintent-'));
execFileSync(TSC, [path.join(NAT, 'src', 'openIntent.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const O = require(path.join(OUT, 'openIntent.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The race ────────────────────────────────────────────────────────────────

test('THE RACE: reading the saved token never closes a chat already opened', () => {
  // This is the whole of the cold-start bug: the notification won, opened the
  // chat, and the token read landed a moment later and put the list back.
  assert.strictEqual(O.screenFor({ hasToken: true, current: 'chat' }), 'chat',
    'the startup token read threw away the chat a notification had opened');
});

test('…but it still shows the list when nothing else has happened', () => {
  assert.strictEqual(O.screenFor({ hasToken: true, current: 'auth' }), 'rooms');
  assert.strictEqual(O.screenFor({ hasToken: true, current: 'rooms' }), 'rooms');
  assert.strictEqual(O.screenFor({ hasToken: true }), 'rooms');
});

test('and no token means the sign-in screen, whatever was open', () => {
  for (const current of ['auth', 'rooms', 'chat']) {
    assert.strictEqual(O.screenFor({ hasToken: false, current }), 'auth',
      'a signed-out app was left showing a chat');
  }
});

// ── What the notification says ──────────────────────────────────────────────

test('THE FIX FOR THE NETWORK: a push that names the chat opens it with no request', () => {
  const r = O.roomFromPush({ roomId: '42', roomName: 'Soran', isDm: '1', peer: 'Soran' });
  assert.deepStrictEqual(r, { id: 42, name: 'Soran', is_dm: 1, other_username: 'Soran' });
});

test('a group push names the room, and is not a DM', () => {
  const r = O.roomFromPush({ roomId: '7', roomName: 'Work', isDm: '0' });
  assert.deepStrictEqual(r, { id: 7, name: 'Work', is_dm: 0, other_username: null });
});

test('an older server sends no name, and that is not an answer', () => {
  // The app then falls back to the offline cache and the network — it must not
  // invent a chat called "undefined".
  assert.strictEqual(O.roomFromPush({ roomId: '42' }), null);
  assert.strictEqual(O.roomFromPush({ roomId: '42', roomName: '' }), null);
});

test('a call notification is not a chat to open', () => {
  assert.strictEqual(O.roomIdFromPush({ roomId: '42', type: 'call' }), null,
    'answering a call would also have opened the chat behind it');
  assert.strictEqual(O.roomFromPush({ roomId: '42', roomName: 'X', type: 'call' }), null);
});

test('nonsense in the payload opens nothing', () => {
  for (const d of [null, undefined, {}, { roomId: '' }, { roomId: 'abc' }, { roomId: '0' }, { roomId: '-3' }]) {
    assert.strictEqual(O.roomIdFromPush(d), null, JSON.stringify(d));
  }
  assert.strictEqual(O.roomIdFromPush({ roomId: 42 }), 42);
  assert.strictEqual(O.roomIdFromPush({ roomId: '42' }), 42);
});

// ── Finding the room in a list ──────────────────────────────────────────────

test('THE MATCH: an id that arrives as a string still finds its room', () => {
  // `x.id === roomId` between a string and a number is a comparison that
  // silently never succeeds.
  const lists = { rooms: [{ id: '7', name: 'Work' }], dms: [] };
  assert.deepStrictEqual(O.resolveRoom(lists, 7), { id: 7, name: 'Work', is_dm: 0, other_username: null });
  assert.deepStrictEqual(O.resolveRoom(lists, '7'), { id: 7, name: 'Work', is_dm: 0, other_username: null });
});

test('a DM is found, and keeps who it is with', () => {
  const lists = { rooms: [], dms: [{ id: 3, name: 'dm', is_dm: 1, other_username: 'Ako' }] };
  const r = O.resolveRoom(lists, 3);
  assert.strictEqual(r.other_username, 'Ako', 'the DM would open with no name at the top');
  assert.strictEqual(r.is_dm, 1);
});

test('is_dm is normalised, because the server has sent it both ways', () => {
  assert.strictEqual(O.resolveRoom({ dms: [{ id: 1, name: 'a', is_dm: true }] }, 1).is_dm, 1);
  assert.strictEqual(O.resolveRoom({ rooms: [{ id: 1, name: 'a', is_dm: 0 }] }, 1).is_dm, 0);
});

test('a failed request is not an empty room list', () => {
  // apiFetch answers { error: 'No connection' } — the old code spread that
  // into an array-of-nothing and concluded the room did not exist.
  assert.strictEqual(O.resolveRoom({ rooms: { error: 'No connection' }, dms: null }, 7), null);
  assert.strictEqual(O.resolveRoom(null, 7), null);
  assert.strictEqual(O.resolveRoom({ rooms: [], dms: [] }, null), null);
});

// ── Not giving up ───────────────────────────────────────────────────────────

test('THE SILENCE: the room list is asked more than once', () => {
  assert.strictEqual(O.shouldKeepTrying(0), true);
  assert.strictEqual(O.shouldKeepTrying(2), true);
  assert.ok(O.RESOLVE_ATTEMPTS >= 3, 'one retry is not enough for a phone that has just woken up');
});

test('…but not forever, in somebody\'s pocket', () => {
  assert.strictEqual(O.shouldKeepTrying(O.RESOLVE_ATTEMPTS), false);
  assert.strictEqual(O.shouldKeepTrying(99), false);
});

test('the first retry is quick, and then it backs off', () => {
  // The commonest failure is a request made in the second before the network
  // came up.
  assert.ok(O.retryDelay(0) <= 500, `first retry waits ${O.retryDelay(0)}ms`);
  assert.ok(O.retryDelay(1) > O.retryDelay(0));
  assert.ok(O.retryDelay(2) > O.retryDelay(1));
  assert.strictEqual(O.retryDelay(9), O.retryDelay(2), 'the ladder runs off its end');
  assert.strictEqual(O.retryDelay(-1), O.retryDelay(0));
});

test('an intent nobody could satisfy expires instead of ambushing the user', () => {
  const now = 5_000_000;
  assert.strictEqual(O.intentStillWanted({ at: now - 1000, now }), true);
  assert.strictEqual(O.intentStillWanted({ at: now - 10 * 60_000, now }), false,
    'a chat opened itself over what the user was doing ten minutes later');
  assert.strictEqual(O.intentStillWanted({ at: now + 5000, now }), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');

test('the startup token read goes through the rule', () => {
  assert.ok(/setScreen\(prev => screenFor\(\{ hasToken: !!t, current: prev \}\)\)/.test(app),
    "the token read still sets 'rooms' unconditionally, which is the cold-start race");
});

test('both notification paths ask the same function to open the chat', () => {
  // One for a tap while the app is running, one for a cold start. They used to
  // parse the payload separately, and only one of them checked for a call.
  const uses = app.match(/openChatFromPush\(/g) || [];
  assert.ok(uses.length >= 3, `only ${uses.length} references — a path opens the chat its own way`);
  assert.ok(app.includes('getLastNotificationResponseAsync'), 'cold starts are not handled at all');
});

test('the chat is looked for on the phone before the network is asked', () => {
  const fn = app.slice(app.indexOf('async function resolveOpenIntent'), app.indexOf('// A tap that arrived while signed out'));
  assert.ok(fn.length > 0, 'resolveOpenIntent is gone — this check would be vacuous');
  const cacheAt = fn.indexOf('offlineStore.loadRooms()');
  const netAt = fn.indexOf("apiFetch('/rooms')");
  assert.ok(cacheAt > 0, 'the room list already on disk is never consulted');
  assert.ok(netAt > 0, 'the server is never asked — this check would be vacuous');
  assert.ok(cacheAt < netAt, 'the network is asked before the room list already on disk');
  assert.ok(fn.includes('intent.from'), 'what the notification itself said is ignored');
  assert.ok(fn.includes('shouldKeepTrying('), 'one failed request still gives up');
  assert.ok(/toast\(/.test(fn), 'a chat that could not be opened is still not mentioned to anyone');
});

test('an intent survives being signed out, and is picked up again', () => {
  assert.ok(/if \(!\(await AsyncStorage\.getItem\('token'\)\)\) return;/.test(app),
    'a notification tapped while signed out is acted on with no session');
  assert.ok(/if \(screen !== 'auth' && openIntent\.current\) resolveOpenIntent\(\)/.test(app),
    'nothing retries the intent after signing in');
});

test('a second tap replaces the first rather than racing it', () => {
  const fn = app.slice(app.indexOf('async function resolveOpenIntent'), app.indexOf('// A tap that arrived while signed out'));
  assert.ok(/if \(openIntent\.current !== intent\) return;/.test(fn),
    'a slow resolve can open the chat the user has already moved on from');
  assert.ok(/if \(resolving\.current\) return;/.test(app), 'two resolves can run at once');
});

// ── A tapped COMMENT notification ───────────────────────────────────────────

test('THE BUG: a comment notification opened a chat with nothing new in it', () => {
  // A comment never appears in the conversation — that is the whole design —
  // so opening the room left the user looking for something that was not
  // there. The push names the message the thread hangs off, and the tap opens
  // that thread at the comment.
  const t = O.commentTargetFromPush({ roomId: '4', parentId: '17', msgId: '93', comment: '1' });
  assert.deepStrictEqual(t, { parentId: 17, commentId: 93 });
});

test('an ordinary message notification is not a thread', () => {
  assert.strictEqual(O.commentTargetFromPush({ roomId: '4', msgId: '93' }), null,
    'every message notification now opens some thread');
  assert.strictEqual(O.commentTargetFromPush(null), null);
  assert.strictEqual(O.commentTargetFromPush({ parentId: 'nonsense' }), null);
  assert.strictEqual(O.commentTargetFromPush({ parentId: '0' }), null);
});

test('a comment push with no comment id still opens the thread', () => {
  // Better the right thread with nothing highlighted than the chat.
  assert.deepStrictEqual(O.commentTargetFromPush({ parentId: '17' }),
    { parentId: 17, commentId: null });
});

test('the app carries the thread from the notification into the chat', () => {
  assert.ok(/commentTargetFromPush/.test(app), 'App.tsx never reads the thread out of the push');
  assert.ok(/setPendingComment\(commentTargetFromPush\(data\)\)/.test(app),
    'the thread is read and then dropped');
  assert.ok(/initialCommentTarget=\{pendingComment\}/.test(app),
    'the chat is never told which thread to open');
  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/initialCommentTarget\?\.parentId/.test(chat), 'the chat ignores it');
  assert.ok(/openComments\(\{ id: initialCommentTarget\.parentId \} as Message\)/.test(chat),
    'the chat opens something other than that thread');
});

test('the web opens the thread from its own notification', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  assert.ok(/parentId: d\.parentId \|\| ''/.test(sw),
    'the web notification forgets the thread before it is ever tapped');
  assert.ok(/postMessage\(\{ type: 'open-room', roomId, parentId/.test(sw),
    'the tap hands the page a room and nothing else');
  const webApp = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  assert.ok(/openComments\(e\.data\.parentId\)/.test(webApp), 'the page ignores it');
  const wp = fs.readFileSync(path.join(ROOT, 'webPush.js'), 'utf8');
  assert.ok(/parentId: data\.parentId/.test(wp),
    'the web push payload drops the thread, so nothing downstream can open it');
});

test('the server tells the notification which thread it came from', () => {
  const at = server.indexOf('sendPushToUsers(\n      memberIds.filter(');
  assert.ok(at > 0, 'the ordinary message push moved — this check would be vacuous');
  const call = server.slice(at, at + 700);
  assert.ok(/parentId: String\(parent\.id\)/.test(call),
    'a comment push carries no parent, so a tap can only open the chat');
  assert.ok(/parent \?/.test(call),
    'an ordinary message is sent as though it were a comment');
});

// ── The server's half ───────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('the push names the chat, so the app need not ask what it is', () => {
  assert.ok(/const openData = \{/.test(server), 'the push still carries only a room id');
  assert.ok(/roomName: room && !room\.is_dm/.test(server), 'a DM push has no name to open with');
  const uses = server.match(/\.\.\.openData/g) || [];
  assert.ok(uses.length >= 2, 'the ordinary message push does not carry it');
});

test('every message push carries it, not just the first one found', () => {
  // A forwarded message and an invitation are notifications too, and a
  // notification that cannot be opened is the reported bug.
  for (const marker of ['roomId: String(dstRoom.id)', 'roomId: String(dm.id)']) {
    const at = server.indexOf(marker);
    assert.ok(at > 0, `${marker} is gone — this check would be vacuous`);
    assert.ok(server.slice(at, at + 320).includes('roomName:'),
      `the push at ${marker} still names only an id`);
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
