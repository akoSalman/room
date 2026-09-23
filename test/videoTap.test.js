// ── The download button that would not go away ──────────────────────────────
//
// "when tapping play video that is not downloaded it will download and play
// but when closing video the download button is still there and it's marked as
// new not downloaded video."
//
// Both halves were true. Tapping the tile STREAMED the video and kept nothing
// — a deliberate choice, written at the top of VideoBubble.tsx: "Streaming
// still works without downloading… The button is for keeping it." So the bytes
// went, the video played, and the tile went straight back to offering a
// download of the thing that had just been watched. On every rewatch.
//
// For somebody on a metered connection that is the wrong trade twice over, so
// a tap now downloads, and opens the player by itself when the file is there.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping video-tap tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'vtap-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'download.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const D = require(path.join(OUT, 'download.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('A VIDEO ON THE PHONE PLAYS FROM THE PHONE', () => {
  assert.strictEqual(D.videoTapAction({ status: 'done', hasFile: true }), 'play-local');
});

test('THE BUG: one that is not, is fetched rather than streamed away', () => {
  assert.strictEqual(D.videoTapAction({ status: undefined, hasFile: false }), 'start-download');
  assert.strictEqual(D.videoTapAction({ status: 'failed', hasFile: false }), 'start-download');
  assert.strictEqual(D.videoTapAction({}), 'start-download');
  assert.strictEqual(D.videoTapAction(), 'start-download');
});

test('"done" WITH NO FILE IS NOT DONE', () => {
  // A record of a download whose file the OS has since reclaimed. Playing it
  // opens a player on a path that is not there.
  assert.strictEqual(D.videoTapAction({ status: 'done', hasFile: false }), 'start-download');
});

test('tapping twice does not start it twice', () => {
  // The second tap is somebody checking whether the first one registered, not
  // a request for a second download of the same file.
  assert.strictEqual(D.videoTapAction({ status: 'downloading' }), 'wait');
  assert.strictEqual(D.videoTapAction({ status: 'paused' }), 'wait');
});

test('THE PLAYER OPENS ITSELF, but only for whoever asked', () => {
  // The whole point: a tap ends in a video playing, not in a progress bar the
  // user has to come back to.
  assert.strictEqual(D.shouldAutoOpen({ waiting: true, status: 'done', hasFile: true }), true);
  // Not for a download nobody is waiting on — yanking somebody into a player
  // while they are reading something else is worse than making them tap.
  assert.strictEqual(D.shouldAutoOpen({ waiting: false, status: 'done', hasFile: true }), false);
  // Not until it is actually finished, and not on a record with no file.
  assert.strictEqual(D.shouldAutoOpen({ waiting: true, status: 'downloading' }), false);
  assert.strictEqual(D.shouldAutoOpen({ waiting: true, status: 'failed' }), false);
  assert.strictEqual(D.shouldAutoOpen({ waiting: true, status: 'done', hasFile: false }), false);
  assert.strictEqual(D.shouldAutoOpen({}), false);
  assert.strictEqual(D.shouldAutoOpen(), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('THE TILE USES THEM, and stops streaming what it will not keep', () => {
  const src = fs.readFileSync(path.join(NAT, 'src', 'components', 'VideoBubble.tsx'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(/videoTapAction\(/.test(code), 'the tap still decides for itself what to do');
  assert.ok(/shouldAutoOpen\(/.test(code), 'a finished download never opens the player');
  assert.ok(/downloads\.start\(url\)/.test(code), 'a tap on an unsaved video fetches nothing');

  const i = code.indexOf('function play()');
  const body = code.slice(i, code.indexOf('\n  }', i));
  // The old line, exactly: onOpen(… ? dl.uri : url) — the `: url` is the
  // stream-and-keep-nothing path this was reported for.
  assert.ok(!/onOpen\([^)]*:\s*url\)/.test(body),
    'tapping still falls back to streaming the remote url, keeping nothing');
});

test('…and leaving the chat does not drag you into a player later', () => {
  // A download still running when the screen goes away must not open a video
  // over whatever the user moved on to.
  const src = fs.readFileSync(path.join(NAT, 'src', 'components', 'VideoBubble.tsx'), 'utf8');
  assert.ok(/useEffect\(\(\) => \(\) => setWaiting\(false\), \[url\]\)/.test(src),
    'the waiting flag outlives the tile that set it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
