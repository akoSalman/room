// Folding a long message.
//
// Asked for as: long text messages should be expandable and foldable.
//
// A pasted article, a forwarded poem, a chain message — one of them fills the
// whole screen and pushes every other message out of the chat, and scrolling
// past it means flicking through somebody else's essay.
//
// The rule folds on LINES as well as characters, because forty short lines are
// as tall as one long paragraph and height is what hurts; and it cuts at a
// line or word boundary, because a cut through the middle of a word reads as
// damage rather than as a fold.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
require(path.join(ROOT, 'public', 'js', 'longText.js'));
const W = global.window.LongText;

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'longtext-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'longText.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'longText.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

const WORDS = 'the quick brown fox jumps over the lazy dog ';
const LONG = WORDS.repeat(30);                       // ~1300 characters
const MANY_LINES = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');

// ── What gets folded ────────────────────────────────────────────────────────

test('THE POINT: an ordinary message is never folded', () => {
  // A "Show more" that reveals a sentence is worse than the sentence.
  for (const t of ['hi', 'a normal message, a couple of lines long\nlike this', '', null]) {
    assert.strictEqual(W.showsToggle(t), false, JSON.stringify(t));
    assert.strictEqual(W.shownText(t, false), String(t == null ? '' : t));
  }
});

test('a pasted article is', () => {
  assert.strictEqual(W.showsToggle(LONG), true);
  assert.ok(W.shownText(LONG, false).length < LONG.length, 'the whole essay is still drawn');
});

test('and so is a message of many short lines', () => {
  // Forty short lines are as tall as one long paragraph, and height is the
  // thing that pushes the rest of the chat off the screen.
  assert.ok(MANY_LINES.length < W.FOLD_CHARS, 'this test no longer tests the line rule');
  assert.strictEqual(W.showsToggle(MANY_LINES), true, 'a wall of short lines is not folded');
  assert.strictEqual(W.lineCount(W.shownText(MANY_LINES, false)), W.PREVIEW_LINES,
    'the preview is not cut to a fixed number of lines');
});

test('the preview ends at a word, not in the middle of one', () => {
  const p = W.shownText(LONG, false);
  assert.ok(p.endsWith('…'), p.slice(-20));
  const beforeEllipsis = p.slice(0, -1);
  assert.ok(/[a-z]$/.test(beforeEllipsis), `cut mid-word: …${beforeEllipsis.slice(-15)}`);
  assert.ok(LONG.startsWith(beforeEllipsis), 'the preview is not the start of the message');
});

test('a single unbroken string is cut where it must be', () => {
  // No spaces and no newlines anywhere: there is nothing better to do than cut.
  const wall = 'x'.repeat(2000);
  const p = W.shownText(wall, false);
  assert.ok(p.length < wall.length, 'a wall of characters was drawn in full');
  assert.strictEqual(p, 'x'.repeat(W.PREVIEW_CHARS) + '…');
});

test('expanding shows the whole thing, exactly', () => {
  assert.strictEqual(W.shownText(LONG, true), LONG);
  assert.strictEqual(W.shownText(MANY_LINES, true), MANY_LINES);
});

test('the button says which way it goes', () => {
  assert.strictEqual(W.toggleLabel(false), 'Show more');
  assert.strictEqual(W.toggleLabel(true), 'Show less');
});

test('the preview is well under the threshold that triggered it', () => {
  // Otherwise folding a message would save a line or two and cost a tap.
  assert.ok(W.PREVIEW_CHARS < W.FOLD_CHARS, 'folding barely shortens anything');
  assert.ok(W.PREVIEW_LINES < W.FOLD_LINES);
  assert.ok(W.FOLD_LINES >= 8, 'ordinary multi-line messages will be folded');
});

test('the app and the web fold identically', () => {
  if (!A) return;
  const cases = [LONG, MANY_LINES, 'short', '', null, 'x'.repeat(2000),
    WORDS.repeat(60), 'a\n'.repeat(50), 'no spaces ' + 'y'.repeat(700)];
  let checked = 0;
  for (const t of cases) {
    assert.strictEqual(W.isLong(t), A.isLong(t), `isLong differs for ${String(t).slice(0, 20)}`);
    assert.strictEqual(W.shownText(t, false), A.shownText(t, false), 'folded text differs');
    assert.strictEqual(W.shownText(t, true), A.shownText(t, true), 'expanded text differs');
    assert.strictEqual(W.showsToggle(t), A.showsToggle(t));
    checked++;
  }
  assert.strictEqual(checked, cases.length, 'the drift check did not actually run');
  for (const k of ['FOLD_CHARS', 'FOLD_LINES', 'PREVIEW_CHARS', 'PREVIEW_LINES']) {
    assert.strictEqual(W[k], A[k], `${k} differs`);
  }
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('the web folds, and can be opened out again', () => {
  assert.ok(app.includes('function attachFold('), 'nothing folds a long message');
  assert.ok(/attachFold\(bubble, textSpan, msg\.content \|\| ''\)/.test(app), 'the fold is never applied');
  const fn = app.slice(app.indexOf('function attachFold('), app.indexOf('// ─── Link previews'));
  assert.ok(fn.includes('LongText.showsToggle(content)'), 'the web decides for itself what is long');
  assert.ok(fn.includes('LongText.shownText(content, expanded)'), 'it cuts the text its own way');
  assert.ok(/expanded = !expanded/.test(fn), 'a folded message cannot be opened');
  assert.ok(fn.includes('e.stopPropagation()'), 'the toggle also opens the message menu');
  assert.ok(html.includes('/js/longText.js'), 'the rules are never loaded by the page');
});

test('THE THING THAT MUST NOT BREAK: copy and edit still get the whole message', () => {
  // dataset.text is what Copy, Edit, Forward and search read.
  const at = app.indexOf("bubble.dataset.text = msg.content;");
  assert.ok(at > 0, 'the full text is no longer kept on the bubble');
  assert.ok(app.slice(at, at + 600).includes('attachFold('),
    'the fold is applied somewhere that may not have the full text beside it');
});

test('the links inside a folded message are re-rendered, not clipped', () => {
  // A CSS clip would leave half a link hanging off the fold with no way to
  // reach the rest of it.
  const fn = app.slice(app.indexOf('function attachFold('), app.indexOf('// ─── Link previews'));
  assert.ok(fn.includes('appendLinkifiedText(textSpan,'), 'the folded text is inserted as plain text');
  assert.ok(fn.includes("textSpan.innerHTML = ''"), 'each redraw appends to the last one');
});

test('the app folds too, from the same rule', () => {
  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/shownText\(msg\.content \|\| '', expandedIds\.has\(msg\.id\)\)/.test(chat),
    'the app still draws the whole message');
  assert.ok(/showsToggle\(msg\.content \|\| ''\)/.test(chat), 'there is no button in the app');
  assert.ok(chat.includes('function toggleExpanded('), 'nothing can open a folded message');
  // Through tokenPress, like everything else tappable inside a bubble.
  assert.ok(/tokenPress\(\(\) => toggleExpanded\(msg\.id\)\)/.test(chat),
    'tapping Show more also opens the message menu');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
