// Tests for the outbox (native-app/src/outbox.ts) — the crash-safety copy of
// in-flight sends.
//
// This exists because "the message sent twice" has come back repeatedly. The
// cause is a read-modify-write race that only shows up when the server ack
// lands at almost the same moment the copy is being persisted, which is
// exactly what happens when you send and immediately leave the chat. Reasoning
// about it was clearly not enough, so it is pinned down here: the AsyncStorage
// stub below lets the test control that timing precisely.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'outboxtest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'outbox.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping outbox tests (native-app deps not installed)');
  process.exit(0);
}

// ── Stubs, resolvable from the compiled file ────────────────────────────────
// getItem is deliberately slow so a read-modify-write cycle can be interleaved
// with another on purpose.
let readDelayMs = 0;
const store = new Map();
const asDir = path.join(OUT, 'node_modules', '@react-native-async-storage', 'async-storage');
fs.mkdirSync(asDir, { recursive: true });
fs.writeFileSync(path.join(asDir, 'package.json'), JSON.stringify({ name: 'async-storage', main: 'index.js' }));
fs.writeFileSync(path.join(asDir, 'index.js'), `
const store = global.__OUTBOX_STORE__;
// __esModule matters: without it esModuleInterop hands outbox the whole
// module object instead of .default, every AsyncStorage call throws into the
// try/catch, nothing is ever written — and the tests all pass vacuously.
exports.__esModule = true;
module.exports.default = {
  getItem: (k) => new Promise(r => setTimeout(() => r(store.has(k) ? store.get(k) : null), global.__OUTBOX_DELAY__)),
  setItem: (k, v) => { store.set(k, v); return Promise.resolve(); },
  multiRemove: () => Promise.resolve(),
};
`);
global.__OUTBOX_STORE__ = store;
Object.defineProperty(global, '__OUTBOX_DELAY__', { get: () => readDelayMs });

execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck', '--esModuleInterop'],
  { stdio: 'pipe' });
