// ── The foreground service, and the rule that crashed the app last time ─────
//
// Asked for after the numbers came back from the reporter's own phone:
//
//     delivered by Firebase ........  2
//     raised by the app's own socket  11
//
// The socket does the work; Android freezing the process is what stops it, and
// a foreground service is the only thing that prevents that.
//
// THE PREVIOUS ATTEMPT KILLED THE APP. It started the service from
// watchAppState when the app went to the BACKGROUND. Android 12+ forbid that
// and refuse it by throwing natively AFTER displayNotification() returns, so
// the try/catch caught nothing and the process died. Opening the media picker
// backgrounds the app, so it was reported as "the camera crashes the app".
//
// That rule is therefore a pure function with tests, rather than an `if` in an
// event handler where it can be quietly widened.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping keep-alive tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-'));
// Stubs: the module imports native packages that do not exist here, and the
// rules under test are pure.
for (const [pkg, body] of [
  ['@react-native-async-storage/async-storage',
    'module.exports = { default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } };'],
  ['@notifee/react-native',
    'module.exports = { default: {}, AndroidImportance: { MIN: 1 }, AndroidForegroundServiceType: { FOREGROUND_SERVICE_TYPE_DATA_SYNC: 1 } };'],
]) {
  const dir = path.join(OUT, 'node_modules', ...pkg.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), body);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, main: 'index.js' }));
}
execFileSync(TSC, [path.join(NAT, 'src', 'keepAlive.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
  '--esModuleInterop'], { stdio: 'pipe' });
const K = require(path.join(OUT, 'keepAlive.js'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const idle = { disabled: false, running: false };

// ── The rule that killed the app ────────────────────────────────────────────

test('OFF, until a manifest change ships with it', () => {
  // It crashed the app on launch. notifee's manifest declares no
  // android:foregroundServiceType, and on Android 14 startForeground() with an
  // undeclared type throws natively and kills the process. Declaring the
  // PERMISSION is a different thing and does not satisfy it.
  assert.strictEqual(K.KEEP_ALIVE_SERVICE, false,
    'the service is on again without the manifest attribute that makes it legal');
  assert.strictEqual(K.mayStart({ appState: 'active', ...idle }), false,
    'the kill switch does not actually stop a start');
});

test('THE CRASH: the state rule still refuses the background', () => {
  // Tested through foregroundOnly rather than mayStart, so it stays under test
  // while the feature is off. A kill switch that also hides the rule it guards
  // means nothing checks that rule until somebody re-enables it — which is the
  // worst possible moment to find out it drifted.
  assert.strictEqual(K.foregroundOnly('background'), false);
});

test('…and "inactive", which is the transition on the way out', () => {
  // The half-second between active and background — a permission dialog, the
  // app switcher, the media picker opening. Treating it as "still in the
  // foreground" is the same crash with a shorter fuse.
  assert.strictEqual(K.foregroundOnly('inactive'), false);
});

test('only "active" passes the state rule', () => {
  assert.strictEqual(K.foregroundOnly('active'), true);
  for (const st of ['unknown', 'extension', '', null, undefined]) {
    assert.strictEqual(K.foregroundOnly(st), false, `allowed from ${st}`);
  }
});

test('a device the service already killed never tries again', () => {
  // The canary's entire purpose: one crash per install, not one per launch.
  // The call version fired at every ring for ever, which is why it had to go.
  // It is what saved this phone when the service crashed it on launch.
  assert.strictEqual(K.mayStart({ appState: 'active', disabled: true, running: false }), false);
});

// ── The canary ──────────────────────────────────────────────────────────────

test('a canary still present at launch means the start killed us', () => {
  // It is written before the start and cleared once the process has survived.
  // The only thing that prevents the clearing is dying in between.
  assert.strictEqual(K.crashedOnLastStart({ canaryPresent: true }), true);
  assert.strictEqual(K.crashedOnLastStart({ canaryPresent: false }), false);
  assert.strictEqual(K.crashedOnLastStart(null), false);
});

test('the disabled flag is read as a flag, not as a truthy string', () => {
  assert.strictEqual(K.isDisabled({ disabledFlag: '1' }), true);
  assert.strictEqual(K.isDisabled({ disabledFlag: null }), false);
  assert.strictEqual(K.isDisabled({ disabledFlag: '' }), false);
  assert.strictEqual(K.isDisabled(null), false);
});

test('the survival window is long enough for Android to object', () => {
  // The refusal arrives natively just after displayNotification() resolves.
  // Clearing the canary too eagerly means a crash looks like a success and
  // the service is retried on every launch for ever.
  assert.ok(K.SURVIVED_AFTER_MS >= 2000,
    `${K.SURVIVED_AFTER_MS}ms is not long enough to be sure Android accepted it`);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
const appJson = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));
const src = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');

test('THE OTHER HALF OF THE CRASH: DATA_SYNC is declared', () => {
  // A foreground service with no permissible type is refused exactly as
  // firmly as one started from the background. Its absence was the other half
  // of the original crash.
  const perms = appJson.expo.android.permissions;
  assert.ok(perms.includes('android.permission.FOREGROUND_SERVICE_DATA_SYNC'),
    'the service declares a type the app has no permission for, which is a dead process');
  assert.ok(perms.includes('android.permission.FOREGROUND_SERVICE'));
});

test('…and it asks for DATA_SYNC only', () => {
  // The call version asked for PHONE_CALL, MICROPHONE and CAMERA, any of
  // which Android 14 refuses without the matching runtime permission.
  assert.ok(/FOREGROUND_SERVICE_TYPE_DATA_SYNC/.test(src));
  for (const t of ['PHONE_CALL', 'MICROPHONE', 'CAMERA']) {
    assert.ok(!new RegExp(`FOREGROUND_SERVICE_TYPE_${t}`).test(src),
      `keepAlive asks for ${t}, which Android refuses without its runtime permission`);
  }
});

test('every start call site passes a foreground state', () => {
  // Counted, not "the rule exists somewhere". A single call from a background
  // handler is the crash, and mayStart would catch it — but a call site that
  // hands it 'active' unconditionally would defeat that, so both are checked.
  const calls = app.match(/keepAlive\.start\(([^)]*)\)/g) || [];
  assert.ok(calls.length >= 1, 'keepAlive is never started');
  for (const c of calls) {
    assert.ok(/AppState\.currentState|'active'/.test(c),
      `a start is made without saying what state the app is in: ${c}`);
  }
});

test('the background branch does NOT start it', () => {
  // The exact shape of the original bug: a start in the branch that runs when
  // the app leaves the foreground.
  const at = app.indexOf("AppState.addEventListener('change'");
  const end = app.indexOf('// Tapping a message notification opens its chat', at);
  const handler = app.slice(at, end > at ? end : at + 3000);
  assert.ok(handler.length > 200, 'the AppState handler moved');
  const afterActive = handler.slice(handler.indexOf('return;'));
  assert.ok(!/keepAlive\.start/.test(afterActive),
    'the service is started from the background branch — this is the crash, again');
});

test('the canary is read BEFORE anything may start', () => {
  // Starting first and checking afterwards means a handset that the service
  // kills is killed again on every launch.
  const initAt = app.indexOf('keepAlive.init()');
  const startAt = app.indexOf('keepAlive.start(AppState.currentState)');
  assert.ok(initAt > -1 && startAt > initAt,
    'the launch start does not wait for the crash canary to be read');
});

test('signing out takes the notification down', () => {
  // A "Connected" line in the shade with nobody signed in is a lie, and there
  // would be no way to clear it from the app.
  assert.ok(/keepAlive\.stop\(\)/.test(app), 'the service outlives sign-out');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
