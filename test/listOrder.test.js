// ── Not moving the chat list out from under a finger ───────────────────────
//
// Reported as: a message arrives in a chat that is not at the top; on leaving
// that chat and returning to the list, it updates at that moment and the wrong
// conversation gets tapped because everything moved.
//
// The list is thrown away while a chat is open and built again on the way
// back. It paints immediately from the cache — the order from before — and the
// server's answer lands a moment later with the new order. That moment is
// exactly when somebody is reaching for the next conversation.
//
// Opening the wrong one is not a small error: it is a message sent to the
// wrong person, read receipts in a chat nobody meant to open, and on a
// disappearing message it cannot be taken back.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping list-order tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'lorder-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'listOrder.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const L = require(path.join(OUT, 'listOrder.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const NOW = 1_000_000;

test('A LIST THAT HAS JUST APPEARED DOES NOT REARRANGE', () => {
  // The reported case exactly: back from a chat, the cache is on screen, the
  // server's answer arrives, and a finger is already on the way down.
  assert.strictEqual(L.mayReorder({ shownAt: NOW, now: NOW + 100 }), false);
  assert.strictEqual(L.mayReorder({ shownAt: NOW, now: NOW + L.SETTLE_MS + 1 }), true);
});

test('A LIST BEING TOUCHED DOES NOT REARRANGE EITHER', () => {
  // Both conditions, not either. A list that has been up for a minute is
  // still being scrolled, and that is the same hazard.
  const old = NOW - 60_000;
  assert.strictEqual(L.mayReorder({ shownAt: old, lastTouchAt: NOW, now: NOW + 50 }), false);
  assert.strictEqual(
    L.mayReorder({ shownAt: old, lastTouchAt: NOW, now: NOW + L.QUIET_MS + 1 }), true);
});

test('NEVER TOUCHED IS NOT RECENTLY TOUCHED', () => {
  // A zero timestamp must not read as "touched at the epoch, which was ages
  // ago" NOR as "touched just now" — the first is right by luck, the second
  // would freeze the order for ever.
  assert.strictEqual(L.mayReorder({ shownAt: NOW - 60_000, lastTouchAt: 0, now: NOW }), true);
});

test('MISSING FACTS DO NOT HOLD THE LIST HOSTAGE', () => {
  // If this cannot tell, the answer is to let the list be correct. A rule
  // that defaults to "never reorder" would silently stop the list updating.
  assert.strictEqual(L.mayReorder({}), true);
  assert.strictEqual(L.mayReorder({ now: NOW }), true);
  assert.strictEqual(L.mayReorder(null), true);
});

test('HELD ORDER KEEPS POSITIONS BUT TAKES THE NEW CONTENT', () => {
  // The whole point: counts and previews must update immediately. It is only
  // the sequence that waits, because the sequence is what moves a target.
  const current = [{ id: 1, unread: 0 }, { id: 2, unread: 0 }, { id: 3, unread: 0 }];
  const incoming = [{ id: 3, unread: 5 }, { id: 1, unread: 0 }, { id: 2, unread: 0 }];
  const held = L.holdOrder(current, incoming);
  assert.deepStrictEqual(held.map(r => r.id), [1, 2, 3], 'the order moved');
  assert.strictEqual(held.find(r => r.id === 3).unread, 5, 'the new unread count was lost');
});

test('A CONVERSATION THAT IS GONE DOES NOT LINGER', () => {
  // Left or deleted. Keeping it would show a chat that is not there, which is
  // worse than a row moving.
  const held = L.holdOrder([{ id: 1 }, { id: 2 }], [{ id: 1 }]);
  assert.deepStrictEqual(held.map(r => r.id), [1]);
});

test('A BRAND NEW CONVERSATION STILL APPEARS, at the end for now', () => {
  // It has to appear from somewhere, and the end is the only place that
  // pushes nothing else aside. It takes its real position once the list
  // settles.
  const held = L.holdOrder([{ id: 1 }, { id: 2 }], [{ id: 9 }, { id: 1 }, { id: 2 }]);
  assert.deepStrictEqual(held.map(r => r.id), [1, 2, 9]);
});

