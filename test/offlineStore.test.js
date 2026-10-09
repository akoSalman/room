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
// A REAL in-memory store, not one that throws everything away: bumpRoom
// reads what it wrote, and a stub that forgets would make it look correct
// whatever it did.
fs.writeFileSync(path.join(WORK, 'stub', 'index.ts'),
  'export const mem = new Map<string, string>();\n'
  + 'const s: any = {\n'
  + '  getItem: async (k: string) => (mem.has(k) ? mem.get(k) : null),\n'
  + '  setItem: async (k: string, v: string) => { mem.set(k, v); },\n'
  + '  removeItem: async (k: string) => { mem.delete(k); },\n'
  + '  multiRemove: async (ks: string[]) => { ks.forEach(k => mem.delete(k)); },\n'
  + '};\nexport default s;\n');
fs.writeFileSync(path.join(WORK, 'offlineStore.ts'),
  fs.readFileSync(path.join(SRC, 'offlineStore.ts'), 'utf8')
    .replace("from '@react-native-async-storage/async-storage'", "from './stub'"));
// offlineStore now reuses the chat list's own ordering rule rather than
// keeping a second copy of it.
fs.copyFileSync(path.join(SRC, 'listOrder.ts'), path.join(WORK, 'listOrder.ts'));

execFileSync(TSC, [path.join(WORK, 'offlineStore.ts'), '--outDir', OUT,
  '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const O = require(path.join(OUT, 'offlineStore.js'));
const MEM = require(path.join(OUT, 'stub')).mem;

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

// ── Opening in the right order ─────────────────────────────────────────────
//
// Reported four times as the chat list moving under a finger. The list is
// thrown away while a chat is open and rebuilt from this copy — a copy last
// written BEFORE that chat was opened, so it is missing everything that
// arrived since and has to be corrected while somebody is reaching for a row.
// Keeping it current while the list is closed means there is nothing to
// correct.

// The key offlineStore actually writes. Read from the source rather than
// written out again here: a test that guesses the key passes whatever the
// code does, because every assertion then compares undefined with undefined.
const ROOMS_KEY = (/const ROOMS_KEY = '([^']+)'/
  .exec(fs.readFileSync(path.join(SRC, 'offlineStore.ts'), 'utf8')) || [])[1];
assert.ok(ROOMS_KEY, 'could not find the room-list storage key');
const rooms = () => JSON.parse(MEM.get(ROOMS_KEY) || 'null');

test('A MESSAGE MOVES ITS CONVERSATION IN THE SAVED LIST', async () => {
  MEM.clear();
  await O.saveRooms([{ id: 1 }, { id: 2 }, { id: 3 }], [{ id: 9 }]);
  await O.bumpRoom(3);
  assert.deepStrictEqual(rooms().rooms.map(r => r.id), [3, 1, 2],
    'the next open still draws the old order');
  assert.deepStrictEqual(rooms().dms.map(r => r.id), [9], 'the other list was disturbed');
});

test('…AND A DM MOVES IN ITS OWN LIST', async () => {
  MEM.clear();
  await O.saveRooms([{ id: 1 }], [{ id: 8 }, { id: 9 }]);
  await O.bumpRoom(9);
  assert.deepStrictEqual(rooms().dms.map(r => r.id), [9, 8], 'direct messages never reorder');
  assert.deepStrictEqual(rooms().rooms.map(r => r.id), [1]);
});

test('IDS FROM THE SOCKET ARE NUMBERS; IDS IN THE LIST MAY NOT BE', async () => {
  MEM.clear();
  await O.saveRooms([{ id: '1' }, { id: '2' }], []);
  await O.bumpRoom(2);
  assert.deepStrictEqual(rooms().rooms.map(r => r.id), ['2', '1'],
    'a string id never matches, so nothing is ever reordered');
});

test('NOTHING IS WRITTEN WHEN NOTHING WOULD CHANGE', async () => {
  // Otherwise this is a disk write for every message in a busy chat.
  MEM.clear();
  await O.saveRooms([{ id: 1 }, { id: 2 }], []);
  const before = MEM.get(ROOMS_KEY);
  await O.bumpRoom(1);            // already first
  assert.strictEqual(MEM.get(ROOMS_KEY), before, 'rewrote the list to the same order');
  await O.bumpRoom(999);          // not in the list at all
  assert.strictEqual(MEM.get(ROOMS_KEY), before, 'rewrote the list for an unknown room');
});

