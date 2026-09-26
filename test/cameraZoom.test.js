// Tests for camera zoom mapping (native-app/src/cameraZoom.ts).
//
// Reported as: the 2x and 3x buttons are not real zoom.
//
// They were not. expo-camera's `zoom` is 0..1 mapped to CameraX's linearZoom,
// which is linear in FIELD OF VIEW, not in the zoom factor — the factor climbs
// slowly at the bottom of the range and runs away at the top. The old code read
// the scale as linear in the factor and offered 0.25 as "2x", which on an 8x
// phone is about 1.3x. That is why the button looked broken.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'camzoom-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'cameraZoom.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping camera-zoom tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const Z = require(path.join(OUT, 'cameraZoom.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const near = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) < tol, `${msg || ''} expected ~${b}, got ${a}`);

test('the ends of the range are exact', () => {
  assert.strictEqual(Z.factorToLinear(1), 0);
  assert.strictEqual(Z.factorToLinear(Z.ASSUMED_MAX_FACTOR), 1);
  assert.strictEqual(Z.linearToFactor(0), 1);
  near(Z.linearToFactor(1), Z.ASSUMED_MAX_FACTOR, 1e-9);
});

test('THE BUG: 2x is not a quarter of the way along the scale', () => {
  // What the old code sent for "2x", and what it really produced.
  near(Z.linearToFactor(0.25, 8), 1.28, 0.02,
    'the old 2x button really gave this much magnification —');
  // And where 2x actually lives.
  near(Z.factorToLinear(2, 8), 0.571, 0.002);
});

test('a factor survives the round trip', () => {
  for (const f of [1, 1.5, 2, 3, 4, 5, 8]) {
    near(Z.linearToFactor(Z.factorToLinear(f, 8), 8), f, 1e-9, `factor ${f}:`);
  }
});

test('the scale is NOT linear in the factor', () => {
  // Halfway along the slider is well past halfway to maximum magnification,
  // because it is the field of view that moves evenly.
  const mid = Z.linearToFactor(0.5, 8);
  assert.ok(mid > 1.7 && mid < 1.8, `halfway gave ${mid}x`);
  assert.ok(Math.abs(mid - 4.5) > 2, 'the mapping is still linear in the factor');
});

test('a pinch multiplies the magnification', () => {
  // Pinching to twice the size doubles the zoom, wherever it started. That is
  // what a pinch means; adding to the 0..1 value instead barely moved at the
  // bottom of the range and slammed to maximum near the top.
  const from2x = Z.factorToLinear(2, 8);
  near(Z.linearToFactor(Z.pinchToLinear(from2x, 2, 8), 8), 4, 1e-9);
  const from1x = 0;
  near(Z.linearToFactor(Z.pinchToLinear(from1x, 2, 8), 8), 2, 1e-9);
});

test('a pinch cannot go outside the range', () => {
  assert.strictEqual(Z.pinchToLinear(0, 0.2, 8), 0, 'pinching in past 1x');
  assert.strictEqual(Z.pinchToLinear(0.9, 50, 8), 1, 'pinching out past the maximum');
});

test('a nonsense scale leaves the zoom alone', () => {
  assert.strictEqual(Z.pinchToLinear(0.4, 0, 8), 0.4);
  assert.strictEqual(Z.pinchToLinear(0.4, -1, 8), 0.4);
});

test('zooming below 1x is not a thing', () => {
  assert.strictEqual(Z.factorToLinear(0.5), 0);
  assert.strictEqual(Z.factorToLinear(0), 0);
  assert.strictEqual(Z.factorToLinear(-3), 0);
});

test('factors are written the way a camera writes them', () => {
  assert.strictEqual(Z.formatFactor(1), '1x');
  assert.strictEqual(Z.formatFactor(2), '2x');
  assert.strictEqual(Z.formatFactor(1.28), '1.3x');
  assert.strictEqual(Z.formatFactor(2.0001), '2x');
});

test('a stop the phone cannot reach is not offered', () => {
  // A button promising 5x on a phone that stops at 3x is a lie the user can see.
  const stops = Z.zoomStops([1, 2, 3, 5], 3);
  assert.deepStrictEqual(stops.map(s => s.label), ['1x', '2x', '3x']);
  assert.strictEqual(stops[stops.length - 1].value, 1, 'the top stop must reach the maximum');
});

test('each stop maps to the value that actually gives its factor', () => {
  for (const st of Z.zoomStops([1, 2, 3], 8)) {
    near(Z.linearToFactor(st.value, 8), st.factor, 1e-9, `${st.label}:`);
  }
});

test('a broken maximum does not produce NaN', () => {
  assert.strictEqual(Z.factorToLinear(2, 1), 0);
  assert.strictEqual(Z.linearToFactor(0.5, 0), 1);
});

// ── Zooming while the clip is running ───────────────────────────────────────
//
// Asked for: zoom controls when taking a video.
//
// The pinch gesture was never disabled during a recording — it worked the
// whole time. What was hidden was every sign of it: the stops above the
// shutter and the readout that says what the zoom is, both behind
// `!recording`. So the one moment you most want to zoom, a clip already
// running, had no visible control and no feedback.

test('THE ZOOM CONTROLS SURVIVE THE SHUTTER', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const src = fs2.readFileSync(
    path2.join(__dirname, '..', 'native-app', 'src', 'screens', 'CameraScreen.tsx'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

  // The stops.
  const stops = code.indexOf('ZOOM_STOPS.map');
  assert.ok(stops > 0, 'the quick zoom stops are gone');
  const beforeStops = code.slice(code.lastIndexOf('{', stops - 200), stops);
  assert.ok(!/!recording/.test(beforeStops),
    'the zoom stops are hidden while recording, which is when they are wanted most');

  // The readout.
  const pill = code.indexOf('s.zoomPill');
  assert.ok(pill > 0, 'the zoom readout is gone');
  const beforePill = code.slice(code.lastIndexOf('{zoom', pill - 1), pill);
  assert.ok(!/!recording/.test(beforePill), 'the zoom readout is hidden while recording');
});

test('…while the controls that would RUIN a clip stay hidden', () => {
  // Not everything is safe mid-recording. Flipping the camera or changing
  // mode ends the clip or throws it away, and this must not have quietly
  // un-hidden those too.
  const fs2 = require('fs');
  const path2 = require('path');
  const src = fs2.readFileSync(
    path2.join(__dirname, '..', 'native-app', 'src', 'screens', 'CameraScreen.tsx'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  const mode = code.indexOf('modeRow');
  assert.ok(/!recording/.test(code.slice(mode - 200, mode)),
    'the photo/video switch is offered mid-recording, which throws the clip away');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
