// "… is typing" belongs to one conversation.
//
// Reported with a screenshot from the iOS web version: a DM with one person on
// screen, and under it "sahardenizz2@gmail.com is typing" — somebody typing in
// a completely different chat.
//
// The mechanism, found in openRoom: the server routes typing by the room each
// socket is CURRENTLY looking at, and it learns that from `join_room`. The web
// set `currentRoomId` immediately but sent `join_room` at the END of opening a
// chat — after `await fetchDMPeerKey(...)`, a network round trip with a retry
// ladder (400/1200/3000/6000ms) behind it. For that whole window the server
// still believed the socket was in the PREVIOUS chat, so that chat's typing
// events were delivered and drawn under the conversation now on screen.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'presence.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'presence.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'presence.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rule skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The rule ────────────────────────────────────────────────────────────────

test('THE BUG: typing in another chat is not shown in this one', () => {
  assert.strictEqual(W.isForRoom(41, 12), false);
  assert.strictEqual(W.isForRoom('41', 12), false);
});

test('typing in THIS chat still is', () => {
  assert.strictEqual(W.isForRoom(12, 12), true);
  // Ids arrive as a number down one path and a string down another; 12 !== '12'
  // would drop every indicator on one of them.
  assert.strictEqual(W.isForRoom('12', 12), true);
  assert.strictEqual(W.isForRoom(12, '12'), true);
});

test('an event with no room named is accepted, on purpose', () => {
  // The server, the web and the app are deployed separately — an app on
  // somebody's phone is updated whenever they get round to it. An older server
  // sends no room at all, and dropping those would silently stop typing
  // indicators working rather than fixing anything.
  assert.strictEqual(W.isForRoom(undefined, 12), true);
  assert.strictEqual(W.isForRoom(null, 12), true);
  assert.strictEqual(W.isForRoom('', 12), true);
});

test('but a named room with no chat open is refused', () => {
  // Nothing is on screen to be about.
  assert.strictEqual(W.isForRoom(41, null), false);
  assert.strictEqual(W.isForRoom(41, undefined), false);
  assert.strictEqual(W.isForRoom(41, ''), false);
});

test('the web and the app decide the same way', () => {
  if (!A) return;
  const cases = [[41, 12], [12, 12], ['12', 12], [12, '12'], [undefined, 12], [null, 12],
    ['', 12], [41, null], [41, ''], [0, 0], ['0', 0]];
  let checked = 0;
  for (const [a, b] of cases) {
    assert.strictEqual(W.isForRoom(a, b), A.isForRoom(a, b), `diverges for ${a} / ${b}`);
    checked++;
  }
  assert.strictEqual(checked, cases.length, 'the drift check did not actually run');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('THE FIX: the web says which room it is in BEFORE it waits on anything', () => {
  const fn = app.slice(app.indexOf('  typingUsers.clear(); recordingUsers.clear(); renderTypingBar();'),
    app.indexOf('  const waiting = unreadCounts[roomId] || 0;'));
  assert.ok(fn.length > 200, 'openRoom moved');
  const joined = fn.indexOf("socket.emit('join_room', roomId)");
  const firstAwait = fn.indexOf('await ');
  assert.ok(joined > -1, 'the web never tells the server which room it is looking at');
  assert.ok(firstAwait === -1 || joined < firstAwait,
    'join_room is sent after something that waits on the network, which is the window the bug lives in');
  // …and only once: two joins for one chat is a second presence broadcast.
  assert.strictEqual((fn.match(/socket\.emit\('join_room', roomId\)/g) || []).length, 1);
});

test('every presence event carries the room it happened in', () => {
  for (const evt of ['user_typing', 'user_stopped_typing', 'user_recording', 'user_stopped_recording']) {
    const re = new RegExp(`'${evt}',\\s*\\n?\\s*\\{[^}]*roomId: String\\(`, 'm');
    assert.ok(re.test(server), `${evt} is sent without naming a room`);
  }
});

test('a stop is routed by the same rule as the start', () => {
  // The stop used to go to the socket.io room, which is a different set of
  // people: it could reach somebody who never got the start, and the indicator
  // it was meant to clear was on another screen entirely.
  const fn = server.slice(server.indexOf("socket.on('typing_stop'"),
    server.indexOf("socket.on('typing_stop'") + 400);
  assert.ok(/emitToRoomUnblocked\(roomId, socket\.user\.id, 'user_stopped_typing'/.test(fn),
    'the stop is still broadcast to everyone joined to the room channel');
  const rec = server.slice(server.indexOf("socket.on('recording_stop'"),
    server.indexOf("socket.on('recording_stop'") + 400);
  assert.ok(/emitToRoomUnblocked\(roomId, socket\.user\.id, 'user_stopped_recording'/.test(rec),
    'the recording stop is still broadcast to everyone joined to the room channel');
});

test('both clients refuse what is not about the chat on screen', () => {
  // Each handler is bounded by the NEXT one, not by a character count: these
  // four sit one after another, so a fixed window reads its neighbour's guard
  // and passes for a handler that has none.
  const body = (src, from, open) => {
    const at = src.indexOf(`${open}('${from}'`);
    if (at === -1) return null;
    const next = src.indexOf(`${open}(`, at + 10);
    return src.slice(at, next === -1 ? at + 400 : next);
  };
  for (const evt of ['user_typing', 'user_stopped_typing', 'user_recording', 'user_stopped_recording']) {
    const web = body(app, evt, 'socket.on');
    assert.ok(web, `the web no longer listens for ${evt}`);
    assert.ok(/Presence\.isForRoom\(roomId, currentRoomId\)/.test(web),
      `the web draws ${evt} from any chat`);
    const nat = body(chat, evt, 'sock.on');
    assert.ok(nat, `the app no longer listens for ${evt}`);
    assert.ok(/if \(!isForRoom\(roomId, room\.id\)\) return;/.test(nat),
      `the app draws ${evt} from any chat`);
  }
  assert.ok(/src="\/js\/presence\.js"/.test(html), 'presence.js is never loaded');
  assert.ok(html.indexOf('presence.js') < html.indexOf('js/app.js'));
  assert.ok(/from '\.\.\/presence'/.test(chat), 'the app keeps a private copy of the rule');
});

test('a disconnect still clears the indicator it left behind', () => {
  // That one is sent from a different place, and a client filtering by room
  // would ignore it if it were the one event without a room on it.
  const fn = server.slice(server.indexOf("socket.on('disconnect', () => {"),
    server.indexOf("socket.on('disconnect', () => {") + 700);
  assert.ok(/'user_stopped_typing',\s*\n?\s*\{[^}]*roomId: String\(info\.roomId\)/.test(fn),
    'the disconnect sweep sends no room, so a filtering client ignores it and the indicator sticks');
  assert.ok(/'user_stopped_recording',\s*\n?\s*\{[^}]*roomId: String\(info\.roomId\)/.test(fn));
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
