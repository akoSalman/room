// What the update button should offer (native-app/src/appUpdate.ts).
//
// Reported as: after downloading the app the user may not install it, so give
// them an Install button rather than making them download it again — but only
// while nothing newer has appeared.
//
// Downloading and installing are separate steps and the second one often does
// not happen: Android shows its installer, the user backs out or never grants
// "allow from this source", and the APK sits in the cache. The app then offered
// Update again, which for these users means paying for the same forty megabytes
// twice.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'appupd-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'updateChoice.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping app-update tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck'], { stdio: 'pipe' });

const U = require(path.join(OUT, 'updateChoice.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const choose = (o) => U.installChoice({
  downloadedVersion: null, latestVersion: null, currentVersion: 100, ...o,
});

test('a failed version check recommends nothing', () => {
  // Offering "Update" with no idea what is available invites a pointless
  // download; offering "up to date" would be a claim we cannot make.
  assert.strictEqual(choose({ latestVersion: null }), 'unknown');
});

test('running the newest version is up to date', () => {
  assert.strictEqual(choose({ latestVersion: 100, currentVersion: 100 }), 'up-to-date');
});

test('a newer version with nothing downloaded is an update', () => {
  assert.strictEqual(choose({ latestVersion: 105, currentVersion: 100 }), 'update');
});

test('THE FIX: a downloaded but uninstalled version is offered as Install', () => {
  assert.strictEqual(
    choose({ downloadedVersion: 105, latestVersion: 105, currentVersion: 100 }),
    'install',
  );
});

test('a downloaded version that has been superseded is an update again', () => {
  // The file on disk is out of date, so downloading really is the right thing.
  assert.strictEqual(
    choose({ downloadedVersion: 105, latestVersion: 110, currentVersion: 100 }),
    'update',
  );
});

test('a downloaded version newer than the server knows about still installs', () => {
  // Can happen while a release is propagating. The file is not out of date.
  assert.strictEqual(
    choose({ downloadedVersion: 110, latestVersion: 105, currentVersion: 100 }),
    'install',
  );
});

test('a download that is already installed is not offered again', () => {
  // Same version running as sitting in the cache: there is nothing to install,
  // and something newer exists.
  assert.strictEqual(
    choose({ downloadedVersion: 100, latestVersion: 105, currentVersion: 100 }),
    'update',
  );
});

test('a downloaded version older than what is running is ignored', () => {
  // A stale file from before a manual install. Installing it would be a
  // downgrade.
  assert.strictEqual(
    choose({ downloadedVersion: 90, latestVersion: 105, currentVersion: 100 }),
    'update',
  );
});

test('a dev build with a version available is an update, not up to date', () => {
  // BUILD_VERSION is 0 for a local build.
  assert.strictEqual(choose({ latestVersion: 105, currentVersion: 0 }), 'update');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
