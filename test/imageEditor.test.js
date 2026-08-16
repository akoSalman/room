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

test('cropping the whole photo gives back the whole photo', () => {
  const natural = { width: 4000, height: 2000 };
  const displayed = E.fitRect(natural, { width: 400, height: 400 });
  const crop = E.toNaturalCrop(displayed, displayed, natural);
  assert.deepStrictEqual(crop, { x: 0, y: 0, width: 4000, height: 2000 });
});

test('a crop is translated into the photo’s own pixels', () => {
  // Photo drawn 10x smaller. A box over the middle quarter of the drawing must
  // land on the middle quarter of the real picture, not on its top-left.
  const natural = { width: 4000, height: 2000 };
  const displayed = E.fitRect(natural, { width: 400, height: 400 }); // 400x200 at y=100
  const box = { x: 100, y: 150, width: 200, height: 100 };
  assert.deepStrictEqual(E.toNaturalCrop(box, displayed, natural),
    { x: 1000, y: 500, width: 2000, height: 1000 });
});

test('the letterbox offset is subtracted, not ignored', () => {
  // The regression this guards: forgetting displayed.y crops from the wrong
  // height, and the error grows with how letterboxed the photo is.
  const natural = { width: 4000, height: 2000 };
  const displayed = E.fitRect(natural, { width: 400, height: 400 });
  // A box at the very TOP of the drawn photo is y=100 on screen, but 0 in the
  // photo. Ignoring the offset would put it 1000 pixels down.
  const box = { x: 0, y: 100, width: 40, height: 20 };
  assert.strictEqual(E.toNaturalCrop(box, displayed, natural).y, 0);
});

test('a crop cannot run off the edge of the photo', () => {
  // Native image code rejects an out-of-bounds crop outright rather than
  // trimming it, so this has to be clamped here.
  const natural = { width: 1000, height: 1000 };
  const displayed = { x: 0, y: 0, width: 500, height: 500 };
  const crop = E.toNaturalCrop({ x: -50, y: -50, width: 600, height: 600 }, displayed, natural);
  assert.strictEqual(crop.x, 0);
  assert.strictEqual(crop.y, 0);
  assert.ok(crop.x + crop.width <= natural.width, `right edge at ${crop.x + crop.width}`);
  assert.ok(crop.y + crop.height <= natural.height, `bottom edge at ${crop.y + crop.height}`);
});

test('a crop is never zero-sized', () => {
  const crop = E.toNaturalCrop({ x: 10, y: 10, width: 0, height: 0 },
    { x: 0, y: 0, width: 500, height: 500 }, { width: 1000, height: 1000 });
  assert.ok(crop.width >= 1 && crop.height >= 1);
});

test('the crop box is kept inside the photo', () => {
  const bounds = { x: 10, y: 20, width: 100, height: 100 };
  const c = E.clampCrop({ x: -50, y: -50, width: 60, height: 60 }, bounds);
  assert.strictEqual(c.x, 10);
  assert.strictEqual(c.y, 20);
  const d = E.clampCrop({ x: 500, y: 500, width: 60, height: 60 }, bounds);
  assert.strictEqual(d.x, 10 + 100 - 60);
  assert.strictEqual(d.y, 20 + 100 - 60);
});

test('the crop box cannot be shrunk to nothing', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  const c = E.clampCrop({ x: 0, y: 0, width: 1, height: 1 }, bounds, 40);
  assert.strictEqual(c.width, 40);
  assert.strictEqual(c.height, 40);
});

test('an untouched box is recognised as "no crop"', () => {
  // Used to skip the crop step entirely, so an unedited photo is sent as-is
  // rather than re-encoded for nothing.
  const displayed = { x: 10, y: 20, width: 300, height: 200 };
  assert.strictEqual(E.isWholeImage({ ...displayed }, displayed), true);
  assert.strictEqual(E.isWholeImage({ ...displayed, width: 250 }, displayed), false);
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

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
