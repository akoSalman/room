// Why the phone went quiet.
//
// Reported as: in the latest version of the APK, push notifications are not
// received at the time. They turn up when the app is opened — which is another
// way of saying they were not pushes at all. The socket delivered them on
// reconnect and the shade stayed empty for as long as the app was closed.
//
// The server was sending them. The device was never registered to receive
// them, because registration was one attempt with no second chance, and that
// attempt was racing the permission dialog:
//
//   1. the app asks for notification permission, without waiting for an answer;
//   2. the stored sign-in token resolves a moment later and the screen leaves
//      'auth', which is what runs the registration effect;
//   3. it asks whether permission is granted. The dialog is still on screen and
//      nothing has been tapped, so the honest answer is no;
//   4. it returns — and its dependency was `[screen === 'auth']`, which never
//      changes again, so it never ran a second time.
//
// The user grants permission a second later to an app that has already given
// up. Everything the app raises ITSELF still works, which is why this reads as
// "late" rather than "broken", but the server has no token to push to.
//
// Installing a new APK is exactly when that race is lost, which is why it was
// reported against a version rather than a feature.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping push-registration tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pushreg-'));
execFileSync(TSC, [path.join(NAT, 'src', 'pushRegistration.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const P = require(path.join(OUT, 'pushRegistration.js'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Is there anything to tell the server? ───────────────────────────────────

test('THE BUG: permission arriving late still results in a registration', () => {
  // The dialog is open: nothing to send YET. The old code treated this as
  // nothing to send EVER.
  assert.strictEqual(P.needsSend({ granted: false, token: 'abc', sentToken: null }), false);
  // The user taps Allow. This is the state the old code could never reach.
  assert.strictEqual(P.needsSend({ granted: true, token: 'abc', sentToken: null }), true);
});

test('…and there IS a second chance, which is the whole fix', () => {
  // A single attempt at a moment when the answer is "not yet" is the bug. The
  // retry has to survive that first no.
  assert.strictEqual(P.shouldRetry({ attempt: 1, registered: false }), true);
  assert.strictEqual(P.shouldRetry({ attempt: P.MAX_ATTEMPTS - 1, registered: false }), true);
  assert.ok(P.MAX_ATTEMPTS >= 3, 'one or two tries is the bug with extra steps');
});

test('a token the server already has is not sent again', () => {
  // Otherwise every return to the foreground is a POST that changes nothing.
  assert.strictEqual(P.needsSend({ granted: true, token: 'abc', sentToken: 'abc' }), false);
});

test('THE OTHER SILENCE: a reissued token is noticed on its own', () => {
  // Firebase reissues tokens — on reinstall, on restore to a new device, after
  // a long idle. The server keeps pushing to the old one until Firebase
  // rejects it, and then has nothing at all.
  assert.strictEqual(P.needsSend({ granted: true, token: 'new', sentToken: 'old' }), true);
});

test('nothing to send is not sent', () => {
  assert.strictEqual(P.needsSend({ granted: true, token: '', sentToken: null }), false);
  assert.strictEqual(P.needsSend({ granted: true, token: null, sentToken: null }), false);
  assert.strictEqual(P.needsSend(null), false);
});

test('retrying stops once it has worked', () => {
  assert.strictEqual(P.shouldRetry({ attempt: 1, registered: true }), false);
  assert.strictEqual(P.shouldRetry({ attempt: P.MAX_ATTEMPTS, registered: false }), false);
});

test('the first retry is quick, and the backoff is bounded', () => {
  // The likeliest reason for the first failure is the permission dialog still
  // being on screen — seconds, not a network problem — so waiting half a
  // minute for the first retry would lose the very case this exists for.
  assert.ok(P.retryDelay(1) <= 2000, `${P.retryDelay(1)}ms before the first retry`);
  assert.ok(P.retryDelay(2) > P.retryDelay(1), 'the backoff does not back off');
  assert.ok(P.retryDelay(99) <= 30000, 'a retry is scheduled for half an hour away');
  assert.ok(P.retryDelay(0) > 0 && P.retryDelay(-5) > 0, 'a nonsense attempt retries instantly, forever');
});

test('the whole retry sequence covers a human tapping Allow', () => {
  // Somebody reading a permission dialog takes a few seconds. If the attempts
  // are all spent before they finish, the fix does not fix anything.
  let total = 0;
  for (let i = 1; i <= P.MAX_ATTEMPTS; i++) total += P.retryDelay(i);
  assert.ok(total >= 30000,
    `registration gives up after ${Math.round(total / 1000)}s, before a slow tap on Allow`);
});

test('the socket fallback covers exactly the gap and no more', () => {
  // Raising notifications from the socket while FCM is also delivering them
  // shows every message twice.
  assert.strictEqual(P.socketFallbackAllowed({ registered: false }), true);
  assert.strictEqual(P.socketFallbackAllowed({ registered: true }), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
const at = app.indexOf('// Register the device FCM token');
const effect = at > 0 ? app.slice(at, app.indexOf('// Global notifications:')) : '';

test('THE FIX IS WIRED: registration retries instead of giving up', () => {
  assert.ok(effect.length > 400, 'the registration effect moved');
  assert.ok(/pushReg\.shouldRetry\(/.test(effect), 'one failed attempt still ends registration');
  assert.ok(/setTimeout\(attemptRegister, pushReg\.retryDelay\(attempt\)\)/.test(effect),
    'nothing is ever scheduled, so the retry rule is decoration');
  // The specific shape of the old bug: a `return` on ungranted permission that
  // ends the effect for good.
  assert.ok(!/if \(!perm\.granted\) return;/.test(effect),
    'an ungranted permission still ends registration permanently');
});

test('coming back to the app is another chance', () => {
  // The case this catches: permission refused in the dialog and granted later
  // from Settings.
  assert.ok(/AppState\.addEventListener\('change'/.test(effect),
    'returning to the app does not retry registration');
  assert.ok(/st !== 'active' \|\| pushRegisteredRef\.current/.test(effect),
    'every foreground re-registers, or none does');
});

test('a reissued token is picked up', () => {
  assert.ok(/addPushTokenListener\(/.test(effect),
    'a token Firebase reissues is never sent, and the server pushes into nothing');
});

test('the token is remembered only after the server accepts it', () => {
  // Recording it before would turn one failed POST into permanent silence —
  // the same shape of bug in a different place.
  const i = effect.indexOf('const res = await apiFetch');
  assert.ok(i > 0, 'the POST moved');
  const after = effect.slice(i, i + 700);
  assert.ok(/if \(res\?\.ok\)/.test(after), 'the response is not checked');
  const ok = after.indexOf('if (res?.ok)');
  assert.ok(after.slice(ok).indexOf('AsyncStorage.setItem(pushReg.SENT_TOKEN_KEY') > -1,
    'the token is not remembered, so it is re-sent on every foreground');
  assert.ok(after.indexOf('AsyncStorage.setItem(pushReg.SENT_TOKEN_KEY') > ok,
    'the token is recorded before the server accepted it');
});

test('the socket fallback asks the rule rather than a bare flag', () => {
  assert.ok(/pushReg\.socketFallbackAllowed\(\{ registered: pushRegisteredRef\.current \}\)/.test(app),
    'the fallback decides for itself whether push is covering notifications');
});

test('THE TRAP THIS INTRODUCES: signing out forgets the registered token', () => {
  // It records "the server has been told this token", and the server stores it
  // against whoever was signed in at the time. Left behind, the next person to
  // sign in on this phone has the same device token — so registration decides
  // there is nothing to send, and they get no push notifications at all while
  // everything appears to work.
  const at = app.indexOf('async function logout()');
  assert.ok(at > 0, 'logout moved');
  const fn = app.slice(at, at + 900);
  assert.ok(/pushReg\.SENT_TOKEN_KEY/.test(fn),
    'signing out leaves the token recorded, so the next account gets no pushes');
  assert.ok(/pushRegisteredRef\.current = false/.test(fn),
    'the next account inherits "already registered" and never registers');
});

test('the effect cleans up after itself', () => {
  // An AppState listener and a timer left behind by a screen change would
  // stack up a new pair on every sign-in.
  assert.ok(/clearTimeout\(timer\)/.test(effect), 'a pending retry outlives the effect');
  assert.ok(/appSub\.remove\(\)/.test(effect), 'the AppState listener is never removed');
  assert.ok(/tokSub\?\.remove\?\.\(\)/.test(effect), 'the token listener is never removed');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
