// ── Sharing into the app, and the spinner that never went away ─────────────
//
// Reported with a photograph: sharing something into the app sticks on
// "Preparing shared content…". The spinner in that photograph sits over a
// CONVERSATION, which is the whole clue — the hand-off had reached the chat
// and stopped there.
//
// One dependency array. ChatScreen staged the shared files in an effect with
// `[]`, so it ran once on mount and never again — and ChatScreen is not keyed
// by room, so choosing the share's target while already in a chat reuses the
// same component instead of mounting a new one. The effect had already run,
// before the share existed, with nothing to do. Nothing staged the files,
// nothing called onShareConsumed, and the overlay waits on that call.
//
// The severity was separate and worse: that overlay is a Modal with no cancel
// and no onRequestClose, so hardware back did nothing and the app was finished
// until it was force-stopped. A hand-off that fails should cost the file, not
// the app.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping share hand-off tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'sharehandoff-'));
execFileSync(TSC, [path.join(NAT, 'src', 'shareHandoff.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const { overlayVisible, handoffExpired, shareKey, HANDOFF_GRACE_MS } = require(path.join(OUT, 'shareHandoff.js'));

const CHAT = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const APP = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE BUG: the chat stages a share when it ARRIVES, not when it mounts', () => {
  // The whole of it. With `[]` this fired once, before any share existed, and
  // never again — and the screen is reused rather than remounted when the
  // room changes, so the share that arrived afterwards was never seen.
  const m = /useEffect\(\(\) => \{\n    if \(!initialShare\) return;([\s\S]*?)\n  \}, \[([^\]]*)\]\);/.exec(CHAT);
  assert.ok(m, 'could not find the share-staging effect');
  assert.strictEqual(m[2].trim(), 'initialShare',
    'the staging effect does not depend on the share, so a share arriving later is never staged');
  assert.ok(/onShareConsumed\?\.\(\)/.test(m[1]),
    'nothing tells the app the share was taken, so the overlay never comes down');
  assert.ok(/setPendingMedia\(/.test(m[1]), 'the files are never staged');
});

test('…and the screen really is reused rather than remounted', () => {
  // If ChatScreen were keyed by room this bug could not happen, and the fix
  // above would be unnecessary. It is not keyed — deliberately, because
  // remounting a chat on every room change throws away the whole list — so
  // the effect has to be the thing that notices.
  const at = APP.indexOf('<ChatScreen');
  assert.ok(at > 0, 'could not find ChatScreen in App');
  // A key would be written on the element itself; the props run for many
  // lines after it, and bounding this on the closing slash walks into the
  // arrow functions among them.
  const tag = APP.slice(at, APP.indexOf('\n', at));
  assert.ok(!/\bkey=/.test(tag),
    'ChatScreen is keyed now — if that is deliberate, this test and the effect comment are stale');
});

test('THE OVERLAY COVERS BOTH STAGES OF THE HAND-OFF', () => {
  // One overlay, deliberately: the intent arriving and the rooms loading,
  // then the chat staging what arrived. Before they were joined there was a
  // gap where the composer sat empty with nothing to say it was working.
  assert.strictEqual(overlayVisible({ hasShareIntent: true, shareRooms: null, screen: 'rooms' }), true,
    'nothing is shown while the room list loads');
  assert.strictEqual(overlayVisible({ pendingShare: { files: [] } }), true,
    'nothing is shown while the chat stages the share');
  assert.strictEqual(overlayVisible({ hasShareIntent: true, shareRooms: [], screen: 'rooms' }), false,
    'the overlay stays up over the chat picker it is meant to hand over to');
  assert.strictEqual(overlayVisible({}), false, 'the overlay is up when nothing is being shared');
});

test('…and never over the sign-in screen', () => {
  // A share that arrives before sign-in must not cover the one screen that
  // can do anything about it.
  assert.strictEqual(overlayVisible({ hasShareIntent: true, shareRooms: null, screen: 'auth' }), false,
    'the overlay covers the sign-in screen');
});

test('A HAND-OFF THAT NEVER COMPLETES IS ABANDONED', () => {
  // The backstop, not the fix. The overlay has no cancel of its own, so
  // without this any future variant of the bug above is an app that cannot be
  // used again until it is force-stopped.
  const now = 1_000_000;
  assert.strictEqual(handoffExpired({ since: now - HANDOFF_GRACE_MS, now }), true,
    'a hand-off that has waited the full grace is kept for ever');
  assert.strictEqual(handoffExpired({ since: now - 1, now }), false,
    'a share is thrown away while it is still being staged');
});

test('…and a clock that moves does not throw a share away', () => {
  const now = 1_000_000;
  // The first of these states intent rather than catching anything: a
  // negative wait is already below any positive grace, so removing the guard
  // that expresses it leaves every answer unchanged. Said here so the next
  // person does not read a passing test as proof the guard is load-bearing.
  assert.strictEqual(handoffExpired({ since: now + 5_000, now }), false,
    'a share stamped in the future is abandoned immediately');
  assert.strictEqual(handoffExpired({ since: null, now }), false, 'nothing pending is treated as expired');
  assert.strictEqual(handoffExpired({ since: 0, now }), false, 'a missing timestamp expires instantly');
});

test('THE GRACE IS LONGER THAN THE WORK IT WAITS FOR', () => {
  // Staging is a render away; this only has to be longer than that, and short
  // enough that somebody stuck is not stuck for long.
  assert.ok(HANDOFF_GRACE_MS >= 5_000, 'the grace is short enough to cut off a share that was working');
  assert.ok(HANDOFF_GRACE_MS <= 30_000, 'a frozen app is left frozen for half a minute');
});

test('THE OVERLAY CAN BE DISMISSED BY HAND', () => {
  // The other half of the severity: a full-screen Modal with no cancel and no
  // onRequestClose cannot be escaped at all on Android.
  const at = APP.indexOf('overlayVisible({');
  assert.ok(at > 0, 'the overlay no longer uses the shared rule');
  // The opening tag only: from the <Modal before the rule to the line that
  // closes it. Bounding on the next '>' lands inside an arrow function.
  const from = APP.lastIndexOf('<Modal', at);
  const modal = APP.slice(from, APP.indexOf('\n          >', from));
  assert.ok(/onRequestClose=\{\(\) => setPendingShare\(null\)\}/.test(modal),
    'hardware back does nothing, so a stuck hand-off leaves the app unusable');
});

test('…and the backstop is actually armed', () => {
  // A timeout that is written and never scheduled is the same as none.
  const eff = /useEffect\(\(\) => \{\n    if \(!pendingShare\) return;([\s\S]*?)\n  \}, \[pendingShare\]\);/.exec(APP);
  assert.ok(eff, 'nothing watches a pending hand-off');
  assert.ok(/handoffExpired\(\{ since: started, now: Date\.now\(\) \}\)/.test(eff[1]),
    'the timer fires and the elapsed time is never checked');
  assert.ok(/setPendingShare\(null\)/.test(eff[1]), 'the expired hand-off is never cleared');
  assert.ok(/clearTimeout\(t\)/.test(eff[1]),
    'the timer outlives the share, so a later one is cut short by an older timer');
});

// ── The chat picker, opening twice ─────────────────────────────────────────
//
// Reported as: sharing something to the app opens the chat list several times
// — two, in the report.
//
// The picker was guarded by a boolean, "a picker has been built", and both
// ways out of a share set it back to false on their way past, together with
// the room list that was the second guard. That is only safe if the intent is
// gone by the next render, and it is not: resetShareIntent goes through React
// state, and it only fires when the shareIntent captured in its own closure
// still looks present. So the effect ran again with the intent still reported
// and nothing left to stop it.
//
// A boolean cannot say WHICH share was dealt with, which is the thing that
// needed remembering.

test('THE SAME SHARE IS RECOGNISED AFTER THE HOOK REBUILDS IT', () => {
  // The hook makes a new object on every refresh, so object identity changes
  // while the share does not — which is exactly the case the old boolean was
  // standing in for and got wrong.
  const a = { files: [{ path: '/cache/a.jpg', fileName: 'A.jpg' }], text: 'hello' };
  const b = { files: [{ path: '/cache/a.jpg', fileName: 'A.jpg' }], text: 'hello' };
  assert.strictEqual(shareKey(a), shareKey(b), 'the same share reads as two, so the picker opens twice');
});

test('…and a DIFFERENT share still gets a picker', () => {
  // The failure that would be worse than the bug: a guard that sticks, and a
  // second share that can never be sent anywhere.
  const a = { files: [{ path: '/cache/a.jpg' }] };
  assert.notStrictEqual(shareKey(a), shareKey({ files: [{ path: '/cache/b.jpg' }] }),
    'two different files read as one share');
  assert.notStrictEqual(shareKey({ text: 'one' }), shareKey({ text: 'two' }),
    'two different texts read as one share');
  assert.notStrictEqual(shareKey({ webUrl: 'https://a' }), shareKey({ webUrl: 'https://b' }),
    'two different links read as one share');
});

test('…and it is never empty while a share is present', () => {
  // The key is compared against a ref that starts empty. "" on both sides
  // would read as "already handled" for a share nobody has touched, and no
  // picker would ever open.
  for (const si of [{}, null, undefined, { files: [] }]) {
    assert.ok(shareKey(si), `an empty share keys to nothing: ${JSON.stringify(si)}`);
  }
});

test('BOTH WAYS OUT RECORD WHICH SHARE THEY HANDLED', () => {
  // Choosing a chat and cancelling both used to disarm the guard instead,
  // which is what let the picker come back.
  const choose = /function chooseShareTarget\(r: any\) \{([\s\S]*?)\n  \}/.exec(APP);
  assert.ok(choose, 'could not find chooseShareTarget');
  assert.ok(/handledShareRef\.current = shareKey\(si\);/.test(choose[1]),
    'choosing a chat does not record the share, so the picker opens again');
  assert.ok(choose[1].indexOf('handledShareRef.current') < choose[1].indexOf('resetShareIntent()'),
    'the share is recorded after the reset, which is the race that caused this');
  const cancel = /function cancelShare\(\) \{([\s\S]*?)\n  \}/.exec(APP);
  assert.ok(cancel, 'could not find cancelShare');
  assert.ok(/handledShareRef\.current = shareKey\(shareIntent\);/.test(cancel[1]),
    'cancelling does not stick, so the picker comes straight back');
});

test('…and neither of them disarms the guard any more', () => {
  assert.ok(!/sharePickerBuiltRef/.test(APP),
    'the boolean guard is back; it cannot say which share was handled');
  const eff = /if \(!hasShareIntent\) \{ handledShareRef\.current = ''; buildingShareRef\.current = ''; return; \}/.exec(APP);
  assert.ok(eff, 'nothing re-arms for the next share when the intent finally clears');
});

test('A LIST ALREADY ON ITS WAY IS NOT FETCHED TWICE', () => {
  // The room list is a round trip and the effect re-runs while it is in
  // flight, so without this a slow connection buys two requests and two
  // pickers — the same symptom by a different route.
  assert.ok(/if \(buildingShareRef\.current === key\) return;/.test(APP),
    'a second fetch starts while the first is still running');
  assert.ok(/buildingShareRef\.current = key;/.test(APP), 'nothing records the fetch in flight');
});

test('THE EFFECT WATCHES THE SHARE IT KEYS ON', () => {
  // The key is computed from shareIntent, so an effect that does not depend
  // on it would compare against a stale one.
  assert.ok(/\}, \[hasShareIntent, screen, shareRooms, shareIntent\]\);/.test(APP),
    'the picker effect ignores the share it is keyed on');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
