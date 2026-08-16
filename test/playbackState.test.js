// Tests for how a player state becomes UI state (native-app/src/playbackState.ts).
//
// This exists because of a bug that could not be caught by looking at the
// code on a device: a voice message would play audibly while its bubble still
// showed ▶. Both causes were the same mistake — believing a state seen during
// start-up — and both are asserted here.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pbtest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'playbackState.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping playback-state tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const P = require(path.join(OUT, 'playbackState.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const settled = (s) => P.playbackFlags(s, false);
const starting = (s) => P.playbackFlags(s, true);

test('playing means playing', () => {
  assert.deepStrictEqual(settled('playing'), { playing: true, loading: false, clearCurrent: false });
});

test('paused is not playing, and does not end the session', () => {
  assert.deepStrictEqual(settled('paused'), { playing: false, loading: false, clearCurrent: false });
});

test('buffering and loading show a spinner, not a stopped player', () => {
  for (const s of ['buffering', 'loading', 'connecting']) {
    const f = settled(s);
    assert.strictEqual(f.loading, true, `${s} did not read as loading`);
    assert.strictEqual(f.playing, false);
    assert.strictEqual(f.clearCurrent, false, `${s} wrongly ended the session`);
  }
});

test('BUG 1: our own reset during start-up must not end the session', () => {
  // Starting a track calls TrackPlayer.reset(), which the service reports as
  // Stopped/None. Believing it meant the app forgot which message was playing
  // a moment before it started playing it — and the bubble showed ▶.
  for (const s of ['none', 'stopped']) {
    assert.strictEqual(starting(s).clearCurrent, false,
      `${s} during start-up was treated as the user pressing Stop`);
  }
});

test('a stop we did NOT cause does end the session', () => {
  // Stop pressed in the notification shade, with no start-up in flight.
  for (const s of ['none', 'stopped']) {
    assert.strictEqual(settled(s).clearCurrent, true,
      `${s} left the app claiming to still be playing something`);
  }
});

test('BUG 2: Ready right after play() reads as still starting, not as stopped', () => {
  // The player normally reports Ready or Buffering immediately after play().
  // Writing that in as "not playing" left the icon on ▶ with nothing further
  // arriving to correct it.
  const f = starting('ready');
  assert.strictEqual(f.loading, true, 'Ready during start-up did not show as loading');
  assert.strictEqual(f.clearCurrent, false);
});

test('a real Playing seen during start-up is believed immediately', () => {
  // Start-up suppresses transient states, but must never suppress the answer
  // we are waiting for — otherwise the spinner outlives the audio.
  assert.deepStrictEqual(starting('playing'), { playing: true, loading: false, clearCurrent: false });
});

test('pausing during start-up is believed too', () => {
  const f = starting('paused');
  assert.strictEqual(f.playing, false);
  assert.strictEqual(f.loading, false, 'a pause was hidden behind a spinner');
});

test('ended stops playback without ending the session', () => {
  // The track is finished but still loaded, so the player should not vanish.
  const f = settled('ended');
  assert.strictEqual(f.playing, false);
  assert.strictEqual(f.clearCurrent, false);
  assert.strictEqual(starting('ended').loading, false);
});

test('an error clears the spinner instead of hanging on it', () => {
  // A stuck spinner disables the play button, so a failed load would leave the
  // message permanently unplayable.
  for (const inStartup of [true, false]) {
    const f = P.playbackFlags('error', inStartup);
    assert.strictEqual(f.loading, false, 'error left the button spinning');
    assert.strictEqual(f.playing, false);
    assert.strictEqual(f.clearCurrent, false);
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
