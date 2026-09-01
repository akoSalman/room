// Why the send button ends up half off an iPhone screen.
//
// Reported as: on the iPhone web version there is a little horizontal scroll,
// and sometimes tapping send does nothing because the button is just past the
// edge; pinching out to unzoom fixes it.
//
// Nothing was actually too wide. Safari on iOS ZOOMS THE WHOLE PAGE IN when a
// text field with a font smaller than 16px is focused, and it does not zoom
// back out afterwards. The layout viewport is then wider than the screen, the
// page can be panned sideways, and whatever sits at the right-hand end of a
// row — the send button — is off it. That is why it happens after typing, why
// it looks like a little horizontal scroll, and why pinching is the cure.
//
// It is a one-number bug that will come back the moment somebody writes
// `font-size: 0.9rem` on an input, so it is guarded here rather than fixed and
// forgotten.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** Every `selector { … }` block, flattened. */
function rules(source) {
  const out = [];
  // Comments first: one of them contains the word "input", and another sits
  // directly above `html, body` — both would end up glued to the selector.
  const clean = String(source).replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean))) {
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return out;
}

/** px for a font-size declaration, assuming the 16px root this page uses. */
function fontPx(body) {
  const m = /font-size:\s*([\d.]+)(px|rem|em)\b/.exec(body);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'px' ? n : n * 16;
}

// Selectors that reach something a person can put a caret in. Checkboxes,
// radios and file inputs cannot be typed into, so they never trigger the zoom.
const FOCUSABLE = /(^|[\s,>+~])(input|textarea|select)\b(?!:not)/i;

/** The ids of every field on the page somebody can type into. */
function typableIds() {
  const out = [];
  const re = /<(input|textarea|select)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[2];
    if (/type=["'](checkbox|radio|file|hidden)["']/i.test(attrs)) continue;
    const id = /id=["']([^"']+)["']/.exec(attrs);
    if (id) out.push(id[1]);
  }
  return out;
}

test('THE BUG: no focusable field is smaller than 16px', () => {
  // By ELEMENT selector (input, textarea, select) and by the id of every
  // typable field in the page. The id half is what matters: the first attempt
  // at this fix added a grouped rule listing the ids near the top of the file
  // and left `#msg-input { font-size: 0.95rem }` in place further down — same
  // specificity, later in the file, so the old size quietly went on winning
  // and the page went on zooming.
  const ids = typableIds();
  assert.ok(ids.includes('msg-input'), 'the message box was not found — this check would be vacuous');
  assert.ok(ids.length >= 5, `only ${ids.length} typable fields found`);
  const offenders = [];
  for (const r of rules(css)) {
    const byElement = FOCUSABLE.test(r.selector) && !/\[type=(checkbox|radio|file)\]/.test(r.selector);
    const byId = ids.some(id => new RegExp(`#${id}\\b`).test(r.selector));
    if (!byElement && !byId) continue;
    const px = fontPx(r.body);
    if (px !== null && px < 16) offenders.push(`${r.selector} → ${px}px`);
  }
  assert.deepStrictEqual(offenders, [],
    'Safari will zoom the page in when one of these is focused, and never zoom back out');
});

test('and the message box carries the 16px in its OWN rule', () => {
  // Not in a grouped rule somewhere else that a later, equally specific rule
  // can override — which is exactly how the first attempt at this failed.
  const own = rules(css).find(r => r.selector === '#msg-input');
  assert.ok(own, '#msg-input has no rule of its own — this check would be vacuous');
  assert.strictEqual(fontPx(own.body), 16, 'the message box sets its own, smaller, size again');
});

test('the page itself is never wider than the phone', () => {
  const base = rules(css).find(r => /^html, body$/.test(r.selector) && /overflow-x/.test(r.body));
  assert.ok(base, 'nothing stops an over-wide element making the page pannable');
  assert.ok(/max-width:\s*100%/.test(base.body), 'the page has no width limit');
});

test('100vw is not used, because it includes the scrollbar', () => {
  // The other classic cause of a page one notch too wide.
  assert.ok(!/width:\s*100vw/.test(css), 'a 100vw width will overflow wherever there is a scrollbar');
});

test('the strip of composer buttons scrolls instead of being cut off', () => {
  // Four pills, and on a narrow phone with a large system font they do not
  // fit: the last one was simply unreachable past the edge of the screen.
  const strip = rules(css).find(r => r.selector === '#composer-strip');
  assert.ok(strip, '#composer-strip is gone — this check would be vacuous');
  assert.ok(/overflow-x:\s*auto/.test(strip.body), 'the last button is still cut off');
  assert.ok(/max-width:\s*100%/.test(strip.body), 'the strip can still widen the page');
  assert.ok(rules(css).some(r => r.selector === '#composer-strip button' && /flex-shrink:\s*0/.test(r.body)),
    'the buttons squash instead of scrolling');
});

test('the viewport is declared the way a phone needs', () => {
  const m = /<meta name="viewport" content="([^"]+)"/.exec(html);
  assert.ok(m, 'there is no viewport meta at all');
  const content = m[1];
  assert.ok(/width=device-width/.test(content), content);
  assert.ok(/initial-scale=1/.test(content), content);
  // Never: it is ignored by modern iOS anyway, and on everything else it takes
  // zooming away from people who need it — including the person in this report,
  // for whom pinching was the only way to reach the send button.
  assert.ok(!/user-scalable\s*=\s*no/.test(content), 'zooming is disabled for everyone');
  assert.ok(!/maximum-scale/.test(content), 'zooming is capped');
});

test('the emoji row scrolls inside itself too', () => {
  const list = rules(css).find(r => r.selector === '#quick-emoji-list');
  assert.ok(list && /overflow-x:\s*auto/.test(list.body),
    'a dozen emojis can push the page wider than the screen');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
