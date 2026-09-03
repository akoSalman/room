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
//
// Reported as: the pen is dotted when drawing; it should draw a solid line.
//
// It used to be a run of thin rotated rectangles, one native view per pair of
// points, because there was no canvas in the editor. At every joint two of
// them met at an angle with nothing filling the wedge between, so a quick
// stroke — whose points are far apart — came out as a string of beads. (It was
// also a few hundred views for one drawing, which is why drawing crawled.)
//
// Now one path, stroked once with round caps and joins. There are no joints to
// fall between.

test('THE BUG: a stroke is ONE path, not a segment per movement', () => {
  const d = E.strokePath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.strictEqual(d, 'M0 0L10 0L10 10');
  // One move-to. More than one would mean the line lifts off the page
  // somewhere in the middle, which is the dotting in a different form.
  assert.strictEqual((d.match(/M/g) || []).length, 1, 'the pen lifts mid-stroke');
});

test('a tap with no movement still leaves a dot', () => {
  // A path with a single point strokes nothing at all, so the dot has to be an
  // explicit zero-length line — with a round cap, that is a dot.
  assert.strictEqual(E.strokePath([{ x: 5, y: 7 }]), 'M5 7L5 7');
});

test('nothing at all draws nothing', () => {
  assert.strictEqual(E.strokePath([]), '');
  assert.strictEqual(E.strokePath(null), '');
  assert.strictEqual(E.strokePath([{ x: NaN, y: 0 }]), '', 'a NaN reached the path string');
});

test('coordinates are rounded, not written out to fifteen decimals', () => {
  const d = E.strokePath([{ x: 1 / 3, y: 2 / 3 }, { x: 1, y: 1 }]);
  assert.strictEqual(d, 'M0.33 0.67L1 1');
});

// ── The arrow ────────────────────────────────────────────────────────────────
//
// Asked for alongside the solid pen: a way to point AT something in a photo.

test('THE ARROW: only the two ends matter, not the wander between them', () => {
  // An arrow that follows the finger's meander is not an arrow.
  const straight = E.arrowPath([{ x: 0, y: 0 }, { x: 100, y: 0 }], 4);
  const wandered = E.arrowPath(
    [{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 60, y: -20 }, { x: 100, y: 0 }], 4);
  assert.strictEqual(straight, wandered);
});

test('the shaft runs from the first point to the last, and the head is at the last', () => {
  const d = E.arrowPath([{ x: 0, y: 0 }, { x: 100, y: 0 }], 4);
  assert.ok(d.startsWith('M0 0L100 0'), d);
  // Two barbs, drawn as one stroke through the tip.
  const barbs = d.slice('M0 0L100 0'.length);
  assert.ok(/^M[\d.-]+ [\d.-]+L100 0L[\d.-]+ [\d.-]+$/.test(barbs), barbs);
  // Both barbs sit BEHIND the tip, one either side of the line.
  const nums = barbs.match(/-?[\d.]+/g).map(Number);
  assert.ok(nums[0] < 100 && nums[4] < 100, 'a barb points forward past the tip');
  assert.ok(nums[1] < 0 !== nums[5] < 0, 'both barbs are on the same side of the line');
});

test('the head is drawn behind the tip whichever way the arrow points', () => {
  for (const [bx, by] of [[100, 0], [-100, 0], [0, 100], [0, -100], [70, 70]]) {
    const d = E.arrowPath([{ x: 0, y: 0 }, { x: bx, y: by }], 4);
    const nums = d.match(/-?[\d.]+/g).map(Number);
    const tipDist = Math.hypot(bx, by);
    // Each barb end is nearer the start than the tip is.
    for (const [px, py] of [[nums[4], nums[5]], [nums[8], nums[9]]]) {
      assert.ok(Math.hypot(px, py) < tipDist,
        `barb ${px},${py} is beyond the tip for ${bx},${by}`);
    }
  }
});

