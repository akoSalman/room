// Searching end-to-end encrypted messages on the device
// (native-app/src/localSearch.ts).
//
// The server holds ciphertext and no key, so it cannot search these — it was
// excluding them and reporting the count. Honest, but the user still could not
// find their own messages. The device has the key, so the device does the work.
//
// Most of what is worth testing here is Persian. Written Persian has several
// ways to spell the same word, and matching that ignores them finds nothing
// while appearing to work.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'locsearch-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'localSearch.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping local-search tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const L = require(path.join(OUT, 'localSearch.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const msg = (id, content) => ({ id, content });

test('plain matching, and it is case insensitive', () => {
  assert.ok(L.matches('Hello there', 'hello'));
  assert.ok(L.matches('hello there', 'THERE'));
  assert.ok(!L.matches('hello there', 'goodbye'));
});

test('an empty query matches nothing', () => {
  // Otherwise every message in the chat is a "result".
  assert.strictEqual(L.matches('anything', ''), false);
  assert.strictEqual(L.matches('anything', '   '), false);
});

test('Arabic and Farsi yeh are the same letter to a reader', () => {
  // ي (Arabic) vs ی (Farsi) are indistinguishable in most fonts, and which one
  // a phone produces depends on the keyboard.
  assert.ok(L.matches('سلام علي', 'علی'), 'Arabic yeh in the text was not found');
  assert.ok(L.matches('سلام علی', 'علي'), 'Arabic yeh in the query did not match');
});

test('Arabic kaf and Farsi keheh are the same letter too', () => {
  assert.ok(L.matches('كتاب', 'کتاب'));
  assert.ok(L.matches('کتاب', 'كتاب'));
});

test('THE PERSIAN CASE: a missing zero-width non-joiner still matches', () => {
  // می‌روم is written with an invisible ZWNJ. Nobody types it into a search box.
  assert.ok(L.matches('من می‌روم خانه', 'میروم'),
    'a search without the invisible joiner found nothing');
  // And the other way round.
  assert.ok(L.matches('من میروم خانه', 'می‌روم'));
});

test('the alef family is one letter', () => {
  assert.ok(L.matches('أحمد', 'احمد'));
  assert.ok(L.matches('إسلام', 'اسلام'));
  assert.ok(L.matches('آب', 'اب'));
});

test('optional vowel marks are ignored', () => {
  // Harakat are rarely typed, and a message that has them must still be found.
  assert.ok(L.matches('کِتاب', 'کتاب'));
  assert.ok(L.matches('مُحَمَّد', 'محمد'));
});

test('Persian and Arabic digits match ASCII ones', () => {
  // A phone number typed with Persian digits has to be findable with a keypad.
  assert.ok(L.matches('شماره ۰۹۱۲۳۴۵۶۷۸۹', '0912'));
  assert.ok(L.matches('رقم ٠١٢٣', '0123'));
  assert.ok(L.matches('code 456', '۴۵۶'));
});

test('different spacing is the same text', () => {
  assert.ok(L.matches('hello    there', 'hello there'));
  assert.ok(L.matches('hello\nthere', 'hello there'));
});

test('a two-character minimum, matching the server', () => {
  const all = [msg(1, 'aa'), msg(2, 'ab')];
  assert.deepStrictEqual(L.searchLocal(all, 'a'), []);
  assert.strictEqual(L.searchLocal(all, 'aa').length, 1);
});

test('results come back newest first', () => {
  const all = [msg(1, 'find me'), msg(2, 'nope'), msg(3, 'find me too')];
  assert.deepStrictEqual(L.searchLocal(all, 'find').map(m => m.id), [3, 1]);
});

test('the limit keeps the NEWEST matches, not the oldest', () => {
  // Searching backwards is what makes this true; a forward scan with a limit
  // would return the start of the history, which is never what is wanted.
  const all = Array.from({ length: 20 }, (_, i) => msg(i + 1, 'hit'));
  const got = L.searchLocal(all, 'hit', 3);
  assert.deepStrictEqual(got.map(m => m.id), [20, 19, 18]);
});

test('messages with no text are skipped rather than crashing', () => {
  const all = [msg(1, null), msg(2, undefined), null, msg(3, 'hit')];
  assert.deepStrictEqual(L.searchLocal(all, 'hit').map(m => m.id), [3]);
});

test('server and device results merge without duplicates', () => {
  // A chat can hold plain and encrypted messages side by side, from before
  // encryption was switched on, so both searches can return the same one.
  const merged = L.mergeResults([msg(5, 'a'), msg(3, 'b')], [msg(4, 'c'), msg(3, 'b')]);
  assert.deepStrictEqual(merged.map(m => m.id), [5, 4, 3]);
});

test('merged results are newest first', () => {
  const merged = L.mergeResults([msg(2, 'a')], [msg(9, 'b'), msg(4, 'c')]);
  assert.deepStrictEqual(merged.map(m => m.id), [9, 4, 2]);
});

test('ids are compared as strings when merging', () => {
  // An unacknowledged message carries a temporary string id; 7 and "7" are the
  // same message and must not both appear.
  const merged = L.mergeResults([msg(7, 'a')], [msg('7', 'a')]);
  assert.strictEqual(merged.length, 1);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
