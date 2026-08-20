// Mute, block and clear (native-app/src/peerActions.ts).
//
// All three read as "make this go away" and mean three very different things.
// Getting the wording or the availability wrong is how somebody destroys a
// conversation they meant to hide, or believes they have stopped a person
// contacting them when they have only silenced the buzz — so the rules live
// away from the sheet that draws them, where they can be pinned down.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'peeract-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'peerActions.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping peer-action tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const P = require(path.join(OUT, 'peerActions.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const someone = (over = {}) => ({ username: 'sara', muted: false, blocked: false, ...over });

// ── Which clear options exist ───────────────────────────────────────────────

test('THE DANGEROUS ONE: "clear for both" is offered only in a direct chat', () => {
  // In a group it would be one member destroying everybody else's record of a
  // conversation they were all part of — and unlike two people, who can simply
  // talk again, there is nobody there whose agreement it stands for.
  assert.deepStrictEqual(P.clearScopes(true), ['me', 'both']);
  assert.deepStrictEqual(P.clearScopes(false), ['me']);
  assert.strictEqual(P.canClearForBoth(false), false);
  assert.strictEqual(P.canClearForBoth(true), true);
});

test('clearing your own copy is always available', () => {
  assert.ok(P.clearScopes(true).includes('me'));
  assert.ok(P.clearScopes(false).includes('me'));
});

// ── Saying what each one does ───────────────────────────────────────────────

test('both clear options say what happens to the OTHER person\'s copy', () => {
  // That difference is the whole distinction between them, and the only thing
  // somebody can get wrong at the moment they tap.
  const mine = P.clearHint('me', 'sara');
  const both = P.clearHint('both', 'sara');
  assert.ok(/keeps their copy/i.test(mine), mine);
  assert.ok(/sara/.test(both) && /delete/i.test(both), both);
  assert.notStrictEqual(mine, both);
});

test('the irreversible option asks first; the reversible one does not', () => {
  const both = P.clearConfirm('both', 'sara');
  assert.ok(both && /both/i.test(both.title), 'deleting for both went ahead unconfirmed');
  assert.ok(/permanent/i.test(both.body), both.body);
  // Clearing your own copy takes nothing from anyone and the chat returns the
  // moment either of you speaks, so a dialog here is only ever in the way.
  assert.strictEqual(P.clearConfirm('me', 'sara'), null);
});

test('blocking asks first; unblocking does not', () => {
  const b = P.blockConfirm(false, 'sara');
  assert.ok(b && /sara/.test(b.title), 'blocking someone went ahead unconfirmed');
  assert.strictEqual(P.blockConfirm(true, 'sara'), null);
});

test('THE MISUNDERSTANDING THIS HEADS OFF: mute does not hide messages', () => {
  // "Mute" is widely assumed to mean the messages stop arriving. Somebody who
  // wanted that wanted block, and finding out later is the wrong time.
  const hint = P.muteHint(false, 'sara');
  assert.ok(/still arrive/i.test(hint), hint);
  assert.ok(/sara/.test(hint), hint);
});

test('every label flips with the state, so no button lies about what it does', () => {
  assert.notStrictEqual(P.muteLabel(true), P.muteLabel(false));
  assert.notStrictEqual(P.blockLabel(true), P.blockLabel(false));
  assert.notStrictEqual(P.muteHint(true, 'sara'), P.muteHint(false, 'sara'));
  assert.notStrictEqual(P.blockHint(true, 'sara'), P.blockHint(false, 'sara'));
  assert.ok(/^Unmute/.test(P.muteLabel(true)));
  assert.ok(/^Unblock/.test(P.blockLabel(true)));
});

test('the person\'s name appears in every explanation', () => {
  // "They will not be able to message you" is a sentence about nobody in
  // particular, on a sheet that can be opened from several places at once.
  for (const s of [
    P.muteHint(false, 'sara'), P.muteHint(true, 'sara'),
    P.blockHint(false, 'sara'), P.blockHint(true, 'sara'),
    P.clearHint('me', 'sara'), P.clearHint('both', 'sara'),
  ]) {
    assert.ok(s.includes('sara'), `no name in: ${s}`);
  }
});

// ── Which actions belong on the sheet ───────────────────────────────────────

test('a direct chat offers all three', () => {
  assert.deepStrictEqual(P.actionsFor(someone(), true), ['mute', 'block', 'clear']);
});

test('a person in a group offers no "clear" — there is no chat to clear', () => {
  assert.deepStrictEqual(P.actionsFor(someone(), false), ['mute', 'block']);
});

test('none of it is offered about yourself', () => {
  // "Block" on your own profile is exactly the kind of thing that gets tapped
  // once out of curiosity.
  assert.deepStrictEqual(P.actionsFor(someone({ isSelf: true }), true), []);
  assert.deepStrictEqual(P.actionsFor(someone({ isSelf: true }), false), []);
});

// ── The avatar ──────────────────────────────────────────────────────────────

test('a person is shown by their own emoji when they have one', () => {
  assert.strictEqual(P.avatarFor({ username: 'sara', avatar: '🦊' }), '🦊');
});

test('and by their initials when they do not', () => {
  // A row of identical speech bubbles tells you nothing about which
  // conversation is which.
  assert.strictEqual(P.avatarFor({ username: 'sara', avatar: null }), 'SA');
  assert.strictEqual(P.avatarFor({ username: 'sara' }), 'SA');
  assert.strictEqual(P.avatarFor({ username: 'sara', avatar: '' }), 'SA');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
