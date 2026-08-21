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

test('THE PROMISE NOT MADE: blocking never claims to stop the other person sending', () => {
  // They are not stopped. Their app still lets them type and send; the
  // messages simply never arrive, and they are never told why. Saying "they
  // cannot message you" would be a promise about somebody else's screen that
  // this app does not keep.
  for (const s of [P.blockHint(false, 'sara'), P.blockConfirm(false, 'sara').body]) {
    assert.ok(!/not be able to send/i.test(s), `claims to stop them sending: ${s}`);
    assert.ok(/reach|receiv/i.test(s), `does not say what actually happens: ${s}`);
  }
});

test('blocking says that online status goes too', () => {
  // Being able to watch when somebody is at their phone is exactly the kind of
  // contact blocking is for, and the one that leaves no trace — so it is worth
  // saying, not just doing.
  assert.ok(/online/i.test(P.blockHint(false, 'sara')), P.blockHint(false, 'sara'));
  assert.ok(/online/i.test(P.blockConfirm(false, 'sara').body));
});

test('and that the other person is not told', () => {
  assert.ok(/not told|do not know|never told/i.test(P.blockConfirm(false, 'sara').body),
    P.blockConfirm(false, 'sara').body);
});

// ── A message that never arrived ────────────────────────────────────────────

test('THE FEEL OF IT: an undelivered message is faded and carries no tick', () => {
  const v = P.vanishedStyle(1);
  assert.strictEqual(v.faded, true);
  assert.strictEqual(v.dashed, true);
  // A ✓ claiming delivery for something the server deliberately withheld
  // would be the one outright lie in this design.
  assert.strictEqual(v.showTicks, false, 'an undelivered message claimed to be delivered');
});

test('an ordinary message is drawn normally, and does show its tick', () => {
  for (const v of [P.vanishedStyle(0), P.vanishedStyle(undefined), P.vanishedStyle(false)]) {
    assert.strictEqual(v.faded, false);
    assert.strictEqual(v.dashed, false);
    assert.strictEqual(v.showTicks, true);
  }
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
  ].map(x => x.replace(/sara's/g, 'sara'))) {
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

// ── The web copy must not drift ─────────────────────────────────────────────
//
// public/js/peerActions.js says it mirrors the TypeScript exactly. That claim
// rots the first time somebody edits one and not the other, and the symptom is
// the worst possible kind: two clients quietly disagreeing about what "block"
// or "clear for both" means, with no error anywhere.
//
// So it is checked, over every input that changes an answer, rather than
// trusted.

const WEB = require(path.join(__dirname, '..', 'public', 'js', 'peerActions.js'));

test('the web build exposes the same functions as the app', () => {
  const missing = Object.keys(P).filter(k => typeof P[k] === 'function' && typeof WEB[k] !== 'function');
  assert.deepStrictEqual(missing, [], `the web copy is missing: ${missing.join(', ')}`);
});

test('THE DRIFT CHECK: web and app agree on every answer', () => {
  const names = ['sara', 'ali_2', 'کاربر'];
  const bools = [true, false];
  const mismatches = [];
  const same = (what, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      mismatches.push(`${what}\n        app: ${JSON.stringify(a)}\n        web: ${JSON.stringify(b)}`);
    }
  };

  for (const isDm of bools) {
    same(`clearScopes(${isDm})`, P.clearScopes(isDm), WEB.clearScopes(isDm));
    same(`canClearForBoth(${isDm})`, P.canClearForBoth(isDm), WEB.canClearForBoth(isDm));
    for (const isSelf of bools) {
      const peer = someone({ isSelf });
      same(`actionsFor(self=${isSelf}, dm=${isDm})`, P.actionsFor(peer, isDm), WEB.actionsFor(peer, isDm));
    }
  }
  for (const name of names) {
    for (const scope of ['me', 'both']) {
      same(`clearLabel(${scope})`, P.clearLabel(scope), WEB.clearLabel(scope));
      same(`clearHint(${scope}, ${name})`, P.clearHint(scope, name), WEB.clearHint(scope, name));
      same(`clearConfirm(${scope}, ${name})`, P.clearConfirm(scope, name), WEB.clearConfirm(scope, name));
    }
    for (const on of bools) {
      same(`muteLabel(${on})`, P.muteLabel(on), WEB.muteLabel(on));
      same(`muteHint(${on}, ${name})`, P.muteHint(on, name), WEB.muteHint(on, name));
      same(`blockLabel(${on})`, P.blockLabel(on), WEB.blockLabel(on));
      same(`blockHint(${on}, ${name})`, P.blockHint(on, name), WEB.blockHint(on, name));
      same(`blockConfirm(${on}, ${name})`, P.blockConfirm(on, name), WEB.blockConfirm(on, name));
    }
    same(`avatarFor(${name})`, P.avatarFor({ username: name }), WEB.avatarFor({ username: name }));
    same(`avatarFor(${name} + emoji)`,
      P.avatarFor({ username: name, avatar: '🦊' }), WEB.avatarFor({ username: name, avatar: '🦊' }));
  }
  for (const v of [1, 0, true, false, undefined, null]) {
    same(`vanishedStyle(${v})`, P.vanishedStyle(v), WEB.vanishedStyle(v));
  }

  assert.deepStrictEqual(mismatches, [],
    `the web copy has drifted from the app:\n      ${mismatches.join('\n      ')}`);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
