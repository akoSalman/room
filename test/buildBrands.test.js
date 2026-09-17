// Which brands an ordinary push builds an APK for.
//
// Asked for: skip the akosalman APK in all future builds until told otherwise.
//
// That is a standing instruction rather than a one-off, so it is worth a test.
// The way it would quietly come undone is somebody — me — editing this
// workflow for an unrelated reason and restoring 'both' as the default,
// because 'both' is what it said for its whole life before this. Nothing about
// a build producing one extra APK looks wrong in a log, so nobody would
// notice; the cost is a wasted runner every push and, more to the point, an
// instruction silently dropped.
//
// The escape hatch is deliberately NOT tested as "akosalman can never build":
// it can, from Actions → Run workflow, by choosing it. That choice is the
// asking.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const wf = fs.readFileSync(
  path.join(ROOT, '.github', 'workflows', 'build-native-apk.yml'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

// Comments stripped before matching: this file's own explanation of the rule
// quotes the strings it checks for, and matching prose is not checking
// behaviour. That trap has already cost two rounds in this repo.
const code = wf.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');

test('THE INSTRUCTION: a push does not build akosalman', () => {
  // On a push the `inputs` context is empty, so whatever this falls back to is
  // what an ordinary commit builds.
  assert.ok(/DEFAULT_BRAND='bistbarg'/.test(code),
    'the default is not bistbarg, so every push builds an akosalman APK again');
  assert.ok(!/inputs\.brand \|\| 'both'/.test(code),
    "the old `inputs.brand || 'both'` is back, which builds both on every push");
});

test('…and neither does a manual run left on its default', () => {
  // Dispatching without touching the dropdown is not "telling you to build
  // akosalman" — it is not choosing at all.
  const at = code.indexOf('brand:');
  assert.ok(at > 0, 'the brand input is gone');
  const input = code.slice(at, at + 400);
  assert.ok(/default: 'bistbarg'/.test(input),
    'the manual default still builds akosalman');
});

test('THE ESCAPE HATCH: akosalman is still reachable on demand', () => {
  // Paused, not removed. If this fails, honouring the instruction has turned
  // into losing the ability, and turning it back on means editing the matrix.
  const at = code.indexOf('options:');
  assert.ok(at > 0, 'the choice list is gone');
  const options = code.slice(at, at + 120);
  assert.ok(/akosalman/.test(options), 'akosalman cannot be built at all any more');
  assert.ok(/both/.test(options), 'there is no way to build both');
  // The matrix must still carry it, or choosing it from the list does nothing.
  assert.ok(/brand: \[akosalman, bistbarg\]/.test(code),
    'akosalman was removed from the matrix, so selecting it builds nothing');
});

test('turning it back on is one word', () => {
  // The point of a named constant rather than an edit scattered through the
  // matrix and the steps: restoring both brands is changing one string, with
  // nothing that can be half done.
  assert.strictEqual((code.match(/DEFAULT_BRAND=/g) || []).length, 1,
    'the default is set in more than one place, so changing it back can be missed');
  assert.ok(/WANTED="\$DEFAULT_BRAND"/.test(code),
    'the constant is declared but not what the step actually uses');
});

test('the skip still works the way the rest of the job expects', () => {
  // Every later step is gated on this output. If the contract changes, the
  // brand is not skipped — it half-builds and fails somewhere further down.
  assert.ok(/echo "build=no" >> "\$GITHUB_OUTPUT"/.test(code), 'nothing reports a skip');
  assert.ok(/echo "build=yes" >> "\$GITHUB_OUTPUT"/.test(code), 'nothing reports a build');
  assert.ok((code.match(/steps\.want\.outputs\.build == 'yes'/g) || []).length >= 5,
    'the later steps no longer check whether this brand was wanted');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