test('the head scales with the thickness of the line', () => {
  assert.ok(E.arrowHeadLength(10) > E.arrowHeadLength(2),
    'a thick arrow gets the same stub of a head as a thin one');
  assert.ok(E.arrowHeadLength(1) >= 12, 'the thinnest pen gets a head too small to see');
});

test('an arrow too short to have a head draws nothing', () => {
  // Better nothing than a splat where a tap landed.
  assert.strictEqual(E.arrowPath([{ x: 0, y: 0 }, { x: 3, y: 0 }], 4), '');
  assert.strictEqual(E.arrowPath([{ x: 5, y: 5 }], 4), '');
  assert.strictEqual(E.arrowPath([], 4), '');
});

test('pathFor picks by the stroke\'s own kind', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  assert.strictEqual(E.pathFor({ points, width: 4 }), E.strokePath(points));
  assert.strictEqual(E.pathFor({ points, width: 4, arrow: true }), E.arrowPath(points, 4));
  assert.notStrictEqual(E.pathFor({ points, width: 4 }), E.pathFor({ points, width: 4, arrow: true }));
});

// ── How the editor draws them ────────────────────────────────────────────────

test('THE FIX: one canvas, round joins, and no view-per-segment', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'components', 'ImageEditor.tsx'), 'utf8');
  assert.ok(!/strokeSegments/.test(src), 'the segment rectangles are still being drawn');
  assert.ok(/<Canvas style=\{StyleSheet\.absoluteFill\}/.test(src), 'there is no canvas');
  const canvas = src.slice(src.indexOf('<Canvas'), src.indexOf('</Canvas>'));
  const caps = canvas.match(/strokeCap="round"/g) || [];
  const joins = canvas.match(/strokeJoin="round"/g) || [];
  assert.strictEqual(caps.length, 2, 'a stroke is drawn with square ends');
  assert.strictEqual(joins.length, 2,
    'the corners are mitred or bevelled, which is the dotting coming back at speed');
  assert.ok(canvas.includes('pathFor(st)'), 'finished strokes are not drawn from the rules');
});

test('the arrow is a tool you can pick, and it is remembered per stroke', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'components', 'ImageEditor.tsx'), 'utf8');
  assert.ok(/type Tool = 'crop' \| 'pen' \| 'arrow';/.test(src), 'there is no arrow tool');
  assert.ok(/label="Arrow"/.test(src), 'the arrow cannot be chosen');
  // Read out of the setStrokes call ITSELF. The same expression appears in
  // the guard a few lines above, and a check that merely found it in the file
  // passed while a released arrow was being stored as a freehand scribble.
  const saved = src.slice(src.indexOf('setStrokes(prev => [...prev, {'),
    src.indexOf('}]);', src.indexOf('setStrokes(prev => [...prev, {')));
  assert.ok(saved.length > 0, 'the stroke is no longer stored — this check would be vacuous');
  assert.ok(/arrow: toolRef\.current === 'arrow'/.test(saved),
    'a finished stroke does not remember whether it was an arrow, so it redraws as a scribble');
  // Read from a ref: the pan responder is built once and never sees a
  // re-render's new `tool`.
  assert.ok(/toolRef\.current = tool;/.test(src), 'the ref is never updated, so it is stuck on crop');
  assert.ok(/const drawingTool = tool === 'pen' \|\| tool === 'arrow';/.test(src),
    'the arrow has no touch surface or no colour controls');
});

