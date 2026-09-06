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

test('re-encoding is skipped when it would not actually help', () => {
  // Transcoding is slow; doing it for no size gain is the worst outcome.
  const size = { width: 1920, height: 1080 };
  // A 30s clip already compressed to 2 MB — 720p would not beat that by much.
  assert.strictEqual(V.shouldTranscode('medium', 2_000_000, 30, size), false,
    'a clip that is already small was re-encoded anyway');
  // A 30s clip straight off a camera at 60 MB is well worth shrinking.
  assert.strictEqual(V.shouldTranscode('medium', 60_000_000, 30, size), true);
  // Original never transcodes.
  assert.strictEqual(V.shouldTranscode('original', 60_000_000, 30, size), false);
  // Already below the target resolution: nothing to gain.
  assert.strictEqual(V.shouldTranscode('high', 60_000_000, 30, { width: 640, height: 480 }), false,
    'a clip smaller than the preset was re-encoded');
  // Unknown size is not a reason to skip.
  assert.strictEqual(V.shouldTranscode('medium', 0, 30, size), true);
  assert.strictEqual(V.shouldTranscode('medium', 60_000_000, 0, size), false);
});

test('durations read as mm:ss', () => {
  assert.strictEqual(V.fmtDuration(0), '0:00');
  assert.strictEqual(V.fmtDuration(9), '0:09');
  assert.strictEqual(V.fmtDuration(75), '1:15');
  assert.strictEqual(V.fmtDuration(600), '10:00');
  assert.strictEqual(V.fmtDuration(-5), '0:00');
});

// ── Why re-encoding was so slow ─────────────────────────────────────────────
//
// Reported as: "still processing videos for lower resolutions takes too long."
//
// The native encoder reports progress from inside its decode → draw → encode
// loop, once per FRAME. Unthrottled, every one of those crossed the bridge and
// woke JavaScript on the same CPU that was trying to encode the video: the app
// spent the phone's processor telling itself how slowly it was going.

/** How many progress events the native side emits, given a divider. */
function eventsEmitted(frames, divider) {
  // Mirrors the native rule: emit when the rounded percentage is a multiple of
  // the divider and has moved on. A divider of 0 means emit every time.
  let last = -1, count = 0;
  for (let i = 1; i <= frames; i++) {
    const pct = Math.round((i / frames) * 100);
    if (divider === 0 || (pct % divider === 0 && pct > last)) { count++; last = pct; }
  }
  return count;
}

test('THE BUG: progress is not reported once per frame', () => {
  const frames = 30 * 30;   // a thirty-second clip at thirty frames a second
  assert.strictEqual(eventsEmitted(frames, 0), frames,
    'the unthrottled rule should emit per frame — the test model is wrong');
  const throttled = eventsEmitted(frames, V.PROGRESS_DIVIDER);
  assert.ok(throttled <= 25,
    `${throttled} progress events for a 30s clip; per-frame reporting is the bug`);
  assert.ok(throttled >= 10,
    `${throttled} events is too few for a bar that should look smooth`);
});

test('the divider still lets the bar reach both ends', () => {
  // A divider that does not divide 100 would stop short of full.
  assert.strictEqual(100 % V.PROGRESS_DIVIDER, 0,
    'the bar would never report 100% with this divider');
});

// ── The web's copy ──────────────────────────────────────────────────────────
//
// Reported: "on ios web version sending video doesn't give user change
// resolution and trim options". The web now offers both where the browser can
// do them, which means it needs the same arithmetic — and a clip must not come
// out at one size from the app and another from the web.

global.window = global;
const W = require(path.join(__dirname, '..', 'public', 'js', 'videoQuality.js'));

test('the web and the app pick the same size for the same clip', () => {
  const sizes = [[1920, 1080], [3840, 2160], [1080, 1920], [640, 480], [854, 480],
    [1281, 720], [0, 0], [1, 1], [2160, 3840]];
  let checked = 0;
  for (const [w, h] of sizes) {
    for (const q of ['low', 'medium', 'high', 'original']) {
      assert.deepStrictEqual(W.videoTarget(w, h, q), V.videoTarget(w, h, q),
        `target diverges for ${w}x${h} at ${q}`);
      checked++;
    }
  }
  assert.deepStrictEqual(W.VIDEO_PRESETS, JSON.parse(JSON.stringify(V.VIDEO_PRESETS)));
  assert.strictEqual(checked, sizes.length * 4, 'the drift check did not actually run');
});

test('…and the same estimate, duration and decision', () => {
  let checked = 0;
  for (const secs of [0, 0.5, 6, 30, 125, 3600]) {
    for (const q of ['low', 'medium', 'high', 'original']) {
      assert.strictEqual(W.estimateBytes(q, secs, 5e6, 60), V.estimateBytes(q, secs, 5e6, 60),
        `estimate diverges at ${q}/${secs}`);
      assert.strictEqual(W.shouldTranscode(q, 5e6, secs, { width: 1920, height: 1080 }),
        V.shouldTranscode(q, 5e6, secs, { width: 1920, height: 1080 }));
      checked++;
    }
    assert.strictEqual(W.fmtDuration(secs), V.fmtDuration(secs));
    assert.strictEqual(W.trimmedDuration(secs, 1, 4), V.trimmedDuration(secs, 1, 4));
  }
  assert.strictEqual(checked, 24, 'the drift check did not actually run');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