test('AN EMPTY LIST TAKES THE SERVER ORDER STRAIGHT AWAY', () => {
  // First load: there is nothing on screen to protect, and holding would mean
  // showing an empty list while the data is already here.
  assert.deepStrictEqual(L.holdOrder([], [{ id: 2 }, { id: 1 }]).map(r => r.id), [2, 1]);
  assert.deepStrictEqual(L.holdOrder(null, [{ id: 2 }]).map(r => r.id), [2]);
  assert.deepStrictEqual(L.holdOrder([{ id: 1 }], null), []);
});

test('A ROW REPEATED IN THE OLD ORDER IS NOT DRAWN TWICE', () => {
  const held = L.holdOrder([{ id: 1 }, { id: 1 }, { id: 2 }], [{ id: 1 }, { id: 2 }]);
  assert.deepStrictEqual(held.map(r => r.id), [1, 2]);
});

test('A CONVERSATION WITH SOMETHING NEW GOES TO THE TOP', () => {
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepStrictEqual(L.bumpToTop(list, 3).map(r => r.id), [3, 1, 2]);
  // Ids arrive from the socket as numbers and from urls as strings.
  assert.deepStrictEqual(L.bumpToTop(list, '3').map(r => r.id), [3, 1, 2]);
});

test('…AND NOTHING HAPPENS WHEN NOTHING WOULD CHANGE', () => {
  // The same array back, so React skips the re-render — on a list that is
  // being redrawn for every arriving message, that matters.
  const list = [{ id: 1 }, { id: 2 }];
  assert.strictEqual(L.bumpToTop(list, 1), list, 'the row already first was moved anyway');
  assert.strictEqual(L.bumpToTop(list, 99), list, 'a room not in this list disturbed it');
  assert.strictEqual(L.bumpToTop(list, null), list);
  assert.deepStrictEqual(L.bumpToTop(null, 1), []);
});

test('BUMPING KEEPS EVERY OTHER ROW IN PLACE', () => {
  // A move that reshuffles the rest is the bug wearing a different hat.
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  assert.deepStrictEqual(L.bumpToTop(list, 3).map(r => r.id), [3, 1, 2, 4]);
});

// ── And the screen uses it ─────────────────────────────────────────────────

const strip = (f) => fs.readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const SCREEN = strip(path.join(NAT, 'src', 'screens', 'RoomsScreen.tsx'));

test('THE SERVER ANSWER GOES THROUGH THE HOLD', () => {
  assert.ok(/applyList\('rooms', r\)/.test(SCREEN), 'rooms are still set directly');
  assert.ok(/applyList\('dms', d\)/.test(SCREEN), 'dms are still set directly');
  assert.ok(!/if \(Array\.isArray\(r\)\) setRooms\(r\);/.test(SCREEN),
    'the old direct assignment is still there');
});

test('TOUCHES ARE NOTED, or the quiet rule can never fire', () => {
  assert.ok(/onTouchStart=\{\(\) => \{ lastTouchAt\.current = Date\.now\(\); \}\}/.test(SCREEN),
    'a finger on the list is not noticed');
  assert.ok(/onScrollBeginDrag=/.test(SCREEN), 'a scroll is not noticed');
});

