// ── Why every message in the chat was redrawn whenever anything happened ────
//
// Reported four times, finally as: "after using a couple of animated
// reactions, tapping the emoji under a message and opening the menu gets
// slow." Four readings of this file found nothing, and I twice shipped a fix
// for a cause I had guessed at. So the app was made to count instead, and the
// counters came back from two phones:
//
//     renders=781  rows=22161    -> 28.4 rows redrawn per screen render
//     renders=260  rows=6345     -> 24.4 rows redrawn per screen render
//
// That is the answer. Not a render loop — the screen rendered a reasonable
// number of times, and every one of them redrew the entire visible list. So
// tapping an emoji, which sets one piece of state, redrew twenty-eight whole
// message rows; and while bursts are starting and expiring the same thing is
// happening several times a second.
//
// The cause: `renderItem` was the render function itself, which is a new
// function on every render, and a changed renderItem re-renders every cell
// whatever extraData says. Memoising extraData — already done once, for this
// same symptom, with a comment explaining it — had therefore been achieving
// nothing at all.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx');
const RAW = fs.readFileSync(FILE, 'utf8');
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE LIST IS GIVEN A renderItem THAT NEVER CHANGES', () => {
  // The whole fix. A new function each render re-renders every cell no matter
  // what extraData says.
  assert.ok(/renderItem=\{renderRow\}/.test(SRC),
    'renderItem is the render function itself, so every row redraws on every render');
  // renderRow is no longer stable FOREVER — it changes with extraData, which
  // is deliberate and tested below. What must still hold is that it does not
  // change on every render, and that the body it calls is always current.
  assert.ok(/renderMessageRef\.current = renderMessage;/.test(SRC),
    'the ref is never refreshed, so rows would render a stale closure');
  assert.ok(/render\.current\(\{ item: msg \}\)/.test(SRC),
    'the row does not call through the ref, so it would hold a stale closure');
});

test('THE ROW ITSELF IS MEMOISED, because a stable renderItem is not enough', () => {
  // Measured. After stabilising renderItem the counters came back at 27.5
  // rows per screen render, against 28.4 and 24.4 before — no change at all.
  //
  // The reason is in React Native: VirtualizedList's CellRenderer is a plain
  // React.Component with no shouldComponentUpdate, so every cell re-renders
  // whenever the list does, whatever renderItem is. Nothing about the list's
  // props could stop that. The only place left is inside the cell.
  assert.ok(/const MemoRow = React\.memo\(/.test(SRC),
    'the row body is not memoised, so every cell still redraws it');
  assert.ok(/<MemoRow msg=\{info\.item\} data=\{rowExtraData\}/.test(SRC),
    'renderItem does not go through the memoised row');
  // The comparison has to be all three: msg, data and the render ref.
  assert.ok(/a\.msg === b\.msg && a\.data === b\.data && a\.render === b\.render/.test(SRC),
    'the memo compares the wrong things, so rows go stale or never skip');
});

test('…and renderItem CHANGES WITH extraData, deliberately', () => {
  // The one place a stable-forever identity would be wrong. If renderRow
  // captured the first render's extraData, the memo would compare an object
  // that never changes and the rows would never update again.
  const dep = /const renderRow = useCallback\([\s\S]*?\n  \);/.exec(SRC);
  assert.ok(dep, 'could not find renderRow');
  assert.ok(/\[rowExtraData\]/.test(dep[0]),
    'renderRow does not depend on extraData, so rows would freeze at their first render');
});

test('EVERYTHING A ROW READS IS IN extraData', () => {
  // The risk the fix introduces, checked mechanically rather than by eye.
  //
  // While every row re-rendered on every render, a row could read state that
  // extraData had never heard of and still update — by accident. Now that
  // rows re-render only when extraData changes, anything left out quietly
  // stops updating: a clock that never ticks, a countdown that sticks, a
  // comments badge that never moves.
  const body = /function renderMessage\(\{ item: msg \}[\s\S]*?\n  \}\n/.exec(SRC);
  assert.ok(body, 'could not find renderMessage');

  const extra = /const rowExtraData = useMemo\([\s\S]*?\n  \);/.exec(SRC);
  assert.ok(extra, 'could not find rowExtraData');
  // The OBJECT and the DEPENDENCY LIST, separately. A value in the deps but
  // not the object never reaches the rows; one in the object but not the deps
  // is frozen at its first value. Checking the block as a whole is satisfied
  // by either — which it was, so dropping a value from the object alone went
  // unnoticed by the first version of this test.
  const obj = /\(\s*\)\s*=>\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(extra[0]);
  assert.ok(obj, 'could not find the rowExtraData object');
  const deps = /\}\s*\)\s*,\s*\[([\s\S]*?)\]\s*,?\s*\)\s*;/.exec(extra[0]);
  assert.ok(deps, 'could not find the rowExtraData dependency list');

  // Every useState in the component, and what the row body actually mentions.
  const states = [...SRC.matchAll(/const \[([a-zA-Z0-9_]+),\s*set[A-Za-z0-9_]+\]\s*=\s*useState/g)]
    .map(m => m[1]);
  assert.ok(states.length > 20, `only found ${states.length} state variables — the scan is broken`);

  // Helpers a row calls that read state on its behalf: the state is reached
  // through the function, so the function's own body counts as the row's.
  const helperState = {
    unreadBadge: 'unreadComments',
    commentCountOf: 'commentCounts',
  };

  const missing = [];
  for (const v of states) {
    const readDirectly = new RegExp('\\b' + v + '\\b').test(body[0]);
    const readViaHelper = Object.entries(helperState)
      .some(([fn, st]) => st === v && new RegExp('\\b' + fn + '\\s*\\(').test(body[0]));
    if (!readDirectly && !readViaHelper) continue;
    // `messages` is the list's data, not extraData; rows get it as `item`.
    if (v === 'messages') continue;
    const inObject = new RegExp('\\b' + v + '\\b').test(obj[1]);
    const inDeps = new RegExp('\\b' + v + '\\b').test(deps[1]);
    if (!inObject || !inDeps) missing.push(v + (inObject ? ' (not in deps)' : ' (not in the object)'));
  }
  assert.deepStrictEqual(missing, [],
    `rows read these but extraData does not list them, so they will stop updating: ${missing.join(', ')}`);
});

test('extraData IS STILL MEMOISED', () => {
  // If it goes back to an inline object the stable renderItem buys nothing:
  // a new extraData every render re-renders every cell just as surely.
  assert.ok(/const rowExtraData = useMemo\(/.test(SRC), 'extraData is no longer memoised');
  assert.ok(!/extraData=\{\{/.test(SRC), 'extraData is an inline object again');
  assert.ok(!/extraData=\{\[/.test(SRC), 'extraData is an inline array again');
});

test('THE COUNTERS ARE STILL THERE to show whether this worked', () => {
  // The next reading of these numbers is how anybody knows the fix landed.
  // Expected afterwards: rows per render far below the ~28 measured, because
  // opening a menu, typing, or a burst expiring should move no rows at all.
  assert.ok(/renderCount\.noteScreen\(\)/.test(SRC), 'screen renders are no longer counted');
  assert.ok(/renderCount\.noteRow\(\)/.test(SRC), 'row renders are no longer counted');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
