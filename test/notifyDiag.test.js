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

test('THE STALE ACCUSATION: an old handler decision does not blame the app', () => {
  // From a real screenshot: 2 pushes 23 seconds ago, and a handler decision
  // from 12 MINUTES earlier saying "hidden, app was open". The verdict read
  // that as "the app decided not to show the last one" — blaming the app for
  // hiding a notification it was never asked about.
  //
  // A diagnostic that accuses the wrong component is worse than one that says
  // nothing: it is exactly how the previous six rounds went wrong.
  let d = D.apply(D.empty(), { kind: 'handler', at: 1_000, showed: false });
  d = D.apply(d, { kind: 'received', at: 800_000 });   // arrived LATER
  const v = D.verdict(d, ok);
  assert.ok(!/decided not to show/i.test(v),
    `a stale handler decision is still blaming the app: ${v}`);
  assert.ok(/arriving/i.test(v), v);
});

test('…but a CURRENT refusal still does blame the app', () => {
  // The guard must not silence the real case, which is the one worth finding.
  let d = D.apply(D.empty(), { kind: 'received', at: 1_000 });
  d = D.apply(d, { kind: 'handler', at: 1_001, showed: false });
  assert.ok(/decided not to show/i.test(D.verdict(d, ok)));
  // Same instant counts as current — the handler runs microseconds after.
  let e = D.apply(D.empty(), { kind: 'received', at: 5_000 });
  e = D.apply(e, { kind: 'handler', at: 5_000, showed: false });
  assert.ok(/decided not to show/i.test(D.verdict(e, ok)));
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

test('THE COUNTER THAT LIED: a refused post is not counted as one shown', () => {
  // From a real screenshot: "shown by the app itself: 38 · last 2s ago" on a
  // phone that had shown none of them. The call site ran
  //
  //     notifee/expo post(...).catch(() => {});
  //     notifyDiag.record('socket-raised');
  //
  // so the record ran whether the post was accepted or refused, and the
  // rejection that would have said why was thrown away. Three builds shipped
  // believing this path worked because its own counter said so.
  let d = D.apply(D.empty(), { kind: 'socket-failed', at: 1000, error: 'Channel not found' });
  assert.strictEqual(d.socketRaisedCount, 0,
    'a refused post was counted under the "shown" label');
  assert.strictEqual(d.socketFailedCount, 1);
  const v = D.verdict(d, ok);
  assert.ok(/refused/i.test(v), v);
  assert.ok(/Channel not found/.test(v),
    'the reason Android gave is recorded but not reported, so it helps nobody');
});

test('…and refusals outrank everything the verdict says about Firebase', () => {
  // If the app's own posts are being refused, nothing appears no matter what
  // Google does — and "no push has ever reached this app / this is delivery,
  // not the app" would send the work in exactly the wrong direction again.
  let d = D.apply(D.empty(), { kind: 'socket-failed', at: 2000, error: 'boom' });
  assert.ok(!/delivery, not the app/i.test(D.verdict(d, ok)));
  // A refusal that has since been superseded by a successful post must NOT
  // keep accusing the app — the same staleness trap as the handler verdict.
  d = D.apply(d, { kind: 'socket-raised', at: 3000 });
  assert.ok(!/refused/i.test(D.verdict(d, ok)),
    'an old refusal still blames the app after posts started working again');
});

test('the failure reason is truncated and never null-crashes', () => {
  const long = D.apply(D.empty(), { kind: 'socket-failed', at: 1, error: 'x'.repeat(500) });
  assert.ok(long.lastSocketError.length <= 120);
  const none = D.apply(D.empty(), { kind: 'socket-failed', at: 1 });
  assert.strictEqual(none.lastSocketError, 'unknown');
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
// The socket notification moved OUT of App.tsx and into its own module, so
// that it is not torn off the socket when a screen unmounts — which is what
// made it work with the app open and not with it closed. These checks follow
// it there; App.tsx is still read for the listener and token wiring.
const notifier = fs.readFileSync(path.join(NAT, 'src', 'socketNotifier.ts'), 'utf8');
const both = app + '\n' + notifier;
const rooms = fs.readFileSync(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');

test('THE FACT IS ACTUALLY RECORDED: an arriving push is counted', () => {
  // Without this listener the screen would report "never received" on every
  // phone, which is the wrong answer stated with total confidence.
  assert.ok(/addNotificationReceivedListener\(/.test(app),
    'nothing records that a push reached the app, so the screen always blames delivery');
  assert.ok(/notifyDiag\.record\('received'\)/.test(app));
  assert.ok(/recvSub\.remove\(\)/.test(app), 'the listener is never removed');
});

test('…and so are the other four', () => {
  for (const k of ['handler', 'token-accepted', 'socket-raised', 'socket-failed']) {
    assert.ok(new RegExp(`notifyDiag\\.record\\('${k}'`).test(both), `${k} is never recorded`);
  }
});

test('THE POST IS NOT FIRE-AND-FORGET: its result decides what is recorded', () => {
  // The bug this file exists to prevent, in its own call site. Read the socket
  // handler's post and require that 'socket-raised' is recorded from the
  // RESULT of the call, not on a line that runs regardless.
  const code = notifier.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf('notifee.displayNotification({');
  assert.ok(i > 0, 'the socket notification is no longer posted through notifee');
  // Bounded by what FOLLOWS the post, not by a character count: a fixed window
  // breaks the moment a line is added, and then passes while checking nothing.
  const end = code.indexOf("socket.on('message_deleted'", i);
  assert.ok(end > i);
  const post = code.slice(i, end);
  assert.ok(/\.then\(/.test(post),
    "the post's result is discarded, so the counter measures attempts again");
  assert.ok(/notifyDiag\.record\('socket-failed'/.test(post),
    'a refused notification is silently dropped — the exact 38-that-were-0 bug');
  assert.ok(!/\.catch\(\(\) => \{\}\)/.test(post),
    'the rejection is swallowed by a bare catch, hiding why nothing appears');
});

test('the socket post names the Messages channel, and notifee owns that channel', () => {
  // Posting on the default channel is silent AND, sharing a tag with the
  // server's FCM notification, turns the sounded one into a soundless update.
  const code = notifier.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf('notifee.displayNotification({');
  const post = code.slice(i, code.indexOf("socket.on('message_deleted'", i));
  assert.ok(/channelId: MESSAGES_CHANNEL/.test(post), 'the socket post has no channel');
  assert.ok(/tag: pushReg\.notificationTag/.test(post),
    'without the matching tag, FCM and the socket stack two notifications');
  // notifee REJECTS on an unknown channel, so it must create it itself rather
  // than trusting expo-notifications to have done it.
  assert.ok(/notifee\.createChannel\(\{[\s\S]{0,400}id: MESSAGES_CHANNEL/.test(app),
    'notifee posts on a channel it never creates; the first post rejects');
});

test('expo\'s scheduler is not in the path any more', () => {
  // trigger: { channelId } named the right channel and displayed NOTHING: a
  // non-null trigger SCHEDULES in expo-notifications, whatever
  // ChannelAwareTriggerInput's documentation implies. Build 293 posted 38 of
  // these and the phone showed none.
  const code = both.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/trigger: \{ channelId: MESSAGES_CHANNEL \}/.test(code),
    'the scheduling trigger is back; these notifications will not appear');
});

test('the screen shows it, and names the key rather than respelling it', () => {
  assert.ok(/notifyDiag\.verdict\(/.test(rooms), 'the screen never states a verdict');
  assert.ok(/receivedCount/.test(rooms), 'the screen does not show whether pushes arrive');
  assert.ok(/pushReg\.SENT_TOKEN_KEY/.test(rooms),
    'the storage key is written out a second time, which is how the two drift apart');
  assert.ok(!/'push-token-sent'/.test(rooms));
});

test('a silenced channel counts as off, on EXPO\'s scale not Android\'s', () => {
  // expo-notifications numbers importance differently from the Android
  // constants: NONE=2, MIN=3, LOW=4, DEFAULT=5, HIGH=6, MAX=7. The first
  // version of this check used Android's 0-5 scale and so reported a fully
  // silenced channel (expo NONE = 2) as enabled — the precise false
  // reassurance this screen exists to prevent.
  assert.ok(/imp >= 4/.test(rooms),
    'the channel check uses the wrong scale, so a silenced channel reads as on');
  assert.ok(!/imp >= 2\b/.test(rooms), 'the Android-scale threshold is back');
  // Pinned against the library itself, so a version that renumbers the enum
  // fails here instead of quietly lying on somebody's phone.
  const enumSrc = fs.readFileSync(path.join(
    NAT, 'node_modules', 'expo-notifications', 'build',
    'NotificationChannelManager.types.d.ts'), 'utf8');
  assert.ok(/NONE = 2/.test(enumSrc) && /LOW = 4/.test(enumSrc) && /MAX = 7/.test(enumSrc),
    'expo renumbered AndroidImportance; the threshold in RoomsScreen must be rechecked');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
