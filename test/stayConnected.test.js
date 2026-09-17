// Not depending on Google to be told about a message.
//
// Reported repeatedly: the message appears instantly and the notification
// arrives a couple of minutes later.
//
// Measured on the server the report came from, with its own live traffic:
//
//   [push] 1 device(s) for 1 user(s) [6] — auth 1ms, send 371ms
//   [push] 1 device(s) for 1 user(s) [6] — auth 1ms, send 403ms
//
// Every push reaches a device in about four hundred milliseconds, nobody is
// suppressed, nobody is missing a token. So the server is not the delay, and
// the remaining link is Google to the handset — mtalk.google.com, a foreign
// Google service for users in Iran.
//
// Two things follow, and the second is the reason this file grew:
//
//   • raise the notification off the app's own socket instead of waiting for
//     FCM. The app already did this, gated on "only while no push token is
//     registered" — so fixing registration in build 256 silenced it. That was
//     a regression, and removing the gate is the fix.
//
//   • keep that socket alive, which in the background needs either a battery
//     exemption the user sets by hand or a foreground service. The manual
//     route was reported as not something these users will finish, so it is
//     the service — with a canary, because ongoingCall.ts turned foreground
//     services off after one crashed the app twice where no JavaScript could
//     catch it. Within one run that is true; across launches it is not.
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

