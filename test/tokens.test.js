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
  // Four digits is where copyable numbers start (see below); the point of this
  // one is that a number of that size is never mistaken for a phone.
  assert.strictEqual(T.classify('2024'), 'number');
  assert.strictEqual(T.classify('12345'), 'number');
});

test('THE ASK: a number too short to be worth copying is just text', () => {
  // Every digit run used to become a tappable chip, so "ساعت ۲ میریم" — "we
  // are leaving at 2" — drew a copy chip around the 2. A number that short is
  // being used as a word.
  assert.strictEqual(T.MIN_COPY_DIGITS, 4);
  for (const n of ['2', '42', '999', '۲', '۱۲', '۱۲۳']) {
    assert.strictEqual(T.classify(n), 'text', `${n} is still offered as something to copy`);
  }
  for (const n of ['1234', '2024', '۱۲۳۴', '۱۲۵۰۰']) {
    assert.strictEqual(T.classify(n), 'number', `${n} can no longer be copied`);
  }
});

test('a short number inside a sentence is left alone, and a long one is not', () => {
  const short = T.tokenize('ساعت ۲ میریم');
  assert.deepStrictEqual(short.filter(t => t.kind !== 'text'), [],
    'a lone digit in ordinary text is still a chip');
  const long = T.tokenize('کد ۱۲۳۴۵ رو بزن');
  assert.deepStrictEqual(long.filter(t => t.kind !== 'text').map(t => t.kind), ['number']);
});

test('the length rule does not reach phones, codes or amounts', () => {
  // They are decided before it, and all of them are long anyway.
  assert.strictEqual(T.classify('0770 123 4567'), 'phone');
  assert.strictEqual(T.classify('IR12345678'), 'number');
  assert.strictEqual(T.classify('1,234.56'), 'number');
  // …but a small decimal is prose, not an amount worth a chip. "12.5" is the
  // one that matters: four characters, three digits — it is DIGITS that are
  // counted, not length, or a separator would be enough to make a chip.
  assert.strictEqual(T.classify('3.5'), 'text');
  assert.strictEqual(T.classify('12.5'), 'text');
  assert.strictEqual(T.classify('1,234'), 'number');
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

test('a long account number stays ONE token (regression: split at 18 digits)', () => {
  // PHONE could match at most 18 digits, so a 24-digit number was chopped into
  // 18 + 6 and tapping either half copied only that half.
  const iban = 'IR100560611828005461905601';
  const toks = kindsOf(iban);
  assert.deepStrictEqual(toks, [['number', iban]],
    'IBAN was not a single copyable token: ' + JSON.stringify(toks));
});

test('a bare long digit run is one token too', () => {
  const n = '100560611828005461905601';
  assert.deepStrictEqual(kindsOf(n), [['number', n]]);
});

test('a letter-prefixed code is never treated as a phone number', () => {
  assert.strictEqual(T.classify('IR12345678'), 'number');
  assert.strictEqual(T.isPhone('IR12345678'), false);
});

test('real phone numbers still classify as phones', () => {
  assert.strictEqual(T.classify('09123456789'), 'phone');
  assert.strictEqual(T.classify('+98 912 345 6789'), 'phone');
});

test('an @mention is one token, digits and all', () => {
  // '@user2' must not have its '2' split off as a number, which is what
  // happens if MENTION is not matched before NUMBER.
  const toks = T.tokenize('hey @ako2 and @sara_x look');
  const mentions = toks.filter(t => t.kind === 'mention').map(t => t.text);
  assert.deepStrictEqual(mentions, ['@ako2', '@sara_x']);
  assert.ok(!toks.some(t => t.kind === 'number'), 'a mention was split into a number');
});

test('an email is not turned into a mention', () => {
  // The token here is '@example.com', NOT '@example' — an earlier version of
  // this test asserted the wrong string and passed while the bug was live.
  for (const src of ['write to me@example.com please', 'ako.salman@gmail.com', 'a@b.co']) {
    const toks = T.tokenize(src);
    assert.ok(!toks.some(t => t.kind === 'mention'),
      `${src} produced a mention: ${JSON.stringify(toks.filter(t => t.kind === 'mention'))}`);
  }
});

test('a mention still works at the start of a message and after punctuation', () => {
  for (const [src, want] of [
    ['@ako hello', '@ako'],
    ['hi @ako', '@ako'],
    ['(@ako)', '@ako'],
    ['say hi to @ako.', '@ako'],
  ]) {
    const toks = T.tokenize(src);
    const m = toks.find(t => t.kind === 'mention');
    assert.ok(m, `no mention found in ${JSON.stringify(src)}`);
    assert.strictEqual(m.text, want, `wrong mention in ${JSON.stringify(src)}`);
  }
});

test('tokenising still round-trips with mentions present', () => {
  const src = 'hi @ako, call 09123456789 or see https://x.com — 250000';
  assert.strictEqual(T.tokenize(src).map(t => t.text).join(''), src);
});

test('the web copies the same threshold', () => {
  // The web has its own tokenizer, inline in app.js, so this is the only thing
  // holding the two together for numbers.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const m = /const MIN_COPY_DIGITS = (\d+);/.exec(app);
  assert.ok(m, 'the web has no threshold at all — every digit is a chip again');
  assert.strictEqual(parseInt(m[1], 10), T.MIN_COPY_DIGITS,
    'a number copyable in the app is plain text on the web, or the other way round');
  assert.ok(/countDigits\(tok\) >= MIN_COPY_DIGITS/.test(app),
    'the web declares the threshold and then does not use it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);