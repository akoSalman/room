// Photos staged in the composer, kept across leaving the chat.
//
// Reported as: after taking pictures and not sending them yet, or while
// editing one, swiping right or tapping back to the chat list and then coming
// back — the images are gone.
//
// They were. Staged attachments lived only in the chat screen's state, and
// going back unmounts that screen. The files were still on the device with
// nothing pointing at them, which is the worst version of losing something.
//
// What is worth pinning down is not "does it save" but the ways a restore can
// be worse than nothing: a tile pointing at a file the OS has cleared, a draft
// outliving its conversation, and one chat's photos appearing in another.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping pending-media tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendingmedia-'));
execFileSync(TSC, [path.join(NAT, 'src', 'pendingMedia.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const P = require(path.join(OUT, 'pendingMedia.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const NOW = Date.parse('2026-08-23T10:00:00Z');
const photo = (n) => ({ uri: `file:///cache/p${n}.jpg`, name: `p${n}.jpg`, mime: 'image/jpeg' });

test('THE BUG: staged photos survive a round trip through storage', () => {
  const items = [photo(1), photo(2)];
  assert.deepStrictEqual(P.parse(P.serialize(items, NOW), NOW), items);
});

test('one chat\'s photos cannot appear in another', () => {
  assert.notStrictEqual(P.draftKey(7), P.draftKey(8));
  assert.ok(P.draftKey(7).includes('7'));
});

test('nothing staged writes nothing, rather than an empty draft', () => {
  // The caller removes the key when this is null; a stored empty list would be
  // an eternal no-op read on every chat open.
  assert.strictEqual(P.serialize([], NOW), null);
  assert.strictEqual(P.serialize(null, NOW), null);
});

test('an entry with no file behind it is never stored', () => {
  assert.strictEqual(P.serialize([{ name: 'x.jpg', mime: 'image/jpeg' }], NOW), null);
  const mixed = P.serialize([photo(1), { uri: '' }], NOW);
  assert.strictEqual(P.parse(mixed, NOW).length, 1);
});

test('a corrupt or missing draft is no draft, not a crash', () => {
  // This runs while a chat is opening; a throw here takes the screen with it.
  assert.deepStrictEqual(P.parse(null, NOW), []);
  assert.deepStrictEqual(P.parse('', NOW), []);
  assert.deepStrictEqual(P.parse('{not json', NOW), []);
  assert.deepStrictEqual(P.parse('{"items":"nope"}', NOW), []);
  assert.deepStrictEqual(P.parse('42', NOW), []);
});

test('a draft older than a month is dropped', () => {
  // Camera captures live in the cache, which Android empties when it likes. A
  // month-old draft is a list of dead paths far more often than a message.
  const old = P.serialize([photo(1)], NOW - P.MAX_AGE_MS - 1);
  assert.deepStrictEqual(P.parse(old, NOW), []);
  const fresh = P.serialize([photo(1)], NOW - P.MAX_AGE_MS + 1000);
  assert.strictEqual(P.parse(fresh, NOW).length, 1, 'a draft inside the window was thrown away');
});

test('a draft written by the older format is still read', () => {
  // Upgrading must not silently bin somebody's staged photos.
  const legacy = JSON.stringify([photo(1), photo(2)]);
  assert.strictEqual(P.parse(legacy, NOW).length, 2);
});

test('a missing name or type is filled in rather than rejected', () => {
  const [m] = P.parse(JSON.stringify({ at: NOW, items: [{ uri: 'file:///a/b/holiday.jpg' }] }), NOW);
  assert.strictEqual(m.name, 'holiday.jpg');
  assert.ok(m.mime.length > 0);
});

// ── Files the system took away ──────────────────────────────────────────────

test('THE OTHER HALF: a photo whose file has gone is not restored', () => {
  // Restoring it shows a broken tile that then fails on send, with nothing on
  // screen to explain why.
  const items = [photo(1), photo(2)];
  const kept = P.keepExisting(items, uri => uri.endsWith('p2.jpg'));
  assert.deepStrictEqual(kept.map(m => m.name), ['p2.jpg']);
});

test('a content:// or remote URI is not ours to check, and is kept', () => {
  const items = [
    { uri: 'content://media/1', name: 'a', mime: 'image/jpeg' },
    { uri: 'https://example.com/b.jpg', name: 'b', mime: 'image/jpeg' },
  ];
  assert.deepStrictEqual(P.keepExisting(items, () => false), items,
    'a URI that cannot be stat-ed was thrown away as if it were missing');
});

test('losing photos is said out loud, once, and in plain words', () => {
  assert.strictEqual(P.lostMessage(2, 2), '', 'a complaint about nothing');
  assert.ok(/One staged photo/.test(P.lostMessage(1, 0)));
  assert.ok(/2 staged photos/.test(P.lostMessage(3, 1)));
  assert.strictEqual(P.lostMessage(1, 3), '', 'gaining photos was reported as losing them');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const screen = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('the screen actually saves and restores the staged list', () => {
  assert.ok(screen.includes('pending.draftKey(room.id)'), 'nothing is stored per room');
  assert.ok(screen.includes('pending.parse('), 'nothing is read back');
  assert.ok(screen.includes('pending.serialize('), 'nothing is written');
});

test('the first render does not erase the draft it is about to read', () => {
  // pendingMedia starts empty, so a save on the first render would write "no
  // photos" over the draft before the restore has had a chance to run.
  assert.ok(/restoredDraft = useRef\(false\)/.test(screen), 'there is no guard at all');
  assert.ok(/if \(!restoredDraft\.current\) return;/.test(screen),
    'the save effect runs before the restore has finished');
});

test('the restore does not throw away a photo taken while it was loading', () => {
  assert.ok(/prev\.length \? \[\.\.\.items, \.\.\.prev\] : items/.test(screen),
    'the restore replaces the staged list instead of merging with it');
});

test('files gone from the cache are checked for, not assumed', () => {
  assert.ok(screen.includes('FileSystem.getInfoAsync(m.uri)'), 'the restore trusts the draft');
  assert.ok(screen.includes('pending.keepExisting('), 'nothing filters the dead entries');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
