// Receiving a file in a chat — and an APK in particular.
//
// Reported as: an APK sent in a chat had no download on the message for the
// person receiving it, and tapping the file said "error opening file". It
// should download like other files and install when tapped.
//
// Three faults, and only one of them is about APKs:
//
//   1. NOTHING DOWNLOADED IT. A file bubble was one "tap to open" card. Every
//      tap fetched the file into the app's cache invisibly — no button, no
//      progress, no evidence it had worked. On these connections a 40 MB APK
//      is minutes of a card that looks inert. Videos have had a download
//      button with progress for months; file messages never got one.
//
//   2. AN APK IS NOT OPENED, IT IS INSTALLED. The card fired a VIEW intent at
//      the APK's mime type. Nothing on Android answers that usefully:
//      installing is ACTION_INSTALL_PACKAGE, which this app already uses for
//      its own updates. VIEW made the package installer appear and fail —
//      "error opening file".
//
//   3. AND THE FAILURE MESSAGE SENT PEOPLE THE WRONG WAY. Android blocks an
//      app from installing another app until "Install unknown apps" is allowed
//      for it. "No app on this device can open this file type" sent people
//      looking for an app instead of for that switch.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping file-open tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'fileopen-'));
execFileSync(TSC, [path.join(NAT, 'src', 'fileOpen.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const F = require(path.join(OUT, 'fileOpen.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Which files are apps ────────────────────────────────────────────────────

test('an APK is recognised by name and by mime type', () => {
  assert.strictEqual(F.isApk('ChatRoom-1.4.apk'), true);
  assert.strictEqual(F.isApk('ChatRoom.APK'), true, 'the extension is case sensitive');
  assert.strictEqual(F.isApk('x', 'application/vnd.android.package-archive'), true);
  // The server signs media URLs, so the name arrives with a query on it.
  assert.strictEqual(F.isApk('app.apk?e=123&s=abc'), true);
});

test('and nothing else is', () => {
  for (const n of ['report.pdf', 'song.mp3', 'apk', 'apk.zip', 'not-an-apk.txt', '', null]) {
    assert.strictEqual(F.isApk(n), false, String(n));
  }
  assert.strictEqual(F.kindOf('report.pdf'), 'document');
  assert.strictEqual(F.kindOf('app.apk'), 'apk');
});

// ── What a tap does ─────────────────────────────────────────────────────────

test('THE BUG: the first tap DOWNLOADS, visibly', () => {
  // It used to fetch the file inside "open", with nothing on screen saying so.
  assert.strictEqual(F.tapAction({ kind: 'apk', downloaded: false, downloading: false }), 'download');
  assert.strictEqual(F.tapAction({ kind: 'document', downloaded: false, downloading: false }), 'download');
});

test('THE OTHER BUG: a downloaded APK is INSTALLED, not opened', () => {
  assert.strictEqual(F.tapAction({ kind: 'apk', downloaded: true, downloading: false }), 'install');
  assert.strictEqual(F.tapAction({ kind: 'document', downloaded: true, downloading: false }), 'open');
});

test('a second tap while it is downloading does not start it again', () => {
  // Which is exactly what happens when a card gives no sign of working.
  for (const kind of ['apk', 'document']) {
    assert.strictEqual(F.tapAction({ kind, downloaded: false, downloading: true }), 'wait');
    assert.strictEqual(F.tapAction({ kind, downloaded: true, downloading: true }), 'wait');
  }
});

// ── What the card says ──────────────────────────────────────────────────────

test('the card says what the next tap will do', () => {
  assert.strictEqual(
    F.cardMeta({ kind: 'apk', ext: 'apk', downloaded: false, downloading: false }),
    'APK · tap to download');
  assert.strictEqual(
    F.cardMeta({ kind: 'apk', ext: 'apk', downloaded: true, downloading: false }),
    'APK · tap to install');
  assert.strictEqual(
    F.cardMeta({ kind: 'document', ext: 'pdf', downloaded: true, downloading: false }),
    'PDF · tap to open');
});

test('and while it downloads it says how far it has got', () => {
  assert.strictEqual(
    F.cardMeta({ kind: 'apk', ext: 'apk', downloaded: false, downloading: true, percent: 42.4 }),
    'Downloading… 42%');
  // Before the server has said how big the file is there is no percentage to
  // show, and "Downloading… 0%" reads as stuck.
  assert.strictEqual(
    F.cardMeta({ kind: 'apk', ext: 'apk', downloaded: false, downloading: true, percent: 0 }),
    'Downloading…');
});

test('a failed download offers another go rather than going quiet', () => {
  assert.strictEqual(
    F.cardMeta({ kind: 'document', ext: 'zip', downloaded: false, downloading: false, failed: true }),
    'Download failed — tap to try again');
});

test('a file still being SENT says so, and offers nothing', () => {
  assert.strictEqual(
    F.cardMeta({ kind: 'apk', ext: 'apk', downloaded: false, downloading: false, uploading: true }),
    'Uploading…');
  assert.strictEqual(
    F.showsDownloadButton({ downloaded: false, downloading: false, uploading: true }), false,
    'the sender was offered a download of their own file');
});

test('a file with no extension still gets a sensible line', () => {
  assert.strictEqual(
    F.cardMeta({ kind: 'document', ext: '', downloaded: false, downloading: false }),
    'FILE · tap to download');
});

test('THE MISSING BUTTON is there, and only where it means something', () => {
  assert.strictEqual(F.showsDownloadButton({ downloaded: false, downloading: false }), true);
  assert.strictEqual(F.showsDownloadButton({ downloaded: true, downloading: false }), false,
    'a file already on the device still offers to download it');
  assert.strictEqual(F.showsDownloadButton({ downloaded: false, downloading: true }), false,
    'the button stays under a running download');
});

// ── What it says when it cannot ─────────────────────────────────────────────

test('a refused install names the switch that has to be turned on', () => {
  const h = F.installHelp();
  assert.ok(/install unknown apps/i.test(h.message), h.message);
  assert.ok(/settings/i.test(h.message), 'it does not say where to look');
  assert.ok(!/no app/i.test(h.message), 'it still sends people looking for an app to install with');
});

test('a document nothing can open says the file is at least downloaded', () => {
  const h = F.openHelp('xyz');
  assert.ok(/\.xyz/.test(h.message), h.message);
  assert.ok(/downloaded/.test(h.message), 'the person is left thinking the download failed too');
  assert.ok(F.openHelp('').message.length > 0);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('the file card has a download button and a progress line', () => {
  assert.ok(chat.includes('showsDownloadButton({'), 'the card decides for itself, or not at all');
  assert.ok(/name="download-outline"/.test(chat), 'there is still nothing to tap');
  assert.ok(chat.includes('cardMeta({'), 'the line under the name is hand-written again');
  assert.ok(/percent: dl \? progressPercent\(dl\.written, dl\.total\) : 0/.test(chat),
    'the card cannot say how far the download has got');
});

test('the card redraws as the download moves', () => {
  // Without this it would say "Downloading…" until something else happened to
  // re-render the list.
  assert.ok(/useEffect\(\(\) => attachments\.subscribe\(bumpDownloads\), \[\]\)/.test(chat),
    'nothing subscribes to the download store');
  assert.ok(chat.includes('function noteFileOnDisk('),
    'a file downloaded before this run is offered for download again');
});

test('an APK goes to the package INSTALLER', () => {
  const fn = chat.slice(chat.indexOf('async function openFile('), chat.indexOf('// Send a received file out'));
  assert.ok(fn.length > 0, 'openFile is gone — this check would be vacuous');
  assert.ok(fn.includes("'android.intent.action.INSTALL_PACKAGE'"),
    'an APK is still opened with a VIEW intent, which is the reported error');
  assert.ok(fn.includes("'android.intent.action.VIEW'"), 'ordinary documents lost their viewer');
  assert.ok(/\.\.\.\(action === 'install' \? \{\} : \{ type: guessMime\(name, null\) \}\)/.test(fn),
    'the install intent carries a mime type, which the installer refuses');
});

test('the tap is decided by the rule, not by the card', () => {
  const fn = chat.slice(chat.indexOf('async function openFile('), chat.indexOf('// Send a received file out'));
  assert.ok(fn.includes('fileTapAction({'), 'openFile decides for itself what a tap means');
  assert.ok(/if \(action === 'wait'\) return;/.test(fn), 'a second tap starts a second download');
  assert.ok(/if \(action === 'download'\)/.test(fn), 'the download is not a step of its own');
  assert.ok(fn.includes('installHelp()'), 'a refused install still says "no app can open this"');
});

test('the permission the installer needs is declared', () => {
  const appJson = fs.readFileSync(path.join(NAT, 'app.json'), 'utf8');
  assert.ok(appJson.includes('android.permission.REQUEST_INSTALL_PACKAGES'),
    'Android will refuse every install, whatever intent is used');
});

test('one-time files are still not openable', () => {
  const fn = chat.slice(chat.indexOf('async function openFile('), chat.indexOf('// Send a received file out'));
  assert.ok(/msg\.one_time_seconds/.test(fn), 'a one-time file can now be downloaded and kept');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
