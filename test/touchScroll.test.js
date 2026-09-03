// Touch drags the page swallowed, and a deploy the servers could not reach.
//
// TWO REPORTS, and the second explains a third:
//
//   1. "The emoji bar on web is not swipable."
//   2. "The comment feature is not on web."
//
// THE EMOJI BAR. The chat cancels document-level touch scrolling, because a
// drag that reaches the document bounces the whole app around behind a fixed
// layout. That was done with a list of four container ids allowed to scroll,
// and anything not named was frozen. The emoji bar is a horizontal strip with
// `overflow-x: auto` and more emojis than fit — so the CSS said scroll and the
// handler said no, and the handler wins. It was never built without scrolling;
// its scrolling was being cancelled.
//
// A list of names is the wrong shape: it has to be added to every time
// anything scrollable is built, and it never is. So the element is asked
// whether it can actually scroll the way the finger is going.
//
// THE COMMENTS. They were on the web, and had been for a day. What had not
// happened was a successful deploy: runs 132 and 133 both failed, both times
// with the SERVER's `git fetch` being closed by GitHub after two and a half
// minutes. These servers are where the people using this app are, and from
// there GitHub is throttled at best — the whole reason this project exists.
// So the deploy no longer asks the server to reach it. See the second half.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
const T = require(path.join(ROOT, 'public', 'js', 'touchScroll.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** A stand-in element: sizes, overflow, and a parent. */
function el(o) {
  return {
    scrollWidth: o.sw || 0, clientWidth: o.cw || 0,
    scrollHeight: o.sh || 0, clientHeight: o.ch || 0,
    overflowX: o.ox || 'visible', overflowY: o.oy || 'visible',
    parentElement: o.parent || null,
    getBoundingClientRect: () => ({}),
  };
}
const styleOf = e => ({ overflowX: e.overflowX, overflowY: e.overflowY });

// ── What may scroll ─────────────────────────────────────────────────────────

test('THE BUG: a horizontal strip with more in it than fits may be swiped', () => {
  // The emoji bar, exactly: overflow-x auto, content wider than the box.
  const bar = el({ sw: 900, cw: 320, ox: 'auto' });
  assert.strictEqual(T.cancelsMove({ target: bar, axis: 'x', styleOf }), false,
    'the page cancels the swipe, so the bar cannot move');
});

test('…and a vertical drag on that same strip still belongs to the page', () => {
  // Otherwise dragging down the screen with a finger on the emoji bar would
  // scroll the app behind the fixed layout, which is what all of this exists
  // to prevent.
  const bar = el({ sw: 900, cw: 320, ox: 'auto' });
  assert.strictEqual(T.cancelsMove({ target: bar, axis: 'y', styleOf }), true);
});

test('a box that merely OVERFLOWS is not a scroller', () => {
  // `overflow: hidden` with big content is a clipped box. Letting a drag
  // through it would move the page while nothing appeared to scroll.
  const clipped = el({ sw: 900, cw: 320, ox: 'hidden' });
  assert.strictEqual(T.cancelsMove({ target: clipped, axis: 'x', styleOf }), true);
});

test('nor is a scroller with nothing to scroll', () => {
  // Six emojis in a bar wide enough for twenty: the drag is the page's.
  const empty = el({ sw: 320, cw: 320, ox: 'auto' });
  assert.strictEqual(T.cancelsMove({ target: empty, axis: 'x', styleOf }), true);
  // A pixel or two of difference is rounding, not content.
  const almost = el({ sw: 321, cw: 320, ox: 'auto' });
  assert.strictEqual(T.cancelsMove({ target: almost, axis: 'x', styleOf }), true);
});

test('the scroller is looked for UP the tree, not only under the finger', () => {
  // Every touch lands on a button or a span, never on the scrolling container
  // itself — a check that only looked at the target would freeze everything.
  const list = el({ sw: 900, cw: 320, ox: 'auto' });
  const button = el({ parent: list });
  assert.strictEqual(T.cancelsMove({ target: button, axis: 'x', styleOf }), false,
    'a tap target inside a scroller cannot scroll it');
});

test('and the search stops at the page itself', () => {
  const body = el({ sh: 4000, ch: 800, oy: 'auto' });
  const inner = el({ parent: body });
  assert.strictEqual(T.cancelsMove({ target: inner, axis: 'y', styleOf, root: body }), false);
  // Past the root there is only the page, which must not move.
  assert.strictEqual(T.cancelsMove({ target: el({}), axis: 'y', styleOf, root: body }), true);
  assert.strictEqual(T.cancelsMove({ target: null, axis: 'y', styleOf }), true);
});

test('before the direction is known, a scroller keeps its drag', () => {
  // Cancelling the first frames of a drag is exactly what makes a scroller
  // feel dead, and the axis is not knowable from the first pixel.
  const bar = el({ sw: 900, cw: 320, ox: 'auto' });
  assert.strictEqual(T.cancelsMove({ target: bar, axis: null, styleOf }), false);
  const nothing = el({ sw: 320, cw: 320, ox: 'auto' });
  assert.strictEqual(T.cancelsMove({ target: nothing, axis: null, styleOf }), true);
});

test('a chain of non-scrollers does not loop forever', () => {
  // A cycle in parentElement is not possible in a real DOM, but a bug that
  // hangs the page on every touch is not worth the risk of assuming so.
  const a = el({});
  const b = el({ parent: a });
  a.parentElement = b;
  assert.strictEqual(T.cancelsMove({ target: b, axis: 'y', styleOf }), true);
});

test('the axis is only decided once the finger has really moved', () => {
  assert.strictEqual(T.axisOf(1, 1), null, 'a jitter picked a direction');
  assert.strictEqual(T.axisOf(20, 3), 'x');
  assert.strictEqual(T.axisOf(3, 20), 'y');
  assert.strictEqual(T.axisOf(-20, 3), 'x', 'a leftward swipe was not seen as horizontal');
  assert.strictEqual(T.axisOf(null, undefined), null);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE LIST OF FOUR IS GONE', () => {
  assert.ok(!/closest\('#messages, #room-list, \.modal-overlay, #online-panel'\)/.test(app),
    'scrolling is still allowed only in four named containers');
  // The exact shape, not merely a mention: `false && TouchScroll.cancelsMove(`
  // still contains the call while never cancelling anything, and a check for
  // the call alone passed on precisely that.
  assert.ok(/if \(!TouchScroll\.cancelsMove\(\{\n/.test(app),
    'the decision is not what actually guards the preventDefault');
  assert.ok(html.includes('/js/touchScroll.js'), 'the rules are never loaded by the page');
});

test('the handler knows which way the finger went', () => {
  // Without a touchstart there is no origin, so every move looks directionless
  // and a vertical drag inside a horizontal strip would move the page.
  assert.ok(/document\.addEventListener\('touchstart'/.test(app), 'the start of the drag is not recorded');
  assert.ok(/TouchScroll\.axisOf\(t\.clientX - touchFrom\.x, t\.clientY - touchFrom\.y\)/.test(app),
    'the direction is never worked out');
  assert.ok(/styleOf: el => getComputedStyle\(el\)/.test(app),
    'overflow is not consulted, so a clipped box counts as a scroller');
});

test('the move listener can still cancel', () => {
  // A passive listener is forbidden from calling preventDefault, and the page
  // would bounce however this decided.
  const fn = app.slice(app.indexOf("document.addEventListener('touchmove'"), app.indexOf("if (token && username)"));
  assert.ok(/\{ passive: false \}/.test(fn), 'the touchmove listener is passive');
  assert.ok(/if \(e\.cancelable\) e\.preventDefault\(\)/.test(fn),
    'preventDefault is called on an event that cannot be cancelled');
});

// ── The deploy that never arrived ───────────────────────────────────────────

const deploy = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-servers.yml'), 'utf8');

test('THE REAL REASON COMMENTS WERE MISSING: the server no longer fetches', () => {
  // Runs 132 and 133 both failed with the server's own `git fetch` closed by
  // GitHub after two and a half minutes. From where these servers are, GitHub
  // is throttled at best — which is the premise of this whole project, and I
  // had built the deploy on top of it anyway.
  assert.ok(!/git fetch origin/.test(deploy), 'the server still pulls from GitHub');
  assert.ok(!/git reset --hard/.test(deploy), 'the server still resets against a remote it cannot reach');
  assert.ok(/git archive --format=tar "\$GITHUB_SHA" > \/tmp\/app\.tar/.test(deploy),
    'the runner does not build the archive');
  assert.ok(/tar -xf \/tmp\/app\.tar -C "\$APP_DIR"/.test(deploy), 'the server never unpacks it');
});

test('and the transfer is retried rather than lost', () => {
  assert.ok(/for attempt in 1 2 3 4; do/.test(deploy), 'one dropped transfer still fails the deploy');
  assert.ok(/sleep \$\(\(attempt \* 5\)\)/.test(deploy), 'it retries instantly, into the same congestion');
  assert.ok(/could not send the code to \$HOST after 4 attempts/.test(deploy),
    'a failed transfer is not reported as an error');
});

test('THE DATABASE AND THE UPLOADS SURVIVE IT', () => {
  // The old path used `git reset --hard`, which only touches tracked files.
  // A careless replacement — rsync --delete, or wiping the directory first —
  // would take chat.db and every uploaded file with it.
  assert.ok(!/rm -rf "\$APP_DIR"/.test(deploy), 'the deploy wipes the app directory');
  assert.ok(!/--delete/.test(deploy), 'the deploy deletes untracked files, which are the user data');
  assert.ok(/test -s \/tmp\/app\.tar/.test(deploy),
    'an empty or missing archive is unpacked over the live app');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
