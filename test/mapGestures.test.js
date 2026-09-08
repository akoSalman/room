// Why the map "does not zoom or move" on an iPhone, and nowhere else.
//
// Reported three times. Each time I drove the map in a real browser, watched
// it pan and zoom, and reported it working. Each time the browser was
// Chromium — and this is a WebKit-only failure, invisible to every check I
// made.
//
// On iOS a two-finger pinch fires WebKit's `gesturestart` / `gesturechange`
// and Safari zooms the WHOLE PAGE. `touch-action: none` does not stop that (it
// governs scrolling and panning, not Safari's pinch-zoom) and neither does
// `user-scalable=no` (ignored since iOS 10). Only preventDefault on those
// events stops it, and nothing in this app did it.
//
// One cause, both symptoms: the pinch zoomed the page instead of the map, and
// a zoomed page then panned instead of the map.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
const M = require(path.join(ROOT, 'public', 'js', 'mapGestures.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** A DOM node that records what was bound to it. */
function fakeEl() {
  return {
    bound: [],
    addEventListener(type, fn, opts) { this.bound.push({ type, fn, opts }); },
  };
}

// ── What gets swallowed ─────────────────────────────────────────────────────

test('THE BUG: all three WebKit gesture events are prevented', () => {
  const el = fakeEl();
  assert.strictEqual(M.blockPageZoom(el), true);
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    assert.ok(el.bound.some(b => b.type === type), `${type} is not swallowed`);
  }
});

test('…and they are bound NON-PASSIVELY, or preventDefault is ignored', () => {
  // A passive listener may not call preventDefault: the code would be there,
  // run, and change nothing — which is the shape of this whole bug.
  const el = fakeEl();
  M.blockPageZoom(el);
  for (const b of el.bound) {
    assert.ok(b.opts && b.opts.passive === false,
      `${b.type} is passive, so its preventDefault does nothing`);
  }
});

test('the handler actually calls preventDefault, when it is allowed to', () => {
  const el = fakeEl();
  M.blockPageZoom(el);
  const h = el.bound.find(b => b.type === 'gesturestart').fn;
  let prevented = false;
  h({ cancelable: true, preventDefault() { prevented = true; } });
  assert.strictEqual(prevented, true, 'the listener is decoration');
  // An uncancelable event must not throw.
  h({ cancelable: false, preventDefault() { throw new Error('must not be called'); } });
});

test('double-tap zoom is stopped too', () => {
  // Over a map a double-tap is nearly always meant for the map.
  const el = fakeEl();
  M.blockPageZoom(el);
  assert.ok(el.bound.some(b => b.type === 'dblclick'));
});

test('binding twice does not stack listeners', () => {
  // The picker is opened again and again in one session.
  const el = fakeEl();
  M.blockPageZoom(el);
  const first = el.bound.length;
  assert.strictEqual(M.blockPageZoom(el), false, 'it bound a second set');
  assert.strictEqual(el.bound.length, first);
});

test('nothing to bind is not a crash', () => {
  assert.strictEqual(M.blockPageZoom(null), false);
  assert.strictEqual(M.blockPageZoom(undefined), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const picker = fs.readFileSync(path.join(ROOT, 'public', 'js', 'locpicker.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');

test('THE ONE IN THE REPORT: the location PICKER blocks it', () => {
  // "The map doesn't zoom and move when sharing location" — this surface.
  const fn = picker.slice(picker.indexOf('function bindMap()'),
    picker.indexOf('function bindMap()') + 900);
  assert.ok(fn.length > 100, 'bindMap moved');
  assert.ok(/MapGestures\.blockPageZoom\(/.test(fn),
    'a pinch on the picker still zooms the page instead of the map');
});

test('and so does the fullscreen map a shared pin opens', () => {
  const at = app.indexOf('function openMapViewer(');
  assert.ok(at > -1, 'openMapViewer moved');
  assert.ok(/MapGestures\.blockPageZoom\(surface\)/.test(app.slice(at, at + 4000)),
    'a pinch on the opened map still zooms the page');
});

test('touch-action is still set, because it is a different problem', () => {
  // It stops the page SCROLLING under a one-finger drag. It has never had
  // anything to do with Safari's pinch-zoom, which is what this file is for —
  // believing otherwise is why this took three reports.
  assert.ok(/#loc-map-wrap \{[^}]*touch-action: none/.test(css));
  assert.ok(/\.map-surface \{[^}]*touch-action: none/.test(css));
});

test('the page loads it before the two files that use it', () => {
  assert.ok(/src="\/js\/mapGestures\.js"/.test(html), 'mapGestures.js is never loaded');
  assert.ok(html.indexOf('mapGestures.js') < html.indexOf('js/locpicker.js'));
  assert.ok(html.indexOf('mapGestures.js') < html.indexOf('js/app.js'));
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
