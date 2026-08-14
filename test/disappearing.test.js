// Tests for disappearing-message labels (native-app/src/disappearing.ts).
//
// These strings are the only thing telling someone their words are being
// deleted, so they have to be right — and they have to match the durations the
// server accepts, or the menu offers something that will be refused.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'distest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'disappearing.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping disappearing tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const D = require(path.join(OUT, 'disappearing.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('the offered durations are exactly the ones the server accepts', () => {
  // Read them out of server.js so the menu can never drift into offering a
  // duration that gets refused.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = /const DISAPPEARING_CHOICES = \[([^\]]+)\]/.exec(src);
  assert.ok(m, 'could not find DISAPPEARING_CHOICES in server.js');
  const serverSide = m[1].split(',').map(x => parseInt(x.trim(), 10));
  assert.deepStrictEqual([...D.DISAPPEARING_OPTIONS], serverSide,
    'the app offers durations the server does not accept');
});

test('durations read as words, not seconds', () => {
  assert.strictEqual(D.disappearingLabel(0), 'Off');
  assert.strictEqual(D.disappearingLabel(30), '30 seconds');
  assert.strictEqual(D.disappearingLabel(300), '5 minutes');
  assert.strictEqual(D.disappearingLabel(3600), '1 hour');
  assert.strictEqual(D.disappearingLabel(86400), '24 hours');
  assert.strictEqual(D.disappearingLabel(604800), '1 week');
});

test('an unknown duration still reads sensibly', () => {
  // An older app meeting a newer server must not print "7200 seconds".
  assert.strictEqual(D.disappearingLabel(45), '45 seconds');
  assert.strictEqual(D.disappearingLabel(7200), '2 hours');
  assert.strictEqual(D.disappearingLabel(172800), '2 days');
});

test('the notice says who did it and what it means', () => {
  const on = D.disappearingNotice('ako', 3600, false);
  assert.ok(on.includes('ako'), `no name in: ${on}`);
  assert.ok(on.includes('1 hour'), `no duration in: ${on}`);
  assert.ok(/on disappearing/.test(on), on);

  const off = D.disappearingNotice('ako', 0, false);
  assert.ok(/off disappearing/.test(off), off);
  assert.ok(!off.includes('vanish'), 'the off notice should not describe a timer');
});

test('the predicate carries no name, so the chat can style it separately', () => {
  const on = D.disappearingPredicate(300);
  assert.ok(on.startsWith('turned on'), on);
  assert.ok(on.includes('5 minutes'), on);
  assert.strictEqual(D.disappearingPredicate(0), 'turned off disappearing messages');
});

test('your own change reads as "You"', () => {
  assert.ok(D.disappearingNotice('ako', 30, true).startsWith('You'));
  assert.ok(!D.disappearingNotice('ako', 30, true).includes('ako'));
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
