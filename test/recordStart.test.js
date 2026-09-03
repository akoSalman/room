// The first second of a voice message.
//
// Reported as: sometimes, on tapping record, the first second or two is empty
// and not recorded.
//
// The audio is not being dropped. The app said "recording" before it was, and
// people quite reasonably started talking. Between the tap and the first
// captured sample sit a permission read, an audio-session switch and building
// an encoder — comfortably one to two seconds on a mid-range Android phone
// with something else holding audio focus — and the bar with its pulsing red
// dot was on screen for all of it.
//
// An earlier attempt moved the TIMER to start after the recorder does. That
// made the displayed duration honest and changed nothing about the gap, because
// what people react to is the bar appearing, not the digits changing.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping record-start tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'recstart-'));
execFileSync(TSC, [path.join(NAT, 'src', 'recordStart.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const R = require(path.join(OUT, 'recordStart.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Not lying about being ready ─────────────────────────────────────────────

test('THE BUG: the bar does not say "recording" while the microphone is opening', () => {
  // This is the whole report. Everything else here is a consequence.
  const phase = R.phaseFor({ started: false, isRecording: false, paused: false, stopped: false });
  assert.strictEqual(phase, 'starting');
  assert.strictEqual(R.showsLiveUi(phase), false,
    'a pulsing dot and a running clock were shown before anything was being captured');
});

test('and it is the RECORDER that says when it is, not the app', () => {
  // startAsync() resolving is not the same as the microphone capturing: on a
  // device that refused it, it can resolve on a recorder that never begins.
  assert.strictEqual(
    R.phaseFor({ started: true, isRecording: false, paused: false, stopped: false }), 'starting',
    'the app decided it was recording because it had asked to be');
  assert.strictEqual(
    R.phaseFor({ started: true, isRecording: true, paused: false, stopped: false }), 'recording');
});

test('once it is really recording, the live bar appears', () => {
  assert.strictEqual(R.showsLiveUi('recording'), true);
  assert.strictEqual(R.showsLiveUi('paused'), true, 'a paused recording hides its own waveform');
  assert.strictEqual(R.showsLiveUi('starting'), false);
  assert.strictEqual(R.showsLiveUi('idle'), false);
  assert.strictEqual(R.showsLiveUi('preview'), false);
});

test('pausing and stopping outrank the rest', () => {
  assert.strictEqual(R.phaseFor({ started: true, isRecording: true, paused: true, stopped: false }), 'paused');
  assert.strictEqual(R.phaseFor({ started: true, isRecording: false, paused: false, stopped: true }), 'preview');
  // A pause that arrives while stopping does not resurrect the recording bar.
  assert.strictEqual(R.phaseFor({ started: true, isRecording: true, paused: true, stopped: true }), 'preview');
});

test('the send button cannot stop a recording that has not started', () => {
  // Stopping there writes a file with no audio in it — the reported bug
  // wearing its shortest coat.
  assert.strictEqual(R.canStop('starting'), false);
  assert.strictEqual(R.canStop('idle'), false);
  assert.strictEqual(R.canStop('recording'), true);
  assert.strictEqual(R.canStop('paused'), true);
  assert.strictEqual(R.canStop('preview'), false);
});

// ── An honest clock ─────────────────────────────────────────────────────────

test('the time shown is the recorder\'s own duration, not a counted interval', () => {
  assert.strictEqual(R.elapsedSeconds(0), 0);
  assert.strictEqual(R.elapsedSeconds(999), 0);
  assert.strictEqual(R.elapsedSeconds(1000), 1);
  assert.strictEqual(R.elapsedSeconds(61_400), 61);
});

test('a missing or nonsense duration reads as zero, not NaN', () => {
  for (const v of [null, undefined, NaN, -5, 'abc']) {
    assert.strictEqual(R.elapsedSeconds(v), 0, String(v));
  }
});

// ── Warming up ──────────────────────────────────────────────────────────────

test('THE OTHER HALF: the microphone is opened while the finger is still down', () => {
  // The slow work does not depend on the user having decided to speak yet.
  assert.strictEqual(R.shouldWarm({ target: 'mic', alreadyWarm: false, recording: false }), true);
});

test('…but not twice, and not while already recording', () => {
  assert.strictEqual(R.shouldWarm({ target: 'mic', alreadyWarm: true, recording: false }), false);
  assert.strictEqual(R.shouldWarm({ target: 'mic', alreadyWarm: false, recording: true }), false,
    'a second microphone was opened underneath a running recording');
});

test('and never for a touch that was not going to record', () => {
  // Taking the microphone from a call because somebody brushed Send would be a
  // worse bug than the one being fixed.
  assert.strictEqual(R.shouldWarm({ target: 'send', alreadyWarm: false, recording: false }), false);
  assert.strictEqual(R.shouldWarm({ target: 'other', alreadyWarm: false, recording: false }), false);
});

test('a microphone opened for a tap that never came is given back', () => {
  const now = 1_000_000;
  assert.strictEqual(R.warmStillGood({ preparedAt: now - 1000, now }), true);
  assert.strictEqual(R.warmStillGood({ preparedAt: now - 30_000, now }), false,
    'a prepared recorder held the microphone open indefinitely');
  assert.strictEqual(R.warmStillGood({ preparedAt: null, now }), false);
  assert.strictEqual(R.warmStillGood({ preparedAt: now + 1000, now }), false);
  assert.ok(R.WARM_TTL_MS <= 15_000, 'the microphone is held open for far too long after a stray touch');
  assert.ok(R.WARM_TTL_MS >= 3_000, 'the warm-up expires before a normal tap could use it');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const rec = fs.readFileSync(path.join(NAT, 'src', 'components', 'VoiceRecorder.tsx'), 'utf8');
const helper = fs.readFileSync(path.join(NAT, 'src', 'voiceRecorder.ts'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const composer = fs.readFileSync(path.join(NAT, 'src', 'components', 'Composer.tsx'), 'utf8');

test('the bar draws what the recorder reports', () => {
  assert.ok(/const phase = phaseFor\(\{ started, isRecording: live, paused, stopped \}\)/.test(rec),
    'the bar keeps its own idea of whether it is recording');
  assert.ok(/setLive\(!!st\.isRecording\)/.test(rec),
    'nothing ever asks the recorder whether it is actually capturing');
  assert.ok(/readyToSpeak \? \(/.test(rec), 'the live bar is drawn in every phase');
  assert.ok(rec.includes('Starting…'), 'the starting state says nothing at all');
});

test('the clock comes from the recording, not from setInterval', () => {
  assert.ok(rec.includes('setSeconds(elapsedSeconds(st.durationMillis))'),
    'the timer counts wall-clock seconds again, which drifts from the audio');
  assert.ok(!/setInterval\(\(\) => setSeconds/.test(rec), 'the old counting interval is back');
});

test('the send button is inert until there is something to send', () => {
  assert.ok(/if \(!canStop\(phase\) \|\| !recordingRef\.current\) return;/.test(rec),
    'stopping while starting still writes an empty voice message');
  assert.ok(/disabled=\{!readyToSpeak\}/.test(rec), 'the send button is tappable while the mic is opening');
});

test('the microphone starts opening on the press-in, not on the tap', () => {
  assert.ok(/onPressIn=\{onRecordPressIn\}/.test(composer), 'the mic button warms nothing');
  assert.ok(/onRecordPressIn=\{warmMic\}/.test(chat), 'the chat never asks for a warm-up');
  const fn = chat.slice(chat.indexOf('function warmMic()'), chat.indexOf('const warmTimer'));
  assert.ok(fn.includes('shouldWarm({'), 'the warm-up is decided by hand rather than by the rule');
  assert.ok(fn.includes('voiceRecorder.warmUp()'), 'nothing is actually warmed up');
  assert.ok(fn.includes('audioManager.stop()'), 'the mic is opened over playing audio');
  assert.ok(/warmTimer\.current = setTimeout/.test(fn), 'a microphone opened for nothing is never released');
});

test('a warm-up nobody used is released, and a used one is not', () => {
  const fn = chat.slice(chat.indexOf('function warmMic()'), chat.indexOf('const warmTimer'));
  assert.ok(/if \(!recordingRef\.current\) voiceRecorder\.cool\(\)/.test(fn),
    'the release can fire underneath a recording that has since started');
  assert.ok(/clearTimeout\(warmTimer\.current\);\s*\n\s*recordingRef\.current = true;/.test(chat),
    'starting to record does not cancel the release timer');
});

test('the helper hands over a recorder that has actually started', () => {
  const begin = helper.slice(helper.indexOf('export async function begin'), helper.indexOf('export async function releaseSession'));
  assert.ok(begin.includes('await rec.startAsync()'), 'begin() returns before starting');
  assert.ok(/warmStillGood\(\{ preparedAt: warmAt, now \}\)/.test(begin),
    'a stale warm-up is started anyway, having held the mic for who knows how long');
  // `releaseHeld()`, which cool() now delegates to as well: it unloads
  // whatever recorder exists — a stale warm-up, or one left behind by a failed
  // attempt, which is the thing that used to poison every later recording.
  assert.ok(begin.includes('await releaseHeld()'), 'a stale recorder is left holding the microphone');
  assert.ok(begin.includes('prepareToRecordAsync'), 'a cold start cannot record at all');
});

test('warming up never asks for permission on a press-in', () => {
  // A permission dialog thrown up by a finger landing on a button, before the
  // tap has even completed, would be its own bug.
  const warm = helper.slice(helper.indexOf('export async function warmUp'), helper.indexOf('export function isWarm'));
  assert.ok(warm.includes('if (!(await hasPermission())) return;'), 'a press-in can raise a permission dialog');
  assert.ok(!warm.includes('requestPermissionsAsync'), 'the warm-up asks for permission');
  assert.ok(rec.includes('requestPermissionsAsync'), 'nothing ever asks for microphone permission');
});

test('the audio session is handed back however the recording ends', () => {
  // Through finish(), which releases expo-av's single recording slot AND the
  // audio session: releasing only the session left a prepared recorder behind,
  // and every later recording then failed until the app was restarted.
  const uses = rec.match(/recorder\.finish\(\)/g) || [];
  assert.ok(uses.length >= 2, 'only one of stop and cancel gives the recorder back');
  const fin = helper.slice(helper.indexOf('export async function finish('), helper.length);
  assert.ok(/releaseHeld\(\)/.test(fin) && /releaseSession\(\)/.test(fin),
    'finish() does not release both the recorder and the session');
  assert.ok(helper.includes('allowsRecordingIOS: false'), 'the playback mode is gone');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