test('the one-tap dialog comes FIRST, with the list behind it', () => {
  // This test used to assert the opposite — that the one-tap dialog must never
  // be used, because it needs `package:<this build's id>` and I had written
  // that id off as unknowable at runtime. It is not: CI rewrites app.json per
  // brand BEFORE the bundle is built, so the shipped app.json carries it.
  //
  // The correction matters because the settings list is four taps through a
  // screen about battery, which was reported as not something these users will
  // finish. One tap is the difference between a fix and a workaround.
  assert.strictEqual(S.EXEMPTION_INTENTS[0],
    'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    'the one-tap dialog is not tried first');
  assert.ok(S.EXEMPTION_INTENTS.includes('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS'),
    'there is no fallback for OEM ROMs that refuse the dialog');
});

test('the explanation leads with the one tap, and names the app for the list', () => {
  const body = S.exemptionBody('BistbargChat');
  assert.ok(/"Allow"/.test(body), 'it does not say what to tap');
  assert.ok(/delay/.test(body), 'it does not say what problem this solves');
  // If the dialog is refused and the list opens instead, there has to be
  // something to look for in it.
  assert.ok(/BistbargChat/.test(body),
    'the fallback sends the user into a list of every app with nothing to find');
  // …and it must not tell a BistbargChat user to look for the other brand.
  assert.ok(!/ChatRoom/.test(S.exemptionBody()), 'the default names the wrong brand');
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

// ── The foreground service, and the canary that makes it safe ───────────────
//
// Asked for as: setting the power-saving option is not straightforward and
// some users will not manage it. That rules the manual route out as THE
// answer, and the only thing that keeps the socket alive without asking
// anything of the user is a foreground service — the mechanism ongoingCall.ts
// turned off after one crashed the app at the first ring, twice, because the
// crash happens natively where no JavaScript can catch it.
//
// True within one run of the app. The process dies; the phone does not. So the
// flag written before the start is still there at the next launch, and that is
// the catch — one launch late, but a fact about the handset rather than a
// guess about Android.

test('THE CANARY: a device that died starting the service never tries again', () => {
  // The flag is still set at launch, so the previous run did not survive
  // starting it. Nothing could catch that when it happened.
  assert.strictEqual(S.serviceAllowed({
    canaryPending: true, previouslyDisabled: false, platform: 'android' }), false,
    'a handset that already crashed on this would be asked to do it again');
  assert.strictEqual(S.serviceAllowed({
    canaryPending: false, previouslyDisabled: true, platform: 'android' }), false,
    'the permanent record is ignored, so it crashes once per launch for ever');
  // A clean device may use it.
  assert.strictEqual(S.serviceAllowed({
    canaryPending: false, previouslyDisabled: false, platform: 'android' }), true);
  assert.strictEqual(S.serviceAllowed({
    canaryPending: false, previouslyDisabled: false, platform: 'ios' }), false);
  assert.strictEqual(S.serviceAllowed(null), false);
});

test('the service runs only while the app is AWAY', () => {
  // On screen the socket is already alive and the process will not be frozen,
  // so it would buy nothing and put a permanent notification in the shade of
  // somebody looking at the app it refers to.
  assert.strictEqual(S.shouldRunService({
    allowed: true, signedIn: true, appState: 'background' }), true);
  assert.strictEqual(S.shouldRunService({
    allowed: true, signedIn: true, appState: 'active' }), false);
  assert.strictEqual(S.shouldRunService({
    allowed: false, signedIn: true, appState: 'background' }), false,
    'a device the canary disabled started it anyway');
  assert.strictEqual(S.shouldRunService({
    allowed: true, signedIn: false, appState: 'background' }), false,
    'a permanent notification before anyone has signed in');
  assert.strictEqual(S.shouldRunService(null), false);
});

test('THE ORDER THAT MATTERS: the canary is written BEFORE the start', () => {
  // Written afterwards it records nothing: a process killed by the start never
  // reaches the write, so the next launch sees a clean slate and crashes
  // again. This ordering IS the safety net.
  const ka = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');
  // Scoped to start(). isAllowed() clears the canary too — that is the read
  // path, and searching the whole file finds its clear before the display and
  // reports a failure that is not there.
  const fn = ka.slice(ka.indexOf('export async function start('),
    ka.indexOf('export async function stop('));
  assert.ok(fn.length > 200, 'start() moved');
  const write = fn.indexOf('AsyncStorage.setItem(stay.CANARY_KEY');
  const display = fn.indexOf('notifee.displayNotification({');
  const clear = fn.indexOf('AsyncStorage.removeItem(stay.CANARY_KEY)');
  assert.ok(write > 0 && display > 0 && clear > 0, 'the canary is gone');
  assert.ok(write < display, 'the canary is written after the call that may kill the process');
  assert.ok(clear > display, 'the canary is cleared before the risky call, so it records nothing');
});

test('…and firing it disables the service permanently', () => {
  const ka = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');
  const at = ka.indexOf('if (canaryPending) {');
  assert.ok(at > 0, 'nothing acts on a fired canary');
  const block = ka.slice(at, at + 400);
  assert.ok(/setItem\(stay\.DISABLED_KEY/.test(block),
    'the death is noticed but not recorded, so it happens again next launch');
  assert.ok(/removeItem\(stay\.CANARY_KEY\)/.test(block),
    'the flag is left set, so one death is read as a death every launch');
});

test('THE CRASH: the background service is switched OFF', () => {
  // "On tapping media and opening camera the app crashes and closes",
  // reported on the first build that shipped the service.
  //
  // Tapping media opens the SYSTEM picker, so the app leaves the foreground
  // and AppState fires 'background' — and the service was started in answer to
  // exactly that. Android 12+ forbid starting a foreground service from the
  // background and refuse it natively, after displayNotification() returns,
  // where no try/catch in JavaScript can see it. The canary does catch it on
  // the following launch, but a safety net of "one crash per install" is not
  // something to leave switched on.
  //
  // This goes back to true only alongside a start that happens while the app
  // is still in the FOREGROUND, which is where Android permits it.
  const ka = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');
  assert.ok(/export const KEEP_ALIVE_FOREGROUND_SERVICE = false;/.test(ka),
    'the background service is switched on again, and it crashes on the media picker');
  // The guard has to be the FIRST thing start() does, or the switch is
  // decoration and the storage and notifee calls still run.
  const fn = ka.slice(ka.indexOf('export async function start('),
    ka.indexOf('export async function stop('));
  const first = fn.split('\n').map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('export async'))[0];
  assert.ok(/KEEP_ALIVE_FOREGROUND_SERVICE/.test(first),
    `start() does something before checking the switch: ${first}`);
});

test('a notification left by the build that had it on can still be cleared', () => {
  // `running` is false on a fresh launch, so a stop() guarded on it would
  // leave a stale "Connected" line in the shade with nothing behind it.
  const ka = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');
  const fn = ka.slice(ka.indexOf('export async function stop('),
    ka.indexOf('export function watchAppState('));
  assert.ok(!/if \(!running\) return;/.test(fn),
    'stop() returns early on a fresh launch, stranding a notification from the previous build');
  assert.ok(/stopForegroundService\(\)/.test(fn) && /cancelNotification\(/.test(fn),
    'nothing actually clears it');
});

test('the service asks for none of the types implicated in the crash', () => {
  // PHONE_CALL, MICROPHONE and CAMERA each require a permission Android checks
  // as the service starts, and they are what ongoingCall.ts was asking for.
  const ka = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');
  const code = ka.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  for (const t of ['FOREGROUND_SERVICE_TYPE_PHONE_CALL', 'FOREGROUND_SERVICE_TYPE_MICROPHONE',
                   'FOREGROUND_SERVICE_TYPE_CAMERA']) {
    assert.ok(!code.includes(t), `the service asks for ${t}, which is the crash`);
  }
  assert.ok(/FOREGROUND_SERVICE_TYPE_DATA_SYNC/.test(code), 'it declares no type at all');
});

test('the permission behind that type is actually declared', () => {
  // From Android 14 the system checks the permission behind each service type
  // AT START, and throws SecurityException on the main thread if it is
  // missing — a process death, not an exception. This app has already lost a
  // release to exactly that, for a type whose permission was not in app.json.
  const appJson = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));
  const perms = appJson.expo.android.permissions;
  assert.ok(perms.includes('android.permission.FOREGROUND_SERVICE_DATA_SYNC'),
    'the data-sync service type is used without its permission — this is the crash');
  assert.ok(perms.includes('android.permission.FOREGROUND_SERVICE'),
    'the base foreground-service permission is missing');
});

test('the notification it shows is as quiet as Android allows', () => {
  // It announces nothing; it is rent paid for the right to keep a socket open.
  const ka = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');
  assert.ok(/importance: AndroidImportance\.MIN/.test(ka), 'it can make a noise');
  assert.ok(/vibration: false/.test(ka), 'it vibrates');
  assert.ok(/sound: undefined/.test(ka), 'it has a sound');
});

test('the service is wired to follow the app in and out of the background', () => {
  assert.ok(/keepAlive\.watchAppState\(/.test(app), 'nothing ever starts it');
  const ka = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');
  assert.ok(/AppState\.addEventListener\('change'/.test(ka), 'it never follows the app state');
  assert.ok(/sub\.remove\(\)/.test(ka), 'the listener is never removed');
  assert.ok(/apply\(String\(AppState\.currentState\)\)/.test(ka),
    'the app may already be backgrounded when this runs, and nothing checks');
});

test('the one-tap dialog is aimed at THIS app, not a guess', () => {
  // Asked for: the settings route is not straightforward for users. One tap is
  // the fix, and it needs package:<this build's id> — which the bundled
  // app.json carries, because CI rewrites it per brand before the bundle.
  assert.strictEqual(S.intentData('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    'com.bistbarg.chatroom'), 'package:com.bistbarg.chatroom');
  // The list intent takes no data.
  assert.strictEqual(S.intentData('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
    'com.bistbarg.chatroom'), null);
  // No package means fall through to the list rather than exempt "package:".
  assert.strictEqual(S.intentData('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', ''), null);
  assert.ok(/APP_PACKAGE = \(require\('\.\/app\.json'\)/.test(app),
    'the package id is hardcoded or missing, so the dialog points at the wrong app');
  const appJson = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));
  assert.ok(appJson.expo.android.permissions.includes(
    'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'),
    'the one-tap dialog needs this permission and it is not declared');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
