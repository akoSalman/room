// Tests for double-tap word selection (native-app/src/textSelect.ts).
//
// Selecting the wrong word is worse than selecting nothing, so the boundary
// rules are pinned down here — including Persian text, which is most of what
// this app carries.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tstest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'textSelect.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping text-selection tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const T = require(path.join(OUT, 'textSelect.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const word = (text, i) => { const r = T.wordRangeAt(text, i); return text.slice(r.start, r.end); };

test('the word under the tap is the one selected', () => {
  const s = 'the quick brown fox';
  assert.strictEqual(word(s, 0), 'the');
  assert.strictEqual(word(s, 5), 'quick');
  assert.strictEqual(word(s, 12), 'brown');
  assert.strictEqual(word(s, 17), 'fox');
});

test('a tap anywhere inside a word selects the whole word', () => {
  const s = 'hello wonderful world';
  for (let i = 6; i <= 14; i++) {
    assert.strictEqual(word(s, i), 'wonderful', `index ${i} gave the wrong word`);
  }
});

test('a tap in the gap after a word takes that word', () => {
  // Landing a finger just past a short word is common; taking the NEXT word
  // would feel wrong.
  assert.strictEqual(word('alpha beta', 5), 'alpha');
  assert.strictEqual(word('alpha. beta', 5), 'alpha');
});

test('punctuation is not part of the word', () => {
  assert.strictEqual(word('hello, world!', 1), 'hello');
  assert.strictEqual(word('hello, world!', 8), 'world');
  assert.strictEqual(word('(parens)', 3), 'parens');
});

test('Persian text selects by word', () => {
  const s = 'سلام دنیا خوبی';
  assert.strictEqual(word(s, 0), 'سلام');
  assert.strictEqual(word(s, 6), 'دنیا');
  assert.strictEqual(word(s, 11), 'خوبی');
});

test('numbers and long account codes stay one word', () => {
  const s = 'card IR100560611828005461905601 ok';
  assert.strictEqual(word(s, 10), 'IR100560611828005461905601');
});

test('an unknown position selects everything rather than guessing', () => {
  const s = 'some text';
  assert.deepStrictEqual(T.wordRangeAt(s, -1), { start: 0, end: s.length });
  assert.deepStrictEqual(T.wordRangeAt(s, 999), { start: 0, end: s.length });
});

test('text made only of separators selects everything', () => {
  assert.deepStrictEqual(T.wordRangeAt('   ', 1), { start: 0, end: 3 });
});

test('empty text does not crash', () => {
  assert.deepStrictEqual(T.wordRangeAt('', 0), { start: 0, end: 0 });
  assert.deepStrictEqual(T.wordRangeAt(null, 0), { start: 0, end: 0 });
});

// ── hit-testing a tap to a character ────────────────────────────────────────
const LINES = [
  { text: 'hello world', x: 0, y: 0, width: 110, height: 20 },
  { text: 'second line', x: 0, y: 20, width: 110, height: 20 },
];

test('the tapped LINE is exact, and offsets accumulate across lines', () => {
  // Start of line 1.
  assert.strictEqual(T.charIndexAt(LINES, 0, 5), 0);
  // Start of line 2 is offset by the whole first line.
  assert.strictEqual(T.charIndexAt(LINES, 0, 25), 11);
});

test('a tap resolves to a sensible word on the right line', () => {
  const full = 'hello worldsecond line';
  // Right-hand side of the first line is "world".
  const i = T.charIndexAt(LINES, 100, 5);
  assert.ok(i >= 6 && i <= 11, `expected the tap to land in "world", got index ${i}`);
  // Right-hand end of line two.
  const j = T.charIndexAt(LINES, 100, 25);
  assert.ok(j >= 17, `expected a late index on line two, got ${j}`);
  assert.ok(full.length >= j);
});

test('a tap above or below every line is clamped, not lost', () => {
  assert.strictEqual(T.charIndexAt(LINES, 0, -50), 0);
  const below = T.charIndexAt(LINES, 0, 999);
  assert.ok(below >= 11, 'a tap below the text did not fall on the last line');
});

test('no line information means "select everything" rather than a wrong guess', () => {
  assert.strictEqual(T.charIndexAt([], 10, 10), -1);
  assert.strictEqual(T.charIndexAt(null, 10, 10), -1);
  // and -1 is exactly what wordRangeAt turns into a select-all.
  assert.deepStrictEqual(T.wordRangeAt('abc def', -1), { start: 0, end: 7 });
});

test('a zero-width line does not produce NaN', () => {
  const bad = [{ text: 'abc', x: 0, y: 0, width: 0, height: 20 }];
  const i = T.charIndexAt(bad, 50, 5);
  assert.ok(Number.isInteger(i), `got ${i}`);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
