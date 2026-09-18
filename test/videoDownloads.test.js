// ── A video download must not freeze the app ────────────────────────────────
//
// Reported twice. The first time I fixed saveProgress — the GALLERY SAVE — and
// said the problem was solved. It was not the path the complaint was about.
// Tapping a video bubble goes through videoDownloads, which was still calling
// every subscriber on every network chunk.
//
// That is the trap this file exists for: the earlier fix was real, the reasoning
// in its comment was right, and it was applied to the wrong module. A test that
// only asked "is progress throttled somewhere" passed the whole time.
//
// So these tests name the FILE. There is no assertion here that can be
// satisfied by throttling something else.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const vid = fs.readFileSync(path.join(NAT, 'src', 'videoDownloads.ts'), 'utf8');
const upd = fs.readFileSync(path.join(NAT, 'src', 'appUpdate.ts'), 'utf8');
const save = fs.readFileSync(path.join(NAT, 'src', 'saveProgress.ts'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** The body of the progress callback passed to createDownloadResumable. */
function progressBody(src) {
  // Anchored on the CALL, not the first mention of the name — the comment
  // above it explains the throttle, so a looser search reads the explanation
  // and concludes the code does what the prose says.
  const at = src.indexOf('FileSystem.createDownloadResumable(');
  if (at < 0) return '';
  // Bounded at the end of the call, not by a character count: a window that
  // overruns picks up the emit() for the FINISHED download and reports it as a
  // per-chunk redraw, which is the opposite of the truth.
  const end = src.indexOf('tasks.set(key, task);', at);
  return src.slice(at, end < 0 ? at + 900 : end);
}

test('THE BUG: the video download does not redraw on every chunk', () => {
  // createDownloadResumable calls back once per network chunk — hundreds of
  // times a second on a large file. A bare emit() there re-renders every
  // subscribed bubble that often, and the thread has nothing left for taps.
  const body = progressBody(vid);
  assert.ok(body.length > 100, 'the video download moved');
  assert.ok(/emitProgress\(/.test(body),
    'the progress callback notifies subscribers directly, once per chunk');
  assert.ok(!/^\s*emit\(\);\s*$/m.test(body),
    'there is still a bare emit() in the progress callback');
});

test('…and it is THIS file that was fixed, not the gallery save again', () => {
  // The whole reason the bug survived a fix: saveProgress is a different
  // feature. Both must throttle, and this asserts the video one specifically.
  assert.ok(/dueForEmit/.test(vid),
    'videoDownloads does not use the throttle rule at all');
  assert.ok(/PROGRESS_EMIT_MS/.test(save), 'saveProgress lost its throttle');
});

test('the interval is defined once and imported, not copied', () => {
  // Two copies of "how often is too often" drift, and the second one is always
  // the one nobody remembers to change.
  assert.ok(/import \{ dueForEmit \} from '\.\/saveProgress'/.test(vid),
    'videoDownloads defines its own interval instead of sharing the rule');
  assert.ok(!/const PROGRESS_EMIT_MS|= 120/.test(vid),
    'the interval is written out a second time in videoDownloads');
});

test('the STATE is still written on every chunk, only the redraw is rationed', () => {
  // Throttling the state itself would make get() stale, and a screen that
  // reads it between redraws would show a number that is behind the file.
  const body = progressBody(vid);
  const setAt = body.indexOf('state.set(');
  const emitAt = body.indexOf('emitProgress(');
  assert.ok(setAt > -1 && emitAt > -1, 'the callback no longer records progress');
  assert.ok(setAt < emitAt,
    'progress is recorded after the throttle, so a skipped redraw loses the bytes with it');
});

test('the last chunk always draws, so the bar cannot stop at 97%', () => {
  const body = progressBody(vid);
  assert.ok(/emitProgress\(key, [^)]*>=[^)]*\)/.test(body),
    'nothing tells the throttle when the download is complete');
  const fn = vid.slice(vid.indexOf('function emitProgress'), vid.indexOf('function emitProgress') + 400);
  assert.ok(/if \(!complete &&/.test(fn),
    'a finished download is held back by the clock like any other chunk');
});

test('two downloads at once do not share one clock', () => {
  // A single module-level timestamp means the second video starves whenever
  // the first has just redrawn, and its bar sits still.
  assert.ok(/lastEmitAt = new Map/.test(vid),
    'the throttle clock is shared between every download in flight');
  assert.ok(/lastEmitAt\.get\(key\)/.test(vid) && /lastEmitAt\.set\(key/.test(vid),
    'the clock is not kept per download');
});

test('a new download does not inherit the last one\'s clock', () => {
  // Left behind, the first chunk of the next download is held back for no
  // reason — which is the moment the user is actually watching the bar.
  assert.ok(/lastEmitAt\.delete\(key\)/.test(vid),
    'the throttle clock is never reset, so a fresh download starts mid-interval');
});

test('finishing, failing and cancelling always redraw', () => {
  // These are one event each, not a stream, and a throttled terminal state
  // leaves the spinner up on a download that is over.
  const done = vid.slice(vid.indexOf("status: 'done'"), vid.indexOf("status: 'done'") + 200);
  assert.ok(/emit\(\)/.test(done), 'a finished download may not redraw');
  const cancel = vid.slice(vid.indexOf('export async function cancel'),
    vid.indexOf('export async function cancel') + 400);
  assert.ok(/emit\(\)/.test(cancel), 'a cancelled download may not redraw');
});

test('THE SAME BUG next door: the app update download is throttled too', () => {
  // Not reported, but it is the same callback shape with the same bare emit(),
  // so downloading an update froze the app in exactly the same way.
  const at = upd.indexOf('const onProgress');
  const body = upd.slice(at, at + 1200);
  assert.ok(at > -1 && /dueForEmit\(lastEmitAt/.test(body),
    'the app update still redraws on every chunk');
  assert.ok(/frac === 1 \|\|/.test(body),
    'the final frame of the update download can be thrown away by the clock');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
