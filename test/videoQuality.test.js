// Tests for video send quality (native-app/src/videoQuality.ts).
//
// Two rules here fail in ways that are painful to diagnose on a device: an
// odd output dimension makes the H.264 encoder refuse the export (so the send
// just fails), and upscaling a small clip produces a bigger file for no gain.
// Both are pinned down here rather than found later.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'vqtest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'videoQuality.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping video-quality tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const V = require(path.join(OUT, 'videoQuality.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('there are three re-encoding choices plus the untouched original', () => {
  assert.strictEqual(V.VIDEO_PRESETS.length, 4);
  assert.deepStrictEqual(V.VIDEO_PRESETS.map(p => p.id), ['low', 'medium', 'high', 'original']);
  assert.strictEqual(V.presetFor('original').maxEdge, 0, 'the original must not be resized');
});

test('an unknown preset falls back to a sane one rather than crashing', () => {
  assert.ok(V.presetFor('nonsense').maxEdge > 0);
});

test('a 4K clip is scaled down to each preset\'s longest edge', () => {
  for (const [id, edge] of [['low', 854], ['medium', 1280], ['high', 1920]]) {
    const t = V.videoTarget(3840, 2160, id);
    assert.strictEqual(Math.max(t.width, t.height), edge, `${id} did not hit its longest edge`);
  }
});

test('output dimensions are always EVEN — odd sizes make H.264 refuse the export', () => {
  // Deliberately awkward sources, including odd and prime dimensions.
  const sources = [[3840, 2160], [1920, 1080], [4032, 3024], [1921, 1081], [2000, 1333], [3000, 1687]];
  for (const [w, h] of sources) {
    for (const id of ['low', 'medium', 'high']) {
      const t = V.videoTarget(w, h, id);
      if (!t) continue;
      assert.strictEqual(t.width % 2, 0, `odd width ${t.width} from ${w}x${h} at ${id}`);
      assert.strictEqual(t.height % 2, 0, `odd height ${t.height} from ${w}x${h} at ${id}`);
    }
  }
});

test('a dimension never rounds down to zero', () => {
  const t = V.videoTarget(4000, 3, 'low');
  assert.ok(t.width >= 2 && t.height >= 2, `got ${t.width}x${t.height}`);
});

test('the aspect ratio is kept, portrait and landscape alike', () => {
  for (const [w, h] of [[3840, 2160], [2160, 3840], [1440, 1080]]) {
    const t = V.videoTarget(w, h, 'medium');
    if (!t) continue;
    // Even-rounding moves it a little; a couple of percent is the tolerance.
    assert.ok(Math.abs(t.width / t.height - w / h) < 0.02,
      `aspect changed for ${w}x${h}: got ${t.width}x${t.height}`);
  }
});

test('a clip already smaller than the preset is left alone, never upscaled', () => {
  assert.strictEqual(V.videoTarget(640, 480, 'high'), null, 'a small clip was upscaled to 1080p');
  assert.strictEqual(V.videoTarget(1280, 720, 'medium'), null, 'a clip exactly at the limit was re-encoded');
  assert.strictEqual(V.videoTarget(854, 480, 'low'), null);
});

test('the original is never resized, whatever its size', () => {
  assert.strictEqual(V.videoTarget(3840, 2160, 'original'), null);
});

test('nonsense dimensions are refused rather than producing NaN', () => {
  for (const [w, h] of [[0, 0], [-10, 100], [NaN, 100], [Infinity, 100]]) {
    assert.strictEqual(V.videoTarget(w, h, 'medium'), null, `accepted ${w}x${h}`);
  }
});

test('trimming reports the seconds that will actually be sent', () => {
  assert.strictEqual(V.trimmedDuration(60, 10, 40), 30);
  assert.strictEqual(V.trimmedDuration(60, 0, 60), 60);
});

test('a trim range outside the clip is clamped, never negative', () => {
  assert.strictEqual(V.trimmedDuration(60, 50, 10), 0, 'end before start gave a negative duration');
  assert.strictEqual(V.trimmedDuration(60, -10, 90), 60, 'the range escaped the clip');
  assert.strictEqual(V.trimmedDuration(0, 0, 10), 0);
});

test('the size estimate scales with length and with quality', () => {
  const ten = V.estimateBytes('medium', 10);
  const twenty = V.estimateBytes('medium', 20);
  assert.ok(Math.abs(twenty - ten * 2) < 2, 'twice the length is not twice the size');
  assert.ok(V.estimateBytes('low', 10) < ten, '480p is not smaller than 720p');
  assert.ok(V.estimateBytes('high', 10) > ten, '1080p is not bigger than 720p');
  assert.strictEqual(V.estimateBytes('medium', 0), 0);
});

test('the original\'s estimate uses its REAL size, scaled by the trim', () => {
  // Guessing a bitrate for an untouched file would be wrong — its size is known.
  assert.strictEqual(V.estimateBytes('original', 30, 60_000_000, 60), 30_000_000);
  assert.strictEqual(V.estimateBytes('original', 60, 60_000_000, 60), 60_000_000);
  // Never reports MORE than the file actually is.
  assert.strictEqual(V.estimateBytes('original', 90, 60_000_000, 60), 60_000_000);
  assert.strictEqual(V.estimateBytes('original', 30, 0, 60), 0, 'invented a size for an unknown file');
});

test('durations read as mm:ss', () => {
  assert.strictEqual(V.fmtDuration(0), '0:00');
  assert.strictEqual(V.fmtDuration(9), '0:09');
  assert.strictEqual(V.fmtDuration(75), '1:15');
  assert.strictEqual(V.fmtDuration(600), '10:00');
  assert.strictEqual(V.fmtDuration(-5), '0:00');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
