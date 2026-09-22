// ── Works for a minute, then stops ──────────────────────────────────────────
//
// Reported on the first build where the socket listener was actually attached
// to the socket: "notification worked fine even on closed app for first
// seconds or first minute and then not worked".
//
// That shape is Doze. A foreground service exempts the process from app
// standby, which is why the first minute works at all; it does NOT exempt it
// from Doze suspending the app's network once the device decides it is idle.
// The socket stops answering pings, the server times it out — the
// ping-timeout in the presence log — and nothing reaches the phone until the
// next maintenance window.
//
// There is one documented way out and the app cannot grant it to itself: the
// user puts the app on the battery-optimisation whitelist. So this is about
// ASKING WELL, and the things that can go wrong are all silent ones — an
// intent no activity handles does nothing on many devices rather than
// throwing, and a button that does nothing is worse than no button.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping battery-exemption tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'batt-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
function stub(name, body) {
  const dir = path.join(OUT, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), body);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
}
stub('expo-intent-launcher', 'module.exports = { startActivityAsync: async () => {} };');
stub('react-native',
  "module.exports = { Platform: { OS: 'android', Version: 33 }, Linking: { openSettings: async () => {} } };");
execFileSync(TSC, [path.join(NAT, 'src', 'batteryExemption.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const B = require(path.join(OUT, 'batteryExemption.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE DIRECT DIALOG IS TRIED FIRST, and it names this app', () => {
  // Without the package: URI Android shows the whole list of installed apps
  // and a non-technical user has to find this one in it. With it, one tap.
  const plan = B.intentPlan('com.example.chat');
  assert.strictEqual(plan[0].action, B.REQUEST_ACTION);
  assert.strictEqual(plan[0].data, 'package:com.example.chat',
    'the package URI is malformed, so the dialog opens for nothing or for the wrong app');
});

test('…and there is ALWAYS a fallback that needs no package name', () => {
  // The package differs per brand and the build rewrites it, so the app
  // cannot rely on knowing it. A plan that only worked with one would leave
  // the other brand with a button that does nothing.
  const plan = B.intentPlan();
  assert.ok(plan.length >= 1);
  assert.ok(plan.every(p => !p.data), 'a step needs a package name that is not available');
  assert.strictEqual(plan[plan.length - 1].action, B.LIST_ACTION);
  assert.deepStrictEqual(B.intentPlan(''), B.intentPlan(null));
  assert.deepStrictEqual(B.intentPlan('   '), B.intentPlan(undefined));
});

test('open() never throws, and says whether anything opened', async () => {
  // Offered from the screen that explains why notifications do not work.
  // Crashing there would be a poor joke.
  assert.strictEqual(await B.open('com.example.chat'), true);
  assert.strictEqual(await B.open(), true);
});

test('…and it falls through to the app\'s own settings when every intent fails', async () => {
  // Intents for activities a device does not have fail silently on many
  // phones. Linking.openSettings() is the one route that exists everywhere
  // and needs no package name.
  const src = fs.readFileSync(path.join(NAT, 'src', 'batteryExemption.ts'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(/Linking\.openSettings\(\)/.test(code),
    'a phone with neither battery activity gets a button that does nothing');
  const fn = code.slice(code.indexOf('export async function open'));
  assert.ok(fn.indexOf('for (const step of intentPlan') < fn.indexOf('Linking.openSettings'),
    'the generic settings page is opened before the direct dialog is even tried');
});

test('NOT OFFERED where there is nothing to exempt from', () => {
  // Doze arrived in Android 6. Below that the button would open nothing, and
  // a diagnostics screen that offers dead buttons stops being believed.
  assert.strictEqual(B.offerable({ os: 'android', version: 33 }), true);
  assert.strictEqual(B.offerable({ os: 'android', version: 23 }), true);
  assert.strictEqual(B.offerable({ os: 'android', version: 22 }), false);
  assert.strictEqual(B.offerable({ os: 'ios', version: 17 }), false);
  // An unknown version is offered rather than hidden: the cost of a spare
  // button is far lower than the cost of hiding the only real fix.
  assert.strictEqual(B.offerable({ os: 'android', version: 'x' }), true);
});

test('THE PERMISSION IS DECLARED, or the direct dialog silently does nothing', () => {
  const app = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));
  const perms = app.expo.android.permissions || [];
  assert.ok(perms.includes('android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'),
    'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS is missing, so the one-tap dialog is refused');
});

test('THE BUTTON EXISTS AND IS WIRED', () => {
  // The whole point is that the user can reach it. A module nothing calls is
  // the same as no module, and this repository has shipped that before.
  const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');
  const code = rooms.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/battery\.offerable\(\)/.test(code), 'the row is shown on phones it cannot help');
  assert.ok(/battery\.open\(\)/.test(code), 'the row does not open anything');
  // And it explains the symptom in the user's words, not in Android's.
  assert.ok(/stop after a minute/i.test(rooms),
    'the row does not say what it is for, so nobody will tap it');
  assert.ok(!/\bDoze\b/.test(code.slice(code.indexOf('battery.offerable()'),
                                        code.indexOf('Messages reaching the app'))),
    'the row explains it in Android\'s vocabulary rather than the user\'s');
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
