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

test('the install banner stands down only while the keyboard is up', () => {
  assert.strictEqual(V.hidesBanner(true), true);
  assert.strictEqual(V.hidesBanner(false), false);
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
  // Comments stripped: this block explains what it replaced, and a search over
  // the raw text finds the explanation rather than the declarations.
  const decls = rule[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/height:\s*var\(--vv-h/.test(decls), 'the app is a fixed full height again');
  assert.ok(/top:\s*var\(--vv-top/.test(decls), 'the app cannot follow the viewport offset');
  assert.ok(!/inset:\s*0/.test(decls), 'inset:0 overrides the height it was just given');
  // A browser with no visualViewport (older desktop) must still fill the page.
  assert.ok(/var\(--vv-h,\s*100%\)/.test(decls), 'there is no fallback height');
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

test('THE SECOND REPORT: the composer keeps every control while typing', () => {
  // "On web version and opened keyboard nothing is above composer" — an
  // earlier attempt at this fix folded the attachment strip and the emoji row
  // away to win back room. Both were wrong: the attachments are what somebody
  // typing reaches for, and the emoji bar is only ever shown BECAUSE the
  // keyboard is open, so hiding it made the 😊 button do nothing at all.
  const kb = [...css.matchAll(/body\.kb-open ([^{]*)\{([^}]*)\}/g)];
  assert.ok(kb.length > 0, 'the kb-open rule is gone — this check would be vacuous');
  for (const m of kb) {
    const selector = m[1];
    assert.ok(!/#composer-strip/.test(selector), 'the attachment buttons vanish while typing');
    assert.ok(!/#quick-emoji-bar/.test(selector), 'the emoji bar cannot open while the keyboard is up');
    assert.ok(!/#composer\b/.test(selector), 'the composer itself is styled away while typing');
  }
});

test('the install banner still stands down, being an interruption', () => {
  const rule = /body\.kb-open #install-hint\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the banner covers the composer while typing');
  assert.ok(/display:\s*none/.test(rule[1]), rule[1]);
  assert.ok(/classList\.toggle\('kb-open', ViewportFit\.hidesBanner\(/.test(app),
    'the class is set by hand rather than by the rule');
});

// ── The sign-in page ────────────────────────────────────────────────────────
//
// Reported from an iPhone, with a screenshot: on the login page the username
// and password inputs are under the keyboard.
//
// Same cause as the chat, and the chat's fix was never applied here. iOS does
// not shrink the layout viewport when the keyboard opens, so `position: fixed;
// inset: 0` keeps this screen at full screen height — and the card, centred
// inside it, stays exactly where it was while the keyboard covers the bottom
// half of it. There is nothing to scroll, because as far as the browser is
// concerned everything fits.

test('THE BUG: the sign-in screen is sized to what can be SEEN', () => {
  const rule = /#auth-screen \{([^}]*)\}/.exec(css);
  assert.ok(rule, '#auth-screen has no rule — this check would be vacuous');
  // Comments stripped first: this rule's own comment explains what `inset: 0`
  // used to do, and a search over the raw block finds those words rather than
  // the declaration — a test that fails on its own prose.
  const decls = rule[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/inset:\s*0/.test(decls),
    'the sign-in screen is still pinned to the full layout viewport, so the '
    + 'keyboard covers the card and nothing can scroll');
  assert.ok(/height:\s*var\(--vv-h/.test(rule[1]), 'it does not follow the visual viewport');
  assert.ok(/top:\s*var\(--vv-top/.test(rule[1]),
    'it does not follow the viewport OFFSET, so it sits off the top while iOS '
    + 'scrolls the layout viewport under the keyboard');
});

test('and content taller than the screen can still be reached', () => {
  // `justify-content: center` overflows EQUALLY in both directions, and the
  // part above the top edge cannot be scrolled back to — so with the keyboard
  // up the username field would be centred out of reach.
  const decls = /#auth-screen \{([^}]*)\}/.exec(css)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/justify-content:\s*safe center/.test(decls),
    'a card taller than the space left has its top cut off unreachably');
  assert.ok(/overflow-y:\s*auto/.test(decls), 'there is nothing to scroll with');
});

test('the field being typed into is brought above the keyboard', () => {
  // Sizing the screen is most of it; a form taller than what is left still
  // has to scroll to the field in use.
  assert.ok(/function scrollFocusIntoView\(/.test(app), 'nothing brings a field into view');
  assert.ok(/ViewportFit\.needsScroll\(\{/.test(app),
    'the decision is made by hand rather than by the rule');
  const fn = app.slice(app.indexOf('function scrollFocusIntoView('),
    app.indexOf('function scrollFocusIntoView(') + 800);
  assert.ok(/document\.activeElement !== el/.test(fn),
    'a field that has since lost focus is still scrolled to');
  assert.ok(/scrollIntoView\(/.test(fn), 'nothing actually scrolls');
  // Twice, because iOS reports the visual viewport mid-animation and a single
  // scroll lands against a keyboard height that is already out of date.
  assert.ok(/\[120, 350\]\.forEach\(ms => setTimeout\(\(\) => scrollFocusIntoView\(el\), ms\)\)/.test(app),
    'the scroll happens once, against a keyboard that is still moving');
});

test('a field already in view is left alone', () => {
  const view = { viewTop: 0, viewBottom: 400 };
  assert.strictEqual(V.needsScroll({ top: 100, bottom: 140, ...view }), false,
    'every focus scrolls the page, including ones that need nothing');
  // Under the keyboard.
  assert.strictEqual(V.needsScroll({ top: 380, bottom: 420, ...view }), true);
  // Flush against its edge is not "visible" either — it reads as half hidden.
  assert.strictEqual(V.needsScroll({ top: 360, bottom: 395, ...view }), true);
  // Scrolled off the TOP, which is where iOS leaves things mid-animation.
  assert.strictEqual(V.needsScroll({ top: -20, bottom: 20, ...view }), true);
  // Nonsense in, no scroll out.
  assert.strictEqual(V.needsScroll(null), false);
  assert.strictEqual(V.needsScroll({ top: 1, bottom: 2 }), false);
});

test('the chat keeps the behaviour it already had', () => {
  // This is an ADDITION to focusin, not a replacement: the chat's own fix is
  // the syncViewport call, and losing it would put the header back off-screen.
  const fn = app.slice(app.indexOf("document.addEventListener('focusin'"),
    app.indexOf("document.addEventListener('focusout'"));
  assert.ok(/setTimeout\(syncViewport, 50\)/.test(fn),
    'the focus handler no longer re-fits the app to the viewport');
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