test('a stroke that would draw nothing is not recorded', () => {
  // Otherwise Undo has to be pressed for something invisible.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'components', 'ImageEditor.tsx'), 'utf8');
  assert.ok(/if \(points\.length > 1 && pathFor\(\{/.test(src),
    'an arrow too short to draw is still added to the undo stack');
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

// ── Saving what was drawn ───────────────────────────────────────────────────
//
// Reported as: after editing an image with the pen and sending it, the edit is
// not there and the ORIGINAL image goes.
//
// Two faults behind that.
//
// A drawing can only be got at by photographing the screen; a crop is best
// done on the file, where the photo keeps its full resolution. The old code
// did one or the other and RETURNED after the crop — so with both outstanding
// the strokes were silently thrown away. A comment claimed that could not
// happen. The code did not enforce it.
//
// And when the edits could not be turned into a file at all, the editor fell
// back to the untouched photo and sent that. Quietly substituting the original
// for the edit is the worst of the available outcomes: the user believes they
// sent an annotated picture, and the person at the other end sees a plain one.

test('THE BUG: a drawing and a crop together keep BOTH', () => {
  const plan = E.savePlan({ annotated: true, cropped: true });
  assert.strictEqual(plan.capture, true, 'the strokes are dropped when a crop is also pending');
  assert.strictEqual(plan.crop, true, 'the crop is dropped');
  assert.strictEqual(plan.unchanged, false);
});

test('a drawing alone is photographed, not cropped', () => {
  const plan = E.savePlan({ annotated: true, cropped: false });
  assert.deepStrictEqual(plan, { capture: true, crop: false, unchanged: false });
});

test('a crop alone touches the FILE, so the photo keeps its resolution', () => {
  // Photographing the screen for a crop would silently downsample a 12MP photo
  // to whatever the phone happens to be showing.
  const plan = E.savePlan({ annotated: false, cropped: true });
  assert.strictEqual(plan.capture, false, 'a plain crop went through a screen capture');
  assert.strictEqual(plan.crop, true);
});

test('nothing outstanding does no work at all', () => {
  const plan = E.savePlan({ annotated: false, cropped: false });
  assert.strictEqual(plan.unchanged, true, 'an untouched photo would be re-encoded for nothing');
});

test('THE OTHER BUG: an edit that could not be made is never sent as the original', () => {
  assert.strictEqual(E.canSend(null), false,
    'a failed edit would be sent as the untouched photo');
  assert.strictEqual(E.canSend({}), false, 'a version with no file was treated as sendable');
  assert.strictEqual(E.canSend({ uri: '' }), false);
  assert.strictEqual(E.canSend({ uri: 'file:///edited.jpg' }), true);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const ed = fs.readFileSync(
  path.join(__dirname, '..', 'native-app', 'src', 'components', 'ImageEditor.tsx'), 'utf8');

test('the editor follows the plan rather than deciding again', () => {
  assert.ok(ed.includes('savePlan({ annotated, cropped })'), 'the editor decides for itself again');
  assert.ok(/if \(plan\.capture\)/.test(ed), 'the capture is not driven by the plan');
  assert.ok(/if \(!plan\.crop\) return base;/.test(ed), 'the crop is not driven by the plan');
});

test('the capture happens BEFORE the crop, or the strokes cannot survive it', () => {
  // The screen shows the picture uncropped with the strokes on top; the crop is
  // a fraction of that same rectangle, so it applies afterwards. Cropping first
  // would leave nothing to photograph the strokes from.
  const fn = ed.slice(ed.indexOf('async function rasterise('), ed.indexOf('async function apply('));
  assert.ok(fn.length > 0, 'rasterise is gone — this check would be vacuous');
  assert.ok(fn.indexOf('captureRef(') < fn.indexOf('manipulateAsync('),
    'the crop runs before the capture, which is how the drawing was lost');
});

test('sending refuses rather than substituting the original', () => {
  const fn = ed.slice(ed.indexOf("async function finish("), ed.indexOf('// Only the picture goes inside'));
  assert.ok(fn.length > 0, 'finish is gone — this check would be vacuous');
  assert.ok(fn.includes('canSend(out)'), 'the send no longer checks whether the edit was made');
  assert.ok(!/out\?\.uri \|\| working/.test(fn),
    'the untouched photo is used as a fallback again — this IS the reported bug');
  assert.ok(/Alert\.alert\('Edit not saved'/.test(fn), 'a failed edit passes in silence');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
