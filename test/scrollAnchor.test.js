// Keeping your place while older messages load above you.
//
// Reported on the iOS web version: scrolling up to load older messages "hops a
// couple of messages up immediately" instead of continuing smoothly.
//
// Reproduced in a real browser against the real server, with photos held back
// 900ms each (public/js/scrollAnchor.js explains why that is the trigger): with
// the old height-difference correction the reader was looking at message 52
// before the page loaded and message 50 once the photos arrived — two messages,
// exactly as described. With the anchor below, the same run stays on 52 and
// drifts 0px.
//
// Why iOS and not Chrome: Chrome implements scroll anchoring and had been
// quietly covering for this. Safari has never implemented it, so the same code
// hops there and nowhere else — which is why the list now keeps its own place
// and the browser's version is switched off.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
const S = require(path.join(ROOT, 'public', 'js', 'scrollAnchor.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The arithmetic ──────────────────────────────────────────────────────────

test('THE BUG: content growing above the reader is measured, and undone', () => {
  // The anchor sat 300px below the top of the list; four photos loaded above
  // it and pushed it to 1300. Scrolling down by that 1000 puts it back.
  const shift = S.shiftFor(300, 1300);
  assert.strictEqual(shift, 1000);
  assert.strictEqual(S.nextTop(500, shift), 1500);
});

test('content shrinking above the reader is undone too', () => {
  // A photo that fails to load, a link preview that gives up: the anchor comes
  // UP, and the correction has to go the other way.
  assert.strictEqual(S.shiftFor(900, 400), -500);
  assert.strictEqual(S.nextTop(1200, -500), 700);
});

test('a correction is never asked for past the top of the list', () => {
  // Safari bounces when it is asked to scroll above the top, which is a second
  // visible jump on top of the one being fixed.
  assert.strictEqual(S.nextTop(80, -400), 0);
  assert.strictEqual(S.nextTop(0, -1), 0);
});

test('nothing moved means nothing is written', () => {
  // Writing scrollTop during a momentum scroll on iOS interrupts the fling, so
  // a correction of zero must not be made at all.
  assert.strictEqual(S.worthCorrecting(0), false);
  assert.strictEqual(S.worthCorrecting(0.4), false);
  assert.strictEqual(S.worthCorrecting(-0.4), false);
  assert.strictEqual(S.worthCorrecting(S.MIN_SHIFT), true);
  assert.strictEqual(S.worthCorrecting(-40), true);
  assert.ok(S.MIN_SHIFT > 0 && S.MIN_SHIFT <= 2, `min shift is ${S.MIN_SHIFT}`);
});

test('a measurement that is not a number changes nothing', () => {
  // getBoundingClientRect on a removed element, a container that is not laid
  // out yet: better a missed correction than scrollTop = NaN, which is a jump
  // to the top.
  assert.strictEqual(S.shiftFor(undefined, 100), 0);
  assert.strictEqual(S.shiftFor(100, null), 0);
  assert.strictEqual(S.nextTop(120, NaN), 120);
  assert.strictEqual(S.worthCorrecting(NaN), false);
});

// ── How long to keep holding ────────────────────────────────────────────────

test('the hold outlasts a photo arriving on a slow connection', () => {
  const t0 = 1_000_000;
  assert.strictEqual(S.stillHolding(t0, t0 + 100), true);
  assert.strictEqual(S.stillHolding(t0, t0 + 3000), true,
    'the hold ends before a photo on a slow connection has arrived, which is the bug');
  assert.ok(S.SETTLE_MS >= 2000, `settle window is only ${S.SETTLE_MS}ms`);
});

test('but it does not hold forever, fighting a real scroll', () => {
  const t0 = 1_000_000;
  assert.strictEqual(S.stillHolding(t0, t0 + S.SETTLE_MS), false);
  assert.strictEqual(S.stillHolding(t0, t0 + 60_000), false);
  assert.ok(S.SETTLE_MS <= 10_000, `the list keeps correcting itself for ${S.SETTLE_MS}ms`);
});

// ── One page at a time ──────────────────────────────────────────────────────

test('another page is not started while one is still arriving', () => {
  // The threshold is near the top, which is where a correction lands. Firing
  // again there stacked two or three loads, and each one jumped.
  assert.strictEqual(S.shouldLoadOlder({ scrollTop: 10, loading: true, done: false }), false);
  assert.strictEqual(S.shouldLoadOlder({ scrollTop: 10, loading: false, done: false }), true);
});

test('and never once the chat has no more history', () => {
  assert.strictEqual(S.shouldLoadOlder({ scrollTop: 0, loading: false, done: true }), false);
});

test('scrolling in the middle of the chat loads nothing', () => {
  assert.strictEqual(S.shouldLoadOlder({ scrollTop: 900, loading: false, done: false }), false);
  assert.strictEqual(S.shouldLoadOlder({ scrollTop: 79, loading: false, done: false }), true);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');

test('the list is pinned to an ELEMENT, not to a total height', () => {
  const fn = app.slice(app.indexOf('function prependMessages('),
    app.indexOf('// ─── Context menu'));
  assert.ok(fn.length > 200, 'prependMessages moved');
  assert.ok(!/prevScrollHeight/.test(fn),
    'the correction still measures the container height, which is short by every photo that has not loaded');
  assert.ok(/container\.firstElementChild/.test(fn), 'nothing is being held still');
  assert.ok(/ScrollAnchor\.shiftFor\(/.test(fn) && /ScrollAnchor\.nextTop\(/.test(fn),
    'the screen does the arithmetic by hand');
  assert.ok(/ScrollAnchor\.worthCorrecting\(/.test(fn),
    'scrollTop is written even when nothing moved, which stops an iOS fling dead');
});

test('and pinned AGAIN as each photo in the new page arrives', () => {
  const fn = app.slice(app.indexOf('function prependMessages('),
    app.indexOf('// ─── Context menu'));
  assert.ok(/addEventListener\('load'/.test(fn),
    'the position is corrected once, before the photos have any height — which is the bug');
  assert.ok(/addEventListener\('error'/.test(fn),
    'a photo that fails to load leaves the list holding a place that no longer exists');
  assert.ok(/ScrollAnchor\.stillHolding\(/.test(fn),
    'the list keeps correcting itself forever, fighting the next deliberate scroll');
  assert.ok(/requestAnimationFrame\(/.test(fn), 'nothing catches a late layout with no event of its own');
});

test('the browser is not correcting the same thing a second time', () => {
  // Chrome anchors by itself and Safari does not. Two corrections on one
  // browser and one on the other is how a fix passes testing and still hops
  // for the person who reported it.
  const rule = css.slice(css.indexOf('#messages {'), css.indexOf('#messages {') + 700);
  assert.ok(/overflow-anchor: none/.test(rule),
    'Chrome still anchors the list as well, so the two corrections compound');
});

test('the page loads the rules', () => {
  assert.ok(/src="\/js\/scrollAnchor\.js"/.test(html),
    'scrollAnchor.js is never loaded, so ScrollAnchor is undefined and loading older messages throws');
  assert.ok(html.indexOf('scrollAnchor.js') < html.indexOf('js/app.js'));
});

test('the scroll handler asks before starting another page', () => {
  const at = app.indexOf("document.getElementById('messages').addEventListener('scroll'");
  const fn = app.slice(at, at + 900);
  assert.ok(at > -1, 'the scroll handler moved');
  assert.ok(/ScrollAnchor\.shouldLoadOlder\(\{/.test(fn), 'the threshold is written out by hand again');
  assert.ok(/loading: loadingOlderMsgs/.test(fn) && /done: !hasMoreOlderMsgs/.test(fn),
    'the guard is not given what it needs, so it can only answer one way');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
