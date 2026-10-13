// ── Why a video would not play, kept instead of discarded ──────────────────
//
// Reported twice, from both ends: a video received a moment ago will not play
// after downloading, and a video just sent will not play after uploading.
//
// The server was measured and cleared — every file on it is structurally
// complete and every chunk offset points inside the media — and the sender's
// own copy is a byte-for-byte copy of what was uploaded. The bytes are good at
// both ends. The player was the only thing left, and it was throwing the
// answer away:
//
//     onError={() => setFailed(true)}
//
// so a decoder that would not start, a file it could not read and a format it
// does not understand all produced the same sentence and nothing else.
//
// The cleaning is the part worth testing hardest. A media URL here carries a
// signature and the viewer's id in its query, ExoPlayer puts the URI it was
// reading into its message, and these reports arrive as PHOTOGRAPHS of the
// screen — so an uncleaned message would put a working credential in front of
// a camera.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping video failure tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'vidfail-'));
execFileSync(TSC, [path.join(NAT, 'src', 'videoFailure.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const { playbackReason, failureHint } = require(path.join(OUT, 'videoFailure.js'));

const PLAYER = fs.readFileSync(path.join(NAT, 'src', 'components', 'VideoPlayer.tsx'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE SIGNED URL NEVER REACHES THE SCREEN', () => {
  // The one that matters. `s` is an HMAC and `u` is the viewer's id; both are
  // live credentials, and this text is photographed.
  const r = playbackReason(
    'Source error: Unable to connect to https://chat.bistbarg.com/uploads/1760-12.mp4'
    + '?e=1760000000&s=3f8a1c9b2d4e5f60718293a4b5c6d7e8&u=ali');
  assert.ok(!/chat\.bistbarg\.com/.test(r), `the host survived: ${r}`);
  assert.ok(!/3f8a1c9b/.test(r), `the signature survived: ${r}`);
  assert.ok(!/u=ali|[?&]u=/.test(r), `the viewer id survived: ${r}`);
  assert.ok(!/https?:/.test(r), `a URL survived: ${r}`);
  // …and what is left still says what went wrong.
  assert.ok(/Source error/.test(r), `the reason itself was lost: ${r}`);
});

test('…and a LOCAL path does not either', () => {
  // A local failure carries the on-disk path, which names the app's data
  // directory and the upload's filename — a filename here is a timestamp that
  // ties a video to the moment somebody sent it.
  const r = playbackReason(
    'MediaCodecVideoRenderer error, index=0, format=video/avc, '
    + 'file:///data/user/0/com.bistbarg.chat/files/videos/vid-1760012345678-99.mp4');
  assert.ok(!/com\.bistbarg\.chat/.test(r), `the package path survived: ${r}`);
  assert.ok(!/vid-1760012345678/.test(r), `the filename survived: ${r}`);
  assert.ok(/MediaCodecVideoRenderer/.test(r), `the reason itself was lost: ${r}`);
});

test('A BARE PATH WITH NO SCHEME IS ALSO REMOVED', () => {
  // ExoPlayer does not always include the scheme.
  const r = playbackReason('Failed to open /storage/emulated/0/Movies/private-clip.mp4');
  assert.ok(!/private-clip|storage\/emulated/.test(r), `the path survived: ${r}`);
  assert.ok(/Failed to open/.test(r), `the reason itself was lost: ${r}`);
});

test('A LONG HEX RUN IS TREATED AS A SECRET WHEREVER IT SITS', () => {
  // Not every token arrives inside a URL.
  const r = playbackReason('Auth failed token=a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.ok(!/a1b2c3d4e5f60718/.test(r), `the token survived: ${r}`);
  assert.ok(/Auth failed/.test(r), `the reason itself was lost: ${r}`);
});

test('EVERY SHAPE THE ERROR ARRIVES IN IS READ', () => {
  // expo-av hands over a string here and an object there, and a React Native
  // rejection is a plain Error whose name is only ever "Error" — the message
  // is the only part worth reading.
  assert.strictEqual(playbackReason('Decoder init failed'), 'Decoder init failed');
  assert.strictEqual(playbackReason({ message: 'Decoder init failed' }), 'Decoder init failed');
  assert.strictEqual(playbackReason({ error: 'Decoder init failed' }), 'Decoder init failed');
  assert.strictEqual(playbackReason(new Error('Decoder init failed')), 'Decoder init failed');
});

test('NOTHING TO SAY IS SAID AS NOTHING', () => {
  // An empty string hides the line entirely rather than drawing a blank row
  // under "Couldn't play this video".
  for (const v of [null, undefined, '', '   ', {}, { message: '' }]) {
    assert.strictEqual(playbackReason(v), '', `${JSON.stringify(v)} produced text`);
  }
});

test('IT FITS ON A PHONE', () => {
  // ExoPlayer messages run to several hundred characters, and this is read
  // off a photograph of a screen.
  const r = playbackReason('x'.repeat(500));
  assert.ok(r.length <= 140, `too long to read: ${r.length}`);
});

test('THE HINT EXPLAINS ONLY WHAT IT ACTUALLY KNOWS', () => {
  assert.match(failureHint('MediaCodecVideoRenderer error'), /could not decode/i);
  assert.match(failureHint('Source error: unable to connect'), /could not be read/i);
  assert.match(failureHint('Unexpected end of stream'), /format it can read/i);
  // A wrong explanation is worse than none.
  assert.strictEqual(failureHint('Something nobody has seen before'), '');
  assert.strictEqual(failureHint(''), '');
});

// ── And that the player actually keeps it ───────────────────────────────────

test('THE PLAYER KEEPS THE REASON AT EVERY POINT IT ARRIVES', () => {
  // Three ways a video fails to open, and all three dropped it before.
  assert.ok(/onError=\{\(e: any\) => \{ setFailed\(true\); setReason\(playbackReason\(e\)\); \}\}/.test(PLAYER),
    'onError still throws the reason away');
  assert.ok(/if \(\(st as any\)\.error\) \{ setFailed\(true\); setReason\(playbackReason\(\(st as any\)\.error\)\); \}/.test(PLAYER),
    'a status carrying an error still throws the reason away');
  assert.ok(/setReason\('Timed out opening'\)/.test(PLAYER),
    'a video that never opens is indistinguishable from one that failed');
});

test('A REFUSAL TO START IS NOT SILENCE EITHER', () => {
  // Reported with a photograph: the video opens, shows its first frame and
  // its length — so it loaded — and tapping play does nothing at all.
  // Nothing is what it did: the rejection went into an empty catch, and a
  // player that could not begin was indistinguishable from a button that had
  // not been pressed.
  //
  // onError does not cover this. A file whose container parses and whose
  // first frame draws has already loaded; what fails afterwards fails when
  // the decoder is asked for frames, which is here.
  const fn = /const togglePlay = useCallback\(\(\) => \{([\s\S]*?)\n  \}, \[playing\]\);/.exec(PLAYER);
  assert.ok(fn, 'could not find togglePlay');
  assert.ok(!/playAsync\(\)\.catch\(\(\) => \{\}\)/.test(fn[1]),
    'a player that refuses to start still fails silently');
  assert.ok(/playAsync\(\)\.catch\(\(e: any\) => \{[\s\S]*?setReason\(playbackReason\(e\)/.test(fn[1]),
    'the reason the player gave for refusing is thrown away');
  assert.ok(/setFailed\(true\)/.test(fn[1]), 'nothing on screen says it failed');
  // A rejection with nothing to say must still say something.
  assert.ok(/\|\| 'The player refused to start'/.test(fn[1]),
    'an empty rejection shows an empty message, which is the silence again');
  // Pausing is still allowed to fail quietly: a pause that does not happen
  // leaves the video playing, which the person can see and press again.
  assert.ok(/pauseAsync\(\)\.catch\(\(\) => \{\}\)/.test(fn[1]),
    'pausing now raises an error overlay over a video that is playing fine');
});

test('…AND SHOWS IT', () => {
  // Kept and not displayed would be the same bug one step further on.
  assert.ok(/\{!!reason && <Text style=\{s\.failReason\}>\{reason\}<\/Text>\}/.test(PLAYER),
    'the reason is kept and never shown');
  assert.ok(/failReason: \{/.test(PLAYER), 'the reason has no style, so it is invisible');
});

test('…AND FORGETS IT WHEN A DIFFERENT VIDEO OPENS', () => {
  // Otherwise the last failure is shown over the next video, which is a
  // report of a bug that is not happening.
  const reset = /setPosition\(0\); setDuration\(0\); setPlayableMs\(0\); setAttempt\(0\);([\s\S]*?)\n  \}, \[item\?\.url\]\);/.exec(PLAYER);
  assert.ok(reset, 'could not find the per-video reset');
  assert.ok(/setReason\(''\)/.test(reset[1]),
    'a stale reason survives into the next video');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
