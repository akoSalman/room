// ── "Muted channel still rings notifications" ───────────────────────────────
//
// It did, and the reason is that ONE message produces a notification by TWO
// different routes, and only one of them had ever heard of mutes.
//
//   the push      server → Firebase / Web Push → the phone.
//                 Filtered. This is the path that reaches a device with the
//                 app closed, and it is the one the mute was built against.
//
//   the socket    server → message_received → the client draws it ITSELF.
//                 Not filtered, not even slightly. This is the path you get
//                 whenever the app is open or its keep-alive service is
//                 running, which is most of the time — and on the web it
//                 also plays notify.wav, which is the "rings" in the report.
//
// So the mute worked precisely when nobody was there to notice, and failed
// every other time. Both clients now read a flag the server stamps per
// recipient; the flag is the server's because a mute is one person's decision
// about one room, and a phone's copy of the room list can be hours old.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');

const tests = [];
const test = (n, f) => tests.push({ n, f });

// The app's decision is compiled and exercised, not just read.
let N = null;
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mring-'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
  const stub = (name, body) => {
    const dir = path.join(OUT, 'node_modules', ...name.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), body);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
  };
  stub('@notifee/react-native', 'module.exports = { default: { displayNotification: async () => {}, cancelNotification: async () => {} }, AndroidImportance: { HIGH: 4 } };');
  stub('expo-notifications', 'module.exports = { dismissNotificationAsync: async () => {} };');
  stub('react-native', "module.exports = { AppState: { currentState: 'background' } };");
  stub('@react-native-async-storage/async-storage',
    'module.exports = { default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } };');
  execFileSync(TSC, [path.join(NAT, 'src', 'socketNotifier.ts'),
    path.join(NAT, 'src', 'pushRegistration.ts'), path.join(NAT, 'src', 'notifyDiag.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
  N = require(path.join(OUT, 'socketNotifier.js'));
}

test('THE BUG: a muted room raises nothing from the socket', () => {
  if (!N) { console.log('    (native-app deps not installed)'); return; }
  const d = N.raiseDecision({
    muted: true, msgId: 42, msgUsername: 'sara', me: 'ako',
    appState: 'background', pushRegistered: true,
  });
  assert.strictEqual(d.raise, false, 'a muted room still raises a notification');
  assert.strictEqual(d.reason, 'muted', 'it is refused, but not for being muted');
});

test('…and the same message unmuted still does', () => {
  // The other half: a check that refuses everything would "fix" this and
  // break notifications altogether, which is the bug this app has spent
  // weeks on.
  if (!N) return;
  const d = N.raiseDecision({
    msgId: 42, msgUsername: 'sara', me: 'ako',
    appState: 'background', pushRegistered: true,
  });
  assert.strictEqual(d.raise, true, 'nothing gets through at all now');
});

test('MUTED BEATS EVERYTHING ELSE', () => {
  // Asked first, before who sent it and before where the reader is. Once
  // somebody has asked for a room to be quiet, no other fact about the
  // message makes it ring.
  if (!N) return;
  for (const extra of [{ msgUsername: 'ako', me: 'ako' }, { appState: 'active' },
                       { msgRoomId: 7, viewingRoomId: 7 }, { msgId: null }]) {
    const d = N.raiseDecision({ muted: true, msgId: 42, pushRegistered: true, ...extra });
    assert.strictEqual(d.raise, false);
  }
});

// ── The wiring ──────────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const serverCode = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('THE SERVER SAYS SO, per recipient', () => {
  // Not worked out on the phone: mute a room on your laptop and the phone's
  // room list is stale until it next refreshes, so it would go on ringing.
  assert.ok(/function emitMessageTo/.test(serverCode), 'nothing stamps the flag');
  const fn = serverCode.slice(serverCode.indexOf('function emitMessageTo'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/hasMutedRoom\(userId, roomId\)/.test(body), 'the flag is not per recipient');
  assert.ok(/muted: true/.test(body));
});

test('…on every path a chat message takes', () => {
  // Seven emits, and one missed would be a room that rings from one screen
  // and not another — which is worse than not having the feature.
  // The helper's own body is the one place the raw emit belongs — it is
  // where the flag is put on.
  const helperAt = serverCode.indexOf('function emitMessageTo');
  const helperEnd = serverCode.indexOf('\n}', helperAt);
  const outside = serverCode.slice(0, helperAt) + serverCode.slice(helperEnd);
  const stray = outside.split('\n').filter(l =>
    /emit\('message_received'/.test(l) && !/emitMessageTo/.test(l));
  // The one exception is the "you left the room" notice, which goes to
  // nobody but you, and your own messages never raise a notification.
  assert.ok(stray.length <= 1,
    'a message path still emits without the mute flag:\n' + stray.join('\n'));
  for (const s of stray) {
    assert.ok(/socket\.user\.id/.test(s),
      'an emit to somebody OTHER than the sender skips the mute flag: ' + s.trim());
  }
});

test('THE APP READS IT', () => {
  const src = fs.readFileSync(path.join(NAT, 'src', 'socketNotifier.ts'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(/muted: !!msg\?\.muted/.test(code), 'the flag arrives and is thrown away');
  assert.ok(/if \(o\.muted\) return \{ raise: false, reason: 'muted' \}/.test(code));
});

test('…AND SO DOES THE WEB, which is where the sound comes from', () => {
  // notify.wav is played by the page itself, right after it raises its own
  // Notification. That is the "rings" in the report, and it is a different
  // file from the app entirely.
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const code = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf('new Notification(');
  assert.ok(i > 0, 'the web no longer raises notifications');
  // The check must come BEFORE the notification and the sound, not after.
  const before = code.slice(Math.max(0, i - 1200), i);
  assert.ok(/if \(msg\.muted\) return;/.test(before),
    'the web raises a notification for a muted room, and plays a sound with it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