test('A ROOM ID THAT IS MISSING OR RUBBISH CHANGES NOTHING', async () => {
  MEM.clear();
  await O.saveRooms([{ id: 1 }, { id: 2 }], []);
  const before = MEM.get(ROOMS_KEY);
  await O.bumpRoom(null);
  await O.bumpRoom(undefined);
  assert.strictEqual(MEM.get(ROOMS_KEY), before);
});

test('WITH NO SAVED LIST THERE IS NOTHING TO REORDER', async () => {
  // First run of the app: a bump must not invent a list.
  MEM.clear();
  await O.bumpRoom(3);
  assert.strictEqual(MEM.get(ROOMS_KEY), undefined, 'a list was written out of nothing');
});

const MEDIA_PREFIX = (/const MEDIA_PREFIX = '([^']+)'/
  .exec(fs.readFileSync(path.join(SRC, 'offlineStore.ts'), 'utf8')) || [])[1];
assert.ok(MEDIA_PREFIX, 'could not find the gallery storage key');

test('ROOMS SAVED IN THE SAME MILLISECOND EVICT THE OLDEST, not the newest', () => {
  // Timestamps come from Date.now(), and refreshing a chat list writes
  // several rooms inside one millisecond. Sorting by time alone left those
  // in insertion order — oldest first — so the rooms just written were the
  // ones thrown away.
  //
  // The index is kept NEWEST FIRST and a new entry goes at the front, so with
  // equal timestamps the END of the list is the oldest.
  const at = 1000;
  const index = Array.from({ length: O.MAX_ROOMS + 2 }, (_, i) => ({ roomId: `r${i}`, at }));
  const { kept, dropped } = O.trimIndex(index);
  assert.strictEqual(kept.length, O.MAX_ROOMS);
  assert.deepStrictEqual(dropped.sort(), [`r${O.MAX_ROOMS}`, `r${O.MAX_ROOMS + 1}`].sort(),
    'the most recently written rooms were evicted instead of the oldest');
  assert.strictEqual(kept[0].roomId, 'r0', 'the newest entry did not stay first');
});

test('A GALLERY IS WRITTEN AND READ BACK', async () => {
  MEM.clear();
  const state = { images: [{ url: '/uploads/a.jpg' }], files: [], music: [], links: [] };
  await O.saveMedia(7, state);
  assert.deepStrictEqual(await O.loadMedia(7), state, 'offline the gallery is still empty');
  assert.deepStrictEqual(await O.loadMedia(8), null, 'a room with no gallery returned one');
});

test('SAVING NOTHING REMOVES WHAT WAS THERE', async () => {
  // A gallery that becomes entirely unkeepable must not leave the old copy
  // behind to be shown instead.
  MEM.clear();
  await O.saveMedia(7, { images: [{ url: '/uploads/a.jpg' }] });
  await O.saveMedia(7, null);
  assert.strictEqual(await O.loadMedia(7), null, 'a stale gallery was left on the device');
});

test('A ROOM EVICTED FOR BEING OLD TAKES ITS GALLERY WITH IT', async () => {
  // Otherwise the galleries accumulate for ever, one per room ever opened,
  // with nothing that would ever remove them.
  MEM.clear();
  for (let i = 0; i < O.MAX_ROOMS + 3; i++) {
    await O.saveMedia(1000 + i, { images: [{ url: `/uploads/${i}.jpg` }] });
  }
  assert.strictEqual(await O.loadMedia(1000), null, 'the oldest gallery was never removed');
  assert.ok(await O.loadMedia(1000 + O.MAX_ROOMS + 2), 'the newest gallery was removed');
  const left = [...MEM.keys()].filter(k => k.startsWith(MEDIA_PREFIX)).length;
  assert.ok(left <= O.MAX_ROOMS, `${left} galleries kept for a limit of ${O.MAX_ROOMS}`);
});

test('SIGNING OUT LEAVES NO GALLERY BEHIND', async () => {
  // The next account must not open a chat and find the previous one's
  // photographs listed in it.
  MEM.clear();
  await O.saveMessages(7, [{ id: 1, type: 'text', content: 'hi' }]);
  await O.saveMedia(7, { images: [{ url: '/uploads/a.jpg' }] });
  await O.clearAll();
  assert.strictEqual(await O.loadMedia(7), null, "the last account's gallery is still readable");
  assert.strictEqual([...MEM.keys()].filter(k => k.startsWith(MEDIA_PREFIX)).length, 0);
});

let passed = 0, failed = 0;
(async () => {
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
