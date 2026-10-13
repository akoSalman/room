// ── Sharing a file OUT, and the share that wedged every one after it ───────
//
// Reported in three steps: shared a file to WhatsApp and it was fine; tried a
// second and the app crashed; every attempt after that failed with
//
//     Call to function 'ExpoSharing.shareAsync' has been rejected.
//     → Caused by: Another share request is being processed now.
//
// permanently, until the app was force-stopped.
//
// expo-sharing keeps ONE pending promise. shareAsync throws that exception if
// it is already set, and it is cleared in exactly one place — OnActivityResult.
// When that result never arrives the field stays set for the life of the
// module and nothing can share again. The result does not always arrive: the
// activity can be destroyed and recreated while the chooser is up, which is
// what a crash in the middle of sharing looks like, and the recreated activity
// is not the one the result was going to.
//
// Two separate faults, and either alone produces the message:
//
//   1. nothing on this side stopped two shares overlapping. The sharingOut
//      flag existed and drove an overlay; no code read it. A second tap is the
//      exception with no crash involved at all.
//
//   2. nothing could recover from a lost result. That is in the module, and
//      the module is patchable — unlike react-native's own code, which is a
//      prebuilt artifact. Checked rather than assumed this time: expo modules
//      are autolinked gradle subprojects built from source, and the generated
//      settings.gradle calls useExpoModules().
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const CHAT = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const PATCH = path.join(NAT, 'patches', 'expo-sharing+12.0.1.patch');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** shareOut's body, where the guard has to be. */
function shareOut() {
  const m = /async function shareOut\(msg: Message\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(m, 'could not find shareOut — every check here would be vacuous');
  return m[1];
}

test('TWO SHARES CANNOT OVERLAP', () => {
  // The second tap is "Another share request is being processed now" on its
  // own, with nothing crashing.
  const fn = shareOut();
  assert.ok(/if \(sharingOutRef\.current\) return;/.test(fn),
    'a second share can still start while the first sheet is open');
  assert.ok(/sharingOutRef\.current = true;/.test(fn), 'nothing marks a share as in flight');
  assert.ok(/sharingOutRef\.current = false;/.test(fn), 'the flag is never lowered');
});

test('…and the flag is a REF, not state', () => {
  // Two taps land in the same frame and both would read the state as it was
  // before either of them ran. The flag that was already here was state, and
  // nothing read it — reading it would not have worked.
  assert.ok(/const sharingOutRef = useRef\(false\)/.test(CHAT),
    'the guard is React state, which both taps in a frame see as false');
});

test('THE FLAG IS RAISED WHERE IT CANNOT LEAK', () => {
  // The trap in writing this: set it at the top of the function and the
  // several early returns below never lower it — a flag stuck on is exactly
  // the bug being fixed, and no share would work again. It has to go after
  // the last return that precedes the try.
  const fn = shareOut();
  const raised = fn.indexOf('sharingOutRef.current = true;');
  assert.ok(raised > 0, 'nothing raises the flag');
  // The try that FOLLOWS the flag: there is an earlier one around the gallery
  // parse, and anchoring on the first `try {` measured the wrong thing.
  const tryAt = fn.indexOf('try {', raised);
  assert.ok(tryAt > raised, 'the flag is raised with no try after it to lower it');
  const between = fn.slice(raised, tryAt);
  assert.ok(!/\breturn\b/.test(between),
    'there is a return between raising the flag and the try that lowers it — it would stay raised for ever');
  // And it is lowered in a finally, not on the happy path.
  assert.ok(/finally \{\n      sharingOutRef\.current = false;/.test(fn),
    'the flag is lowered only when the share succeeds');
});

test('A LOST RESULT NO LONGER WEDGES THE MODULE', () => {
  // The other half, and the one that explains "permanently". The pending
  // promise is cleared in OnActivityResult alone; a result that never comes
  // leaves it set for the life of the module.
  assert.ok(fs.existsSync(PATCH), 'the expo-sharing patch is gone — a lost result wedges sharing again');
  const patch = fs.readFileSync(PATCH, 'utf8');
  assert.ok(/SharingModule\.kt/.test(patch), 'the patch is not against the sharing module');
  assert.ok(/OnActivityEntersForeground \{/.test(patch),
    'nothing settles a pending share when the chooser is gone');
  const hook = patch.slice(patch.indexOf('OnActivityEntersForeground {'));
  assert.ok(/pendingPromise\?\.resolve\(null\)/.test(hook), 'the waiting promise is never settled');
  assert.ok(/pendingPromise = null/.test(hook),
    'the field is left set, which is the whole of the bug');
});

test('…and the real result still clears it first when it comes', () => {
  // The ordinary path must be untouched: a share that completes normally
  // resolves on its result, and the foreground hook then finds nothing.
  const patch = fs.readFileSync(PATCH, 'utf8');
  assert.ok(/OnActivityResult \{/.test(patch) || /OnActivityResult/.test(patch),
    'the patch removed the result handler');
  // Nothing in the patch deletes the existing clearing.
  assert.ok(!/^-.*pendingPromise = null/m.test(patch.replace(/^---.*$/gm, '')),
    'the patch removes the clearing that already worked');
});

test('THE PATCH IS SOMEWHERE THE BUILD COMPILES', () => {
  // The lesson from the react-native patch that never ran: node_modules is
  // not automatically compiled. Expo modules are — they are autolinked gradle
  // subprojects — and expo-sharing declares itself as one.
  const cfg = JSON.parse(fs.readFileSync(
    path.join(NAT, 'node_modules', 'expo-sharing', 'expo-module.config.json'), 'utf8'));
  assert.ok((cfg.platforms || []).includes('android'), 'expo-sharing no longer ships an android module');
  assert.ok((cfg.android?.modules || []).includes('expo.modules.sharing.SharingModule'),
    'the patched class is not the one autolinking registers');
  assert.ok(fs.existsSync(path.join(NAT, 'node_modules', 'expo-sharing', 'android', 'build.gradle')),
    'expo-sharing is no longer a gradle project, so its source may not be compiled');
});

test('AND THE REASON STILL REACHES THE PERSON', () => {
  // Whatever goes wrong, the message says which thing — that is how the
  // native text in the report got read at all.
  const fn = shareOut();
  assert.ok(/Alert\.alert\('Could not share', String\(e\?\.message/.test(fn),
    'a failed share is reported without saying what failed');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
