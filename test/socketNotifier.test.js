// ── The notification must outlive the screen ────────────────────────────────
//
// Reported as: the socket notification works with the app open and not with
// the app closed. The previous arrangement guaranteed exactly that.
//
// The listener lived in a React useEffect whose cleanup ran
// sock.off('message_received', handler). So the socket's lifetime belonged to
// the keep-alive foreground service and the listener's belonged to a mounted
// React tree. Closing the app tore the listener off a socket that was still
// connected and still receiving. Reopening re-attached it, which is why this
// read as a quirk rather than as a bug.
//
// Two things are tested here, and the second matters more than the first:
// the rule that decides whether to notify, and the WIRING — that the listener
// is attached once, outside React, and is not removed when a screen unmounts.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping socket-notifier tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'sockn-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

// Stubs: the module imports notifee, expo-notifications, AsyncStorage and
// react-native, none of which exist here. The rules under test are pure.
function stub(name, body) {
  const dir = path.join(OUT, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), body);
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name, main: 'index.js' }));
}
stub('@notifee/react-native',
  'module.exports = { default: { displayNotification: async () => {}, cancelNotification: async () => {} },'
  + ' AndroidImportance: { HIGH: 4 } };');
stub('expo-notifications', 'module.exports = { dismissNotificationAsync: async () => {} };');
stub('react-native', "module.exports = { AppState: { currentState: 'background' } };");
stub('@react-native-async-storage/async-storage',
  'module.exports = { default: { getItem: async () => null, setItem: async () => {} } };');

