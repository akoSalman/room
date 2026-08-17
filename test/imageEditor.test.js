// Tests for the image editor's geometry (native-app/src/imageEditor.ts).
//
// A crop is drawn on a photo scaled to fit the screen and applied to the
// photo's own, much larger pixels. Getting that translation wrong crops the
// wrong part of the picture — which looks like a working feature until you
// compare the result with what was on screen.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'imgedit-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'imageEditor.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping image-editor tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const E = require(path.join(OUT, 'imageEditor.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('a landscape photo is letterboxed vertically', () => {
  // 4000x2000 into 400x400: fits the width, centred with bars above and below.
  const r = E.fitRect({ width: 4000, height: 2000 }, { width: 400, height: 400 });
  assert.deepStrictEqual(r, { x: 0, y: 100, width: 400, height: 200 });
});

test('a portrait photo is letterboxed horizontally', () => {
  const r = E.fitRect({ width: 2000, height: 4000 }, { width: 400, height: 400 });
  assert.deepStrictEqual(r, { x: 100, y: 0, width: 200, height: 400 });
});

test('a degenerate size does not produce NaN', () => {
  assert.deepStrictEqual(E.fitRect({ width: 0, height: 0 }, { width: 400, height: 400 }),
    { x: 0, y: 0, width: 0, height: 0 });
  assert.deepStrictEqual(E.fitRect({ width: 10, height: 10 }, { width: 0, height: 0 }),
    { x: 0, y: 0, width: 0, height: 0 });
});

// ── Pen strokes ──────────────────────────────────────────────────────────────

test('a stroke becomes one segment per movement', () => {
  const segs = E.strokeSegments([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 4);
  assert.strictEqual(segs.length, 2);
});

test('a horizontal segment is placed and angled correctly', () => {
  // Positioned by its midpoint, because a View rotates about its own centre.
  // Deliberately not starting at the origin, where "midpoint minus half the
  // length" and "the first point" happen to be the same number.
  const [seg] = E.strokeSegments([{ x: 100, y: 50 }, { x: 110, y: 50 }], 4);
  assert.strictEqual(seg.length, 10);
  assert.strictEqual(seg.angle, 0);
  assert.strictEqual(seg.x, 100);    // midpoint 105, minus half the length
  assert.strictEqual(seg.y, 48);     // midpoint 50, minus half the thickness
});

test('a vertical segment is rotated a quarter turn', () => {
  const [seg] = E.strokeSegments([{ x: 0, y: 0 }, { x: 0, y: 10 }], 4);
  assert.strictEqual(seg.angle, 90);
  assert.strictEqual(seg.length, 10);
  // A rectangle is laid out horizontally and THEN rotated about its centre,
  // so before rotation it must straddle the midpoint. Placing it at the first
  // point instead sends every non-left-to-right stroke off at a tangent —
  // and for a left-to-right stroke the two happen to agree, which is exactly
  // what makes the mistake survive casual testing.
  assert.strictEqual(seg.x, -5, 'the segment was not centred on its midpoint');
  assert.strictEqual(seg.y, 3);
});

test('a right-to-left segment is centred too', () => {
  const [seg] = E.strokeSegments([{ x: 110, y: 50 }, { x: 100, y: 50 }], 4);
  assert.strictEqual(seg.x, 100, 'a backwards stroke was drawn from the wrong end');
  assert.strictEqual(Math.abs(seg.angle), 180);
});

test('a finger resting still does not pile up invisible segments', () => {
  const points = Array.from({ length: 50 }, () => ({ x: 5, y: 5 }));
  assert.deepStrictEqual(E.strokeSegments(points, 4), []);
});

test('a single point is not a stroke', () => {
  assert.deepStrictEqual(E.strokeSegments([{ x: 1, y: 1 }], 4), []);
  assert.deepStrictEqual(E.strokeSegments([], 4), []);
});

// ── The crop box as a fraction ───────────────────────────────────────────────
//
// Reported as: no crop was made, but after drawing on the photo and sending it,
// the photo came back cropped.
//
// The box was stored in screen pixels and started equal to the whole displayed
// picture, and "did the user crop?" compared the two. The displayed picture is
// only as big as the space left on screen — so when the confirm button appeared
// after the first pen stroke, the canvas got shorter, the picture shrank, and
// the box no longer matched it. The editor concluded a crop had been made.

test('THE BUG: the layout changing does not turn an untouched box into a crop', () => {
  // The picture as first laid out, and again after the canvas lost 60px to a
  // button that appeared underneath it.
  const tall = E.fitRect({ width: 4000, height: 3000 }, { width: 360, height: 640 });
  const short = E.fitRect({ width: 4000, height: 3000 }, { width: 360, height: 580 });

  const box = { ...E.WHOLE_IMAGE };
  assert.ok(E.isWholeFrac(box), 'the untouched box did not read as the whole picture');

  // The same fraction on either layout is still the whole picture.
  assert.ok(E.isWholeFrac(E.screenToFrac(E.fracToScreen(box, tall), tall)));
  assert.ok(E.isWholeFrac(E.screenToFrac(E.fracToScreen(box, short), short)));

  // And this is what used to happen: a box measured against the TALL layout,
  // compared against the SHORT one, looks like a deliberate crop.
  const stale = E.screenToFrac(E.fracToScreen(box, tall), short);
  assert.ok(!E.isWholeFrac(stale),
    'the fixture is wrong — the two layouts must actually differ for this to prove anything');
});

test('a fractional box survives a round trip through screen coordinates', () => {
  const displayed = E.fitRect({ width: 4000, height: 3000 }, { width: 360, height: 640 });
  const f = { x: 0.25, y: 0.1, w: 0.5, h: 0.4 };
  const back = E.screenToFrac(E.fracToScreen(f, displayed), displayed);
  for (const k of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(back[k] - f[k]) < 1e-9, `${k} drifted: ${back[k]} vs ${f[k]}`);
  }
});