// AFTER compiling: tsc follows the import and emits the real api.js, which
// drags in socket.io and the rest. outbox only wants getSocket for its
// app-wide ack listener, so replace it with a stub that never connects.
fs.writeFileSync(path.join(OUT, 'api.js'), 'module.exports = { getSocket: () => Promise.reject(new Error("no socket in tests")) };');
const outbox = require(path.join(OUT, 'outbox.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const failedFor = (roomId) => JSON.parse(store.get(`failed-msgs-${roomId}`) || '[]');

// ── tests ───────────────────────────────────────────────────────────────────

test('an acked send leaves nothing behind, even when the ack beats the write', async () => {
  store.clear();
  readDelayMs = 40; // make the read-modify-write window wide and deterministic

  const roomId = 1;
  const clientId = 'tmp-race-1';
  outbox.markStart(clientId, roomId);

  // remember() starts first (as dispatchText does)…
  const persisting = outbox.remember(roomId, { id: clientId, type: 'text', content: 'hello' });
  // …and the server ack arrives while it is still mid-cycle. This is the
  // "send, then immediately leave the chat" case.
  await new Promise(r => setTimeout(r, 10));
  outbox.markDone(clientId);
  const forgetting = outbox.forget(roomId, clientId);

  await Promise.all([persisting, forgetting]);
  // Let any late write settle before asserting.
  await new Promise(r => setTimeout(r, 60));

  assert.deepStrictEqual(failedFor(roomId), [],
    'a delivered message was left in the outbox — it would be resent on re-entering the chat');
});

test('a send that is never acked IS kept, so it can be retried', async () => {
  store.clear();
  readDelayMs = 0;

  const roomId = 2;
  const clientId = 'tmp-keep-2';
  outbox.markStart(clientId, roomId);
  await outbox.remember(roomId, { id: clientId, type: 'text', content: 'undelivered' });

  const kept = failedFor(roomId);
  assert.strictEqual(kept.length, 1, 'an unacked message must survive for retry');
  assert.strictEqual(kept[0].content, 'undelivered');
  assert.strictEqual(kept[0]._uploadFailed, true);
});

test('a delivered id can never be re-persisted afterwards', async () => {
  store.clear();
  readDelayMs = 0;

  const roomId = 3;
  const clientId = 'tmp-late-3';
  outbox.markStart(clientId, roomId);
  outbox.markDone(clientId);
  // A late failure handler tries to persist it after the ack.
  await outbox.remember(roomId, { id: clientId, type: 'text', content: 'late' });

  assert.deepStrictEqual(failedFor(roomId), [],
    'a message the server already has was persisted anyway');
});

test('deleting a failed message tombstones it against a retry re-persisting', async () => {
  store.clear();
  readDelayMs = 0;

  const roomId = 4;
  const first = 'tmp-origin-4';
  outbox.markStart(first, roomId);
  await outbox.remember(roomId, { id: first, type: 'text', content: 'doomed' });
  await outbox.discard(roomId, { id: first, _originId: first });
  assert.deepStrictEqual(failedFor(roomId), [], 'discard did not remove the entry');

  // A retry dispatches a NEW client id carrying the same origin; when it fails
  // it must not bring the deleted message back.
  const retryId = 'tmp-retry-4';
  outbox.setNextOrigin(first, 1);
  outbox.markStart(retryId, roomId);
  await outbox.remember(roomId, { id: retryId, type: 'text', content: 'doomed' });

  assert.deepStrictEqual(failedFor(roomId), [],
    'a deleted message came back through a retry');
});

(async () => {
  // ── The failed-message controls ────────────────────────────────────────────

// Comments stripped -- BOTH kinds. These assertions are about running code,
// and a test that is satisfied by a sentence someone wrote about the code
// proves nothing. This file has been fooled that way three times: by an HTML
// comment naming a selector, by a CSS comment quoting a rule, and by an
// import line. Block comments matter here because JSX explanations are
// written as {/* ... */} and sit right beside the thing they describe.
const CHAT = require('fs').readFileSync(require('path').join(__dirname, '..',
  'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

test('THE RETRY LINK UNDER THE MESSAGE IS GONE', () => {
  // Reported: tapping it ALSO opened the message menu. A bubble watches its
  // own touches, and those fire whether or not the bubble owns the responder,
  // so the tap that retried went on to open the menu over it.
  assert.ok(!/tap to retry/i.test(CHAT), 'the retry link is still there');
  assert.ok(!/uploadRetryText/.test(CHAT), 'the retry link style is still referenced');
});

test('THE CORNER BUTTON IS THE RETRY, for a send that failed', () => {
  // One thing is worth offering on a failed send, so the button is that
  // thing rather than a menu of everything else.
  assert.ok(/msg\._uploadFailed \?[\s\S]{0,400}?name="refresh"/.test(CHAT),
    'a failed message does not offer a retry icon in its corner');
  // Through tokenPress, which is how this file says a touch is already
  // answered -- without it the retry also opens the menu, which is the bug.
  assert.ok(/tokenPress\(\(\) => retryUpload\(msg, true\)\)/.test(CHAT),
    'the retry is not routed through tokenPress, so it opens the menu too');
});

test('...and an ordinary message still gets its menu', () => {
  // The failed case must not swallow the normal one.
  assert.ok(/setActionsMsg\(\{ msg, x: e\.nativeEvent\.pageX/.test(CHAT),
    'ordinary messages lost their menu button');
});

test('SWIPING A FAILED SEND DISCARDS IT LOCALLY', () => {
  // It has no id on the server, so the ordinary delete would ask the server
  // to remove a message it has never heard of.
  assert.ok(/onSwipeLeft=\{msg\._uploadFailed \? \(\) => discardFailed\(msg\)/.test(CHAT),
    'swiping a failed send away does not discard it');
  assert.ok(/: mine \? \(\) => deleteMsg\(msg\.id, true\)/.test(CHAT),
    'swiping a real message of mine no longer deletes it');
});

test('OPENING A CHAT RETRIES EVERY FAILED SEND, not the first three', () => {
  // Asked for in those words. The cap it replaces existed because a send
  // that could never succeed looped for ever with no way out -- the way out
  // now is that a failed message shows a retry button and can be swiped away.
  assert.ok(!/MAX_AUTO_RETRIES/.test(CHAT),
    'the attempt cap still gates the retry on open');
  // What must NOT be retried is a send whose file was only ever a cache path.
  assert.ok(/\^\(file\|content\):/.test(CHAT),
    'a send with no local file left is retried, which can only ever fail');
});

let passed = 0, failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
