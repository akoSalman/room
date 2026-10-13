// ── Whose task the app opens in when something is shared to it ─────────────
//
// Reported with a photograph of the recents screen: after sharing from
// Telegram the two apps are "mixed" — Telegram's card is still listed, with
// Telegram's icon, and opening it opens this app.
//
// That is one Android behaviour: an activity started by another app runs
// inside THAT app's task unless it says otherwise, so the task keeps the
// sender's icon and label while this app sits on top of it. A share target has
// to ask for its own task, and the asking is three attributes in the manifest.
//
// What was there:
//
//     android:launchMode="singleTask"          ← correct, and the library's
//                                                own documented default
//     android:documentLaunchMode="never"       ← ours, unexplained
//     android:excludeFromRecents="false"
//
// `never` is the one of those that changes where an activity lands: it strips
// FLAG_ACTIVITY_NEW_DOCUMENT and FLAG_ACTIVITY_MULTIPLE_TASK from the incoming
// intent, which are the flags that give a share target a task of its own. It
// appears in no commit message and in none of the library's guidance. It is
// gone.
//
// Verified by generating the manifest — `expo prebuild` — and reading
// MainActivity's attributes before and after, rather than by reasoning about
// what the plugin ought to produce. That generation is minutes long and needs
// the whole toolchain, so what is pinned here is the configuration that drives
// it, with the finding written down beside it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const app = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** The share plugin's entry in the plugin list, with its options. */
function sharePlugin() {
  const found = (app.expo.plugins || []).find(p => Array.isArray(p) && p[0] === 'expo-share-intent');
  assert.ok(found, 'expo-share-intent is no longer configured — sharing into the app is gone');
  return found[1] || {};
}

test('THE APP ASKS FOR ITS OWN TASK', () => {
  // Without this the activity runs inside the sending app's task, which is
  // what put this app behind Telegram's icon in the recents list.
  const attrs = sharePlugin().androidMainActivityAttributes || {};
  assert.strictEqual(attrs['android:launchMode'], 'singleTask',
    'the share target no longer asks for its own task, so it opens inside the sender\'s');
});

test('THE BUG: nothing overrides the flags that grant it', () => {
  // documentLaunchMode="never" strips FLAG_ACTIVITY_NEW_DOCUMENT and
  // FLAG_ACTIVITY_MULTIPLE_TASK from the intent — the flags a share target
  // relies on to be given a task rather than joining one. It was ours, it was
  // never explained in any commit, and the library asks for launchMode alone.
  const attrs = sharePlugin().androidMainActivityAttributes || {};
  assert.ok(!('android:documentLaunchMode' in attrs),
    'documentLaunchMode is back; it overrides the flags that give a share target its own task');
});

test('…and the app still appears in recents at all', () => {
  // The opposite mistake: a share target nobody can get back to.
  const attrs = sharePlugin().androidMainActivityAttributes || {};
  assert.notStrictEqual(attrs['android:excludeFromRecents'], 'true',
    'the app hides itself from the recents list, so a share cannot be returned to');
});

test('THE TASK AFFINITY IS LEFT TO ANDROID, and that is deliberate', () => {
  // An affinity defaults to the package name, and the two brands have
  // different packages — so each already gets its own task, per brand, for
  // free. Writing one in by hand looked like making the intent explicit and
  // would have given BOTH brands the same affinity, letting the two apps'
  // tasks merge on a phone with both installed. That was nearly committed.
  const attrs = sharePlugin().androidMainActivityAttributes || {};
  assert.ok(!('android:taskAffinity' in attrs),
    'a task affinity is hardcoded; both brands would share it and their tasks could merge');
});

test('…which only works while the brands really do differ', () => {
  // The invariant the line above leans on. If two brands ever shipped the
  // same package the default affinity would stop separating them, and nothing
  // else here would notice.
  const names = fs.readdirSync(path.join(NAT, 'brands')).filter(f => f.endsWith('.json'));
  assert.ok(names.length >= 2, 'there is only one brand — this check would be vacuous');
  const packages = names.map(n =>
    JSON.parse(fs.readFileSync(path.join(NAT, 'brands', n), 'utf8')).package);
  assert.ok(packages.every(p => typeof p === 'string' && p),
    'a brand has no package, so its task affinity is undefined');
  assert.strictEqual(new Set(packages).size, packages.length,
    'two brands share a package name, so their tasks would merge');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