test('a real crop is still recognised as one', () => {
  assert.ok(!E.isWholeFrac({ x: 0.1, y: 0, w: 0.9, h: 1 }));
  assert.ok(!E.isWholeFrac({ x: 0, y: 0, w: 0.5, h: 1 }));
  assert.ok(!E.isWholeFrac({ x: 0, y: 0.2, w: 1, h: 0.8 }));
});

test('a fractional box stays inside the picture', () => {
  assert.deepStrictEqual(E.clampFrac({ x: -0.5, y: -0.5, w: 1, h: 1 }), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepStrictEqual(E.clampFrac({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }),
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  // Never collapses to nothing.
  const tiny = E.clampFrac({ x: 0.5, y: 0.5, w: 0, h: 0 });
  assert.ok(tiny.w >= 0.05 && tiny.h >= 0.05);
  // Never larger than the picture.
  assert.deepStrictEqual(E.clampFrac({ x: 0, y: 0, w: 3, h: 3 }), { x: 0, y: 0, w: 1, h: 1 });
});

test('the whole picture converts to the whole picture in real pixels', () => {
  assert.deepStrictEqual(E.fracToNatural(E.WHOLE_IMAGE, { width: 4000, height: 3000 }),
    { x: 0, y: 0, width: 4000, height: 3000 });
});

test('a fractional crop lands on the right pixels', () => {
  assert.deepStrictEqual(E.fracToNatural({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 },
    { width: 4000, height: 3000 }), { x: 1000, y: 1500, width: 2000, height: 1500 });
});

test('a crop can never run past the edge of the photo', () => {
  // The native cropper rejects an out-of-bounds rectangle outright rather than
  // trimming it, so this has to be exact.
  const box = E.fracToNatural({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, { width: 1000, height: 800 });
  assert.ok(box.x + box.width <= 1000, `runs ${box.x + box.width - 1000}px past the right edge`);
  assert.ok(box.y + box.height <= 800, `runs ${box.y + box.height - 800}px past the bottom`);
});

// ── Undo ─────────────────────────────────────────────────────────────────────
//
// The editor holds edits in two places at once: pending on screen (a crop box,
// strokes, captions) and already applied, each of which produced a file. Undo
// walks back through both, newest first.
//
// The previous version compared a caption's Date.now() id against the NUMBER
// of strokes — two quantities with nothing to do with each other — so which of
// the two it removed was effectively arbitrary.

const undoOf = (o) => E.nextUndo({ cropped: false, committed: 0, ...o });

test('a pending stroke is always the newest thing', () => {
  assert.strictEqual(undoOf({ lastStrokeSeq: 3 }), 'stroke');
  assert.strictEqual(undoOf({ lastStrokeSeq: 3, cropped: true }), 'stroke');
  assert.strictEqual(undoOf({ lastStrokeSeq: 3, cropped: true, committed: 5 }), 'stroke');
});

test('nothing to undo when nothing has been done', () => {
  assert.strictEqual(undoOf({}), null);
});

test('sequence zero still counts as an edit', () => {
  // A plain truthiness check here would treat the very first stroke as absent.
  assert.strictEqual(undoOf({ lastStrokeSeq: 0 }), 'stroke');
});

test('with the annotations gone, the crop box is next', () => {
  assert.strictEqual(undoOf({ cropped: true }), 'crop');
  // But only once nothing newer is outstanding.
  assert.strictEqual(undoOf({ cropped: true, lastStrokeSeq: 1 }), 'stroke');
});

test('with nothing pending, undo steps back through the applied versions', () => {
  assert.strictEqual(undoOf({ committed: 2 }), 'revert');
  assert.strictEqual(undoOf({ committed: 0 }), null);
});

test('a pending crop is undone before an applied one is reverted', () => {
  assert.strictEqual(undoOf({ cropped: true, committed: 3 }), 'crop');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
