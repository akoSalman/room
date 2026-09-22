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

const PLUGIN = require(path.join(NAT, 'plugins', 'withNotifeeDataSync.js'));

/** notifee's core AAR, which is where the service is really declared. */
function findNotifeeAar() {
  const base = path.join(NAT, 'node_modules', '@notifee', 'react-native', 'android', 'libs');
  if (!fs.existsSync(base)) return null;
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.aar')) out.push(f);
    }
  })(base);
  return out[0] || null;
}

function extractManifest(aar) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aar-'));
  try {
    execFileSync('unzip', ['-o', '-q', aar, 'AndroidManifest.xml', '-d', dir], { stdio: 'pipe' });
    return fs.readFileSync(path.join(dir, 'AndroidManifest.xml'), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── The rule that killed the app ────────────────────────────────────────────

test('THE CRASH: notifee declares shortService, and this asks for dataSync', () => {
  // Read out of notifee's own AAR, because this single fact is what killed
  // the app on launch and no amount of reading the JS would have shown it:
  //
  //   <service android:name="app.notifee.core.ForegroundService"
  //            android:foregroundServiceType="shortService" />
  //
  // Asking for a type the manifest does not declare throws natively on
  // Android 14. If a notifee upgrade changes that attribute, this fails here
  // rather than on somebody's phone.
  const aar = findNotifeeAar();
  if (!aar) return;
  const xml = extractManifest(aar);
  assert.ok(/app\.notifee\.core\.ForegroundService/.test(xml),
    'notifee no longer declares the service this feature depends on');
  const m = xml.match(/ForegroundService[\s\S]{0,200}?foregroundServiceType="([^"]+)"/);
  assert.ok(m, 'notifee no longer declares a foregroundServiceType at all');
  assert.strictEqual(m[1], 'shortService',
    `notifee now declares "${m[1]}" — the override in withNotifeeDataSync.js must be rechecked`);
});

test('…so the plugin overrides it, because shortService is capped at ~3 minutes', () => {
  // Switching the code to shortService instead would compile and not crash,
  // and then Android would kill the app after about three minutes. A socket
  // that dies after three minutes is not a socket being kept alive.
  assert.strictEqual(PLUGIN.TYPE, 'dataSync',
    'the override asks for a type with a time limit, which defeats the point');
  assert.strictEqual(PLUGIN.SERVICE, 'app.notifee.core.ForegroundService');
});

test('THE PLUGIN ACTUALLY REWRITES THE MANIFEST', () => {
  // Driven with a manifest object rather than asserting the source contains
  // the right words: a plugin that is registered but silently does nothing
  // would pass every other check in this file and crash the app again.
  // The shape expo's helper expects: it finds the application by name.
  const manifest = { manifest: { $: {},
    application: [{ $: { 'android:name': '.MainApplication' }, service: [] }] } };
  const out = PLUGIN.applyToManifest(manifest);
  const app = out.manifest.application[0];
  const svc = (app.service || []).find(x => x.$['android:name'] === PLUGIN.SERVICE);
  assert.ok(svc, 'the plugin did not add the service override');
  assert.strictEqual(svc.$['android:foregroundServiceType'], 'dataSync');
  assert.strictEqual(svc.$['tools:replace'], 'android:foregroundServiceType',
    'without tools:replace the manifest merger fails on the conflicting value');
  assert.strictEqual(out.manifest.$['xmlns:tools'], 'http://schemas.android.com/tools',
    'tools: is used without declaring the namespace, which fails the merge');
});

test('…and it overwrites an existing entry rather than adding a second', () => {
  // Two <service> elements for one name is a manifest error.
  const manifest = { manifest: { $: {},
    application: [{ $: { 'android:name': '.MainApplication' }, service: [
      { $: { 'android:name': PLUGIN.SERVICE, 'android:foregroundServiceType': 'shortService' } },
    ] }] } };
  const out = PLUGIN.applyToManifest(manifest);
  const svcs = out.manifest.application[0].service.filter(
    x => x.$['android:name'] === PLUGIN.SERVICE);
  assert.strictEqual(svcs.length, 1, 'the service is declared twice');
  assert.strictEqual(svcs[0].$['android:foregroundServiceType'], 'dataSync');
});

test('the plugin is registered, or it never runs', () => {
  const plugins = (appJson.expo.plugins || []).map(x => (Array.isArray(x) ? x[0] : x));
  assert.ok(plugins.includes('./plugins/withNotifeeDataSync'),
    'the plugin exists but is not in app.json, so the manifest is never changed');
});

test('the feature is on, now that the manifest agrees with it', () => {
  assert.strictEqual(K.KEEP_ALIVE_SERVICE, true);
  assert.strictEqual(K.mayStart({ appState: 'active', ...idle }), true);
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


// ── Keeping it out of the way ───────────────────────────────────────────────

test('OFF THE LOCK SCREEN: the service notification is SECRET', () => {
  // Asked for from a photo of it sitting on the lock screen: "don't show that
  // connected status but keep socket alive". It cannot be removed — Android
  // kills a foreground service whose notification is gone — but it can be
  // kept out of the place it was actually in the way.
  //
  // MIN importance does NOT do this. MIN governs sound and position in the
  // shade; lock-screen visibility is a separate setting that defaults to
  // PRIVATE, which is why MIN was already set and it showed anyway.
  const src = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const ch = code.indexOf('notifee.createChannel({');
  assert.ok(ch > 0, 'the channel is no longer created here');
  assert.ok(/visibility: AndroidVisibility\.SECRET/.test(code.slice(ch, code.indexOf('}', ch) + 400)),
    'the channel does not hide the notification from the lock screen');
  // And on the notification too, for phones whose channel already exists.
  const n = code.indexOf('notifee.displayNotification({');
  assert.ok(n > 0);
  assert.ok(/visibility: AndroidVisibility\.SECRET/.test(code.slice(n)),
    'only the channel is SECRET, so existing installs still show it on the lock screen');
  assert.ok(/AndroidVisibility/.test(code.slice(0, code.indexOf('export'))),
    'AndroidVisibility is used but never imported');
});

test('…and the channel id was bumped, or none of that reaches a real phone', () => {
  // Android caches a channel's settings forever: importance and lock-screen
  // visibility cannot be changed once it exists. Editing v1's settings would
  // change nothing on any handset that already has v1 — which is every
  // handset that has ever run this. A new id is the only way to ship one.
  assert.strictEqual(K.CHANNEL_ID, 'connection-v2',
    'the channel id still names a channel that already exists with the old settings');
  // Pinned against notifee's enum, so a renumbering fails here rather than
  // quietly putting it back on somebody's lock screen.
  const en = fs.readFileSync(path.join(
    NAT, 'node_modules', '@notifee', 'react-native', 'dist', 'types',
    'NotificationAndroid.d.ts'), 'utf8');
  assert.ok(/SECRET = -1/.test(en), 'notifee renumbered AndroidVisibility; recheck keepAlive');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
