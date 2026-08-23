// Tapping to set the brightness, and the makeup pass.
//
// Asked for as: the camera should have brightness control by tapping the
// object, and makeup, on both video and images.
//
// What a tap can and cannot do is the whole design. On a phone's own camera
// app, tapping a face tells the SENSOR to expose for that spot. expo-camera
// does not offer that — its exposure/ISO/white-balance settings are web-only
// and there is no metering-point API on Android — so nothing here changes what
// the sensor does. What it does instead is correct the picture the sensor
// gives, which is the same answer for the user PROVIDED the preview shows the
// correction and the photo gets exactly the one it showed. That is why both
// numbers come from this one module.
//
// Video is the honest exception, and these tests pin that down too: an overlay
// on the preview is not in the recorded frames.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping camera-tune tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cameratune-'));
execFileSync(TSC, [path.join(NAT, 'src', 'cameraTune.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const T = require(path.join(OUT, 'cameraTune.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The slider ──────────────────────────────────────────────────────────────

test('THE POINT: dragging up brightens, dragging down darkens', () => {
  // On a screen y grows downwards, so the drag has to be negated. Getting this
  // backwards would be the kind of bug nobody reports politely.
  assert.ok(T.evFromDrag(0, -50, 150) > 0, 'dragging up made it darker');
  assert.ok(T.evFromDrag(0, 50, 150) < 0, 'dragging down made it brighter');
});

test('a full drag covers the whole range, and no more', () => {
  assert.strictEqual(T.evFromDrag(T.EV_MIN, -150, 150), T.EV_MAX);
  assert.strictEqual(T.evFromDrag(0, -9999, 150), T.EV_MAX, 'the exposure ran past the top');
  assert.strictEqual(T.evFromDrag(0, 9999, 150), T.EV_MIN, 'the exposure ran past the bottom');
});

test('the drag continues from where the last one stopped', () => {
  // Otherwise every touch snaps the exposure back to the middle and fine
  // adjustment is impossible.
  const mid = T.evFromDrag(0, -37, 150);
  assert.ok(T.evFromDrag(mid, -37, 150) > mid);
});

test('a zero-height track cannot produce a nonsense exposure', () => {
  assert.strictEqual(T.evFromDrag(0.4, -50, 0), 0.4);
  // Nonsense in means NEUTRAL out, not maximum: a stray NaN or Infinity
  // reaching this should leave the photo as it was taken, never silently
  // push it a full stop.
  assert.strictEqual(T.clampEv(NaN), 0);
  assert.strictEqual(T.clampEv(Infinity), 0);
  assert.strictEqual(T.clampEv(-Infinity), 0);
});

test('the knob sits where the exposure says', () => {
  assert.strictEqual(T.knobFraction(T.EV_MIN), 0);
  assert.strictEqual(T.knobFraction(T.EV_MAX), 1);
  assert.strictEqual(T.knobFraction(0), 0.5);
});

// ── The preview must not promise more than the photo delivers ───────────────

test('the preview brightens when the exposure is raised, and darkens when lowered', () => {
  assert.strictEqual(T.previewOverlay(0.5).color, 'white');
  assert.strictEqual(T.previewOverlay(-0.5).color, 'black');
  assert.ok(T.previewOverlay(1).opacity > T.previewOverlay(0.3).opacity,
    'the preview shows the same thing for a big change as for a small one');
});

test('at zero the preview is untouched', () => {
  assert.strictEqual(T.previewOverlay(0).opacity, 0, 'an overlay over an unmodified preview');
});

test('the preview overlay stays gentle', () => {
  // Overstating it is the worst outcome available here: a preview that
  // promises a photo the correction cannot deliver.
  for (const ev of [-1, -0.5, 0.5, 1]) {
    assert.ok(T.previewOverlay(ev).opacity <= 0.45, `opacity ${T.previewOverlay(ev).opacity} at ev ${ev}`);
  }
});

// ── The correction applied to the file ──────────────────────────────────────

test('THE BUG THIS AVOIDS: exposure multiplies, it does not add', () => {
  // Adding a constant is the classic mistake: it lifts the blacks to grey, so
  // the photo looks foggy rather than brighter.
  const m = T.exposureMatrix(1);
  assert.strictEqual(m[4], 0, 'a constant is being added to red');
  assert.strictEqual(m[9], 0, 'a constant is being added to green');
  assert.strictEqual(m[14], 0, 'a constant is being added to blue');
  assert.ok(Math.abs(m[0] - 2) < 1e-9, 'one stop up did not double the light');
});

test('one stop down halves it, and zero leaves the photo alone', () => {
  assert.ok(Math.abs(T.exposureMatrix(-1)[0] - 0.5) < 1e-9);
  const id = T.exposureMatrix(0);
  assert.ok(Math.abs(id[0] - 1) < 1e-9 && Math.abs(id[6] - 1) < 1e-9 && Math.abs(id[12] - 1) < 1e-9);
});

test('every channel gets the same gain, or the colours shift', () => {
  const m = T.exposureMatrix(0.7);
  assert.ok(Math.abs(m[0] - m[6]) < 1e-9 && Math.abs(m[6] - m[12]) < 1e-9,
    'brightening tinted the photo');
  assert.strictEqual(m[18], 1, 'the alpha channel was scaled with the colours');
});

// ── Makeup ──────────────────────────────────────────────────────────────────

test('off means off — no blur, no blend, no warmth', () => {
  const p = T.makeupParams('off');
  assert.deepStrictEqual([p.blurSigma, p.blend, p.warmth, p.lift], [0, 0, 0, 0]);
});

test('strong is stronger than light, and light is genuinely light', () => {
  const l = T.makeupParams('light');
  const s = T.makeupParams('strong');
  assert.ok(s.blend > l.blend && s.blurSigma > l.blurSigma);
  assert.ok(l.blend <= 0.4, `a "light" blend of ${l.blend} is not light`);
  assert.ok(s.blend < 0.7, `a "strong" blend of ${s.blend} would erase the face`);
});

test('the blur is scaled to the photo, not fixed in pixels', () => {
  // The same sigma is invisible on a 4000px photo and heavy on a 1080px one,
  // so "light" would mean something different on every phone.
  const small = T.scaledSigma(3, 1080);
  const big = T.scaledSigma(3, 4320);
  assert.ok(Math.abs(small - 3) < 1e-9);
  assert.ok(Math.abs(big - 12) < 1e-9, `a 4x wider photo got sigma ${big}`);
  assert.strictEqual(T.scaledSigma(0, 1080), 0);
  assert.strictEqual(T.scaledSigma(3, 0), 0, 'an unknown width produced a blur anyway');
});

test('makeup warms the skin rather than greying it', () => {
  const m = T.makeupMatrix('light');
  assert.ok(m[0] > 1, 'red was not lifted, so smoothed skin goes grey');
  assert.ok(m[12] < 1, 'blue was not pulled back');
  assert.deepStrictEqual(T.makeupMatrix('off').slice(0, 3), [1, 0, 0], 'off tinted the photo');
});

// ── Doing nothing, properly ─────────────────────────────────────────────────

test('THE OTHER BUG THIS AVOIDS: an untouched photo is not re-encoded', () => {
  // Decoding and re-encoding for a no-op costs a second of the user's time, a
  // generation of JPEG quality and the photo's EXIF.
  assert.strictEqual(T.needsProcessing({ ev: 0, makeup: 'off' }), false);
  assert.strictEqual(T.needsProcessing({ ev: 0.004, makeup: 'off' }), false,
    'a rounding-error exposure triggered a full re-encode');
});

test('anything actually asked for IS processed', () => {
  assert.strictEqual(T.needsProcessing({ ev: 0.5, makeup: 'off' }), true);
  assert.strictEqual(T.needsProcessing({ ev: -0.5, makeup: 'off' }), true);
  assert.strictEqual(T.needsProcessing({ ev: 0, makeup: 'light' }), true);
});

// ── The honest limit ────────────────────────────────────────────────────────

test('THE LIMIT: these controls are photo-only, deliberately', () => {
  // The preview overlay is not in the recorded frames, and those frames cannot
  // be reached without replacing the camera stack. A control that appears on
  // video and silently changes nothing about the file is worse than no
  // control — this is the one place that decision is written down.
  assert.strictEqual(T.tuningAvailable('photo'), true);
  assert.strictEqual(T.tuningAvailable('video'), false);
});

// ── Where the tap target goes ───────────────────────────────────────────────

const SCREEN = { w: 400, h: 860 };

test('the ring lands where the finger did', () => {
  const t = T.placeTarget({ x: 200, y: 400 }, SCREEN);
  assert.strictEqual(t.x, 200);
  assert.strictEqual(t.y, 400);
});

test('THE TRAP: a tap at the edge keeps its slider on screen', () => {
  // Off the side, the slider exists and cannot be dragged — a control that
  // looks real and does nothing.
  const right = T.placeTarget({ x: 399, y: 400 }, SCREEN);
  assert.ok(right.sliderX >= 0 && right.sliderX + 34 <= SCREEN.w,
    `slider at ${right.sliderX} is off the screen`);
  const left = T.placeTarget({ x: 0, y: 400 }, SCREEN);
  assert.ok(left.sliderX >= 0, `slider at ${left.sliderX} is off the left`);
});

test('the slider flips to the other side when there is no room', () => {
  const right = T.placeTarget({ x: 399, y: 400 }, SCREEN);
  assert.ok(right.sliderX < right.x, 'the slider stayed on the crowded side');
  const middle = T.placeTarget({ x: 200, y: 400 }, SCREEN);
  assert.ok(middle.sliderX > middle.x, 'the slider is on the left by default');
});

test('the ring and slider keep clear of the top bar and the shutter', () => {
  const top = T.placeTarget({ x: 200, y: 0 }, SCREEN);
  assert.ok(top.y >= 90, `y ${top.y} is under the top bar`);
  assert.ok(top.sliderY >= 90, `slider y ${top.sliderY} is under the top bar`);
  const bottom = T.placeTarget({ x: 200, y: 859 }, SCREEN);
  assert.ok(bottom.y <= SCREEN.h - 190, `y ${bottom.y} is behind the shutter`);
  assert.ok(bottom.sliderY + 150 <= SCREEN.h - 190, 'the slider runs under the shutter');
});

test('the target does not sit on screen forever', () => {
  // It is drawn over the picture, but it is also a control somebody may be
  // deciding with — every phone camera settles on a few seconds.
  assert.ok(T.TARGET_FADE_MS >= 2000 && T.TARGET_FADE_MS <= 8000,
    `${T.TARGET_FADE_MS}ms is not a sensible time for the ring to linger`);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const cam = fs.readFileSync(path.join(NAT, 'src', 'screens', 'CameraScreen.tsx'), 'utf8');
const editor = fs.readFileSync(path.join(NAT, 'src', 'components', 'ImageEditor.tsx'), 'utf8');
const tune = fs.readFileSync(path.join(NAT, 'src', 'photoTune.ts'), 'utf8');

test('the camera reacts to a tap, and only in photo mode', () => {
  assert.ok(cam.includes('Gesture.Tap()'), 'nothing responds to a tap on the preview');
  assert.ok(cam.includes('placeTarget({'), 'the target is placed by hand rather than by the rule');
  const tap = cam.slice(cam.indexOf('const tapTarget'), cam.indexOf('const dragEv'));
  assert.ok(tap.includes('tuningAvailable('), 'a tap while recording puts up a control that does nothing');
});

test('the preview shows the correction that the photo will get', () => {
  assert.ok(cam.includes('previewOverlay(ev)'), 'the preview does not show the exposure at all');
  assert.ok(/tunePhoto\(pic\.uri, tune\)/.test(cam), 'the photo is never corrected');
  // The SAME numbers, captured at the shutter — not whatever the sliders say
  // by the time the file has finished writing.
  assert.ok(/const tune = \{ ev, makeup \};/.test(cam),
    'the correction is read after the capture, so it can drift from what was shown');
});

test('a photo that needs nothing is left exactly as it was', () => {
  assert.ok(cam.includes('if (!needsProcessing(tune)) return;'),
    'every photo is re-encoded, including the ones nobody adjusted');
  assert.ok(tune.includes('if (!uri || !needsProcessing(o)) return uri;'),
    'the processor re-encodes unconditionally');
});

test('a failure hands back the original photo rather than nothing', () => {
  // A photo that comes back unretouched is a disappointment; one that comes
  // back undefined is a lost moment.
  const body = tune.slice(tune.indexOf('export async function tunePhoto'));
  assert.ok((body.match(/return uri;/g) || []).length >= 5,
    'some failure path drops the photo instead of returning the original');
  assert.ok(/catch \{\s*\n?\s*return uri;/.test(body), 'a throw loses the photo');
});

test('makeup is offered on the camera and in the editor, at both strengths', () => {
  assert.ok(/setMakeup\(m => \(m === 'off' \? 'light' : m === 'light' \? 'strong' : 'off'\)\)/.test(cam),
    'the camera has no makeup control');
  assert.ok(editor.includes("setMakeup(m => (m === 'off'"), 'the editor has no makeup control');
  assert.ok(editor.includes('tunePhoto(uri, { ev, makeup })'), 'the editor never applies it');
});

test('the editor applies the correction AFTER the crop and the drawing', () => {
  // Correcting first would re-encode the photo twice, and the crop would be
  // applied to an already-recompressed image.
  const finish = editor.slice(editor.indexOf('async function finish('), editor.indexOf('// Only the picture goes inside'));
  const raster = finish.indexOf('rasterise()');
  const applied = finish.indexOf('tunePhoto(');
  assert.ok(raster > -1 && applied > raster, 'the correction runs before the edits are flattened');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
