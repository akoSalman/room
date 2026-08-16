// Tests for the connection indicator (native-app/src/connection.ts and
// connectionBanner.ts).
//
// Two things have to be true for this to be worth having:
//   • while there is no connection, the app SAYS SO — saved chats and live
//     chats look identical otherwise, and someone reading old messages with no
//     warning will assume they are current;
//   • when the connection returns, the app says that too, and then stops. A
//     warning that silently vanishes leaves the user unsure whether it is safe
//     to send.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'conntest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping connection tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [
  path.join(SRC, 'connection.ts'), path.join(SRC, 'connectionBanner.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
], { stdio: 'pipe' });
const B = require(path.join(OUT, 'connectionBanner.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// connection.ts holds module state, so each test gets a fresh copy.
function freshConnection() {
  delete require.cache[path.join(OUT, 'connection.js')];
  return require(path.join(OUT, 'connection.js'));
}

// ── The banner ───────────────────────────────────────────────────────────────

test('offline is shown, for as long as it lasts', () => {
  assert.strictEqual(B.bannerFor('offline', 0, false), 'offline');
  assert.strictEqual(B.bannerFor('offline', 60 * 60 * 1000, true), 'offline',
    'the warning timed out while still offline');
});

test('starting up connected says nothing', () => {
  // The app must not congratulate the user on having a connection at launch.
  assert.strictEqual(B.bannerFor('online', 0, false), 'hidden');
  assert.strictEqual(B.bannerFor('online', 10, false), 'hidden');
});

test('coming back online is announced', () => {
  assert.strictEqual(B.bannerFor('online', 0, true), 'restored');
  assert.strictEqual(B.bannerFor('online', B.RESTORED_MS - 1, true), 'restored');
});

test('the "back online" note goes away by itself', () => {
  assert.strictEqual(B.bannerFor('online', B.RESTORED_MS, true), 'hidden');
  assert.strictEqual(B.bannerFor('online', B.RESTORED_MS + 5000, true), 'hidden');
});

// ── The state itself ─────────────────────────────────────────────────────────

test('the app assumes it is online until told otherwise', () => {
  // Starting at "offline" would flash a warning at every single launch.
  const c = freshConnection();
  assert.strictEqual(c.isOnline(), true);
});

test('subscribers hear about a drop and a recovery', () => {
  const c = freshConnection();
  const seen = [];
  c.subscribe(s => seen.push(s));
  c.report(false);
  c.report(true);
  assert.deepStrictEqual(seen, ['offline', 'online']);
});

test('repeating the same state notifies nobody', () => {
  // The socket and ordinary requests both report reachability, so the same
  // answer arrives many times; each one must not re-trigger the banner and
  // restart its timer.
  const c = freshConnection();
  const seen = [];
  c.subscribe(s => seen.push(s));
  c.report(true);            // already online
  c.report(false);
  c.report(false);
  c.report(false);
  assert.deepStrictEqual(seen, ['offline']);
});

test('the change is timestamped, and only on a real change', () => {
  const c = freshConnection();
  c.report(false);
  const at = c.since();
  c.report(false);           // not a change
  assert.strictEqual(c.since(), at, 'a repeated report restarted the clock');
});

test('unsubscribing actually stops the callbacks', () => {
  const c = freshConnection();
  const seen = [];
  const off = c.subscribe(s => seen.push(s));
  off();
  c.report(false);
  assert.deepStrictEqual(seen, []);
});

test('one listener throwing does not silence the others', () => {
  // A screen unmounting mid-notification must not take the banner with it.
  const c = freshConnection();
  const seen = [];
  c.subscribe(() => { throw new Error('boom'); });
  c.subscribe(s => seen.push(s));
  c.report(false);
  assert.deepStrictEqual(seen, ['offline']);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
