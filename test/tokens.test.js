// Tests for message text tokenisation (native-app/src/textTokens.ts):
// which spans become tappable, and whether Persian/Arabic digits are handled.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'toktest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'textTokens.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping token tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const T = require(path.join(OUT, 'textTokens.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const kindsOf = (s) => T.tokenize(s).filter(t => t.kind !== 'text').map(t => [t.kind, t.text]);

test('converts Persian and Arabic-Indic digits to ASCII', () => {
  assert.strictEqual(T.toAsciiDigits('۰۹۱۲۳۴۵۶۷۸۹'), '09123456789');
  assert.strictEqual(T.toAsciiDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.strictEqual(T.toAsciiDigits('mixed ۴۲ and 42'), 'mixed 42 and 42');
});

test('finds numbers embedded in Persian text', () => {
  const got = kindsOf('قیمت ۱۲۵۰۰ تومان است');
  assert.deepStrictEqual(got, [['number', '۱۲۵۰۰']], JSON.stringify(got));
});

test('finds numbers embedded in English text', () => {
  const got = kindsOf('Your code is 4821 ok');
  assert.deepStrictEqual(got, [['number', '4821']], JSON.stringify(got));
});

test('recognises a Persian-digit phone number as a phone', () => {
  const got = kindsOf('شماره من ۰۹۱۲۳۴۵۶۷۸۹ است');
  assert.strictEqual(got.length, 1, JSON.stringify(got));
  assert.strictEqual(got[0][0], 'phone', JSON.stringify(got));
  assert.strictEqual(T.telHref(got[0][1]), 'tel:09123456789');
});

test('recognises ASCII and formatted phone numbers', () => {
  assert.strictEqual(T.classify('+98 912 345 6789'), 'phone');
  assert.strictEqual(T.classify('(021) 8877-6655'), 'phone');
  assert.strictEqual(T.telHref('+98 912 345 6789'), 'tel:+989123456789');
});

test('short numbers are numbers, not phones', () => {
  assert.strictEqual(T.classify('42'), 'number');
  assert.strictEqual(T.classify('2024'), 'number');
});

test('a 16-digit card number is not treated as a phone', () => {
  assert.strictEqual(T.classify('6037991234567890'), 'number');
});

test('decimal amounts are not phones', () => {
  assert.strictEqual(T.classify('12345678.99'), 'number');
});

test('urls are urls, and win over the number inside them', () => {
  assert.deepStrictEqual(kindsOf('see https://example.com/a/123 now'),
    [['url', 'https://example.com/a/123']]);
  assert.strictEqual(T.classify('example.com'), 'url');
});

test('trailing punctuation stays out of the token', () => {
  const toks = T.tokenize('call 09123456789.');
  const phone = toks.find(t => t.kind === 'phone');
  assert.strictEqual(phone.text, '09123456789');
  assert.ok(toks.some(t => t.kind === 'text' && t.text.includes('.')), 'trailing dot lost');
});

test('tokenize round-trips the original text exactly', () => {
  const samples = [
    'قیمت ۱۲۵۰۰ تومان، تماس ۰۹۱۲۳۴۵۶۷۸۹',
    'Visit https://x.com and call +98 912 345 6789 today.',
    'no tokens here at all',
    '',
  ];
  for (const s of samples) {
    assert.strictEqual(T.tokenize(s).map(t => t.text).join(''), s,
      `round-trip lost text for ${JSON.stringify(s)}`);
  }
});

test('multiple tokens in one message are all found', () => {
  const got = kindsOf('کد ۱۲۳۴ و شماره ۰۲۱۸۸۷۷۶۶۵۵ و سایت example.com');
  assert.strictEqual(got.length, 3, JSON.stringify(got));
  assert.deepStrictEqual(got.map(g => g[0]), ['number', 'phone', 'url']);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
