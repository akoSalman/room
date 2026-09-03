// Two things the app kept doing that only closing it would fix.
//
//   1. "A lot of times, while microphone permission is granted, I still get
//      that error while recording voice, and I should close and reopen the app
//      to solve it." — with a photo of "Recording Error: Could not start
//      recording. Please check microphone permissions in Settings."
//
//      That message was wrong, and its wrongness is the whole report: the
//      permission WAS granted. expo-av allows exactly ONE Audio.Recording to
//      be prepared at a time, and the flag saying one exists lives in the
//      library's module state. A recorder that is prepared and then LOST — its
//      start threw, the screen was left mid-preparation, a warm-up whose owner
//      went away — makes every later recording fail, forever, with an error
//      that names no cause. Killing the app clears the module state, which is
//      exactly what people worked out for themselves.
//
//   2. "Still while swiping and closing that voice player, it appears on
//      mobile as [a notification]." — a media notification for a voice message
//      left in the shade after the player was closed.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping recorder-slot tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'recslot-'));
execFileSync(TSC, [path.join(NAT, 'src', 'recordStart.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const R = require(path.join(OUT, 'recordStart.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── What the failure is actually called ─────────────────────────────────────

test('THE BUG: a granted microphone is never blamed for the failure', () => {
  // The dialog in the photo said "check microphone permissions in Settings"
  // to somebody who had already granted them — so they went to a setting that
  // was already correct, found nothing, and restarted the app.
  const kind = R.classifyStartFailure({
    granted: true, message: 'Only one Recording object can be prepared at a given time',
  });
  // 'self', not 'busy'. This is expo-av's OWN slot, taken by this app — the
  // second wrong message shipped for this failure told people a call or
  // another app was using the microphone, which was just as untrue as the
  // permission screen and just as impossible to act on.
  assert.strictEqual(kind, 'self');
  const text = R.startFailureText(kind);
  assert.ok(!/permission/i.test(text), 'it still sends them to the permission screen');
  assert.ok(!/settings/i.test(text), 'it still sends them to Settings');
  assert.ok(!/another app|a call/i.test(text), 'it still blames something the user cannot see');
  assert.ok(/try again/i.test(text), text);
});

test('…and a missing one still is', () => {
  const kind = R.classifyStartFailure({ granted: false, message: 'whatever' });
  assert.strictEqual(kind, 'permission');
  assert.ok(/microphone/i.test(R.startFailureText(kind)));
  assert.ok(/settings/i.test(R.startFailureText(kind)), 'it does not say where to fix it');
});

test('this app fighting itself is told apart from the phone being busy', () => {
  // The two need different words because they need different actions: one is
  // fixed by tapping again, the other by ending whatever else is recording.
  for (const m of [
    'Only one Recording object can be prepared at a given time',
    'Recorder is already prepared',
    'Failed to prepare recorder',
  ]) {
    assert.strictEqual(R.classifyStartFailure({ granted: true, message: m }), 'self', m);
  }
  for (const m of [
    'AudioRecord: microphone in use',
    'Resource temporarily unavailable',
    'Microphone is busy',
  ]) {
    assert.strictEqual(R.classifyStartFailure({ granted: true, message: m }), 'busy', m);
  }
  // `prepare` on its own must NOT mean "busy": it matched expo-av's own
  // message, and that is exactly how the app came to blame the phone for its
  // own bug.
  assert.notStrictEqual(R.classifyStartFailure({ granted: true, message: 'prepare' }), 'busy');
});

test('an unrecognised failure says something true rather than guessing', () => {
  const kind = R.classifyStartFailure({ granted: true, message: 'something else entirely' });
  assert.strictEqual(kind, 'unknown');
  const text = R.startFailureText(kind);
  assert.ok(!/permission/i.test(text), 'an unknown failure still blames permissions');
  assert.ok(/try again/i.test(text), text);
});

test('everything but a missing permission offers another go', () => {
  // Because after the slot is released, the next attempt usually works —
  // which is the difference between one tap and restarting the app.
  assert.strictEqual(R.offersRetry('busy'), true);
  assert.strictEqual(R.offersRetry('unknown'), true);
  assert.strictEqual(R.offersRetry('permission'), false,
    'offering "try again" for a permission that is off is a loop');
});

// ── The slot itself ─────────────────────────────────────────────────────────

const rec = fs.readFileSync(path.join(NAT, 'src', 'voiceRecorder.ts'), 'utf8');
const bar = fs.readFileSync(path.join(NAT, 'src', 'components', 'VoiceRecorder.tsx'), 'utf8');

test('THE FIX: nothing is ever created without being remembered', () => {
  // A recorder that exists but is not referenced can never be unloaded, and
  // it is the one that poisons every later attempt.
  const creates = rec.match(/new Audio\.Recording\(\)/g) || [];
  assert.strictEqual(creates.length, 2, 'the number of places a recorder is created has changed');
  // Both of them assign to `held` on the very next line, before anything that
  // can throw. Written to match BOTH spellings — `const rec = new …` in the
  // warm-up and a bare `rec = new …` in begin() — because a check that only
  // saw one of them passed while the other was made to remember too late.
  const sites = [...rec.matchAll(/(?:const )?rec = new Audio\.Recording\(\);\n([^\n]*)\n/g)];
  assert.strictEqual(sites.length, 2, `found ${sites.length} creation sites, expected 2`);
  for (const m of sites) {
    assert.ok(/held = rec;/.test(m[1]),
      `a recorder is created and only remembered later: ${m[1].trim()}`);
  }
});

test('THE PERSISTENCE: every failure gives the slot back, not just a failed start', () => {
  // Reported as "it is always there, with nothing else recording".
  //
  // prepareToRecordAsync used to throw from OUTSIDE the try, so a recorder
  // that failed to prepare stayed held, expo-av went on believing one was
  // prepared, and every later attempt failed identically until the app was
  // killed. One unlucky moment broke recording for the rest of the session.
  const fn = rec.slice(rec.indexOf('export async function begin('), rec.indexOf('export async function finish('));
  // Both must sit inside the SAME try as the catch that releases — so the
  // check is that no new `try {` opens between either of them and that catch.
  // (Written this way because asserting "a try appears before prepare" passed
  // while prepare had been moved into a block of its own: the first `try` in
  // the function is not necessarily the one that guards it.)
  const guard = fn.indexOf('} catch (e) {');
  assert.ok(guard > 0, 'the catch that releases the slot is gone — this check would be vacuous');
  for (const step of ['await rec.prepareToRecordAsync(OPTIONS);', 'await rec.startAsync();']) {
    const at = fn.indexOf(step);
    assert.ok(at > 0 && at < guard, `${step} no longer runs before the catch`);
    assert.ok(!fn.slice(at, guard).includes('try {'),
      `${step} is in a try of its own, so its failure never releases the slot`);
  }
  assert.ok(/\} catch \(e\) \{[\s\S]{0,600}?await releaseHeld\(\);[\s\S]{0,400}?throw e;/.test(fn),
    'a failure is not followed by releasing the recorder');
  assert.ok(/setAudioModeAsync\(PLAYBACK_MODE\)/.test(fn),
    'the audio session is left in record mode after a failure');
});

test('THE RACE: a start waits for a warm-up that is still running', () => {
  // The warm-up is fired by the finger landing on the microphone and begin()
  // runs when it lifts. If begin did not wait, it released the half-prepared
  // recorder out from under the warm-up and prepared a SECOND one — and
  // expo-av allows exactly one. On a slow phone the two are always close
  // enough for that to happen every single time, which is the report.
  const fn = rec.slice(rec.indexOf('export async function begin('), rec.indexOf('export async function finish('));
  assert.ok(/if \(warming\) \{ try \{ await warming; \} catch \{\} \}/.test(fn),
    'begin races the warm-up it is supposed to be collecting');
  assert.ok(fn.indexOf('await warming') < fn.indexOf('await releaseHeld()'),
    'the wait happens after the release, which is the race it was meant to fix');
});

test('and every start releases whatever a previous attempt left behind', () => {
  const fn = rec.slice(rec.indexOf('export async function begin('), rec.indexOf('export async function finish('));
  assert.ok(fn.includes('await releaseHeld();'), 'a leaked recorder survives into the next attempt');
  const warm = rec.slice(rec.indexOf('export async function warmUp('), rec.indexOf('export function isWarm('));
  assert.ok(warm.includes('await releaseHeld();'), 'warming up can leak a second recorder');
});

test('the bar gives the slot back on every way out, not just the tidy one', () => {
  assert.ok(/recorder\.finish\(\);/.test(bar), 'nothing releases the recorder');
  const uses = bar.match(/recorder\.finish\(\)/g) || [];
  assert.ok(uses.length >= 2, `only ${uses.length} exit releases the slot — cancel or stop still leaks`);
  assert.ok(!/recordingRef\.current\?\.stopAndUnloadAsync\(\)\.catch/.test(bar),
    'unmount still unloads only its own reference, which is null when it leaked');
});

test('the dialog offers Try again, and trying again really restarts it', () => {
  assert.ok(bar.includes('classifyStartFailure({'), 'the bar writes its own diagnosis again');
  assert.ok(/text: 'Try again', onPress: \(\) => \{ setStarted\(false\); startRecording\(\); \}/.test(bar),
    'Try again does not actually start a new recording');
  assert.ok(!/Please check microphone permissions in Settings/.test(bar),
    'the old, wrong message is still there');
});

// ── The notification in the shade ───────────────────────────────────────────

const audio = fs.readFileSync(path.join(NAT, 'src', 'audioManager.ts'), 'utf8');
const appTsx = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');

test('THE PHOTO: stopping is not skipped because a flag says "not ready"', () => {
  const fn = audio.slice(audio.indexOf('  async stop() {'), audio.indexOf('  async stop() {') + 1200);
  assert.ok(!/if \(this\.ready\) await TrackPlayer\.reset\(\)/.test(fn),
    'a media session set up by an earlier launch is left running, notification and all');
  assert.ok(/await TrackPlayer\.stop\(\);/.test(fn) && /await TrackPlayer\.reset\(\);/.test(fn),
    'the player is not actually stopped');
});

test('a PAUSED voice message does not keep a notification forever', () => {
  // Nobody comes back to a voice message from the lock screen, and there was
  // no way to get the notification out of the shade from inside the app.
  const fn = audio.slice(audio.indexOf("Event.PlaybackState"), audio.indexOf('Event.PlaybackProgressUpdated'));
  assert.ok(/paused && !this\.queue\.length/.test(fn), 'a paused single track keeps its session');
  assert.ok(/this\.stop\(\)\.catch/.test(fn), 'nothing clears it');
  assert.ok(/clearTimeout\(this\.pausedSweep\)/.test(fn), 'the sweep is never cancelled, so a resume is cut off');
});

test('…but a playlist keeps its session, which is the point of one', () => {
  const fn = audio.slice(audio.indexOf("Event.PlaybackState"), audio.indexOf('Event.PlaybackProgressUpdated'));
  assert.ok(/!this\.queue\.length/.test(fn), 'music is stopped out from under the lock screen');
});

test('leaving the app with a voice message paused clears it too', () => {
  const fn = appTsx.slice(appTsx.indexOf("AppState.addEventListener('change'"), appTsx.indexOf("AppState.addEventListener('change'") + 1200);
  assert.ok(/st === 'background' && !audioManager\.playing && !audioManager\.queue\?\.length/.test(fn),
    'a notification is left behind when the app goes to the background');
  assert.ok(/audioManager\.stop\(\)/.test(fn), 'nothing stops it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
