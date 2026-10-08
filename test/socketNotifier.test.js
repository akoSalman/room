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
  'const shown = [];\n'
  // __esModule, or TypeScript's interop helper wraps this a second time and
  // notifee.displayNotification lands on undefined.
  + 'module.exports = { __esModule: true, __shown: shown, default: {\n'
  + '  displayNotification: async (n) => { shown.push(n); },\n'
  + '  cancelNotification: async () => {},\n'
  + '}, AndroidImportance: { HIGH: 4 } };');
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

const NOTIFEE = require(path.join(OUT, 'node_modules', '@notifee', 'react-native'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

/**
 * Deliver one message the way the socket does, and return what was drawn.
 *
 * Through attach and the real listener rather than by calling a helper, so
 * what is asserted is the notification a person would actually see.
 */
async function raise(msg) {
  S.detach();
  S.setMe('sara');
  S.setViewing(null);
  // attach registers more than one onAny listener — one for arrivals and one
  // for deletions — so every one of them gets the event, as the socket does.
  const handlers = [];
  S.attach({ on: () => {}, onAny: (f) => { handlers.push(f); } });
  assert.ok(handlers.length, 'attach never registered a listener');
  NOTIFEE.__shown.length = 0;
  handlers.forEach(h => h('message_received', msg));
  // displayNotification is a promise the listener does not await.
  await new Promise(r => setImmediate(r));
  S.detach();
  return NOTIFEE.__shown;
}

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
  const i = code.indexOf("if (event !== 'message_received') return;");
  assert.ok(i > 0, 'the message listener moved');
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
  const sock = { on: (ev) => calls.push(ev), onAny: () => calls.push('any') };
  S.attach(sock);
  S.attach(sock);
  S.attach(sock);
  // onAny now, so the marker is 'any' — see THE SILENCER for why the
  // notifier cannot use on('message_received') any more.
  assert.strictEqual(calls.filter(c => c === 'any').length, 2,
    'the listeners were attached more than once for the same socket');
  S.detach();
});

