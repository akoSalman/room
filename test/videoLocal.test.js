// ── A video the app was sure it had ────────────────────────────────────────
//
// Reported with a photograph of the player: an uploaded video will not play.
// The player said "Saved on this device" and showed the file's length, and
// tapping play did nothing. Then, plainly: "it seems it's because the video is
// not downloaded".
//
// Both were true. localUri returned the remembered path the moment its state
// said "done", and checked the disk only on the FIRST ask — so a file that
// went away afterwards left the app certain it still had it, handing the
// player a file:// path to nothing. "Saved on this device" is computed from
// that path starting with file://, so the label was loyally reporting a lie.
//
// Things do take the file away. A phone short of space reclaims; the cleaners
// these devices ship with get used; and this app's own startup sweep caps the
// video directory. None of that reaches a Map that lives as long as the
// process.
//
// The module is RUN here against a fake filesystem, not read: the whole bug is
// a decision about when to believe something, and a test that greps for the
// check cannot tell whether the check is reached.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping video local tests (native-app deps not installed)');
  process.exit(0);
}

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'videolocal-'));
execFileSync(TSC, [
  path.join(NAT, 'src', 'videoDownloads.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop',
], { stdio: 'pipe' });

// ── A filesystem this test owns ─────────────────────────────────────────────
//
// Only the handful of calls videoDownloads makes, and `files` is the disk:
// deleting a key here is a phone reclaiming space.
const files = new Map();
const unreadable = new Set();
const fakeFs = {
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  makeDirectoryAsync: async () => {},
  async getInfoAsync(uri) {
    // A path the filesystem refuses to answer about. Storage that has been
    // unmounted, or a file the app has lost permission to — rarer than a
    // deletion and the same thing as far as playing it goes.
    if (unreadable.has(uri)) throw new Error('EACCES');
    const size = files.get(uri);
    return size === undefined ? { exists: false } : { exists: true, size, uri };
  },
  async copyAsync({ from, to }) {
    const size = files.get(from);
    if (size === undefined) throw new Error('no such file');
    files.set(to, size);
  },
  async deleteAsync(uri) { files.delete(uri); },
  async moveAsync({ from, to }) {
    const size = files.get(from);
    if (size === undefined) throw new Error('no such file');
    files.delete(from); files.set(to, size);
  },
  createDownloadResumable() { throw new Error('not used in this test'); },
};

// Hand the compiled module our filesystem in place of the real one.
const shim = path.join(OUT, 'node_modules', 'expo-file-system');
fs.mkdirSync(shim, { recursive: true });
fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ name: 'expo-file-system', main: 'index.js' }));
fs.writeFileSync(path.join(shim, 'index.js'), `module.exports = global.__fakeFs;`);
global.__fakeFs = fakeFs;
// Its siblings are compiled beside it by the same tsc call? No — compile them.
execFileSync(TSC, [
  path.join(NAT, 'src', 'download.ts'), path.join(NAT, 'src', 'saveProgress.ts'),
  path.join(NAT, 'src', 'mediaSource.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop',
], { stdio: 'pipe' });

const vd = require(path.join(OUT, 'videoDownloads.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const URL = 'https://chat.bistbarg.com/uploads/1760-12.MOV?e=1&s=ab&u=ali';
const DEST = `file:///doc/videos/${vd.keyFor(URL)}`;

function reset() {
  files.clear();
  unreadable.clear();
  // A fresh module state between cases, through the module's own door.
  return vd.remove(URL).catch(() => {});
}

test('THE BUG: a file that has gone is no longer reported as held', () => {
  // The app is sure it has the video because it put it there itself, and
  // something else removed it afterwards. Nothing tells the app.
  return reset()
    .then(() => { files.set('file:///tmp/sent.MOV', 1234); })
    .then(() => vd.adopt('file:///tmp/sent.MOV', URL))
    .then(ok => {
      assert.strictEqual(ok, true, 'the sender\'s own copy was not adopted at all');
      return vd.localUri(URL);
    })
    .then(uri => {
      assert.strictEqual(uri, DEST, 'the adopted copy is not reported as held');
      // The phone reclaims it. The app is told nothing.
      files.delete(DEST);
      return vd.localUri(URL);
    })
    .then(uri => {
      assert.strictEqual(uri, null,
        'the app still reports a file that is gone — the player is handed a file:// path to nothing, which is "Saved on this device" and no playback');
    });
});

test('…and the tile goes back to offering the download', () => {
  // The other half: forgetting it is what puts the download button back,
  // rather than leaving a tile that claims to be ready and is not.
  return reset()
    .then(() => { files.set('file:///tmp/sent.MOV', 99); })
    .then(() => vd.adopt('file:///tmp/sent.MOV', URL))
    .then(() => vd.localUri(URL))
    .then(() => {
      assert.ok(vd.get(URL), 'nothing was recorded in the first place');
      files.delete(DEST);
      return vd.localUri(URL);
    })
    .then(() => {
      assert.strictEqual(vd.get(URL), null,
        'the state still says the video is downloaded, so the bubble offers to play nothing');
    });
});

test('A FILE THAT IS STILL THERE IS STILL REPORTED', () => {
  // The opposite mistake: making every video re-download because the check
  // is too eager.
  return reset()
    .then(() => { files.set('file:///tmp/sent.MOV', 4321); })
    .then(() => vd.adopt('file:///tmp/sent.MOV', URL))
    .then(() => vd.localUri(URL))
    .then(() => vd.localUri(URL))
    .then(uri => assert.strictEqual(uri, DEST, 'a video that is present is reported as missing'));
});

test('AN EMPTY FILE IS NOT A VIDEO', () => {
  // What an interrupted copy leaves behind. It exists, so existence alone
  // would keep saying yes to something no player can open.
  return reset()
    .then(() => { files.set('file:///tmp/sent.MOV', 500); })
    .then(() => vd.adopt('file:///tmp/sent.MOV', URL))
    .then(() => vd.localUri(URL))
    .then(() => { files.set(DEST, 0); return vd.localUri(URL); })
    .then(uri => assert.strictEqual(uri, null, 'a zero-byte file is reported as a downloaded video'));
});

test('A FILE THE PHONE WILL NOT ANSWER ABOUT IS NOT HELD', () => {
  // Unreadable is the same as absent for every purpose here: the player would
  // be handed a path it also cannot read. Treating the refusal as "still
  // there" is the original bug by another route.
  return reset()
    .then(() => { files.set('file:///tmp/sent.MOV', 777); })
    .then(() => vd.adopt('file:///tmp/sent.MOV', URL))
    .then(() => vd.localUri(URL))
    .then(() => { unreadable.add(DEST); return vd.localUri(URL); })
    .then(uri => assert.strictEqual(uri, null,
      'a file the filesystem refuses to describe is reported as a downloaded video'));
});

test('ADOPTING NOTHING IS NOT ADOPTING', () => {
  // The sender's copy is the whole point of adopt; a copy that failed must
  // not leave the state saying it worked.
  return reset()
    .then(() => vd.adopt('file:///tmp/missing.MOV', URL))
    .then(ok => {
      assert.strictEqual(ok, false, 'a file that could not be copied was adopted anyway');
      return vd.localUri(URL);
    })
    .then(uri => assert.strictEqual(uri, null, 'a failed adoption still reports a local copy'));
});

(async () => {
  let passed = 0, failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