test('A HELD ORDER IS NOT APPLIED A MOMENT LATER', () => {
  // This replaces a test that asserted the opposite, and the reversal is the
  // point. Holding the order and then applying it moved the list at ~750ms
  // instead of ~400ms — nearer the tap, not further from it — and the problem
  // came back a third time. There is no delay at which somebody is reliably
  // not reaching for a row.
  assert.ok(!/pendingOrder/.test(SCREEN),
    'a held order is still stored up to be applied later');
  assert.ok(!/setInterval\([\s\S]{0,400}?bumpToTop/.test(SCREEN),
    'a timer still reorders the list behind the person looking at it');
});

test('A MESSAGE ARRIVING MOVES NOTHING ON SCREEN', () => {
  // Reported a fourth time. The previous version moved a row whenever the
  // list had been up for a moment and nobody had touched it yet — which is
  // most of the time a list is on screen, and exactly when somebody is
  // choosing a row. It also contradicted the comment above it, which already
  // said the order is decided when the list opens and stays put.
  assert.ok(!/bumpToTop/.test(SCREEN),
    'the visible list still moves a row when a message arrives');
  assert.ok(!/applyBump/.test(SCREEN), 'the old bump path is still wired up');
  // The count still changes, which is the part that says something arrived.
  assert.ok(/setUnread\(prev => \(\{ \.\.\.prev, \[msg\.room_id\]/.test(SCREEN),
    'an arriving message no longer updates the unread count either');
});

test('THE SAVED LIST IS KEPT IN ORDER WHILE THE LIST IS CLOSED', () => {
  // The actual fix, and the one the previous three rounds did not attempt.
  // The list is thrown away while a chat is open and rebuilt from the copy on
  // the device — a copy last written BEFORE that chat was opened. Correcting
  // it afterwards is the bug; there is no moment at which the correction is
  // safe. So the copy is kept current while nobody can be reaching for it.
  const order = fs.readFileSync(path.join(NAT, 'src', 'roomOrder.ts'), 'utf8');
  assert.ok(/offline\.bumpRoom\(msg\?\.room_id\)/.test(order),
    'nothing keeps the saved order current');
  // onAny, or two screens' off('message_received') removes this listener too
  // — the hazard socketNotifier.ts exists because of.
  assert.ok(/socket\.onAny\(/.test(order), "uses on('message_received'), which any screen can remove");
  assert.ok(/attached === socket/.test(order), 'attaching twice adds two listeners');

  const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
  assert.ok(/roomOrder\.attach\(sock\)/.test(app), 'the order keeper is never attached');
  // Through onSocket, so a replaced socket is also covered — the mistake
  // that once left the notifier listening to a dead one.
  const eff = /const stop = onSocket\(sock => \{([\s\S]*?)\n    \}\);/.exec(app);
  assert.ok(eff && /roomOrder\.attach\(sock\)/.test(eff[1]),
    'it is attached once rather than to every socket');

  const store = fs.readFileSync(path.join(NAT, 'src', 'offlineStore.ts'), 'utf8');
  assert.ok(/export async function bumpRoom/.test(store), 'the store cannot reorder itself');
  assert.ok(/bumpToTop\(cached\.rooms, roomId\)/.test(store)
    && /bumpToTop\(cached\.dms, roomId\)/.test(store),
    'only one of the two lists is kept in order');
  assert.ok(/if \(rooms === cached\.rooms && dms === cached\.dms\) return;/.test(store),
    'a disk write per message in a busy chat, for no change');
});

test('PULLING TO REFRESH DOES REORDER', () => {
  // Otherwise a list whose order is held has no way back at all. Their own
  // gesture, their own expectation, and their finger is on the list rather
  // than on a row.
  assert.ok(/onRefresh=\{refresh\}/.test(SCREEN), 'pull to refresh does not go through refresh');
  const fn = /const refresh = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[load\]\);/.exec(SCREEN);
  assert.ok(fn, 'could not find refresh');
  assert.ok(/forceOrder\.current = true/.test(fn[1]), 'refresh does not force the order');
  assert.ok(/finally \{ forceOrder\.current = false; \}/.test(fn[1]),
    'the force is never cleared, so every later answer reorders too');
  const al = /const applyList = useCallback\(\(which: 'rooms' \| 'dms', incoming: Room\[\]\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(SCREEN);
  assert.ok(al && /forceOrder\.current \|\| mayReorder/.test(al[1]),
    'applyList ignores the forced refresh');
});

test('REFRESH IS DECLARED AFTER WHAT IT CALLS', () => {
  // `const load` in the same scope: naming it in a dependency array before
  // it exists throws on every render, which is a blank screen rather than a
  // misordered list. Caught here because it is invisible until it runs.
  assert.ok(SCREEN.indexOf('const load = useCallback') < SCREEN.indexOf('const refresh = useCallback'),
    'refresh reads load before it is initialised');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