test('…but a NEW socket (re-login) does get listeners', () => {
  const a = { on: () => {}, onAny: () => {} };
  const calls = [];
  const b = { on: (ev) => calls.push(ev), onAny: () => calls.push('any') };
  S.attach(a);
  S.attach(b);
  assert.ok(calls.includes('any'), 'after re-login nothing listens at all');
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

test('THE DEAF APP: the notifier FOLLOWS the socket, it is not handed one', () => {
  // Reported on v323, and it is the whole bug:
  //
  //     Socket to the server: connected
  //     Messages reaching the app: 0 · last never
  //
  // The socket was up and not one message had ever reached the listener —
  // never delivered, not refused. attach() was called once, from a React
  // effect, against whatever socket existed at that instant; any socket built
  // afterwards carried no listener, while getSocket() and the diagnostics
  // line both reported the NEW one as connected. The app looked perfectly
  // healthy and was deaf.
  assert.ok(/onSocket\(sock =>/.test(code),
    'the notifier is still handed one socket and left there');
  assert.ok(/socketNotifier\.attach\(sock/.test(code));
  // And the subscription is undone when the effect is, or a signed-out
  // account's notifier keeps attaching to the next account's socket.
  assert.ok(/return \(\) => \{ cancelled = true; stop\(\); \};/.test(code),
    'the socket subscription is never removed');
});

test('…and api.ts tells subscribers about the socket that ALREADY exists', () => {
  // Subscribing after one was built is the same failure with better timing:
  // the listener would wait for a replacement that may never come.
  const api = fs.readFileSync(path.join(NAT, 'src', 'api.ts'), 'utf8');
  const a = api.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(/export function onSocket/.test(a), 'there is no way to follow the socket');
  const fn = a.slice(a.indexOf('export function onSocket'), a.indexOf('async function createSocket'));
  assert.ok(/if \(socket\) \{ try \{ cb\(socket\); \} catch \{\} \}/.test(fn),
    'a subscriber is not told about the socket that already exists');
  // …and about every new one, BEFORE getSocket() resolves, so an awaiting
  // caller cannot race the subscribers.
  const made = a.slice(a.indexOf('async function createSocket'));
  const notify = made.indexOf('for (const cb of socketSubscribers)');
  const ret = made.indexOf('return socket;');
  assert.ok(notify > 0, 'new sockets are never announced');
  assert.ok(notify < ret, 'the socket is returned before its subscribers are told');
});

test('THE SILENCER: no screen can remove the notifier\'s listener', () => {
  // The bug that hid behind every other one this week.
  //
  //     socketRef.current?.off('message_received');   // ChatScreen
  //     sock?.off('message_received');                // RoomsScreen
  //
  // socket.io's off() given ONLY an event name removes EVERY listener for it,
  // including this module's. Leaving a chat — or closing the app, which
  // unmounts the screen — tore the notification listener off the socket from
  // a file that has never heard of it. The socket stayed connected, every
  // diagnostic stayed green, and "messages reaching the app" sat at 0.
  //
  // Two defences, and both are needed. Fixing the call sites is necessary;
  // onAny is what makes it stay fixed, because the next screen will do the
  // blunt thing again and the damage lands somewhere else entirely.
  const src = fs.readFileSync(path.join(NAT, 'src', 'socketNotifier.ts'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(/socket\.onAny\(/.test(code),
    "the notifier listens with on('message_received'), which any screen can remove");
  assert.ok(!/socket\.on\('message_received'/.test(code));
  assert.ok(!/socket\.on\('message_deleted'/.test(code));
});

test('…and NO screen removes listeners by event name alone', () => {
  // The root cause, checked where it happens rather than only defended
  // against. A blanket off() is a silent action at a distance: it breaks a
  // different file from the one it is written in.
  for (const f of ['ChatScreen.tsx', 'RoomsScreen.tsx']) {
    const src = fs.readFileSync(path.join(NAT, 'src', 'screens', f), 'utf8');
    const lines = src.split('\n').filter(l => !l.trim().startsWith('//'));
    const blanket = lines.filter(l => /\.off\((['"`])[^'"`]+\1\s*\)/.test(l));
    assert.deepStrictEqual(blanket, [],
      `${f} removes every listener for an event, including other modules':\n      ${blanket.join('\n      ')}`);
  }
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

test('A CHAT BEING READ ON ANOTHER DEVICE DOES NOT BUZZ THIS ONE', () => {
  // Only the server can know this, so it stamps it on the delivery. Without
  // it, reading a conversation on a laptop made the phone in your pocket buzz
  // for every message you had just read.
  assert.strictEqual(S.shouldRaise({ ...base, seenElsewhere: true }), false);
  assert.strictEqual(S.raiseDecision({ ...base, seenElsewhere: true }).reason, 'read-elsewhere');
});

test('...and it does not swallow everything else', () => {
  // The flag absent or false must change nothing: a rule that silenced
  // messages either way would be indistinguishable from notifications being
  // broken, which is how this app has been diagnosed wrongly before.
  assert.strictEqual(S.shouldRaise({ ...base, seenElsewhere: false }), true);
  assert.strictEqual(S.shouldRaise({ ...base, seenElsewhere: undefined }), true);
});

test('A MUTE STILL WINS over being read elsewhere', () => {
  // Both silence it, so the reported reason is what distinguishes them —
  // "muted" and "read elsewhere" are very different answers to "why did my
  // phone not ring", and the diagnostics screen shows this string.
  assert.strictEqual(
    S.raiseDecision({ ...base, muted: true, seenElsewhere: true }).reason, 'muted');
});

test('THE NOTIFIER ACTUALLY PASSES THE FLAG ON', () => {
  // The rule is worth nothing if the listener does not read it off the
  // message. This has been the real fault twice: a correct rule, never
  // consulted.
  const src = fs.readFileSync(
    path.join(NAT, 'src', 'socketNotifier.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.ok(/seenElsewhere:\s*!!msg\?\.seenElsewhere/.test(src),
    'raiseDecision is called without seenElsewhere, so the rule never fires');
});

test("THE NOTIFICATION CARRIES THE SENDER'S PROFILE EMOJI", async () => {
  // The emoji is how people are told apart everywhere else in the app. A tray
  // with three messages in it was three rows of plain text.
  const shown = await raise({
    id: 900001, room_id: 7, username: 'ali', avatar: '🦊', type: 'text',
  });
  assert.strictEqual(shown.length, 1, 'nothing was drawn at all');
  assert.strictEqual(shown[0].title, '🦊 ali',
    `the notification is titled "${shown[0].title}"`);
});

test('…AND READS AS A NAME WHEN SOMEBODY HAS NO EMOJI', async () => {
  // Nobody is forced to pick one, and "undefined ali" would be worse than
  // the bare name this replaces.
  const shown = await raise({ id: 900002, room_id: 7, username: 'ali', type: 'text' });
  assert.strictEqual(shown.length, 1, 'nothing was drawn at all');
  assert.strictEqual(shown[0].title, 'ali', `the notification is titled "${shown[0].title}"`);
});

test('THE APP AND THE SERVER TITLE A NOTIFICATION THE SAME WAY', () => {
  // Both routes are keyed by the same tag so either may replace the other.
  // While they disagreed, which title you saw depended on which arrived
  // first — and the replacement showed as the name changing.
  const PR = require(path.join(OUT, 'pushRegistration.js'));
  const SRV = require(path.join(ROOT, 'notify.js'));
  for (const avatar of ['🦊', '', null, undefined, 0]) {
    for (const username of ['ali', '', null]) {
      for (const suffix of ['', ' · Family', null]) {
        const args = { avatar, username, suffix };
        assert.strictEqual(PR.senderTitle(args), SRV.senderTitle(args),
          `the two disagree for ${JSON.stringify(args)}`);
      }
    }
  }
  // Agreeing on something, not merely agreeing: two copies that both
  // returned '' would pass the loop above.
  assert.strictEqual(PR.senderTitle({ avatar: '🦊', username: 'ali' }), '🦊 ali');
  assert.strictEqual(SRV.senderTitle({ avatar: '🦊', username: 'ali', suffix: ' · Family' }),
    '🦊 ali · Family');
});

test('THE APP AND THE SERVER AGREE ABOUT WHAT COUNTS AS TOO OLD', () => {
  // Reported as: notifications for messages received hours earlier and
  // already read. Firebase queues a push for an offline device and hands it
  // over when the device returns; only calls ever set a lifetime.
  const PR = require(path.join(OUT, 'pushRegistration.js'));
  const SRV = require(path.join(ROOT, 'notify.js'));
  const now = 1_700_000_000_000;
  const HOUR = 60 * 60 * 1000;
  // Negative ages are a phone whose clock is behind — a whole time zone of
  // it, which must still show the notification rather than refuse it.
  for (const age of [-400 * HOUR, -13 * HOUR, -3 * HOUR, 0, 1000, HOUR,
      5 * HOUR, 7 * HOUR, 48 * HOUR]) {
    const args = { sentAt: now - age, now };
    assert.strictEqual(PR.pushIsStale(args), SRV.pushIsStale(args),
      `the two disagree for an age of ${age / HOUR}h`);
  }
  for (const bad of [{ now }, { sentAt: 0, now }, { sentAt: 'x', now }, {}, null]) {
    assert.strictEqual(PR.pushIsStale(bad), SRV.pushIsStale(bad),
      `the two disagree for ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(PR.STALE_PUSH_MS, SRV.STALE_PUSH_MS,
    'the phone and the server disagree about the backstop');
  // Agreeing on something, not merely agreeing: two copies that always
  // returned false would pass the loops above.
  assert.strictEqual(PR.pushIsStale({ sentAt: now - 7 * HOUR, now }), true);
  assert.strictEqual(PR.pushIsStale({ sentAt: now - 1000, now }), false);
  assert.strictEqual(PR.pushIsStale({ sentAt: now + 13 * HOUR, now }), false,
    'a phone a time zone behind refuses everything it is sent');
});

test('THE HANDLER ACTUALLY ASKS, before it asks anything else', () => {
  // A stale push must not consume the once-only claim for its message: if it
  // did, a message whose push arrives late would have its claim used up by
  // the copy that is thrown away, and the socket's live notification for the
  // same message would then be refused.
  const app = fs.readFileSync(path.join(NAT, '..', 'native-app', 'App.tsx'), 'utf8');
  const fn = /handleNotification: async \(notification: any\) => \{([\s\S]*?)\n  \},/.exec(app);
  assert.ok(fn, 'could not find the notification handler');
  assert.ok(/pushReg\.pushIsStale\(\{ sentAt: data\.sentAt, now: Date\.now\(\) \}\)/.test(fn[1]),
    'the app draws a notification however old it is');
  assert.ok(fn[1].indexOf('pushIsStale') < fn[1].indexOf('notifyOnce.claim'),
    'a stale push uses up the claim for its message, silencing the live one');
});

let passed = 0, failed = 0;
(async () => {
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
