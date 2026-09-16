// Persian sentences with English words in them.
//
// Reported with two screenshots side by side: the same paragraph, correct in
// the app it was copied from and scrambled in ours — "(DWT) باربری" landing in
// the middle of a different clause, a full stop at the wrong end of a line, a
// number separated from the unit it belongs to.
//
// Nothing reordered the words. Unicode's bidirectional algorithm did what it
// is supposed to do, against the wrong BASE DIRECTION.
//
// Every paragraph of mixed text has one, and it decides where the NEUTRAL
// characters go — spaces, digits, brackets, punctuation. A Persian sentence
// laid out in an LTR paragraph keeps its Persian words in the right order
// (they are a strong RTL run) and hangs everything neutral off the wrong end.
// The words are all there and the sentence is unreadable.
//
// The web set no direction at all, so every message inherited the document's.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'bidi.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'bidi-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'bidi.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'bidi.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// The paragraph from the report, as it was pasted in.
const REPORTED = 'طبق داده‌های ثبت کشتی، کایلو یه نفتکش نوع Suezmax، ساخت سال ۲۰۰۱ بوده، '
  + 'با ظرفیت باربری (DWT) حدود ۱۶۰,۵۷۳ تن و طول ۲۷۴ متر. این کشتی قبلاً هم تحت تحریم '
  + 'آمریکا و بریتانیا بوده، چون در انتقال نفت ایران و روسیه با روش‌های پنهانی '
  + '(مثل خاموش‌کردن AIS) نقش داشته.';

// ── Which way round ─────────────────────────────────────────────────────────

test('THE BUG: the reported paragraph is a Persian one', () => {
  // It has Suezmax, DWT, AIS and a pile of digits in it, and it is still
  // Persian. Laid out LTR — which is what having no direction meant — the
  // brackets and the full stops go to the wrong ends.
  assert.strictEqual(W.baseDirection(REPORTED), 'rtl');
});

test('English stays English', () => {
  assert.strictEqual(W.baseDirection('The tanker was built in 2001 (DWT 160,573).'), 'ltr');
  assert.strictEqual(W.baseDirection('hello'), 'ltr');
});

test('a mostly-English sentence with one Persian word is English', () => {
  assert.strictEqual(
    W.baseDirection('The word سلام means hello in Persian, a common greeting'), 'ltr');
});

test('NOT first-strong: a Persian sentence opening with a product name', () => {
  // dir="auto" takes the first strong character, so this would be laid out
  // backwards for the sake of one word — and these users write exactly like
  // this.
  const s = 'Suezmax یه نفتکش بزرگه که ظرفیت زیادی داره و برای انتقال نفت استفاده میشه';
  assert.strictEqual(W.baseDirection(s), 'rtl',
    'the first word decided the paragraph, which is what dir="auto" gets wrong here');
});

test('a third is enough to make it Persian', () => {
  assert.ok(W.RTL_SHARE <= 0.4 && W.RTL_SHARE > 0, `share is ${W.RTL_SHARE}`);
  // Exactly at the line, and just under it.
  const at = 'ابت' + 'abcdefg';        // 3 rtl of 10 strong
  assert.strictEqual(W.baseDirection(at), 'rtl');
  assert.strictEqual(W.baseDirection('اب' + 'abcdefgh'), 'ltr');
});

test('nothing strong at all is left alone', () => {
  assert.strictEqual(W.baseDirection(''), 'ltr');
  assert.strictEqual(W.baseDirection(null), 'ltr');
  assert.strictEqual(W.baseDirection('12345 (99) — !!'), 'ltr');
  assert.strictEqual(W.baseDirection('🙂🎉'), 'ltr');
});

test('Arabic and Hebrew are RTL too, not only Persian', () => {
  assert.strictEqual(W.baseDirection('مرحبا كيف حالك اليوم يا صديقي'), 'rtl');
  assert.strictEqual(W.baseDirection('שלום מה שלומך היום ידידי'), 'rtl');
});

test('the alignment follows the direction, and never contradicts it', () => {
  assert.strictEqual(W.alignFor('rtl'), 'right');
  assert.strictEqual(W.alignFor('ltr'), 'left');
  assert.deepStrictEqual(W.textDirection(REPORTED), { dir: 'rtl', align: 'right' });
  assert.deepStrictEqual(W.textDirection('hello there'), { dir: 'ltr', align: 'left' });
});

