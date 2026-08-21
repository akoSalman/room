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

// ── The web copy must not drift ─────────────────────────────────────────────
//
// public/js/mentions.js mirrors this module. The rule about when "@" starts a
// mention is the whole substance of it, and a copy that gets it slightly wrong
// pops a suggestion list over somebody typing an email address — on one client
// only, with no error anywhere.

const WEB = require(path.join(__dirname, '..', 'public', 'js', 'mentions.js'));

test('THE DRIFT CHECK: web and app agree on when an @ starts a mention', () => {
  const cases = [
    ['', 0], ['@', 1], ['@al', 3], ['hi @al', 6], ['hi @al', 4],
    ['mail me at a@b.com', 18], ['a@b', 3], ['x@', 2],
    ['@ali ', 5], ['@ali there', 10], ['hi @ali there', 7],
    ['@' + 'a'.repeat(25), 26],
    ['line\n@al', 8], ['@AL_2.x', 7],
    ['hi @al', 0], ['hi', 99], ['hi', -1],
  ];
  const bad = [];
  for (const [text, caret] of cases) {
    const a = M.mentionQuery(text, caret);
    const b = WEB.mentionQuery(text, caret);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      bad.push(`mentionQuery(${JSON.stringify(text)}, ${caret}): app=${JSON.stringify(a)} web=${JSON.stringify(b)}`);
    }
  }
  assert.deepStrictEqual(bad, [], `mentions have drifted:\n      ${bad.join('\n      ')}`);
});

test('THE DRIFT CHECK: web and app splice the chosen name in identically', () => {
  const cases = [
    ['@al', 0, 3, 'ali'], ['hi @al', 3, 6, 'ali'],
    ['hi @al there', 3, 6, 'ali'], ['@a b', 0, 2, 'ali'],
  ];
  for (const [text, start, caret, name] of cases) {
    assert.deepStrictEqual(
      WEB.applyMention(text, start, caret, name),
      M.applyMention(text, start, caret, name),
      `applyMention(${JSON.stringify(text)}, ${start}, ${caret}, ${name})`);
  }
});

test('THE DRIFT CHECK: web and app rank suggestions identically', () => {
  const names = ['ali', 'kamal', 'alireza', 'sara', 'Ali_2'];
  for (const q of ['', 'a', 'al', 'AL', 'ma', 'zzz']) {
    assert.deepStrictEqual(WEB.filterUsernames(names, q), M.filterUsernames(names, q), `q=${q}`);
    assert.deepStrictEqual(WEB.filterUsernames(names, q, 2), M.filterUsernames(names, q, 2), `q=${q} limit`);
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
