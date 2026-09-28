// ── One notification per message ────────────────────────────────────────────
//
// Reported as: sometimes both the socket notification and the Firebase one
// arrive for the same message.
//
// They were supposed to collapse — they carry the same tag for exactly that
// reason — and they cannot, for a reason that was measured rather than
// argued:
//
//   expo-notifications posts every notification with the Android id 0
//   (ANDROID_NOTIFICATION_ID in ExpoPresentationDelegate.kt).
//
//   notifee posts with String.hashCode() of the id string
//   (NotificationModel.b() in the shipped AAR: invokevirtual hashCode).
//
// Android keys a notification by (package, tag, id). Same tag, different id,
// two notifications. No amount of tagging could have fixed it.
//
// So the two routes agree in JavaScript instead. The rule below is what they
// agree on, and the property that matters most is that it fails OPEN.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping notify-once tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nonce-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'notifyOnce.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const N = require(path.join(OUT, 'notifyOnce.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const NOW = 1_800_000_000_000;

test('THE FIRST ROUTE DRAWS IT, THE SECOND STANDS DOWN', () => {
  N.reset();
  assert.strictEqual(N.claim(42, NOW), true, 'the first route was refused');
  assert.strictEqual(N.claim(42, NOW + 900), false, 'the second route drew a duplicate');
});

test('…whichever route happens to be first', () => {
  // There is no designated winner. Firebase beats the socket on one message
  // and loses on the next, and either is correct — only "both" is wrong.
  N.reset();
  assert.strictEqual(N.claim('99', NOW), true);
  assert.strictEqual(N.claim(99, NOW + 50), false, 'a numeric id and its string form are different messages');
});

test('IT FAILS OPEN: a message with no id is always allowed', () => {
  // The property that matters. If there is nothing to key on, the choice is
  // between a possible duplicate and a possible silence — and silence is the
  // failure nobody can diagnose.
  N.reset();
  for (const bad of [null, undefined, '', '   ']) {
    assert.strictEqual(N.claim(bad, NOW), true, JSON.stringify(bad));
    assert.strictEqual(N.claim(bad, NOW + 10), true, JSON.stringify(bad));
  }
});

test('…and id 0 is an id, not an absence', () => {
  // Number(null) is 0 and !0 is true: the trap this codebase keeps meeting.
  N.reset();
  assert.strictEqual(N.claim(0, NOW), true);
  assert.strictEqual(N.claim(0, NOW + 10), false, 'message 0 can be notified twice');
});

test('DIFFERENT MESSAGES ARE DIFFERENT NOTIFICATIONS', () => {
  N.reset();
  assert.strictEqual(N.claim(1, NOW), true);
  assert.strictEqual(N.claim(2, NOW), true, 'a second message was suppressed as a duplicate');
  assert.strictEqual(N.claim(3, NOW), true);
});

test('a claim expires, so the map cannot grow for ever', () => {
  N.reset();
  assert.strictEqual(N.claim(7, NOW), true);
  assert.strictEqual(N.claim(7, NOW + N.WINDOW_MS - 1), false);
  assert.strictEqual(N.claim(7, NOW + N.WINDOW_MS), true, 'the claim never expires');
});

test('THE WINDOW OUTLASTS A ROUND TRIP TO FIREBASE, and no more', () => {
  // The gap being covered is a push going out and coming back — seconds. Long
  // enough to be safe, short enough that a genuinely re-sent message is not
  // silenced hours later.
  assert.ok(N.WINDOW_MS >= 60 * 1000, 'too short to cover the gap between the two routes');
  assert.ok(N.WINDOW_MS <= 30 * 60 * 1000, 'a later notification for the same message is silenced');
});

test('asking is not claiming', () => {
  N.reset();
  assert.strictEqual(N.claimed(5, NOW), false);
  assert.strictEqual(N.claimed(5, NOW), false, 'asking claimed it');
  assert.strictEqual(N.claim(5, NOW), true, 'asking used up the claim');
  assert.strictEqual(N.claimed(5, NOW), true);
  // An absent id was never claimed by anybody.
  assert.strictEqual(N.claimed(null, NOW), false);
});

test('THE MAP IS BOUNDED, on a phone that has little to spare', () => {
  N.reset();
  for (let i = 0; i < N.MAX_REMEMBERED + 50; i++) N.claim(`m${i}`, NOW);
  // The oldest have gone, so they can be claimed again; the newest have not.
  assert.strictEqual(N.claim('m0', NOW), true, 'the map is unbounded');
  assert.strictEqual(N.claim(`m${N.MAX_REMEMBERED + 49}`, NOW), false,
    'the newest claim was evicted, which is the wrong end');
});

test('a broken clock does not break the rule', () => {
  N.reset();
  for (const bad of [NaN, 'x', null, undefined]) {
    assert.doesNotThrow(() => N.claim(`c${String(bad)}`, bad));
  }
  // …and it still suppresses: two claims in the same instant are one
  // notification whatever the clock said.
  N.reset();
  assert.strictEqual(N.claim(11, NaN), true);
  assert.strictEqual(N.claim(11, NaN), false, 'a bad clock let a duplicate through');
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('BOTH ROUTES ASK BEFORE THEY DRAW', () => {
  // One of them asking is no use at all: the point is that whichever is
  // SECOND is the one that stands down, and either can be second.
  const sock = fs.readFileSync(path.join(NAT, 'src', 'socketNotifier.ts'), 'utf8');
  assert.ok(/notifyOnce\.claim\(/.test(sock),
    'the socket route draws without asking, so it duplicates the push');

  const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
  assert.ok(/notifyOnce\.claim\(/.test(app),
    'the push route draws without asking, so it duplicates the socket');
});

test('…and the push route reads the message id the server sent', () => {
  // Without the id there is nothing to key on and every push is allowed
  // through, which is the old behaviour wearing a new function call.
  const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
  const i = app.indexOf('setNotificationHandler');
  assert.ok(i > 0, 'the handler is gone');
  const body = app.slice(i, app.indexOf('});', i));
  assert.ok(/msgId/.test(body), 'the handler never looks at which message this is');
  assert.ok(/content\?\.data|content\.data/.test(body),
    'the handler does not read the push payload');
});

test('THE SERVER STILL SENDS THE MESSAGE ID, or none of this works', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(/data\.msgId \? \{ tag: notificationTag\(data\.msgId\) \}/.test(server),
    'the push no longer carries the message id');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
