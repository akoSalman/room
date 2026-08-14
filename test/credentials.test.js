// The username/password rules exist twice: /credentials.js (server + web) and
// native-app/src/credentials.ts (the app). Two copies drift, and drift here is
// nasty — the app would accept a username the server rejects, or show a green
// tick for a password that is then refused.
//
// So the same table of cases runs through BOTH copies and they must agree
// exactly, including the message codes.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JS = require('../credentials.js');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'credtest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'credentials.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping credential tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const TS = require(path.join(OUT, 'credentials.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const USERNAMES = [
  'ako', 'ako_salman', 'good.name_9', 'a1b2c3', 'twentycharacters0000',
  '', 'ab', 'averyveryverylongusername', '1leading', '_leading', '.leading',
  'has space', 'HasCaps', 'trailing_', 'trailing.', 'double__us', 'dot..dot',
  'mixed._sep', 'admin', 'ROOT', 'chatroom', 'unicodeنام', 'emoji😀name',
];

const PASSWORDS = [
  ['correct horse battery', 'ako'],
  ['abcd1234efgh', 'ako'],
  ['', 'ako'],
  ['short', 'ako'],
  ['        ', 'ako'],
  ['password', 'ako'],
  ['12345678', 'ako'],
  ['87654321', 'ako'],
  ['aaaaaaaa', 'ako'],
  ['abcdefgh', 'ako'],
  ['myakopass', 'ako'],
  ['x'.repeat(200), 'ako'],
  ['P@ssw0rd!longenough', 'someone'],
];

test('username rules are identical in both copies', () => {
  for (const u of USERNAMES) {
    const a = JS.validateUsername(u);
    const b = TS.validateUsername(u);
    assert.deepStrictEqual(
      a ? a.code : null, b ? b.code : null,
      `disagreement on username ${JSON.stringify(u)}: js=${a && a.code} ts=${b && b.code}`,
    );
  }
});

test('password rules are identical in both copies', () => {
  for (const [pw, user] of PASSWORDS) {
    const a = JS.validatePassword(pw, user);
    const b = TS.validatePassword(pw, user);
    assert.deepStrictEqual(
      a ? a.code : null, b ? b.code : null,
      `disagreement on password ${JSON.stringify(pw)}: js=${a && a.code} ts=${b && b.code}`,
    );
  }
});

test('strength scoring is identical in both copies', () => {
  for (const [pw] of PASSWORDS) {
    assert.strictEqual(JS.passwordStrength(pw), TS.passwordStrength(pw),
      `strength disagreement on ${JSON.stringify(pw)}`);
  }
});

test('normalisation is identical, and folds case', () => {
  for (const u of ['Ako', ' AKO ', 'ako', 'A.k_O']) {
    assert.strictEqual(JS.normalizeUsername(u), TS.normalizeUsername(u));
  }
  assert.strictEqual(JS.normalizeUsername('  AkoSalman '), 'akosalman');
});

test('the warning text exists in both languages', () => {
  for (const mod of [JS, TS]) {
    assert.ok(mod.PASSWORD_WARNING.en.length > 40, 'English warning missing');
    assert.ok(mod.PASSWORD_WARNING.fa.length > 40, 'Persian warning missing');
    // Persian text must actually be Persian, not an untranslated copy.
    assert.ok(/[؀-ۿ]/.test(mod.PASSWORD_WARNING.fa), 'Persian warning is not Persian');
  }
  assert.strictEqual(JS.PASSWORD_WARNING.fa, TS.PASSWORD_WARNING.fa);
});

test('every rejection carries both languages', () => {
  const bad = [JS.validateUsername('ab'), JS.validateUsername('admin'),
               JS.validatePassword('short'), JS.validatePassword('password')];
  for (const e of bad) {
    assert.ok(e && e.en && e.fa, 'a rule is missing a translation');
    assert.ok(/[؀-ۿ]/.test(e.fa), `not Persian: ${e.fa}`);
  }
});

test('sensible credentials are accepted', () => {
  assert.strictEqual(JS.validateUsername('ako_salman'), null);
  assert.strictEqual(JS.validateUsername('good.name_9'), null);
  assert.strictEqual(JS.validatePassword('correct horse battery', 'ako'), null);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
