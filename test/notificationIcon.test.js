// ── The blank grey square in the shade ──────────────────────────────────────
//
// Photographed: "Connected — Messages arrive instantly while this is on", and
// beside it a solid grey box where the app's icon belongs.
//
// Settled by decompiling notifee's own AAR rather than by guessing. In
// NotificationAndroidModel.getSmallIcon, an absent `smallIcon` key returns
// null immediately, and the builder then jumps clean over setSmallIcon:
//
//     751: getSmallIcon:()Ljava/lang/Integer;
//     756: ifnull  796
//
// No small icon means Android falls back to the launcher icon, and every
// small icon is rendered from its ALPHA CHANNEL alone. A full-colour launcher
// icon is opaque everywhere, so its silhouette is a filled square.
//
// The asset to use was already in the project and already built into the
// Android resources — it was simply never named to notifee.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping notification-icon tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nicon-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'notificationIcon.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const I = require(path.join(OUT, 'notificationIcon.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('EVERY NOTIFEE NOTIFICATION NAMES AN ICON', () => {
  // All three drew the grey square, not just the keep-alive one that was
  // photographed — the message notifications and the update progress bar had
  // the same gap, and nobody had looked at them side by side.
  for (const file of ['keepAlive.ts', 'socketNotifier.ts', 'appUpdate.ts']) {
    const src = fs.readFileSync(path.join(NAT, 'src', file), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.ok(/displayNotification\(/.test(code), `${file} no longer posts a notification`);
    assert.ok(/notificationIcon\.iconFields\(\)/.test(code),
      `${file} posts a notification with no small icon, so Android draws a grey square`);
  }
});

test('THE NAME MATCHES THE RESOURCE THAT IS ACTUALLY BUILT', () => {
  // notifee's failure mode for a name that does not resolve is to log a line
  // nobody will ever read and draw the grey square again — identical to the
  // bug, and silent. So the name is pinned to the plugin that generates it.
  const plugin = fs.readFileSync(path.join(
    NAT, 'node_modules', 'expo-notifications', 'plugin', 'build',
    'withNotificationsAndroid.js'), 'utf8');
  const m = plugin.match(/exports\.NOTIFICATION_ICON = '([^']+)'/);
  assert.ok(m, 'expo-notifications no longer exports the drawable name');
  assert.strictEqual(I.SMALL_ICON, m[1],
    'the drawable expo builds and the one notifee asks for have drifted apart');
});

test('…and the asset that becomes that resource exists', () => {
  const app = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));
  const plugin = (app.expo.plugins || []).find(p => Array.isArray(p) && p[0] === 'expo-notifications');
  assert.ok(plugin, 'the expo-notifications plugin is gone, so no drawable is generated');
  const icon = plugin[1] && plugin[1].icon;
  assert.ok(icon, 'no notification icon is configured, so the drawable is never built');
  assert.ok(fs.existsSync(path.join(NAT, icon)), `${icon} is configured but missing`);
  // The colour comes from the same place, so the tint and the icon cannot
  // disagree.
  assert.strictEqual(I.ICON_COLOR, plugin[1].color,
    'the tint in app.json and the one notifee is given have drifted apart');
});

test('THE ASSET IS A SILHOUETTE, not a picture', () => {
  // The part that makes this fix work at all. Android keeps only the alpha
  // channel of a small icon, so a full-colour square becomes a full grey
  // square — which is the bug. This asset is mostly transparent, which is
  // what makes it render as the app's shape.
  //
  // Checked by reading the PNG rather than trusting the filename: swapping in
  // an opaque logo here would reproduce the reported bug exactly, while every
  // other test on this page went on passing.
  const png = fs.readFileSync(path.join(NAT, 'assets', 'notification-icon.png'));
  assert.strictEqual(png.slice(1, 4).toString(), 'PNG');
  const colorType = png[25];
  assert.ok(colorType === 6 || colorType === 4,
    'the notification icon has no alpha channel at all, so Android will draw a solid block');
});

test('the fields are what notifee expects, and nothing more', () => {
  const f = I.iconFields();
  assert.deepStrictEqual(Object.keys(f).sort(), ['color', 'smallIcon']);
  assert.ok(/^#[0-9a-f]{6}$/i.test(f.color), 'the tint is not a colour Android can parse');
  assert.ok(!/[^a-z0-9_]/.test(f.smallIcon),
    'an Android resource name may only hold lowercase letters, digits and underscores');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