test('a fragment dropped into another line is fenced off', () => {
  // A preview or a quote sits INSIDE somebody else's row, and without an
  // isolate it drags that row's punctuation around with it.
  const wrapped = W.isolate('سلام');
  assert.strictEqual(wrapped.codePointAt(0), 0x2068, 'not a first-strong isolate');
  assert.strictEqual(wrapped.codePointAt(wrapped.length - 1), 0x2069, 'the isolate is never closed');
  assert.ok(wrapped.includes('سلام'));
  // Nothing to fence is left alone rather than becoming two invisible
  // characters that measure as a non-empty string.
  assert.strictEqual(W.isolate(''), '');
  assert.strictEqual(W.isolate(null), '');
});

test('the web and the app agree, sentence by sentence', () => {
  if (!A) return;
  const cases = [REPORTED, '', 'hello', 'سلام', 'Suezmax یه نفتکش بزرگه که ظرفیت زیادی داره',
    'The word سلام means hello', '12345', '🙂', 'שלום', 'مرحبا'];
  let checked = 0;
  for (const c of cases) {
    assert.strictEqual(W.baseDirection(c), A.baseDirection(c), `directions diverge for "${c}"`);
    assert.deepStrictEqual(W.textDirection(c), A.textDirection(c));
    assert.strictEqual(W.isolate(c), A.isolate(c));
    checked++;
  }
  assert.strictEqual(W.RTL_SHARE, A.RTL_SHARE);
  assert.strictEqual(checked, cases.length, 'the drift check did not actually run');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('every message on the web carries its own direction', () => {
  assert.ok(/Bidi\.applyDirection\(textSpan, msg\.content \|\| ''\)/.test(app),
    'a message is drawn with no direction, so it inherits the page and scrambles');
  // …including one that has just been edited, which is rebuilt by another path.
  const edit = app.slice(app.indexOf('function applyEdit('), app.indexOf('// ─── Delete'));
  assert.ok(/Bidi\.applyDirection\(textSpan, content\)/.test(edit),
    'an edited message loses its direction');
  // …and the quote above it, the reply bar, the comments heading, and a draft
  // put back into the composer — a Persian sentence restored with no direction
  // reads backwards in the box it was typed in.
  //
  // An exact count rather than "at least": a new place that draws somebody's
  // words should fail here until somebody has decided whether it needs a
  // direction, which is the only way this stays true as the file grows.
  assert.strictEqual((app.match(/Bidi\.applyDirection\(/g) || []).length, 6,
    'some of the places that draw somebody\'s words still do not set a direction');
  const restore = app.slice(app.indexOf('function restoreDraft('), app.indexOf('function clearDraft('));
  assert.ok(/Bidi\.applyDirection\(el, el\.value\)/.test(restore),
    'a restored draft loses the direction it was typed in');
  assert.ok(/src="\/js\/bidi\.js"/.test(html),
    'bidi.js is never loaded, so Bidi is undefined and drawing a message throws');
});

test('the direction is set on something that can HOLD a paragraph', () => {
  // An inline span cannot start one, so the direction it was given would be
  // ignored by the bidi algorithm — the fix would be there in the DOM and do
  // nothing on screen.
  assert.ok(/\.msg-bubble > span\[dir\] \{[^}]*display: block/.test(css),
    'the text is inline, so its direction has no paragraph to apply to');
});

test('the composer follows what is being typed', () => {
  const input = html.slice(html.indexOf('id="msg-input"'), html.indexOf('id="msg-input"') + 400);
  assert.ok(/dir="auto"/.test(input),
    'typing Persian shows the caret and the punctuation at the wrong end');
});

test('the app lays a message out the same way', () => {
  assert.ok(/msgDirStyle\(msg\.content \|\| ''\)/.test(chat), 'the app message has no direction');
  const fn = chat.slice(chat.indexOf('function msgDirStyle('), chat.indexOf('// Kept for the select sheet'));
  assert.ok(/textDirection\(text\)/.test(fn), 'the app decides direction by hand');
  assert.ok(/writingDirection: dir/.test(fn) && /textAlign: align/.test(fn),
    'the app sets one of the two and lets the other contradict it');
  assert.ok(/from '\.\.\/bidi'/.test(chat), 'the app keeps a private copy of the rule');
  // The old private heuristic is gone rather than left to drift.
  assert.ok(!/\\u0590-\\u05FF/.test(chat), 'the app still has its own character ranges');
  // Previews are fragments and are fenced, not merely aligned.
  assert.ok(/bidiIsolate\(replyPreview\(msg\)\)/.test(chat), 'the app reply quote is not fenced');
  assert.ok(/bidiIsolate\(parentPreview\(/.test(chat), 'the comments heading is not fenced');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