execFileSync(TSC, [
  path.join(NAT, 'src', 'socketNotifier.ts'),
  path.join(NAT, 'src', 'pushRegistration.ts'),
  path.join(NAT, 'src', 'notifyDiag.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop',
], { stdio: 'pipe' });
const S = require(path.join(OUT, 'socketNotifier.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const base = {
  msgUsername: 'ali', me: 'sara', appState: 'background',
  viewingRoomId: null, msgRoomId: 7, msgId: 101,
};

// ── The rule ────────────────────────────────────────────────────────────────

test('a message from someone else, app closed, notifies', () => {
  assert.strictEqual(S.shouldRaise(base), true);
});

test('my own message never notifies me', () => {
  assert.strictEqual(S.shouldRaise({ ...base, msgUsername: 'sara' }), false);
});

test('nothing while the user is looking at the app', () => {
  assert.strictEqual(S.shouldRaise({ ...base, appState: 'active' }), false);
});

test('…but "background" and "inactive" both notify', () => {
  // 'inactive' is the half-second of a transition and, on the way out of the
  // app, is followed by 'background'. Treating it as "in front of the user"
  // would drop a notification that arrived mid-swipe.
  assert.strictEqual(S.shouldRaise({ ...base, appState: 'inactive' }), true);
  assert.strictEqual(S.shouldRaise({ ...base, appState: null }), true);
});

test('THE STALE ROOM: closing the app inside a chat does NOT silence it', () => {
  // Reported as "notifications still do not work while the app is closed",
  // and it was introduced by the fix that moved the listener out of React.
  //
  // viewingRoomId is set when a chat opens and nothing cleared it when the
  // app went away, so closing the app from inside a conversation left that
  // room marked "being read" — and every message in it was suppressed for as
  // long as the app stayed closed. The one conversation you are most likely
  // to be waiting on is the one it silenced.
  //
  // It could not happen before the listener survived the app closing: back
  // then the listener was destroyed outright, a different bug that hid this
  // one completely.
  assert.strictEqual(S.shouldRaise({
    ...base, appState: 'background', viewingRoomId: '7', msgRoomId: 7,
  }), true, 'a chat left open when the app closed is still silenced');
  // Same for the half-second transition on the way out.
  assert.strictEqual(S.shouldRaise({
    ...base, appState: 'inactive', viewingRoomId: '7', msgRoomId: 7,
  }), true);
});

test('THE NUMBER/STRING TRAP: reading room 7 silences room 7', () => {
  // The socket delivers room_id as a NUMBER; navigation state holds it as a
  // string. 7 !== '7' would have notified somebody about the conversation
  // they were reading, every single message.
  // Only while the app is ACTIVE — see the stale-room test above for why.
  // shouldRaise returns false for 'active' anyway; this pins the room check
  // itself, which is what stops a popup over the chat on screen if AppState
  // is momentarily stale during a transition.
  const V = require(path.join(OUT, 'socketNotifier.js'));
  assert.strictEqual(V.shouldRaise({
    ...base, appState: 'active', viewingRoomId: '7', msgRoomId: 7,
  }), false);
  assert.strictEqual(V.shouldRaise({
    ...base, appState: 'active', viewingRoomId: 7, msgRoomId: '7',
  }), false);
});

test('…and a DIFFERENT room still notifies', () => {
  assert.strictEqual(S.shouldRaise({ ...base, viewingRoomId: '8', msgRoomId: 7 }), true);
  // Not in a chat at all: every room notifies.
  assert.strictEqual(S.shouldRaise({ ...base, viewingRoomId: null, msgRoomId: 7 }), true);
});

test('no message id means no tag, so no notification', () => {
  // Without the tag this and the server's push are two notifications rather
  // than one replacing the other.
  assert.strictEqual(S.shouldRaise({ ...base, msgId: null }), false);
  assert.strictEqual(S.shouldRaise({ ...base, msgId: '' }), false);
  assert.strictEqual(S.shouldRaise(null), false);
});

test('a registered device still notifies from the socket', () => {
  // Firebase delivered 0 of dozens to the reporter's handset over a full day.
  // Gating this on registration switched the socket off for exactly the
  // device that needed it.
  assert.strictEqual(S.shouldRaise({ ...base, pushRegistered: true }), true);
});

test('the body names the KIND of message and never its content', () => {
  assert.strictEqual(S.bodyFor('text'), '💬 New message');
  assert.strictEqual(S.bodyFor('video'), '🎥 Video');
  assert.strictEqual(S.bodyFor('anything-else'), '📄 File');
  for (const t of ['text', 'audio', 'image', 'gallery', 'video', 'music', 'invite', null]) {
    assert.ok(!/undefined/.test(S.bodyFor(t)), `bodyFor(${t}) leaks "undefined"`);
  }
});

// ── Why it said no ──────────────────────────────────────────────────────────

test('THE REFUSAL NAMES THE RULE THAT REFUSED IT', () => {
  // A phone reported "Shown by the app itself: 0 · never" with the socket
  // connected and the keep-alive running. Two causes, opposite fixes, and
  // identical from outside: the listener never fired, or it fired and every
  // message was refused. Guessing between them cost days.
  assert.strictEqual(S.raiseDecision(base).reason, 'ok');
  assert.strictEqual(S.raiseDecision({ ...base, appState: 'active' }).reason, 'app-active');
  assert.strictEqual(S.raiseDecision({ ...base, msgUsername: 'sara' }).reason, 'mine');
  assert.strictEqual(S.raiseDecision({ ...base, msgId: null }).reason, 'no-id');
  assert.strictEqual(S.raiseDecision(null).reason, 'no-message');
  // Every reason is short enough to survive a log line and a screenshot.
  for (const o of [base, { ...base, appState: 'active' }, { ...base, msgId: null }]) {
    assert.ok(S.raiseDecision(o).reason.length <= 40);
    assert.ok(!/\s/.test(S.raiseDecision(o).reason), 'a reason with spaces breaks the log format');
  }
});

test('shouldRaise still answers yes or no, and agrees with the decision', () => {
  for (const o of [base, { ...base, appState: 'active' }, { ...base, msgUsername: 'sara' },
                   { ...base, msgId: null }, null]) {
    assert.strictEqual(S.shouldRaise(o), S.raiseDecision(o).raise);
  }
});

test('EVERY ARRIVAL IS COUNTED, before any rule runs', () => {
  // Without this, "0 shown" cannot be told from "0 arrived".
  const code = fs.readFileSync(path.join(NAT, 'src', 'socketNotifier.ts'), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  const i = code.indexOf("socket.on('message_received'");
  assert.ok(i > 0);
  const body = code.slice(i, i + 700);
  assert.ok(/notifyDiag\.record\('socket-msg'\)/.test(body),
    'arrivals are not counted, so a silent listener and a refusing one look identical');
  assert.ok(body.indexOf("record('socket-msg')") < body.indexOf('raiseDecision('),
    'the arrival is counted after the rules, so a refusal is never counted as an arrival');
  assert.ok(/notifyDiag\.record\('socket-skipped', undefined, decision\.reason\)/.test(body),
    'the refusal reason is computed and then thrown away');
});

// ── Attaching, which is the actual bug ──────────────────────────────────────

test('ATTACH IS IDEMPOTENT: re-rendering does not stack listeners', () => {
  // Attached once per render, every message would have raised N identical
  // notifications — or, with the shared tag, silently replaced itself N times
  // while the phone buzzed once per copy.
  const calls = [];
  const sock = { on: (ev) => calls.push(ev) };
  S.attach(sock);
  S.attach(sock);
  S.attach(sock);
  assert.strictEqual(calls.filter(c => c === 'message_received').length, 1,
    'the listener was attached more than once for the same socket');
  S.detach();
});

test('…but a NEW socket (re-login) does get listeners', () => {
  const a = { on: () => {} };
  const calls = [];
  const b = { on: (ev) => calls.push(ev) };
  S.attach(a);
  S.attach(b);
  assert.ok(calls.includes('message_received'), 'after re-login nothing listens at all');
  S.detach();
});

test('where the user is, is a VALUE not a closure', () => {
  // The listener is created once. If it learned the current room by closing
  // over React state, it would have to be re-created to notice navigation —
  // which is the lifetime mistake this file exists to undo.
  S.detach();
  S.setMe('sara');
  S.setViewing(7);
  assert.deepStrictEqual(S._state().me, 'sara');
  assert.strictEqual(S._state().viewingRoomId, '7', 'the room id is not normalised to a string');
  S.setViewing(null);
  assert.strictEqual(S._state().viewingRoomId, null);
  S.detach();
});

// ── The wiring in App.tsx ───────────────────────────────────────────────────

const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
const code = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('THE BUG ITSELF: nothing removes the listener when a screen unmounts', () => {
  // This is the whole report. socket alive (foreground service) + listener
  // removed (React cleanup) = a connected socket nobody is listening to.
  assert.ok(!/sock\.off\(['"]message_received['"]/.test(code),
    "App.tsx still detaches the message listener on unmount — the app-closed bug is back");
  assert.ok(!/sock\.off\(['"]message_deleted['"]/.test(code));
});

test('…and App.tsx attaches through the notifier rather than inline', () => {
  assert.ok(/socketNotifier\.attach\(/.test(code), 'nothing attaches the notifier');
  assert.ok(/socketNotifier\.setViewing\(/.test(code), 'the notifier never learns which room is open');
  assert.ok(/socketNotifier\.setMe\(/.test(code), 'the notifier never learns who I am');
  // The notification is no longer built in App.tsx at all.
  assert.ok(!/notifee\.displayNotification\(\{[\s\S]{0,200}id: pushReg\.notificationTag\(msg\.id\)/.test(code),
    'App.tsx still builds the message notification itself');
});

test('the attach effect does not depend on the open room', () => {
  // Depending on room?.id would re-run it on every navigation. attach() is
  // idempotent so that would be harmless — but it is also how the listener
  // drifts back to being owned by the screen.
  const i = code.indexOf('socketNotifier.attach(');
  assert.ok(i > 0);
  const deps = code.slice(i, code.indexOf('}, [', i) + 40);
  assert.ok(!/\}, \[screen, room\?\.id\]/.test(deps),
    'the attach effect is keyed on the open room again');
});

test('…and App.tsx stops believing a room is open when the app leaves', () => {
  // The rule above no longer depends on this, but a stale value should not be
  // sitting there waiting to matter the next time somebody reads it.
  assert.ok(/if \(st !== 'active'\) socketNotifier\.setViewing\(null\);/.test(code),
    'the open room is never cleared when the app goes to the background');
});

test('sign-out releases it', () => {
  assert.ok(/socketNotifier\.detach\(\)/.test(code),
    'after sign-out the previous account\'s socket still raises notifications');
});

test('both files name the SAME channel', () => {
  // Two spellings is how one of them ends up on Android's default channel,
  // silent — which has already happened once in this app.
  const sn = fs.readFileSync(path.join(NAT, 'src', 'socketNotifier.ts'), 'utf8');
  const a = /MESSAGES_CHANNEL = '([^']+)'/.exec(sn);
  const b = /MESSAGES_CHANNEL = '([^']+)'/.exec(app);
  assert.ok(a && b, 'the channel constant moved');
  assert.strictEqual(a[1], b[1], `channels disagree: ${a[1]} vs ${b[1]}`);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
