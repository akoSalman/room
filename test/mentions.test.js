// Tests for @mention autocomplete logic (native-app/src/mentions.ts).
//
// The failure that matters here is a false positive: popping a list of names
// over the keyboard while someone is typing an email address, or splicing a
// name into the wrong place in the text. Both are asserted directly.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mentest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'mentions.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping mention tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const M = require(path.join(OUT, 'mentions.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('an @ at the very start begins a mention', () => {
  const q = M.mentionQuery('@al', 3);
  assert.deepStrictEqual(q, { start: 0, query: 'al' });
});

test('an @ after a space begins a mention', () => {
  const q = M.mentionQuery('hey @sa', 7);
  assert.deepStrictEqual(q, { start: 4, query: 'sa' });
});

test('a bare @ offers everyone', () => {
  const q = M.mentionQuery('hey @', 5);
  assert.deepStrictEqual(q, { start: 4, query: '' });
});

test('an email address is NOT a mention', () => {
  // The regression this file exists for: "ali@example.com" must not open a
  // suggestion list while it is being typed.
  assert.strictEqual(M.mentionQuery('ali@exa', 7), null);
  assert.strictEqual(M.mentionQuery('mail me at ali@exa', 18), null);
});

test('the mention ends at the first space', () => {
  // Caret is past the name, so there is nothing left to complete.
  assert.strictEqual(M.mentionQuery('hi @ali there', 13), null);
});

test('a character a username cannot contain ends the mention', () => {
  assert.strictEqual(M.mentionQuery('@ali!', 5), null);
  // …but dots and underscores are legal in a username, so they do not.
  assert.deepStrictEqual(M.mentionQuery('@a.b_c', 6), { start: 0, query: 'a.b_c' });
});

test('an absurdly long run after @ is not treated as a name', () => {
  assert.strictEqual(M.mentionQuery('@' + 'x'.repeat(25), 26), null);
});

test('the caret position decides, not the end of the text', () => {
  // Caret sits inside "@al", with more text after it.
  const q = M.mentionQuery('@al and more', 3);
  assert.deepStrictEqual(q, { start: 0, query: 'al' });
});

test('picking a name replaces only the partial name', () => {
  const r = M.applyMention('hey @al and more', 4, 7, 'ali');
  assert.strictEqual(r.text, 'hey @ali and more');
  // No double space: the text already had one after the name.
  assert.strictEqual(r.caret, 'hey @ali'.length);
});

test('picking a name at the end of the text leaves a trailing space', () => {
  const r = M.applyMention('hey @al', 4, 7, 'ali');
  assert.strictEqual(r.text, 'hey @ali ');
});

test('prefix matches rank above matches in the middle', () => {
  const out = M.filterUsernames(['kamal', 'ali', 'alireza', 'sam'], 'al');
  assert.deepStrictEqual(out, ['ali', 'alireza', 'kamal']);
});

test('matching ignores case and the list is capped', () => {
  assert.deepStrictEqual(M.filterUsernames(['Ali', 'bob'], 'aL'), ['Ali']);
  const many = Array.from({ length: 20 }, (_, i) => `user${i}`);
  assert.strictEqual(M.filterUsernames(many, 'user').length, 6);
  assert.strictEqual(M.filterUsernames(many, 'user', 3).length, 3);
});

test('an empty query offers the whole (capped) list', () => {
  assert.deepStrictEqual(M.filterUsernames(['a', 'b'], ''), ['a', 'b']);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
