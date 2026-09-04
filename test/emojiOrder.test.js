// The emoji bar, arranged by what you actually use.
//
// Asked for as: the arrangement of emojis on the emoji bar should change
// automatically based on the most used ones.
//
// The bar was a fixed list in an order somebody guessed once. The two or three
// anybody really uses ended up wherever they happened to be put, which for a
// bar that scrolls means off the edge of the screen.
//
// THE PART THAT IS EASY TO GET WRONG is not the counting, it is WHEN the order
// may change. A bar that re-sorts the instant you tap is hostile: the finger is
// already moving towards where the next one was, and it has been replaced. So
// counting is immediate and the order is recomputed only when the bar OPENS.
// That is what the wiring checks at the bottom are for — the pure rules cannot
// see it, and it is the half a user would actually feel.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'emojiOrder.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'emoord-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'emojiOrder.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'emojiOrder.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

const BAR = ['😂', '❤️', '😘', '👍', '🙏', '😍'];

// ── The rule ────────────────────────────────────────────────────────────────

test('THE ASK: the most used emoji comes first', () => {
  let c = {};
  for (let i = 0; i < 5; i++) c = W.bump(c, '🙏');
  c = W.bump(c, '❤️');
  assert.deepStrictEqual(W.orderFor(BAR, c).slice(0, 2), ['🙏', '❤️'],
    'the bar is still in the order somebody guessed');
});

test('the SET never changes — this reorders, it never adds or removes', () => {
  const c = W.bump(W.bump({}, '🥳'), '🥳'); // used, but not in this user's bar
  const out = W.orderFor(BAR, c);
  assert.deepStrictEqual(out.slice().sort(), BAR.slice().sort(),
    'somebody who chose exactly these twelve no longer has exactly these twelve');
  assert.strictEqual(out.length, BAR.length);
});

test('unused emojis keep the order they were given', () => {
  // Ties break on the ORIGINAL index, which is what stops the bar shuffling
  // for no reason.
  assert.deepStrictEqual(W.orderFor(BAR, {}), BAR, 'an untouched bar rearranged itself');
  assert.deepStrictEqual(W.orderFor(BAR, { '😂': 3, '❤️': 3 }).slice(0, 2), ['😂', '❤️'],
    'two equally used emojis swapped places');
});

test('it is most used LATELY: counts age instead of ossifying', () => {
  let old = {};
  // One emoji hammered long ago, past the ageing threshold.
  for (let i = 0; i < W.AGE_AT; i++) old = W.bump(old, '😂');
  assert.ok(old['😂'] <= W.AGE_AT / 2,
    'nothing ages, so the first week of use freezes the bar forever');
  // A newcomer can now overtake it in far fewer than AGE_AT uses.
  let c = old;
  for (let i = 0; i < old['😂'] + 1; i++) c = W.bump(c, '🙏');
  assert.strictEqual(W.orderFor(BAR, c)[0], '🙏');
});

test('ageing rescales without reordering', () => {
  let c = {};
  for (let i = 0; i < 10; i++) c = W.bump(c, '👍');
  for (let i = 0; i < 4; i++) c = W.bump(c, '🙏');
  const before = W.orderFor(BAR, c);
  for (let i = c['😂'] || 0; i < W.AGE_AT; i++) c = W.bump(c, '😂');
  // 😂 is now on top, but the two below it kept their relative order — the
  // halving is a change of scale, not of ranking.
  assert.deepStrictEqual(W.orderFor(BAR, c).filter(e => e === '👍' || e === '🙏'),
    before.filter(e => e === '👍' || e === '🙏'), 'the halving reshuffled the ranking');
});

test('the store cannot grow without bound', () => {
  let c = {};
  for (let i = 0; i < W.MAX_TRACKED + 25; i++) c = W.bump(c, 'e' + i);
  assert.ok(Object.keys(c).length <= W.MAX_TRACKED,
    `kept ${Object.keys(c).length} counts; this is written to storage on every tap`);
});

test('bump does not mutate what it was given', () => {
  // The counts are held in a module-level variable read by other renders; a
  // mutation in place would move the bar under a finger.
  const c = { '😂': 1 };
  const next = W.bump(c, '😂');
  assert.strictEqual(c['😂'], 1, 'bump edited the caller\'s object');
  assert.strictEqual(next['😂'], 2);
});

test('only a deliberate PICK counts', () => {
  assert.strictEqual(W.countsAsUse('bar'), true);
  assert.strictEqual(W.countsAsUse('reaction'), true);
  // A message that happens to contain an emoji is not a vote for it: one long
  // message about a party would promote 🎉 over the things used every day.
  assert.strictEqual(W.countsAsUse('typed'), false);
});

test('rubbish in does not corrupt the order', () => {
  assert.deepStrictEqual(W.orderFor(BAR, null), BAR);
  assert.deepStrictEqual(W.orderFor(null, {}), []);
  assert.deepStrictEqual(W.orderFor(BAR, { '😂': 'lots' }), BAR, 'a bad count poisoned the sort');
  assert.deepStrictEqual(W.bump({}, ''), {}, 'an empty emoji was counted');
});

// ── The two copies ──────────────────────────────────────────────────────────

