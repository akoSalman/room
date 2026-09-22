// ── The 150 MB video that picked as a file and not as a video ───────────────
//
// "when picking 150MB video as video from gallery to upload it doesn't pick
// but as file is ok".
//
// Not a mystery, once the picker's own source is read. expo-image-picker 15's
// Android MediaHandler.handleVideo copies the whole file into the app's cache
// directory before returning it, so a 150 MB video needs 150 MB free and a
// full byte copy — and the phone this came from was holding nine gigabytes of
// this app's own rubbish.
//
// The part that made it look like nothing happened at all: the picker call
// was awaited with no try/catch, so the rejection went nowhere. Every rule
// here exists to make a failure SAY something, and to point at the route the
// user already found works.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping pick-failure tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'pickFailure.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const P = require(path.join(OUT, 'pickFailure.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const MB = 1024 * 1024;

test('A FULL PHONE IS RECOGNISED, an unmeasured one is not', () => {
  // This is asked at the moment the picker has already thrown, which is
  // before it says how big the file was — so the only number available is how
  // much room the phone has.
  assert.strictEqual(P.spaceLooksTight(10 * MB), true);
  assert.strictEqual(P.spaceLooksTight(900 * MB), false);
  // Unknown means NO. Free space fails to report on plenty of devices, and
  // telling somebody their phone is full on a number that never arrived sends
  // them deleting photos over a problem they do not have.
  for (const v of [null, undefined, 0, -1, NaN, 'x']) {
    assert.strictEqual(P.spaceLooksTight(v), false, String(v));
  }
});

test('THE FAILURE SAYS SOMETHING, and always offers the route that works', () => {
  // The bug as experienced: the tap did nothing and the app said nothing.
  // Anything at all beats that, and the file route is not a guess — the user
  // established it on this exact file.
  const f = P.failureMessage({ error: new Error('boom'), isVideo: true });
  assert.ok(f.title && f.body);
  assert.strictEqual(f.offerFileRoute, true);
  assert.ok(/file button/i.test(f.body), 'the message does not say what to do instead');
});

test('…and never in the library\'s vocabulary', () => {
  // These users read Persian and Kurdish. "FailedToWriteFileException" names
  // the library's problem, not theirs, and an English stack trace is the same
  // as silence except ruder.
  const f = P.failureMessage({
    error: new Error('FailedToWriteFileException: /data/user/0/.../cache/x.mp4'),
  });
  assert.ok(!/Exception|cache|\/data\//.test(f.title + f.body),
    'the exception text was passed through to the user');
});

test('OUT OF SPACE IS NAMED AS ITSELF', () => {
  // It is the likeliest cause and the only one the user can act on, so it
  // gets its own message rather than being folded into "could not open".
  const f = P.failureMessage({ outOfSpace: true });
  assert.ok(/space/i.test(f.title), 'a full phone is reported as a mystery');
  assert.ok(/free|space/i.test(f.body));
  // Recognised from the error too, for the devices that report it that way
  // and never answer a free-space query.
  assert.ok(/space/i.test(P.failureMessage({ error: new Error('ENOSPC') }).title));
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const code = chat.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

test('THE PICKER CALL IS NO LONGER UNGUARDED', () => {
  // This is the whole bug. An awaited rejection with nothing to catch it
  // attaches nothing and says nothing.
  const i = code.indexOf('launchImageLibraryAsync');
  assert.ok(i > 0);
  const before = code.slice(code.indexOf('async function pickFromGallery'), i);
  assert.ok(/try \{/.test(before),
    'launchImageLibraryAsync is awaited with nothing to catch its rejection');
  const after = code.slice(i, code.indexOf('if (res.canceled)', i));
  assert.ok(/catch/.test(after) && /failureMessage/.test(after),
    'the failure is caught and then not reported, which is the same silence');
});

test('…and space is made before the copy that needs it', () => {
  const fn = code.slice(code.indexOf('async function pickFromGallery'),
                        code.indexOf('launchImageLibraryAsync'));
  assert.ok(/storage\.sweep\(/.test(fn),
    'the app does not clear its own rubbish before asking for 150 MB of room');
});

test('THE FILE ROUTE IS REACHABLE FROM THE FAILURE', () => {
  // An alert that names a fix without offering it makes the user go and find
  // the 📎 button themselves, having just been told the app cannot cope.
  assert.ok(/function pickVideoAsFile/.test(code), 'there is no file route to offer');
  assert.ok(/type: 'video\/\*'/.test(code), 'the file route shows every file, not videos');
  assert.ok(/onPress: pickVideoAsFile/.test(code),
    'the alert names the file route but does not open it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
