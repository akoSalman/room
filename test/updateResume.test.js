// Keeping an update download across a change of network.
//
// Reported as: while the update is downloading, changing the internet
// connection stops it and the user has to start again from scratch.
//
// The download already used a resumable task and already wrote a snapshot when
// it failed, so on the face of it it should have resumed. It did not, for a
// reason worth pinning down in a test:
//
//   expo-file-system's `savable()` only carries `resumeData` if the task was
//   PAUSED. One that died of a network error has none, and a task rebuilt
//   without resumeData starts again at byte zero. The snapshot looked like
//   insurance and was a receipt for nothing.
//
// So the connection going is now a deliberate PAUSE while the task is still
// alive, and its return resumes without asking.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping update-resume tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'updres-'));
execFileSync(TSC, [path.join(NAT, 'src', 'updateResume.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const U = require(path.join(OUT, 'updateResume.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── What losing the connection means ────────────────────────────────────────

test('THE POINT: losing the connection pauses, it does not fail', () => {
  // Nothing is wrong with the bytes already on disk. Calling it a failure is
  // what invited people to start a forty-megabyte download over.
  assert.strictEqual(U.phaseOnNetworkChange('downloading', false), 'paused');
});

test('and getting it back resumes, without being asked', () => {
  assert.strictEqual(U.phaseOnNetworkChange('paused', true), 'downloading');
});

test('a FAILURE is not retried on every flicker of signal', () => {
  // A failure has a cause we do not know; retrying it automatically is a loop
  // nobody asked for. A pause is ours, and resolves itself.
  assert.strictEqual(U.phaseOnNetworkChange('failed', true), 'failed');
});

test('nothing else is disturbed by the network changing', () => {
  for (const phase of ['idle', 'done', 'failed']) {
    assert.strictEqual(U.phaseOnNetworkChange(phase, false), phase);
  }
  assert.strictEqual(U.phaseOnNetworkChange('idle', true), 'idle');
  assert.strictEqual(U.phaseOnNetworkChange('done', true), 'done');
  // A download in progress is left alone by the connection coming back.
  assert.strictEqual(U.phaseOnNetworkChange('downloading', true), 'downloading');
});

test('it only resumes when there is something to resume', () => {
  assert.strictEqual(U.shouldAutoResume({ phase: 'paused', online: true, hasSnapshot: true }), true);
  assert.strictEqual(U.shouldAutoResume({ phase: 'paused', online: true, hasSnapshot: false }), false,
    'a resume was attempted with no snapshot, which starts from zero');
  assert.strictEqual(U.shouldAutoResume({ phase: 'paused', online: false, hasSnapshot: true }), false);
  assert.strictEqual(U.shouldAutoResume({ phase: 'failed', online: true, hasSnapshot: true }), false);
  assert.strictEqual(U.shouldAutoResume({ phase: 'downloading', online: true, hasSnapshot: true }), false,
    'a running download was started a second time');
});

// ── The snapshot ────────────────────────────────────────────────────────────

test('a snapshot for a different file is not used', () => {
  // A brand's build and GitHub's are different URLs; resuming one into the
  // other would produce an APK made of two halves.
  const snap = { url: 'https://a.test/app.apk', fileUri: 'file:///x.apk', resumeData: 'abc' };
  assert.strictEqual(U.snapshotMatches(snap, 'https://a.test/app.apk'), true);
  assert.strictEqual(U.snapshotMatches(snap, 'https://b.test/app.apk'), false);
  assert.strictEqual(U.snapshotMatches(null, 'https://a.test/app.apk'), false);
  assert.strictEqual(U.snapshotMatches({ url: 'https://a.test/app.apk' }, 'https://a.test/app.apk'), false,
    'a snapshot with no file behind it was accepted');
});

test('THE BUG, named: a snapshot without resumeData will NOT continue', () => {
  // This is the whole fault. It is not that the snapshot was missing — it is
  // that a snapshot taken from a task that was never paused carries nothing to
  // resume from, and rebuilding a task with it starts at byte zero.
  assert.strictEqual(U.canContinue({ url: 'u', fileUri: 'f' }), false);
  assert.strictEqual(U.canContinue({ url: 'u', fileUri: 'f', resumeData: '' }), false);
  assert.strictEqual(U.canContinue({ url: 'u', fileUri: 'f', resumeData: null }), false);
  assert.strictEqual(U.canContinue({ url: 'u', fileUri: 'f', resumeData: 'deadbeef' }), true);
  assert.strictEqual(U.canContinue(null), false);
});

// ── What the user is told ───────────────────────────────────────────────────

test('a paused download says it is waiting, and what will happen', () => {
  const line = U.statusLine({ phase: 'paused', percent: 42, online: false, canContinue: true });
  assert.ok(/waiting for a connection/i.test(line), line);
  assert.ok(line.includes('42'), 'the progress already made is not mentioned');
  assert.ok(/continue/i.test(line), 'it does not say the download will carry on');
});

test('…and does not promise to continue when it cannot', () => {
  // Promising "it will carry on" and then spending somebody's data from zero
  // is worse than saying nothing.
  const line = U.statusLine({ phase: 'paused', percent: 42, online: false, canContinue: false });
  assert.ok(/start again/i.test(line), line);
  assert.ok(!/continue from/i.test(line), 'it promised to continue when it cannot');
});

test('a pause with the network back says it is already carrying on', () => {
  const line = U.statusLine({ phase: 'paused', percent: 42, online: true, canContinue: true });
  assert.ok(/continuing/i.test(line), line);
});

test('a running download reports the percentage', () => {
  assert.strictEqual(
    U.statusLine({ phase: 'downloading', percent: 7.4, online: true, canContinue: true }),
    'Downloading update… 7%');
});

test('only a failure asks the user to do something', () => {
  // The pause resolves itself; asking for a tap would be asking somebody to
  // shepherd a download over a bad connection.
  assert.strictEqual(U.needsTap('paused'), false);
  assert.strictEqual(U.needsTap('downloading'), false);
  assert.strictEqual(U.needsTap('failed'), true);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const upd = fs.readFileSync(path.join(NAT, 'src', 'appUpdate.ts'), 'utf8');
const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');

test('the download pauses ITSELF when the connection goes', () => {
  // The pause is the entire fix: it is the only way a real resume offset is
  // ever produced.
  assert.ok(upd.includes('connection.subscribe('), 'nothing watches the connection');
  assert.ok(/await t\?\.pauseAsync\(\)/.test(upd),
    'the task is never paused, so its snapshot carries nothing to resume from');
  const watcher = upd.slice(upd.indexOf('function watchConnection()'), upd.indexOf('export async function start'));
  assert.ok(watcher.indexOf('pauseAsync') < watcher.indexOf('savable'),
    'the snapshot is taken before the pause, which is where the resume data comes from');
});

test('and picks itself back up when it returns', () => {
  assert.ok(upd.includes('shouldAutoResume({'), 'the resume is decided by hand rather than by the rule');
  assert.ok(/start\(currentUrl, currentVersion\)/.test(upd),
    'nothing actually restarts the download when the network comes back');
});

test('an error while offline is a pause, not a failure', () => {
  // The watcher may not see the drop before the request does.
  assert.ok(/connection\.isOnline\(\)\s*\?\s*\{ \.\.\.state, status: 'failed'/.test(upd),
    'a network error is still reported as a failure even when the phone is offline');
});

test('a resume does not zero the bar it is continuing', () => {
  assert.ok(/progress: state\.status === 'paused' \? state\.progress : 0/.test(upd),
    'starting a resume resets the progress, so a continuing download looks like a fresh one');
});

test('the profile treats a paused download as still in progress', () => {
  // Otherwise the bar disappears and the Update button comes back — which is
  // exactly how somebody starts the whole download again.
  assert.ok(/st\.status === 'downloading' \|\| st\.status === 'paused'/.test(rooms),
    'a paused download is not counted as running, so the screen offers to start over');
  assert.ok(rooms.includes('updateStatusLine({'), 'the screen writes its own status text again');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
