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

// ── The same bug, at the bottom of the list ─────────────────────────────────
//
// Reported on the iPhone web version: opening a chat you have been talking in
// lands on the newest message, and then "instantly it seems that scrolls to a
// couple message upper" — leaving the reader to scroll down for the latest.
//
// Opening a chat scrolled to the bottom ONCE, with `scrollTop = scrollHeight`.
// That is a number, correct only for the height at that instant, and the page
// just rendered is full of photos that are zero pixels tall until they load —
// the fact this whole file exists for. Each one that arrives grows the content
// BELOW the saved position, so the bottom moves away and nothing follows it.

test('THE BUG: a list that has grown below the reader is not at the bottom', () => {
  // 900 tall, 400 visible, scrolled to 500 — the bottom at the time. Two
  // photos then load and add 300px, and that same 500 is now 300 short.
  assert.strictEqual(S.distanceFromBottom({ scrollTop: 500, scrollHeight: 900, clientHeight: 400 }), 0);
  assert.strictEqual(S.distanceFromBottom({ scrollTop: 500, scrollHeight: 1200, clientHeight: 400 }), 300);
});

test('…so it is pinned again, until the page settles', () => {
  const at = { scrollTop: 500, scrollHeight: 1200, clientHeight: 400 };
  assert.strictEqual(S.shouldHoldBottom({ ...at, startedAt: 0, now: 1000 }), true);
  // FOUR SECONDS WAS NOT ENOUGH. That was the prepend hold's number, and on a
  // phone connection it is when photos start arriving rather than when they
  // have finished — so the hold expired at the moment it was needed. Reported
  // as: "when last message are image… after loading images the scroll seems
  // to go upper instead of the end of chat".
  assert.ok(S.BOTTOM_HOLD_MS >= 10000,
    'the bottom hold gives up before slow photos have loaded');
  assert.strictEqual(S.shouldHoldBottom({ ...at, startedAt: 0, now: 6000 }), true);
  // Already at the bottom: nothing to do, and writing scrollTop on iOS during
  // a momentum scroll interrupts the fling.
  assert.strictEqual(S.shouldHoldBottom({
    scrollTop: 800, scrollHeight: 1200, clientHeight: 400, startedAt: 0, now: 1000,
  }), false);
  // And it does expire, so it cannot fight a scroll a minute later.
  assert.strictEqual(S.shouldHoldBottom({ ...at, startedAt: 0, now: S.BOTTOM_HOLD_MS + 1 }), false);
});

test('A DELIBERATE SCROLL UP ENDS THE HOLD, always', () => {
  // The failure that would be worse than the one being fixed: somebody
  // scrolls up to read something, a photo finishes three seconds later, and
  // they are yanked back to the newest message.
  const at = { scrollTop: 100, scrollHeight: 1200, clientHeight: 400, startedAt: 0, now: 500 };
  assert.strictEqual(S.shouldHoldBottom({ ...at, userScrolled: false }), true);
  assert.strictEqual(S.shouldHoldBottom({ ...at, userScrolled: true }), false);
});

test('nonsense measurements move nothing', () => {
  // getBoundingClientRect and scrollHeight both return 0 on a detached node,
  // and a hold computed from those would scroll the list somewhere arbitrary.
  for (const o of [{}, { scrollTop: NaN, scrollHeight: 1200, clientHeight: 400 },
                   { scrollTop: 0, scrollHeight: null, clientHeight: 400 }]) {
    assert.strictEqual(S.distanceFromBottom(o), 0, JSON.stringify(o));
    assert.strictEqual(S.shouldHoldBottom({ ...o, startedAt: 0, now: 1 }), false);
  }
  assert.strictEqual(S.distanceFromBottom(), 0);
  // iOS rubber-band overscroll puts scrollTop past the end while the finger
  // is down. That is a bounce which returns by itself, not a gap to correct.
  assert.strictEqual(S.distanceFromBottom({ scrollTop: 860, scrollHeight: 1200, clientHeight: 400 }), 0);
});

test('THE PAGE WATCHES THE HEIGHT rather than predicting it', () => {
  // The second report is what showed the first fix up. Hanging listeners on
  // every <img> only covers what is in the DOM at that instant with a src
  // already set — not a lazily loaded image, not a link preview measuring
  // itself late, not an <img> whose src is assigned a tick later. Each of
  // those moves the bottom, and none of them was watched.
  const fs2 = require('fs');
  const path2 = require('path');
  const app = fs2.readFileSync(path2.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const code = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf('function scrollBottom(');
  assert.ok(i > 0, 'scrollBottom is gone');
  const body = code.slice(i, code.indexOf('\n}\n', i));
  assert.ok(/shouldHoldBottom/.test(body), 'the bottom is set once and never held');
  // Twice: once to START the loop and once inside it to re-arm. Asserting
  // merely that the call appears passed while the kick-off was deleted and
  // the hold never ran at all — a test that measured nothing, caught by
  // deleting the line and watching it still pass.
  const rafs = (body.match(/requestAnimationFrame\(tick\)/g) || []).length;
  assert.ok(rafs >= 2,
    `the hold is armed ${rafs} time(s): it either never starts or never re-checks, `
    + 'so growth it did not predict is missed');
  assert.ok(!/querySelectorAll\('img/.test(body),
    'the hold is back to enumerating elements, which cannot see what is not there yet');
});

test('…and only a PERSON can end it', () => {
  // The browser scrolls the list too — Chrome's own scroll anchoring does it
  // while images load. A browser-initiated scroll counted as the reader would
  // cancel the hold at exactly the moment it was needed, which is
  // indistinguishable from it never having worked at all.
  const fs2 = require('fs');
  const path2 = require('path');
  const app = fs2.readFileSync(path2.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const code = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf('function scrollBottom(');
  const body = code.slice(i, code.indexOf('\n}\n', i));
  for (const ev of ['touchstart', 'wheel', 'keydown']) {
    assert.ok(body.includes(ev), `${ev} does not end the hold, so a reader cannot escape it`);
  }
  assert.ok(!/addEventListener\('scroll'/.test(body),
    'a scroll event ends the hold again, and the browser fires those itself');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
