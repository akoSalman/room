// ── The diagnostic has to be trustworthy, or it is worse than nothing ───────
//
// Notifications have been diagnosed six times from reading the source and the
// answer has been wrong every time, because the facts that decide it live on a
// handset: whether Android granted permission, whether the channel is
// enabled, and above all whether an FCM message EVER reaches the app.
//
// That last one splits the problem in half. Messages arriving but not drawn is
// a bug in this app. Messages never arriving is delivery, and nothing in this
// repository reaches it. From outside they are identical — "no notification" —
// and they need opposite fixes.
//
// So the counters and the verdict are tested here. A screen that says "12
// received" when nothing arrived would send the next week of work in the wrong
// direction, exactly as the last six were.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping notify-diag tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ndiag-'));
// Stubbed: the module stores through AsyncStorage, which does not exist here,
// and the rules under test are pure anyway.
fs.mkdirSync(path.join(OUT, 'node_modules', '@react-native-async-storage', 'async-storage'), { recursive: true });
fs.writeFileSync(
  path.join(OUT, 'node_modules', '@react-native-async-storage', 'async-storage', 'index.js'),
  'module.exports = { default: { getItem: async () => null, setItem: async () => {} } };',
);
fs.writeFileSync(
  path.join(OUT, 'node_modules', '@react-native-async-storage', 'async-storage', 'package.json'),
  JSON.stringify({ name: '@react-native-async-storage/async-storage', main: 'index.js' }),
);
execFileSync(TSC, [path.join(NAT, 'src', 'notifyDiag.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
  '--esModuleInterop'], { stdio: 'pipe' });
const D = require(path.join(OUT, 'notifyDiag.js'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const ok = { permissionGranted: true, channelEnabled: true, tokenRegistered: true };

// ── The verdict ─────────────────────────────────────────────────────────────

test('THE SPLIT: nothing ever received says the loss is NOT in the app', () => {
  // The single most valuable sentence this can produce. The server log already
  // proves messages are handed to Google; if none has ever reached the app,
  // the gap is between them, and more app changes are wasted work.
  const v = D.verdict(D.empty(), ok);
  assert.ok(/no push message has ever reached this app/i.test(v), v);
  assert.ok(/delivery, not the app/i.test(v), v);
});

test('…and messages arriving but refused points back INTO the app', () => {
  let d = D.apply(D.empty(), { kind: 'received', at: 1000 });
  d = D.apply(d, { kind: 'handler', at: 1001, showed: false });
  const v = D.verdict(d, ok);
  assert.ok(/arriving/i.test(v) && /not to show/i.test(v), v);
});

test('arriving and shown says so plainly', () => {
  let d = D.apply(D.empty(), { kind: 'received', at: 1000 });
  d = D.apply(d, { kind: 'handler', at: 1001, showed: true });
  assert.ok(/arriving and being shown/i.test(D.verdict(d, ok)));
});

test('the blocking settings are reported BEFORE anything else', () => {
  // A phone with notifications switched off will never receive anything, so
  // "no push has ever arrived" would be true and utterly misleading.
  const none = D.empty();
  assert.ok(/Android is blocking/i.test(
    D.verdict(none, { ...ok, permissionGranted: false })));
  assert.ok(/channel/i.test(
    D.verdict(none, { ...ok, channelEnabled: false })));
  assert.ok(/has not registered/i.test(
    D.verdict(none, { ...ok, tokenRegistered: false })));
});

test('permission outranks the channel, which outranks registration', () => {
  // All three wrong at once must name the one to fix FIRST, or the reader
  // fixes the last of them and nothing changes.
  const v = D.verdict(D.empty(),
    { permissionGranted: false, channelEnabled: false, tokenRegistered: false });
  assert.ok(/Android is blocking/i.test(v), v);
});

// ── The counters ────────────────────────────────────────────────────────────

test('counting is per event and never silently resets', () => {
  let d = D.empty();
  for (let i = 1; i <= 3; i++) d = D.apply(d, { kind: 'received', at: i * 1000 });
  assert.strictEqual(d.receivedCount, 3);
  assert.strictEqual(d.lastReceivedAt, 3000);
  // A different event must not disturb it — the two paths are counted
  // separately precisely so they can be told apart.
  d = D.apply(d, { kind: 'socket-raised', at: 4000 });
  assert.strictEqual(d.receivedCount, 3, 'a socket notification was counted as a push');
  assert.strictEqual(d.socketRaisedCount, 1);
});

test('the app drawing one itself is NOT counted as a push arriving', () => {
  // These are the two different channels, and confusing them would hide
  // exactly the failure this screen exists to find.
  const d = D.apply(D.empty(), { kind: 'socket-raised', at: 1000 });
  assert.strictEqual(d.receivedCount, 0);
  assert.ok(/no push message has ever reached this app/i.test(D.verdict(d, ok)),
    'a socket-raised notification was mistaken for FCM working');
});

test('a corrupt or missing record reads as empty, not as a crash', () => {
  assert.deepStrictEqual(D.apply(null, { kind: 'received', at: 5 }).receivedCount, 1);
  assert.deepStrictEqual(D.apply(undefined, { kind: 'received', at: 5 }).receivedCount, 1);
  assert.strictEqual(D.apply(D.empty(), { kind: 'received', at: 0 }).receivedCount, 0,
    'an event with no timestamp was counted');
  assert.strictEqual(D.apply(D.empty(), { kind: 'nonsense', at: 5 }).receivedCount, 0);
});

test('empty() hands out a fresh object every time', () => {
  // Returning a shared constant means one caller mutating it changes what
  // every later reader sees — a diagnostic that invents its own history.
  const a = D.empty();
  a.receivedCount = 99;
  assert.strictEqual(D.empty().receivedCount, 0);
});

// ── How long ago, for somebody holding a phone ──────────────────────────────

test('"never" is a word, not a number', () => {
  // The difference between "no push has ever arrived" and "one arrived 40
  // days ago" is the whole diagnosis, and 0 would read as "just now".
  assert.strictEqual(D.ago(null), 'never');
  assert.strictEqual(D.ago(0), 'never');
  assert.strictEqual(D.ago(undefined), 'never');
});

test('recent times read in units a person can act on', () => {
  const now = 1_000_000_000;
  assert.strictEqual(D.ago(now - 5_000, now), '5s ago');
  assert.strictEqual(D.ago(now - 120_000, now), '2m ago');
  assert.strictEqual(D.ago(now - 7_200_000, now), '2h ago');
  assert.strictEqual(D.ago(now - 5 * 86_400_000, now), '5d ago');
  // A clock that jumped must not print a negative age.
  assert.strictEqual(D.ago(now + 60_000, now), '0s ago');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');

test('THE FACT IS ACTUALLY RECORDED: an arriving push is counted', () => {
  // Without this listener the screen would report "never received" on every
  // phone, which is the wrong answer stated with total confidence.
  assert.ok(/addNotificationReceivedListener\(/.test(app),
    'nothing records that a push reached the app, so the screen always blames delivery');
  assert.ok(/notifyDiag\.record\('received'\)/.test(app));
  assert.ok(/recvSub\.remove\(\)/.test(app), 'the listener is never removed');
});

test('…and so are the other three', () => {
  for (const k of ['handler', 'token-accepted', 'socket-raised']) {
    assert.ok(new RegExp(`notifyDiag\\.record\\('${k}'`).test(app), `${k} is never recorded`);
  }
});

test('the screen shows it, and names the key rather than respelling it', () => {
  assert.ok(/notifyDiag\.verdict\(/.test(rooms), 'the screen never states a verdict');
  assert.ok(/receivedCount/.test(rooms), 'the screen does not show whether pushes arrive');
  assert.ok(/pushReg\.SENT_TOKEN_KEY/.test(rooms),
    'the storage key is written out a second time, which is how the two drift apart');
  assert.ok(!/'push-token-sent'/.test(rooms));
});

test('a silenced channel counts as off', () => {
  // Importance NONE(0) and MIN(1) draw nothing a user notices. Treating them
  // as "on" would report a healthy channel to somebody seeing nothing.
  assert.ok(/imp >= 2/.test(rooms),
    'a channel silenced to MIN or NONE is reported as enabled');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
