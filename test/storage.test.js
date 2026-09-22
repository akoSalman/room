// ── Nine gigabytes, and half a gigabyte, both measured honestly ─────────────
//
// Reported as: Android's app info says the app is using 9 GB while the
// profile screen says half a gigabyte. Neither number was wrong. The profile
// screen measured documentDirectory/media/ and nothing else, and the app
// writes to six places.
//
// The rules here are the ones that decide what gets DELETED, which is why
// they are separated from the filesystem and tested on their own. Every
// mistake available in this file is the same mistake — deleting something
// somebody still wants — and it is silent, unrecoverable, and discovered a
// week later by somebody whose draft lost its photo.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping storage tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
function stub(name, body) {
  const dir = path.join(OUT, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), body);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
}
stub('expo-file-system',
  "module.exports = { documentDirectory: 'doc/', cacheDirectory: 'cache/',"
  + " readDirectoryAsync: async () => [], getInfoAsync: async () => ({ exists: false }),"
  + " deleteAsync: async () => {} };");
stub('@react-native-async-storage/async-storage',
  'module.exports = { default: { getItem: async () => null, removeItem: async () => {} } };');
stub('./download', 'module.exports = { localNameFor: (u, p) => p + u };');
execFileSync(TSC, [path.join(NAT, 'src', 'storage.ts'), path.join(NAT, 'src', 'mediaCache.ts'),
  path.join(NAT, 'src', 'download.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const S = require(path.join(OUT, 'storage.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

// ── What may be deleted ─────────────────────────────────────────────────────

test('ONLY THIS APP\'S OWN FILES, never a neighbour\'s', () => {
  // The cache directory is shared. expo's image picker, the video decoder and
  // anything else keep working files there, and deleting one mid-use turns a
  // cleanup into a crash in a library that will not say why.
  const old = NOW - 30 * DAY;
  assert.strictEqual(S.isSweepableTemp({ name: 'tuned-1.jpg', modified: old }, NOW), true);
  assert.strictEqual(S.isSweepableTemp({ name: 'ImagePicker/xyz.jpg', modified: old }, NOW), false);
  assert.strictEqual(S.isSweepableTemp({ name: 'ExponentAsset-abc', modified: old }, NOW), false);
  assert.strictEqual(S.isSweepableTemp({ name: 'SQLite', modified: old }, NOW), false);
});

test('…and only when they are old', () => {
  // A file being written this second has the right name. Age is what
  // separates rubbish from work in progress.
  assert.strictEqual(S.isSweepableTemp({ name: 'paste-1.png', modified: NOW - 1000 }, NOW), false);
  assert.strictEqual(S.isSweepableTemp({ name: 'paste-1.png', modified: NOW - 2 * DAY }, NOW), true);
});

test('AN UNKNOWN AGE IS NOT AN OLD ONE', () => {
  // getInfoAsync returns modificationTime 0 on some Android versions, and the
  // arithmetic would date that file to 1970 — making every file with no
  // timestamp instantly sweepable, including the one being written now.
  for (const modified of [0, null, undefined, NaN, -1, 'x']) {
    assert.strictEqual(S.isSweepableTemp({ name: 'outbox-1.jpg', modified }, NOW), false,
      `a file with modified=${modified} was swept`);
  }
  assert.strictEqual(S.isSweepableTemp(null, NOW), false);
  assert.strictEqual(S.isSweepableTemp({ name: '' }, NOW), false);
});

test('A SAVED DRAFT IS NOT RUBBISH, and keeps its photo for a week', () => {
  // outbox- files are the media attached to a saved draft, and that draft
  // surviving a closed chat was itself a bug report. Sweeping one on the
  // scratch-file clock would empty a draft somebody left over a weekend.
  assert.strictEqual(S.isSweepableTemp({ name: 'outbox-1.jpg', modified: NOW - 2 * DAY }, NOW), false);
  assert.strictEqual(S.isSweepableTemp({ name: 'outbox-1.jpg', modified: NOW - 8 * DAY }, NOW), true);
  // A scratch file on the same day IS swept — the two clocks are different
  // on purpose, and a single clock would be wrong for one of them.
  assert.strictEqual(S.isSweepableTemp({ name: 'tuned-1.jpg', modified: NOW - 2 * DAY }, NOW), true);
  // Same for a video already on the phone: deleting it costs a re-download.
  assert.strictEqual(S.isSweepableTemp({ name: 'vid-abc', modified: NOW - 2 * DAY }, NOW), false);
});

// ── The update APK: forty megabytes nobody was ever going to use again ──────

test('THE APK IS DELETED ONCE THE VERSION IT HOLDS IS RUNNING', () => {
  // This is the one the user asked for by name. An install cannot report its
  // own success — it replaces the process that would report it — so the
  // evidence is the version running at the next start.
  assert.strictEqual(S.updateApkIsSpent({ downloadedVersion: 330, currentVersion: 330 }), true);
  assert.strictEqual(S.updateApkIsSpent({ downloadedVersion: 330, currentVersion: 331 }), true);
});

test('…and KEPT while it is still waiting to be installed', () => {
  // Backing out of Android's installer is easy to do by accident, and this
  // record exists precisely for that case. Deleting the file there costs a
  // forty-megabyte re-download on a connection that made resuming worth
  // building in the first place.
  assert.strictEqual(S.updateApkIsSpent({ downloadedVersion: 331, currentVersion: 330 }), false);
});

test('an unknown version deletes NOTHING', () => {
  // Wrong in the safe direction: a kept file costs disk, a deleted one costs
  // somebody their download.
  for (const o of [{}, { downloadedVersion: 330 }, { currentVersion: 330 },
                   { downloadedVersion: null, currentVersion: 330 },
                   { downloadedVersion: 330, currentVersion: 0 },
                   { downloadedVersion: 'x', currentVersion: 330 }]) {
    assert.strictEqual(S.updateApkIsSpent(o), false, JSON.stringify(o));
  }
});

// ── The cap that was never there ────────────────────────────────────────────

test('VIDEOS HAVE A CAP AT ALL', () => {
  // The heart of the 9 GB. Photos were capped at 2 GB; videos, which are two
  // orders of magnitude larger each, had no cap and were not even counted.
  assert.ok(S.VIDEO_MAX_BYTES > 0);
  assert.ok(S.VIDEO_MAX_BYTES <= 2 * 1024 * 1024 * 1024,
    'the video cap is larger than the photo cache cap, which cannot be right');
  const src = fs.readFileSync(path.join(NAT, 'src', 'storage.ts'), 'utf8');
  assert.ok(/planPrune/.test(src),
    'the videos are pruned by some second implementation of an already-tested decision');
});

test('THE TOTAL COUNTS EVERY DIRECTORY, not just the one it used to', () => {
  // The bug exactly: the profile screen read documentDirectory/media/ and
  // reported that as the app's storage. Everything else was invisible, which
  // is why a 9 GB app could say half a gigabyte with a straight face.
  const src = fs.readFileSync(path.join(NAT, 'src', 'storage.ts'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  const fn = code.slice(code.indexOf('export async function usage'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/sizeOfDir\(DOC\(\)\)/.test(body),
    'the whole document directory is not measured, so videos and covers stay invisible');
  assert.ok(/cacheOwnUsage\(\)/.test(body), 'the cache files are not counted');
  // And it recurses, or videos/ and covers/ count as zero-byte directories.
  assert.ok(/isDirectory \? await sizeOfDir/.test(code),
    'a subdirectory is counted as its own size, which is zero');
});

test('THE SCREEN ASKS THE NEW COUNTER', () => {
  // A module nothing calls is the same as no module, and this repository has
  // shipped that before.
  const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');
  const code = rooms.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/storage\.usage\(\)/.test(code),
    'the profile screen still reports one directory out of six');
  assert.ok(!/mediaCache\.usage\(\)/.test(code), 'the old partial measurement is still in use');
});

test('THE SWEEP RUNS, at start-up, with the version it needs', () => {
  const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
  const code = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/storage\.sweep\(/.test(code), 'nothing ever sweeps, so this fixes nothing');
  assert.ok(/storage\.sweep\(BUILD_VERSION\)/.test(code),
    'the sweep is not told which version is running, so it cannot know the APK is spent');
});

test('housekeeping can never be why the app does not open', async () => {
  // It runs on the path to the user's chats. Every part swallows its own
  // failure, and the stubs above make every filesystem call return nothing.
  assert.strictEqual(await S.sweep(330), 0);
  assert.strictEqual(await S.usage(), 0);
  assert.strictEqual(await S.pruneVideos(), 0);
  assert.strictEqual(await S.sweepTemp(), 0);
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
