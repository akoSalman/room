// Tests for playlist ordering (native-app/src/playlist.ts).
//
// A shuffle that drops, duplicates or reorders wrongly is nearly impossible to
// catch by ear, so the properties that matter are asserted directly.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pltest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'playlist.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping playlist tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const P = require(path.join(OUT, 'playlist.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const mk = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `t${i + 1}` }));
const ids = list => list.map(t => t.id);

// A deterministic generator, so a failure is reproducible.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('repeat cycles off → all → one → off', () => {
  assert.strictEqual(P.nextRepeat('off'), 'all');
  assert.strictEqual(P.nextRepeat('all'), 'one');
  assert.strictEqual(P.nextRepeat('one'), 'off');
});

test('shuffling keeps exactly the same tracks — none lost, none duplicated', () => {
  const base = mk(50);
  for (let seed = 1; seed <= 20; seed++) {
    const out = P.shuffled(base, seeded(seed));
    assert.strictEqual(out.length, base.length, 'length changed');
    assert.deepStrictEqual(ids(out).slice().sort((a, b) => a - b), ids(base),
      'the shuffled list is not a permutation of the original');
  }
});

test('shuffling does not mutate the caller\'s array', () => {
  const base = mk(20);
  const before = ids(base);
  P.shuffled(base, seeded(7));
  assert.deepStrictEqual(ids(base), before, 'the input array was reordered in place');
});

test('shuffling actually changes the order', () => {
  const base = mk(30);
  const out = P.shuffled(base, seeded(3));
  assert.notDeepStrictEqual(ids(out), ids(base), 'the "shuffled" list came back in the original order');
});

test('every position is reachable — the shuffle is not partial', () => {
  // A common Fisher-Yates bug is an off-by-one that pins the first or last
  // element. Over many seeds, every track must reach position 0.
  const base = mk(6);
  const firsts = new Set();
  for (let seed = 1; seed <= 400; seed++) firsts.add(P.shuffled(base, seeded(seed))[0].id);
  assert.strictEqual(firsts.size, 6, `only ${firsts.size} of 6 tracks ever landed first`);
});

test('the playing track keeps playing when shuffle is turned on', () => {
  const base = mk(10);
  const { order, index } = P.orderFor(base, 4, true, seeded(11));
  assert.strictEqual(order[index].id, 4, 'the current track is not at the reported index');
  assert.strictEqual(index, 0, 'the current track should lead the shuffled order');
  assert.deepStrictEqual(ids(order).slice().sort((a, b) => a - b), ids(base), 'tracks were lost');
});

test('turning shuffle off restores the original order and finds the track in it', () => {
  const base = mk(10);
  const { order, index } = P.orderFor(base, 7, false);
  assert.deepStrictEqual(ids(order), ids(base), 'the original order was not restored');
  assert.strictEqual(order[index].id, 7, 'the current track is not at the reported index');
  assert.strictEqual(index, 6);
});

test('an unknown current track does not break the order', () => {
  const base = mk(5);
  const off = P.orderFor(base, 999, false);
  assert.deepStrictEqual(ids(off.order), ids(base));
  assert.strictEqual(off.index, 0, 'should fall back to the start, not -1');

  const on = P.orderFor(base, 999, true, seeded(5));
  assert.strictEqual(on.order.length, 5, 'a track went missing when nothing was playing');
  assert.strictEqual(on.index, 0);
});

test('an empty queue is handled', () => {
  const { order, index } = P.orderFor([], null, true);
  assert.deepStrictEqual(order, []);
  assert.strictEqual(index, -1);
});

test('a single track shuffles to itself', () => {
  const { order, index } = P.orderFor(mk(1), 1, true, seeded(2));
  assert.deepStrictEqual(ids(order), [1]);
  assert.strictEqual(index, 0);
});

test('ids are compared as strings, so numeric and string ids match', () => {
  const base = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const { index, order } = P.orderFor(base, 2, false);
  assert.strictEqual(order[index].id, '2', 'a numeric id failed to match its string twin');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
