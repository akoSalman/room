// Sending a video from the web: resolution, trim, and what a browser can
// actually do about either.
//
// Reported: "on ios web version sending video doesn't give user change
// resolution and trim options". The app has had both for a long time; the web
// staged a video as a grey 🎥 box and sent it whole — no preview, no size, no
// controls, so a 90MB clip went out with nothing said about it.
//
// The awkward part is that a page has no encoder. The only route is to play
// the clip into a canvas, capture that canvas and record it, which is REAL
// TIME and needs three separate APIs — and on iOS Safari one of them
// (captureStream on a media element) does not exist at all. So the honest
// answer differs per browser, and the point of the module under test is to say
// which answer applies here rather than showing controls that do nothing.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
require(path.join(ROOT, 'public', 'js', 'videoQuality.js'));   // WebVideo reads it
const V = require(path.join(ROOT, 'public', 'js', 'webVideo.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── What this browser can do ────────────────────────────────────────────────

test('THE BUG: iOS Safari cannot re-encode, and is not pretended otherwise', () => {
  // No captureStream on the media element — the case in the report.
  assert.strictEqual(V.canReencode({
    canvasCapture: true, mediaCapture: false, outputType: 'video/mp4',
  }), false);
});

test('a browser that can record only WebM is not used either', () => {
  // It would produce a smaller file that no iPhone in the chat can play, which
  // is worse than sending the original.
  assert.strictEqual(V.canReencode({
    canvasCapture: true, mediaCapture: true, outputType: '',
  }), false);
  assert.ok(V.OUTPUT_TYPES.every(t => t.startsWith('video/mp4')),
    'a format other than MP4 is accepted, and half the chat cannot play it');
});

test('a browser with all three pieces can', () => {
  assert.strictEqual(V.canReencode({
    canvasCapture: true, mediaCapture: true, outputType: 'video/mp4',
  }), true);
});

test('the recorder is asked what it supports, not assumed', () => {
  const asked = [];
  const Rec = { isTypeSupported: (t) => { asked.push(t); return t === 'video/mp4'; } };
  assert.strictEqual(V.outputType(Rec), 'video/mp4');
  assert.ok(asked.length >= 1, 'nothing was asked');
  assert.strictEqual(V.outputType({ isTypeSupported: () => false }), '');
  assert.strictEqual(V.outputType({}), '', 'a browser with no MediaRecorder claimed a format');
  // A recorder that throws on an odd codec string must not take the page down.
  assert.strictEqual(V.outputType({ isTypeSupported: () => { throw new Error('nope'); } }), '');
});

// ── What will happen when Send is pressed ───────────────────────────────────

const CLIP = { duration: 30, width: 1920, height: 1080, bytes: 60 * 1024 * 1024 };

test('THE BUG: with no re-encoder the clip is sent as it is, and says so', () => {
  const p = V.plan({ ...CLIP, quality: 'low', start: 5, end: 10, canReencode: false });
  assert.strictEqual(p.action, 'as-is');
  assert.strictEqual(p.seconds, 30, 'a trim was promised that cannot be carried out');
  assert.strictEqual(p.bytes, CLIP.bytes, 'the size shown is not the size that will be sent');
  assert.ok(/cannot re-encode/.test(p.why), `unexplained: "${p.why}"`);
});

test('a big clip at 720p is worth re-encoding, and the wait is stated', () => {
  const p = V.plan({ ...CLIP, quality: 'medium', canReencode: true });
  assert.strictEqual(p.action, 'reencode');
  assert.deepStrictEqual(p.target, { width: 1280, height: 720 });
  assert.ok(p.bytes < CLIP.bytes / 5, `estimate is ${p.bytes}`);
  // Real time, and nobody warned assumes it has hung.
  assert.ok(/Takes about/.test(p.why), `the wait is not mentioned: "${p.why}"`);
});

test('a trim is a re-encode too, even at Original', () => {
  // The range has to be played out and recorded; there is no other way to cut
  // a file in a page.
  const p = V.plan({ ...CLIP, quality: 'original', start: 2, end: 8, canReencode: true });
  assert.strictEqual(p.action, 'reencode');
  assert.strictEqual(p.trimmed, true);
  assert.strictEqual(p.seconds, 6);
});

test('a re-encode that would save nothing is refused, not sold', () => {
  // Half a minute of waiting for a 5% saving is a worse deal than sending it.
  const small = { duration: 8, width: 640, height: 480, bytes: 400 * 1024 };
  const p = V.plan({ ...small, quality: 'high', canReencode: true });
  assert.strictEqual(p.action, 'as-is');
  assert.ok(/as it is/.test(p.why), `unexplained: "${p.why}"`);
});

test('Original with no trim is simply sent', () => {
  const p = V.plan({ ...CLIP, quality: 'original', canReencode: true });
  assert.strictEqual(p.action, 'as-is');
  assert.strictEqual(p.bytes, CLIP.bytes);
});

test('a clip whose length is not known yet does not become a 0-second plan', () => {
  const p = V.plan({ duration: 0, bytes: 1024, quality: 'medium', canReencode: true });
  assert.strictEqual(p.action, 'as-is');
  assert.strictEqual(p.bytes, 1024);
});

// ── The trim handles ────────────────────────────────────────────────────────

test('the handles cannot cross, whichever one is dragged', () => {
  // A range of nothing records an empty file.
  const a = V.clampRange({ duration: 30, start: 20, end: 20, moved: 'end' });
  assert.ok(a.end - a.start >= 1, `${a.start}..${a.end}`);
  const b = V.clampRange({ duration: 30, start: 20, end: 20, moved: 'start' });
  assert.ok(b.end - b.start >= 1, `${b.start}..${b.end}`);
  assert.ok(b.start < b.end);
  // Dragging start past end moves START, not end: the handle under the finger
  // is the one that must obey.
  const c = V.clampRange({ duration: 30, start: 25, end: 10, moved: 'start' });
  assert.strictEqual(c.end, 10);
  assert.ok(c.start <= 9);
});

test('a range outside the clip is pulled back inside it', () => {
  const r = V.clampRange({ duration: 12, start: -5, end: 99 });
  assert.deepStrictEqual(r, { start: 0, end: 12 });
});

test('a clip shorter than the minimum range still works', () => {
  const r = V.clampRange({ duration: 0.6, start: 0, end: 0.6 });
  assert.ok(r.start >= 0 && r.end <= 0.6 && r.end >= r.start);
});

test('sizes are readable, and nothing is "0 B"', () => {
  assert.strictEqual(V.humanSize(0), '');
  assert.strictEqual(V.humanSize(900), '900 B');
  assert.strictEqual(V.humanSize(5 * 1024), '5 KB');
  assert.strictEqual(V.humanSize(3.4 * 1024 * 1024), '3.4 MB');
  assert.strictEqual(V.humanSize(90 * 1024 * 1024), '90 MB');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('a staged video shows what it is and what it will cost', () => {
  const fn = app.slice(app.indexOf('function renderPendingFiles('),
    app.indexOf('function renderPendingFiles(') + 2600);
  assert.ok(/pending-video/.test(fn), 'a video is still a grey box with no preview');
  assert.ok(/WebVideo\.humanSize\(/.test(fn), 'the size is not shown, which was the complaint');
  assert.ok(/pending-cog/.test(fn) && /openVideoSheet\(p\.file\)/.test(fn),
    'there is nothing to press to reach the options');
});

test('the sheet exists, and hides what this browser cannot do', () => {
  assert.ok(/id="video-modal"/.test(html), 'there is no video sheet');
  assert.ok(/id="video-chips"/.test(html) && /id="video-trim-start"/.test(html),
    'the sheet has no resolution or trim controls');
  const fn = app.slice(app.indexOf('function renderVideoSheet('),
    app.indexOf('function onTrimInput('));
  assert.ok(fn.length > 200, 'renderVideoSheet moved');
  assert.ok(/WebVideo\.canReencode\(\)/.test(fn), 'the sheet decides for itself what is possible');
  // BOTH sections: the resolution chips and the trim handles are equally
  // impossible without a re-encoder, and leaving either one on screen is the
  // iOS case in the report.
  assert.strictEqual((fn.match(/classList\.toggle\('hidden', !can\)/g) || []).length, 2,
    'one of the two sections is shown on a browser that cannot do it');
  assert.ok(/video-quality-section/.test(fn) && /video-trim-section/.test(fn),
    'the sections are not the ones being hidden');
  assert.ok(/plan\.why/.test(fn), 'nothing explains why the controls are missing');
  assert.ok(/VideoQuality\.VIDEO_PRESETS/.test(fn), 'the chips are hand-built and can drift from the app');
});

test('the chosen options are actually applied before sending', () => {
  const fn = app.slice(app.indexOf('const prepared = Promise.all('),
    app.indexOf('const prepared = Promise.all(') + 800);
  assert.ok(/encodeVideoForSend\(p\.file/.test(fn),
    'the sheet changes nothing — the original file is uploaded whatever was chosen');
  const enc = app.slice(app.indexOf('async function encodeVideoForSend('),
    app.indexOf('async function encodeVideoForSend(') + 3000);
  assert.ok(/WebVideo\.plan\(\{/.test(enc), 'the encoder decides for itself what to do');
  assert.ok(/if \(plan\.action !== 'reencode' \|\| !type\) return file;/.test(enc),
    'a browser that cannot re-encode still tries, and the send fails');
  assert.ok(/catch \{\s*return file;/.test(enc),
    'a failed re-encode loses the video instead of sending the original');
  assert.ok(/getAudioTracks\(\)/.test(enc), 'the re-encoded clip would arrive silent');
  assert.ok(/blob\.size >= file\.size\)\) return file;/.test(enc),
    'a re-encode that came out bigger is sent anyway');
  // …except when it was trimmed, where a shorter clip is the point whatever
  // it weighs.
  assert.ok(/!plan\.trimmed && blob\.size >= file\.size/.test(enc),
    'a trimmed clip is thrown away whenever the re-encode did not also shrink it');
});

test('the wait is visible while it happens', () => {
  assert.ok(/id="video-progress"/.test(html), 'nothing is shown during a real-time re-encode');
  assert.ok(/encodeVideoForSend\(p\.file, showVideoProgress\)/.test(app),
    'the progress bar is never fed');
  assert.ok(/hideVideoProgress\(\)/.test(app), 'the bar stays on screen after the send');
});

test('the page loads both rule files, before app.js', () => {
  for (const f of ['videoQuality.js', 'webVideo.js']) {
    assert.ok(html.includes(`/js/${f}`), `${f} is never loaded`);
    assert.ok(html.indexOf(f) < html.indexOf('js/app.js'), `${f} loads after the code that uses it`);
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
