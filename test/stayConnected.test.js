// Not depending on Google to be told about a message.
//
// Reported repeatedly: the message appears instantly and the notification
// arrives a couple of minutes later.
//
// Everything on this side was measured rather than guessed at. The chat server
// is in Frankfurt; it reaches Google in 33ms of TLS; it hands each push to FCM
// in about 139ms; every active user holds a valid device token; the channel is
// MAX importance and every message is sent priority high. The registration bug
// that could have explained it is fixed and installed, and the notifications
// are still late. That leaves the link this project cannot control: Google to
// the handset, over a connection to mtalk.google.com that is a foreign Google
// service for users in Iran.
//
// The obvious answer — hold the app's own socket open behind a foreground
// service — is not available here. CALL_FOREGROUND_SERVICE in ongoingCall.ts
// is `false` because starting one crashed the app at the first ring, twice,
// natively, where no JavaScript can catch it. So this does the thing that
// needs no service: ask to be exempt from Doze, and raise the notification off
// the socket the moment a message lands.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping stay-connected tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'stay-'));
execFileSync(TSC, [path.join(NAT, 'src', 'stayConnected.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const S = require(path.join(OUT, 'stayConnected.js'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The fast path ───────────────────────────────────────────────────────────

test('THE FIX: a backgrounded app raises the notification itself', () => {
  // The old rule was "only when no push token is registered", which made every
  // notification wait for Google even though the socket had already delivered
  // the message.
  assert.strictEqual(S.shouldRaiseLocally({
    fromMe: false, appState: 'background', openRoomId: null, msgRoomId: 7,
  }), true);
  assert.strictEqual(S.shouldRaiseLocally({
    fromMe: false, appState: 'inactive', openRoomId: null, msgRoomId: 7,
  }), true, 'a phone mid-transition is still away');
});

test('…and never for your own message', () => {
  assert.strictEqual(S.shouldRaiseLocally({
    fromMe: true, appState: 'background', msgRoomId: 7,
  }), false);
});

test('…nor while the app is on screen', () => {
  // The unread badges say it better, and a notification for a chat being
  // looked at is noise.
  assert.strictEqual(S.shouldRaiseLocally({
    fromMe: false, appState: 'active', msgRoomId: 7,
  }), false);
});

test('…nor for the chat that is already open', () => {
  assert.strictEqual(S.shouldRaiseLocally({
    fromMe: false, appState: 'background', openRoomId: 7, msgRoomId: 7,
  }), false);
  // A DIFFERENT chat still notifies.
  assert.strictEqual(S.shouldRaiseLocally({
    fromMe: false, appState: 'background', openRoomId: 7, msgRoomId: 8,
  }), true);
});

test('THE TYPE TRAP: room ids are compared as strings', () => {
  // A room id arrives as a number over the socket and as a string in a
  // notification payload. `7 !== "7"` would notify somebody about the chat
  // they are standing in — and this exact mistake is written up in
  // openIntent.ts as one of the four causes of a different bug.
  assert.strictEqual(S.shouldRaiseLocally({
    fromMe: false, appState: 'background', openRoomId: 7, msgRoomId: '7',
  }), false, 'the open chat notified because its id was a string');
  assert.strictEqual(S.shouldRaiseLocally({
    fromMe: false, appState: 'background', openRoomId: '7', msgRoomId: 7,
  }), false);
});

test('nothing sensible in does not raise a notification', () => {
  assert.strictEqual(S.shouldRaiseLocally(null), false);
  assert.strictEqual(S.shouldRaiseLocally(undefined), false);
});

// ── Why two notifications do not become two notifications ───────────────────

test('THE REASON THIS IS SAFE: both carry the same tag', () => {
  // Android replaces a notification sharing a tag. Without this, raising the
  // local one early would simply show every message twice — which is why the
  // old code waited for FCM to be absent.
  assert.strictEqual(S.dedupeTag(42), 'msg-42');
  assert.strictEqual(S.dedupeTag('42'), 'msg-42',
    'a string id produces a different tag, so the two would not collapse');
});

test('the server puts that exact tag on its own notification', () => {
  // If these two ever disagree, every message shows twice and nothing in
  // either file looks wrong on its own.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(/tag: `msg-\$\{data\.msgId\}`/.test(server),
    'the server no longer tags its push with msg-<id>, so the two will double up');
});

// ── Asking to be left running ───────────────────────────────────────────────

test('the exemption is asked for once, and only after signing in', () => {
  assert.strictEqual(S.shouldAskExemption({
    signedIn: true, alreadyAsked: false, platform: 'android' }), true);
  assert.strictEqual(S.shouldAskExemption({
    signedIn: true, alreadyAsked: true, platform: 'android' }), false, 'it nags');
  assert.strictEqual(S.shouldAskExemption({
    signedIn: false, alreadyAsked: false, platform: 'android' }), false,
    'a dialog about background behaviour on the login screen is inexplicable');
  assert.strictEqual(S.shouldAskExemption({
    signedIn: true, alreadyAsked: false, platform: 'ios' }), false,
    'iOS has no battery-optimisation list to send anybody to');
  assert.strictEqual(S.shouldAskExemption(null), false);
});

test('THE CRASH THAT IS NOT BEING REPEATED: no intent needs a permission', () => {
  // REQUEST_IGNORE_BATTERY_OPTIMIZATIONS is the one-tap dialog, and it needs
  // both the matching permission and `package:<this app's id>` as its data.
  // The id is rewritten per brand by CI, so it is not a constant this code can
  // know — and this app's history with Android refusing something it was not
  // entitled to ask for is a foreground service that killed the process twice.
  for (const intent of S.EXEMPTION_INTENTS) {
    assert.ok(!/REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/.test(intent),
      'the one-tap dialog is back, and it needs a package id this build cannot know');
  }
  assert.ok(S.EXEMPTION_INTENTS.length >= 1, 'there is nowhere to send anybody');
});

test('the explanation names the app, because it opens a LIST', () => {
  const body = S.exemptionBody('BistbargChat');
  assert.ok(/BistbargChat/.test(body),
    'the user is sent into a list of every app on the phone with nothing to look for');
  assert.ok(/minutes late/.test(body), 'it does not say what problem this solves');
  // The default must not tell a BistbargChat user to look for something else.
  assert.ok(!/ChatRoom/.test(S.exemptionBody()), 'the fallback names the wrong brand');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');

test('THE OLD RULE IS GONE from the socket handler', () => {
  // `socketFallbackAllowed` made the local notification wait for FCM to be
  // absent. Leaving it in place would leave the delay in place.
  assert.ok(!/socketFallbackAllowed/.test(app),
    'the local notification still waits for push to be unregistered');
  assert.ok(/stay\.shouldRaiseLocally\(\{/.test(app), 'the handler decides for itself again');
  assert.ok(/identifier: stay\.dedupeTag\(msg\.id\)/.test(app),
    'the local notification is tagged by hand, so it will not collapse with the push');
});

test('the exemption prompt is wired, and records the asking BEFORE prompting', () => {
  const at = app.indexOf('Ask Android to stop pausing this app');
  assert.ok(at > 0, 'the exemption prompt is gone');
  const fn = app.slice(at, app.indexOf('// Global notifications:'));
  assert.ok(/stay\.shouldAskExemption\(\{/.test(fn), 'it asks without consulting the rule');
  // Recorded after the prompt, a user who dismisses it by leaving the app is
  // asked again on every single launch.
  assert.ok(fn.indexOf('AsyncStorage.setItem(stay.ASKED_KEY') < fn.indexOf('Alert.alert('),
    'the asking is recorded after the prompt, so dismissing it means being asked forever');
});

test('opening the settings can fail without taking the app with it', () => {
  // Every OEM ROM is different and some have removed the screen entirely. This
  // app has already lost a release to an Android refusal it could not catch.
  const at = app.indexOf('async function openBatterySettings(');
  assert.ok(at > 0, 'openBatterySettings moved');
  const fn = app.slice(at, at + 700);
  assert.ok(/catch \{\}/.test(fn), 'a refused intent is unhandled');
  assert.ok(/Linking\.openSettings\(\)/.test(fn), 'there is no last resort');
});

test('the foreground service is still OFF, and this did not turn it back on', () => {
  // The strongest fix for this bug would be a foreground service holding the
  // socket open. It is disabled because starting one crashed the app at the
  // first ring, twice — the second time on a build carrying a fix for it — and
  // ongoingCall.ts asks in writing that it not be re-enabled without a crash
  // log. Fixing one bug by re-opening a worse one is the trap here.
  const ongoing = fs.readFileSync(path.join(NAT, 'src', 'ongoingCall.ts'), 'utf8');
  assert.ok(/export const CALL_FOREGROUND_SERVICE = false;/.test(ongoing),
    'the foreground service was turned back on without a crash log');
  const stayFile = fs.readFileSync(path.join(NAT, 'src', 'stayConnected.ts'), 'utf8');
  const code = stayFile.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(!/registerForegroundService|asForegroundService/.test(code),
    'this file starts a foreground service, which is the crash that cost a release');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