test('the web and the app order identically', () => {
  if (!A) return;
  assert.strictEqual(W.AGE_AT, A.AGE_AT);
  assert.strictEqual(W.MAX_TRACKED, A.MAX_TRACKED);
  let cw = {}, ca = {};
  let checked = 0;
  // The same sequence of picks through both, comparing the bar at every step.
  const picks = ['😂', '🙏', '🙏', '❤️', '👍', '🙏', '😍', '😍', '😍', '😍'];
  for (let round = 0; round < 12; round++) {
    for (const p of picks) { cw = W.bump(cw, p); ca = A.bump(ca, p); }
    assert.deepStrictEqual(cw, ca, 'the counts diverged');
    assert.deepStrictEqual(W.orderFor(BAR, cw), A.orderFor(BAR, ca), 'the bars diverged');
    checked++;
  }
  assert.strictEqual(checked, 12, 'the drift check did not actually run');
  for (const s of ['bar', 'reaction', 'typed', 'nonsense']) {
    assert.strictEqual(W.countsAsUse(s), A.countsAsUse(s), `disagree on ${s}`);
  }
});

// ── The wiring, which the rules above cannot see ────────────────────────────

const webApp = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

test('the web bar is built through the rule and records its own taps', () => {
  const start = webApp.indexOf('function initQuickEmoji(');
  assert.ok(start > 0, 'initQuickEmoji is gone — this check is vacuous');
  const body = webApp.slice(start, webApp.indexOf('\n}', start));
  assert.ok(/EmojiOrder\.orderFor\(/.test(body),
    'the web bar is rendered in the fixed order, so nothing the user does moves it');
  assert.ok(/noteEmojiUse\(/.test(body), 'tapping a bar emoji is not counted');
  // Reacting is a pick too, and it is the commoner one.
  const pick = webApp.slice(webApp.indexOf('function pickEmoji('));
  assert.ok(/noteEmojiUse\(emoji, 'reaction'\)/.test(pick.slice(0, 400)),
    'reactions are not counted, so the bar only learns from the composer');
  // And the module has to actually be on the page.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/src="\/js\/emojiOrder\.js"/.test(html),
    'emojiOrder.js is never loaded, so EmojiOrder is undefined and the bar throws');
});

test('a missing or unreadable store leaves the bar working', () => {
  // localStorage throws outright in some privacy modes, and the bar must not
  // be the thing that takes the chat down.
  const start = webApp.indexOf('function emojiCounts(');
  assert.ok(start > 0, 'emojiCounts is gone — this check is vacuous');
  const body = webApp.slice(start, webApp.indexOf('\n}', start));
  assert.ok(/try/.test(body) && /catch/.test(body), 'a throwing localStorage takes out the bar');
});

test('the app bar is built through the rule and records its own taps', () => {
  const fav = fs.readFileSync(path.join(NAT, 'src', 'favEmojis.ts'), 'utf8');
  assert.ok(/from '\.\/emojiOrder'/.test(fav), 'the app keeps its own private copy of the rule');
  assert.ok(/countsAsUse\(source\)/.test(fav), 'the app counts things the web does not');
  assert.ok(/AsyncStorage\.setItem\(COUNTS_KEY/.test(fav), 'the counts die with the process');
  assert.ok(/orderFor\(list, counts\)/.test(fav), 'the app bar is still in the fixed order');

  const comp = fs.readFileSync(path.join(NAT, 'src', 'components', 'Composer.tsx'), 'utf8');
  assert.ok(/useOrderedFavEmojis\(/.test(comp), 'the composer bar is not ordered');
  assert.ok(/noteEmojiUse\(em, 'bar'\)/.test(comp), 'tapping a bar emoji is not counted');

  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/useOrderedFavEmojis\(/.test(chat), 'the reaction rows are not ordered');
  const react = chat.slice(chat.indexOf('function toggleReact('));
  assert.ok(/noteEmojiUse\(emoji, 'reaction'\)/.test(react.slice(0, 400)),
    'reacting is not counted on the app');
});

test('THE HOSTILE CASE: the bar does not rearrange while it is open', () => {
  // The order is pinned to an "is this open" value, so it is recomputed on the
  // way in and then held. Without that dependency the row would re-sort under
  // the user's finger on every single tap.
  const fav = fs.readFileSync(path.join(NAT, 'src', 'favEmojis.ts'), 'utf8');
  const start = fav.indexOf('export function useOrderedFavEmojis(');
  assert.ok(start > 0, 'useOrderedFavEmojis is gone — this check is vacuous');
  const body = fav.slice(start, fav.indexOf('\n}', start));
  assert.ok(/useMemo\(/.test(body),
    'the order is recomputed on every render, so it changes under a moving finger');
  assert.ok(/\[list, openKey\]/.test(body),
    'the order is not pinned to the moment the bar opened');

  const comp = fs.readFileSync(path.join(NAT, 'src', 'components', 'Composer.tsx'), 'utf8');
  assert.ok(/useOrderedFavEmojis\(quickEmoji\)/.test(comp),
    'the composer does not pin its order to the bar being open');
  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/useOrderedFavEmojis\(!!emojiPicker \|\| !!actionsMsg\)/.test(chat),
    'the reaction rows do not pin their order to the sheet being open');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
