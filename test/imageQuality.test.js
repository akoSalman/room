// Tests for send-quality sizing (native-app/src/imageQuality.ts).
//
// The rule that matters most is the one that is easiest to get wrong: an image
// already smaller than the limit must be left ALONE. Scaling it "down" to the
// limit would upscale it — bigger file, no extra detail.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'iqtest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'imageQuality.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping image-quality tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const Q = require(path.join(OUT, 'imageQuality.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('HD never resizes and never re-encodes', () => {
  assert.strictEqual(Q.resizeTarget(4000, 3000, 'hd'), null);
  assert.strictEqual(Q.shouldCompress('image/jpeg', 'hd'), false);
});

test('a big photo is scaled so its longest edge hits the limit', () => {
  const t = Q.resizeTarget(4032, 3024, 'standard');
  assert.strictEqual(Math.max(t.width, t.height), Q.STANDARD_MAX_EDGE);
});

test('the aspect ratio survives resizing', () => {
  for (const [w, h] of [[4032, 3024], [3024, 4032], [6000, 1000], [1000, 6000]]) {
    const t = Q.resizeTarget(w, h, 'standard');
    assert.ok(Math.abs(t.width / t.height - w / h) < 0.01,
      `aspect ratio changed for ${w}x${h}: got ${t.width}x${t.height}`);
  }
});

test('an image already under the limit is left alone', () => {
  // The regression this guards: "resizing" a 800px image to 1600px upscales
  // it — a bigger file with no more detail.
  assert.strictEqual(Q.resizeTarget(800, 600, 'standard'), null);
  assert.strictEqual(Q.resizeTarget(1600, 900, 'standard'), null, 'exactly at the limit should not resize');
  assert.strictEqual(Q.resizeTarget(200, 200, 'standard'), null);
});

test('resizing only ever shrinks', () => {
  for (const [w, h] of [[4032, 3024], [2000, 1500], [1601, 20], [9000, 9000]]) {
    const t = Q.resizeTarget(w, h, 'standard');
    if (!t) continue;
    assert.ok(t.width <= w && t.height <= h,
      `${w}x${h} was scaled UP to ${t.width}x${t.height}`);
  }
});

test('an extremely thin image never collapses to zero pixels', () => {
  const t = Q.resizeTarget(8000, 3, 'standard');
  assert.ok(t.width >= 1 && t.height >= 1, `got a zero dimension: ${t.width}x${t.height}`);
});

test('nonsense dimensions are refused rather than producing NaN', () => {
  for (const [w, h] of [[0, 0], [-5, 100], [NaN, 100], [Infinity, 100]]) {
    assert.strictEqual(Q.resizeTarget(w, h, 'standard'), null, `accepted ${w}x${h}`);
  }
});

test('only still images are re-encoded', () => {
  assert.strictEqual(Q.shouldCompress('image/jpeg', 'standard'), true);
  assert.strictEqual(Q.shouldCompress('image/png', 'standard'), true);
  // Re-encoding an animated GIF would freeze it to a single frame.
  assert.strictEqual(Q.shouldCompress('image/gif', 'standard'), false);
  assert.strictEqual(Q.shouldCompress('image/svg+xml', 'standard'), false);
  assert.strictEqual(Q.shouldCompress('video/mp4', 'standard'), false);
  assert.strictEqual(Q.shouldCompress('application/pdf', 'standard'), false);
});

test('the toggle reads clearly', () => {
  assert.strictEqual(Q.qualityLabel('hd'), 'HD');
  assert.strictEqual(Q.qualityLabel('standard'), 'Standard');
});

// ── The web copy must not drift ─────────────────────────────────────────────
//
// public/js/imageQuality.js mirrors this module. If the two disagree, the same
// photo sent from a phone and from a browser comes out at different sizes and
// different quality, and nothing anywhere reports a problem.

const WEB = require(path.join(__dirname, '..', 'public', 'js', 'imageQuality.js'));

test('the web copy agrees on the limits', () => {
  assert.strictEqual(WEB.STANDARD_MAX_EDGE, Q.STANDARD_MAX_EDGE);
  assert.strictEqual(WEB.STANDARD_JPEG_QUALITY, Q.STANDARD_JPEG_QUALITY);
});

test('THE DRIFT CHECK: web and app resize identically', () => {
  const sizes = [
    [4032, 3024], [3024, 4032], [1600, 1200], [1601, 1200], [1200, 900],
    [8000, 100], [100, 8000], [1, 1], [0, 0], [-5, 10], [NaN, 100], [Infinity, 100],
  ];
  const bad = [];
  for (const [w, h] of sizes) {
    for (const q of ['standard', 'hd']) {
      const a = Q.resizeTarget(w, h, q), b = WEB.resizeTarget(w, h, q);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        bad.push(`resizeTarget(${w}, ${h}, ${q}): app=${JSON.stringify(a)} web=${JSON.stringify(b)}`);
      }
    }
  }
  assert.deepStrictEqual(bad, [], `resizing has drifted:\n      ${bad.join('\n      ')}`);
});

test('THE DRIFT CHECK: web and app agree on what is worth re-encoding', () => {
  const mimes = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml',
    'video/mp4', 'application/pdf', '', 'IMAGE/JPEG',
  ];
  for (const m of mimes) {
    for (const q of ['standard', 'hd']) {
      assert.strictEqual(WEB.shouldCompress(m, q), Q.shouldCompress(m, q), `${m} @ ${q}`);
    }
  }
});

test('THE DRIFT CHECK: web and app label the toggle identically', () => {
  for (const q of ['standard', 'hd']) {
    assert.strictEqual(WEB.qualityLabel(q), Q.qualityLabel(q));
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
