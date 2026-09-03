// The keyboard, on an iPhone, taking the chat with it.
//
// Reported with a screen recording: opening the keyboard on the iPhone web
// version pushes the chat header off the top of the screen, and the composer
// ends up half under Safari's own toolbar — the row with ⌃ ⌄ and ✓.
//
// It is one of the oldest differences between mobile browsers. Chrome on
// Android shrinks the LAYOUT viewport when the keyboard opens, so a
// full-height page simply becomes shorter. Safari on iOS does not: the layout
// viewport keeps its full height and only the VISUAL viewport gets smaller. A
// `position: fixed; inset: 0` app therefore keeps its full height behind the
// keyboard, and Safari scrolls the page to bring the caret into view — which
// is exactly what takes the header away.
//
// The page had tried to fix this by setting the height of <html> and <body>.
// That could never work, and the reason is worth keeping: #app-screen is
// position:fixed, so it is laid out against the layout viewport and does not
// care what size its ancestors are. It has to be told directly.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
require(path.join(ROOT, 'public', 'js', 'viewportFit.js'));
const V = global.window.ViewportFit;

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

// An iPhone 14 Pro in Safari: 844 points tall, about 336 of them keyboard.
const CLOSED = { innerHeight: 844, vvHeight: 844, vvOffsetTop: 0 };
const OPEN = { innerHeight: 844, vvHeight: 508, vvOffsetTop: 0 };

// ── What the app should be sized to ─────────────────────────────────────────

test('THE POINT: with the keyboard up the app is the height you can see', () => {
  const box = V.boxFor(OPEN);
  assert.strictEqual(box.height, 508, 'the app still stretches behind the keyboard');
  assert.strictEqual(box.keyboardOpen, true);
});

test('and with it down, the whole screen', () => {
  const box = V.boxFor(CLOSED);
  assert.strictEqual(box.height, 844);
  assert.strictEqual(box.top, 0);
  assert.strictEqual(box.keyboardOpen, false);
});

test('the app follows the viewport when iOS scrolls it under the keyboard', () => {
  // Mid-animation the visual viewport is offset, and an app pinned to top:0
  // would sit that far off the top of the screen.
  const box = V.boxFor({ innerHeight: 844, vvHeight: 508, vvOffsetTop: 96 });
  assert.strictEqual(box.top, 96, 'the app is pinned to the layout viewport, not to what is visible');
});

test('Safari hiding its OWN toolbar is not a keyboard', () => {
  // The address bar collapsing shrinks the visual viewport too — by far less.
  // Treating that as a keyboard would fold the composer's buttons away every
  // time somebody scrolled the chat.
  const box = V.boxFor({ innerHeight: 844, vvHeight: 844 - 60, vvOffsetTop: 0 });
  assert.strictEqual(box.keyboardOpen, false, 'a scroll would hide the attachment buttons');
  assert.ok(V.KEYBOARD_MIN > 60 && V.KEYBOARD_MIN < 200, `threshold is ${V.KEYBOARD_MIN}`);
});

test('nonsense from the browser falls back to the window', () => {
  assert.strictEqual(V.boxFor({ innerHeight: 800 }).height, 800);
  assert.strictEqual(V.boxFor({}).height, 0);
  assert.strictEqual(V.boxFor(null).top, 0);
  assert.strictEqual(V.boxFor({ innerHeight: 800, vvHeight: 800, vvOffsetTop: -5 }).top, 0,
    'a negative offset moved the app off the top of the screen');
});

test('the extras fold away only while the keyboard is up', () => {
  assert.strictEqual(V.hidesExtras(true), true);
  assert.strictEqual(V.hidesExtras(false), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('THE OLD FIX IS GONE: html/body height is not what gets set', () => {
  // #app-screen is position:fixed. Sizing its ancestors did nothing at all,
  // which is why the keyboard still covered the composer.
  assert.ok(!/document\.body\.style\.height = window\.visualViewport\.height/.test(app),
    'the app is still trying to fix this by resizing <body>');
  assert.ok(/root\.style\.setProperty\('--vv-h'/.test(app), 'nothing sizes the app itself');
  assert.ok(/root\.style\.setProperty\('--vv-top'/.test(app), 'nothing positions the app itself');
});

test('and the app really uses those variables', () => {
  const rule = /#app-screen\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '#app-screen has no rule — this check would be vacuous');
  assert.ok(/height:\s*var\(--vv-h/.test(rule[1]), 'the app is a fixed full height again');
  assert.ok(/top:\s*var\(--vv-top/.test(rule[1]), 'the app cannot follow the viewport offset');
  assert.ok(!/inset:\s*0/.test(rule[1]), 'inset:0 overrides the height it was just given');
  // A browser with no visualViewport (older desktop) must still fill the page.
  assert.ok(/var\(--vv-h,\s*100%\)/.test(rule[1]), 'there is no fallback height');
});

test('the page is scrolled back after iOS scrolls it to the caret', () => {
  const fn = app.slice(app.indexOf('const syncViewport = () =>'), app.indexOf('function keepBottomInView'));
  assert.ok(fn.includes('window.scrollTo(0, 0)'), 'the header stays pushed off the top');
  for (const ev of ['resize', 'scroll']) {
    assert.ok(app.includes(`window.visualViewport.addEventListener('${ev}'`), `${ev} is not watched`);
  }
  // focusin too: the keyboard animation and the resize event do not always
  // arrive in that order on iOS.
  assert.ok(/document\.addEventListener\('focusin'/.test(app), 'a tap on the message box is not handled');
});

test('the newest message stays in view when the keyboard takes half the screen', () => {
  assert.ok(app.includes('function keepBottomInView('), 'nothing keeps the conversation in view');
  const fn = app.slice(app.indexOf('function keepBottomInView('), app.indexOf('function keepBottomInView(') + 500);
  assert.ok(/nearBottom/.test(fn), 'it scrolls to the bottom even when the reader is up in the history');
});

test('the two rows of extras fold away while typing', () => {
  // They cost about a third of what is left of the screen, and both are one
  // tap from coming back.
  const rule = /body\.kb-open #composer-strip,\s*body\.kb-open #quick-emoji-bar,\s*body\.kb-open #install-hint\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'nothing folds away while the keyboard is up');
  assert.ok(/display:\s*none/.test(rule[1]), rule[1]);
  assert.ok(/classList\.toggle\('kb-open', ViewportFit\.hidesExtras\(/.test(app),
    'the class is set by hand rather than by the rule');
});

test('the rules are loaded by the page', () => {
  assert.ok(html.includes('/js/viewportFit.js'));
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
