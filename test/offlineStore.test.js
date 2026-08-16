// Tests for the offline copy of chats (native-app/src/offlineStore.ts).
//
// What matters about this cache is what it REFUSES to hold. It exists so the
// app can be opened and read with no connection, which means it writes real
// message content to the device — so anything sent on the understanding that
// it would not persist must never reach it.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'offtest-'));
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping offline-store tests (native-app deps not installed)');
  process.exit(0);
}
// AsyncStorage cannot load off-device, so it is stubbed for the compile.
const SRC = path.join(__dirname, '..', 'native-app', 'src');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'offsrc-'));
fs.mkdirSync(path.join(WORK, 'stub'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'stub', 'index.ts'),
  'const s: any = { getItem: async () => null, setItem: async () => {},\n'
  + '  removeItem: async () => {}, multiRemove: async () => {} };\nexport default s;\n');
fs.writeFileSync(path.join(WORK, 'offlineStore.ts'),
  fs.readFileSync(path.join(SRC, 'offlineStore.ts'), 'utf8')
    .replace("from '@react-native-async-storage/async-storage'", "from './stub'"));

execFileSync(TSC, [path.join(WORK, 'offlineStore.ts'), '--outDir', OUT,
  '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const O = require(path.join(OUT, 'offlineStore.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const msg = (over = {}) => ({ id: 1, type: 'text', content: 'hi', ...over });

test('ordinary messages are kept', () => {
  const out = O.forStorage([msg({ id: 1 }), msg({ id: 2 })]);
  assert.deepStrictEqual(out.map(m => m.id), [1, 2]);
});

test('a DISAPPEARING message is never written to the device', () => {
  // The whole point of the feature is that the message stops existing. A copy
  // saved for offline reading would outlive it.
  const out = O.forStorage([msg({ id: 1 }), msg({ id: 2, disappear_seconds: 30 })]);
  assert.deepStrictEqual(out.map(m => m.id), [1],
    'a self-destructing message was saved to disk');
});

test('a ONE-TIME message is never written to the device', () => {
  const out = O.forStorage([msg({ id: 5, one_time_seconds: 10 })]);
  assert.deepStrictEqual(out, []);
});

test('messages still sending, or failed, are left to the outbox', () => {
  // The outbox persists these itself; a second copy here shows them twice.
  const out = O.forStorage([
    msg({ id: 1 }),
    msg({ id: 2, _uploading: true }),
    msg({ id: 3, _uploadFailed: true }),
    msg({ id: 'local-abc' }),         // optimistic id, not real history
  ]);
  assert.deepStrictEqual(out.map(m => m.id), [1]);
});

test('only the NEWEST messages are kept when there are too many', () => {
  // The tail is what someone opening a chat actually sees.
  const many = Array.from({ length: 100 }, (_, i) => msg({ id: i + 1 }));
  const out = O.forStorage(many, 10);
  assert.strictEqual(out.length, 10);
  assert.strictEqual(out[0].id, 91, 'kept the oldest messages instead of the newest');
  assert.strictEqual(out[9].id, 100);
});

test('the cap counts only what is actually stored', () => {
  // Excluded messages must not eat into the budget, or a chat with many
  // disappearing messages would keep almost no readable history.
  const list = [
    ...Array.from({ length: 20 }, (_, i) => msg({ id: i + 1, disappear_seconds: 30 })),
    ...Array.from({ length: 5 }, (_, i) => msg({ id: 100 + i })),
  ];
  assert.deepStrictEqual(O.forStorage(list, 5).map(m => m.id), [100, 101, 102, 103, 104]);
});

test('rubbish in does not throw', () => {
  assert.deepStrictEqual(O.forStorage(null), []);
  assert.deepStrictEqual(O.forStorage([null, undefined, msg()]).map(m => m.id), [1]);
});

test('the room index keeps the most recently opened chats', () => {
  const { kept, dropped } = O.trimIndex([
    { roomId: 'a', at: 100 },
    { roomId: 'b', at: 300 },
    { roomId: 'c', at: 200 },
  ], 2);
  assert.deepStrictEqual(kept.map(k => k.roomId), ['b', 'c']);
  assert.deepStrictEqual(dropped, ['a'], 'the wrong chat was evicted');
});

test('re-opening a chat refreshes its place instead of duplicating it', () => {
  const { kept, dropped } = O.trimIndex([
    { roomId: 'a', at: 100 },
    { roomId: 'b', at: 200 },
    { roomId: 'a', at: 300 },
  ], 2);
  assert.deepStrictEqual(kept.map(k => k.roomId), ['a', 'b']);
  assert.deepStrictEqual(dropped, [], 'a room was evicted because of its own older entry');
});

test('nothing is evicted while under the limit', () => {
  const { kept, dropped } = O.trimIndex([{ roomId: 'a', at: 1 }], 40);
  assert.strictEqual(kept.length, 1);
  assert.deepStrictEqual(dropped, []);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
