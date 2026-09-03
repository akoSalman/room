// A crash that leaves something to read.
//
// Reported as: tapping the comment button and tapping the call button both
// crash the app.
//
// I could not reproduce either or find either by reading the code. This is the
// third crash in this project reported from a device I cannot reach, in a
// place where no crash-reporting service is reachable either — and twice now I
// have guessed at a cause, shipped the guess, and been told it still crashes.
// Guessing has a worse record here than admitting I do not know.
//
// Two changes, and both are about being honest rather than clever.
//
//   1. THE CALL. Its foreground service is off. My previous fix assumed
//      Android 14 was refusing a service type whose permission the app did not
//      hold, and gated the types on what is granted — but it still asks for a
//      service whenever any type qualifies, so a refusal from anywhere else
//      survives it unchanged. And it cannot be caught: the service starts
//      natively AFTER displayNotification() returns, so the try/catch around
//      it is decoration. What is lost is a call's protection from being frozen
//      in the background; what is gained is that the call connects.
//
//   2. EVERYTHING ELSE. A JavaScript error now draws a screen with what went
//      wrong and a Copy button, instead of the app vanishing. What it cannot
//      catch is a native crash — and that is the point, because the two
//      outcomes now MEAN different things: an error screen says the fault is
//      in the JavaScript and names it; a silent disappearance says it is
//      native and the JavaScript is innocent.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping crash-report tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-'));
execFileSync(TSC, [path.join(NAT, 'src', 'crashReport.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const R = require(path.join(OUT, 'crashReport.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── What the report says ────────────────────────────────────────────────────

test('THE POINT: the message survives, in full, at the top', () => {
  // It is the one line that usually identifies the fault, and it is what
  // somebody will photograph. Truncating it would waste the whole exercise.
  const long = 'undefined is not a function (evaluating \'someLongExpression.thatFailed()\')';
  const out = R.describeCrash({ message: long, stack: 'at foo (app.bundle:1:2)' });
  assert.ok(out.startsWith(long), out);
});

test('and what the user was doing, when we know it', () => {
  const out = R.describeCrash({ message: 'boom', where: 'Opening comments' });
  assert.ok(/While: Opening comments/.test(out), out);
});

test('the useful frames are kept and the noise is cut', () => {
  const stack = [
    'TypeError: x is not a function',
    '    at openComments (https://10.0.2.2:8081/index.bundle?platform=android:4412:9)',
    '    at onPress (/data/user/0/com.app/files/index.android.bundle:99:1)',
    ...Array.from({ length: 40 }, (_, i) => `    at reactFrame${i} (react.js:${i}:1)`),
  ].join('\n');
  const out = R.describeCrash({ message: 'x is not a function', stack });
  assert.ok(out.includes('at openComments (index.bundle?platform=android:4412:9)'),
    'the bundle URL was left in, pushing the useful part off a phone screen');
  assert.ok(out.includes('at onPress (index.android.bundle:99:1)'), out);
  assert.ok(!out.includes('/data/user/0/'), 'the device path is still there');
  // Not the whole of React's stack: a report nobody can scroll to the end of
  // does not get sent.
  assert.ok(out.split('\n').length < 20, `the report is ${out.split('\n').length} lines long`);
  assert.strictEqual(R.STACK_LINES, 6);
});

test('the error class line is dropped — it repeats the message', () => {
  const frames = R.topFrames('TypeError: nope\n    at a (b.js:1:1)', 6);
  assert.deepStrictEqual(frames, ['at a (b.js:1:1)']);
});

test('an error with nothing in it still produces a report', () => {
  // A thrown string, a rejected promise with no reason, an error whose message
  // is empty: all of them still have to say something.
  assert.strictEqual(R.describeCrash(null), 'Unknown error');
  assert.strictEqual(R.describeCrash({}), 'Unknown error');
  assert.strictEqual(R.describeCrash({ message: '   ' }), 'Unknown error');
  assert.deepStrictEqual(R.topFrames(null, 6), []);
  assert.deepStrictEqual(R.topFrames('', 6), []);
});

test('React\'s own trace of what was mounting is included', () => {
  const out = R.describeCrash({
    message: 'boom',
    componentStack: '\n    in ChatScreen\n    in App',
  });
  assert.ok(/In:/.test(out) && /in ChatScreen/.test(out), out);
});

// ── Not making it worse ─────────────────────────────────────────────────────

test('THE LOOP: the same crash does not replace the report with itself', () => {
  // An error thrown while the report is on screen, or one repeating every
  // frame, would otherwise wipe the thing the user is trying to read.
  const a = { message: 'boom', stack: 'at a (x.js:1:1)\nat b (x.js:2:2)' };
  const b = { message: 'boom', stack: 'at a (x.js:1:1)\nat b (x.js:2:2)\nat c (x.js:3:3)' };
  assert.strictEqual(R.isSameCrash(a, b), true, 'a deeper stack for the same fault read as a new crash');
  assert.strictEqual(R.isSameCrash(a, { message: 'other', stack: a.stack }), false);
  assert.strictEqual(R.isSameCrash(a, { message: 'boom', stack: 'at z (y.js:9:9)' }), false);
  assert.strictEqual(R.isSameCrash(null, a), false);
  assert.strictEqual(R.isSameCrash(a, null), false);
});

test('"Go back" is offered only when going back is safe', () => {
  // After a fatal error the runtime is in an unknown state, and pretending
  // otherwise produces a second, stranger crash. A render that failed inside
  // one screen can be backed out of, and forcing a restart there would throw
  // away a half-written message for nothing.
  assert.strictEqual(R.canContinue({ message: 'x', isFatal: true }), false);
  assert.strictEqual(R.canContinue({ message: 'x' }), true);
  assert.strictEqual(R.canContinue(null), true);
});

test('the hint does not blame the person reading it', () => {
  assert.ok(/not your fault/i.test(R.CRASH_HINT), R.CRASH_HINT);
  assert.ok(/copy/i.test(R.CRASH_HINT), 'it does not say what to do');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
const screen = fs.readFileSync(path.join(NAT, 'src', 'components', 'CrashScreen.tsx'), 'utf8');
const globalCrash = fs.readFileSync(path.join(NAT, 'src', 'globalCrash.ts'), 'utf8');
const ongoing = fs.readFileSync(path.join(NAT, 'src', 'ongoingCall.ts'), 'utf8');

test('the whole app is inside the boundary', () => {
  assert.ok(/<CrashBoundary onRestart=/.test(app), 'nothing catches a render that throws');
  assert.ok(/<\/CrashBoundary>/.test(app), 'the boundary is opened and never closed');
  // Above every screen, so a fault in any of them is caught.
  assert.ok(app.indexOf('<CrashBoundary') < app.indexOf("{screen === 'chat' && room && ("),
    'the chat screen is outside the boundary');
});

test('and errors from outside render reach it too', () => {
  // A socket handler, a promise, a timer: none of them go through React, and
  // in a release build the global handler simply ends the process.
  assert.ok(/installGlobalCrashHandler\(\);/.test(app), 'the global handler is never installed');
  assert.ok(/setGlobalHandler/.test(globalCrash), 'nothing hooks the global handler');
  assert.ok(/onGlobalCrash\(info => \{/.test(screen), 'the screen never hears about them');
});

test('a fatal error still ends the process — after the report has been seen', () => {
  // Carrying on inside a broken runtime produces worse failures than stopping.
  // But ending it immediately destroys the very report it would have shown.
  assert.ok(/if \(isFatal && typeof prev === 'function'\)/.test(globalCrash),
    'a fatal error is swallowed and the app limps on');
  assert.ok(/setTimeout\(\(\) => \{ try \{ prev\(err, isFatal\); \} catch \{\} \}, 8000\)/.test(globalCrash),
    'the process ends before the crash screen can paint');
});

test('the report can be got OFF the phone', () => {
  // The whole purpose. A screen nobody can copy from is a screen nobody sends.
  assert.ok(/Clipboard\.setStringAsync\(text\)/.test(screen), 'there is no way to copy the report');
  assert.ok(/selectable/.test(screen), 'the text cannot even be selected by hand');
});

test('THE CALL: no foreground service is asked for at all', () => {
  assert.ok(/export const CALL_FOREGROUND_SERVICE = false;/.test(ongoing),
    'the call still starts a foreground service — the thing that has now crashed twice');
  assert.ok(/const wantsService = CALL_FOREGROUND_SERVICE && types\.length > 0;/.test(ongoing),
    'the switch is declared and not used');
  assert.ok(/asForegroundService: wantsService,/.test(ongoing), 'the notification still asks for one');
  assert.ok(/foregroundServiceTypes: wantsService \? types : undefined,/.test(ongoing),
    'service types are still sent, which is what Android refuses');
});

test('…but the call notification itself is untouched', () => {
  // It is how you get back to a call and how you hang up without doing so.
  assert.ok(/id: ONGOING_ID/.test(ongoing), 'the ongoing notification is gone');
  assert.ok(/title: 'End call'/.test(ongoing), 'there is no way to hang up from the shade');
  assert.ok(/showChronometer: showsChronometer\(info\.connected\)/.test(ongoing), 'the timer is gone');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
