// The video player: a seek bar that did nothing, a speed control that did not
// exist, and a download that froze the app.
//
// THE SEEK BAR. It failed for a reason invisible on the line that looks wrong.
// The gesture handler is built once —
//
//     const seekResponder = useRef(PanResponder.create({ … })).current;
//
// — so every handler inside closes over the FIRST render's variables. On the
// first render the video has not loaded, so `duration` is 0, and it stays 0
// inside those handlers for the life of the player. Dragging computed
// `fraction * 0`, the thumb reported zero wherever it was, and releasing
// seeked to the start.
//
// The file had been bitten by this once already: `scrubMs` is read through a
// ref, with a comment saying the responder closes over the first render's
// state. Only that one value was moved and `duration` was left behind — which
// is why the fix looked done and the bar still did nothing.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping video-control tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'vctl-'));
execFileSync(TSC, [path.join(NAT, 'src', 'videoControls.ts'), path.join(NAT, 'src', 'saveProgress.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const V = require(path.join(OUT, 'videoControls.js'));
const S = require(path.join(OUT, 'saveProgress.js'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Seeking ─────────────────────────────────────────────────────────────────

test('THE BUG: a duration of zero seeks nowhere, whatever is dragged', () => {
  // This is the state the responder was frozen in. Half way along a 300px bar
  // is 0ms when the duration is 0 — the arithmetic was right and the input was
  // stale, which is why nothing in the handler looked wrong.
  assert.strictEqual(V.msFromTouch(150, 300, 0), 0);
  // With a real duration the same drag is half way through the video.
  assert.strictEqual(V.msFromTouch(150, 300, 60000), 30000);
});

test('a touch maps to a position along the bar', () => {
  assert.strictEqual(V.msFromTouch(0, 200, 10000), 0);
  assert.strictEqual(V.msFromTouch(200, 200, 10000), 10000);
  assert.strictEqual(V.msFromTouch(50, 200, 10000), 2500);
});

test('dragging past either end stays inside the video', () => {
  // A finger leaving the bar reports an offset outside it.
  assert.strictEqual(V.msFromTouch(-40, 200, 10000), 0);
  assert.strictEqual(V.msFromTouch(999, 200, 10000), 10000);
});

test('a bar that has not been laid out yet does not divide by zero', () => {
  // Infinity or NaN as a seek target is either the end of the video or a
  // silent failure, and both look like the bar not working.
  assert.strictEqual(V.msFromTouch(50, 0, 10000), 0);
  assert.strictEqual(V.msFromTouch(50, undefined, 10000), 0);
  assert.ok(Number.isFinite(V.msFromTouch(50, 0, 10000)));
});

test('the thumb never draws past the end of its own bar', () => {
  // playableDurationMillis can briefly exceed the duration while buffering.
  assert.strictEqual(V.fraction(12000, 10000), 1);
  assert.strictEqual(V.fraction(-5, 10000), 0);
  assert.strictEqual(V.fraction(5000, 10000), 0.5);
  assert.strictEqual(V.fraction(5000, 0), 0);
});

test('a seek is clamped to the video', () => {
  // The ±10s buttons run off both ends on a short clip.
  assert.strictEqual(V.clampSeek(-10000, 5000), 0);
  assert.strictEqual(V.clampSeek(99000, 5000), 5000);
  assert.strictEqual(V.clampSeek(2500, 5000), 2500);
  assert.strictEqual(V.clampSeek(1000, 0), 0);
});

// ── Speed ───────────────────────────────────────────────────────────────────

test('THE FEATURE: tapping cycles the speed, and comes back round', () => {
  // Starts at 1 and speeds UP first: the reason people reach for a speed
  // control is usually to get through something faster.
  assert.strictEqual(V.SPEEDS[0], 1);
  assert.ok(V.nextSpeed(1) > 1, 'the first tap slows the video down');
  let r = 1;
  const seen = new Set([r]);
  for (let i = 0; i < V.SPEEDS.length; i++) { r = V.nextSpeed(r); seen.add(r); }
  assert.strictEqual(r, 1, 'cycling does not return to normal speed');
  assert.strictEqual(seen.size, V.SPEEDS.length, 'some speeds are unreachable');
});

test('every speed offered is one a person can listen to', () => {
  for (const r of V.SPEEDS) {
    assert.ok(r >= 0.5 && r <= 2, `${r}x is not usable speech`);
  }
});

test('an unrecognised rate steps back onto the list, not off the end', () => {
  assert.strictEqual(V.nextSpeed(3.7), V.SPEEDS[0]);
  assert.strictEqual(V.nextSpeed(undefined), V.SPEEDS[0]);
  assert.strictEqual(V.nextSpeed(null), V.SPEEDS[0]);
});

test('the label is short enough for a row of small controls', () => {
  assert.strictEqual(V.speedLabel(1), '1×');
  assert.strictEqual(V.speedLabel(1.5), '1.5×');
  for (const r of V.SPEEDS) assert.ok(V.speedLabel(r).length <= 5);
});

test('the control is not offered for something with no duration', () => {
  // A rate cannot be applied to a stream still loading, and a control that
  // does nothing teaches people it does nothing.
  assert.strictEqual(V.canChangeSpeed(0), false);
  assert.strictEqual(V.canChangeSpeed(undefined), false);
  assert.strictEqual(V.canChangeSpeed(1), true);
});

// ── The download that froze the app ─────────────────────────────────────────

test('THE FREEZE: progress does not redraw on every chunk', () => {
  // createDownloadResumable calls back once per network chunk — hundreds of
  // times a second on a large file — and every one re-rendered every
  // subscriber. The bytes arrived fine; the JavaScript thread had nothing left
  // for the taps, which is what "every other action is blocked" was.
  S._reset();
  let draws = 0;
  S.subscribe(() => { draws++; });
  S.begin(1);
  const drawsAfterBegin = draws;
  // 500 chunks inside a SINGLE frame — one timestamp, which is the shape of a
  // fast download arriving faster than the screen can refresh.
  const frame = 1_000_000;
  for (let i = 1; i <= 500; i++) S.report(i * 1000, 10_000_000, frame);
  assert.ok(draws - drawsAfterBegin <= 1,
    `${draws - drawsAfterBegin} redraws for 500 chunks in one instant — the thread is saturated`);
  S._reset();
});

test('…but it still redraws as the download goes on', () => {
  // Throttled, not disabled: a bar that never moves is its own bug.
  S._reset();
  let draws = 0;
  S.subscribe(() => { draws++; });
  S.begin(1);
  const base = draws;
  // Five seconds of download, one callback every 10ms.
  for (let t = 0; t <= 5000; t += 10) S.report(t * 100, 10_000_000, 2_000_000 + t);
  const drawn = draws - base;
  assert.ok(drawn >= 5000 / S.PROGRESS_EMIT_MS - 2,
    `only ${drawn} redraws over five seconds — the bar barely moves`);
  assert.ok(drawn <= 5000 / S.PROGRESS_EMIT_MS + 2,
    `${drawn} redraws over five seconds — more than the interval allows`);
  S._reset();
});

test('the last chunk always draws, so the bar reaches the end', () => {
  // Otherwise it can stop at 97% and sit there until the next file starts.
  S._reset();
  let last = null;
  S.subscribe(s => { last = s; });
  S.begin(1);
  S.report(1000, 1_000_000, 3_000_000);      // drawn: first chunk
  S.report(999_999, 1_000_000, 3_000_001);   // throttled away
  S.report(1_000_000, 1_000_000, 3_000_002); // complete — must draw
  assert.strictEqual(last.written, 1_000_000, 'the bar never reached 100%');
  S._reset();
});

test('the state is exact even when the redraw is skipped', () => {
  // Only the drawing is rationed; get() must never be stale, because the
  // cancel button and the overlay both read it.
  S._reset();
  S.begin(1);
  S.report(1, 100, 4_000_000);
  S.report(42, 100, 4_000_001); // throttled: not drawn
  assert.strictEqual(S.get().written, 42, 'the skipped redraw also skipped the truth');
  S._reset();
});

test('each file gets its own throttle', () => {
  // The first chunk of the second video must not be held back by the last
  // chunk of the first.
  S._reset();
  let draws = 0;
  S.subscribe(() => { draws++; });
  S.begin(2);
  S.report(10, 100, 5_000_000);
  const before = draws;
  S.advance(1);
  S.report(10, 100, 5_000_001); // one millisecond later, but a new file
  assert.ok(draws > before + 1, 'the new file waited out the previous one\'s throttle');
  S._reset();
});

test('a clock that jumps backwards does not stall the bar for ever', () => {
  assert.strictEqual(S.dueForEmit(0, 0), true, 'the very first report is held back');
  assert.strictEqual(S.dueForEmit(9_000_000, 1_000), true, 'a backwards clock freezes the bar');
  assert.strictEqual(S.dueForEmit(1_000, 1_000 + S.PROGRESS_EMIT_MS), true);
  assert.strictEqual(S.dueForEmit(1_000, 1_001), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const vp = fs.readFileSync(path.join(NAT, 'src', 'components', 'VideoPlayer.tsx'), 'utf8');

test('THE FIX: the seek handlers read the duration from a REF', () => {
  // Not from the closure. This is the whole bug: the responder is built once,
  // and anything it reads directly is frozen at the first render, where the
  // duration is 0.
  assert.ok(/const durationRef = useRef\(0\);/.test(vp), 'there is no duration ref');
  assert.ok(/durationRef\.current = duration;/.test(vp), 'the ref is never updated');
  const at = vp.indexOf('const seekResponder = useRef(');
  assert.ok(at > 0, 'the seek responder moved');
  const fn = vp.slice(at, vp.indexOf('if (!item) return null;'));
  assert.ok(fn.length > 200, 'the responder body is empty');
  assert.ok(/durationRef\.current/.test(fn),
    'the responder still reads `duration` from the render it was created in');
  // EVERY read must go through the ref, not just one of them. Checking that
  // `durationRef` appears somewhere passes while a second handler still reads
  // the frozen variable — which is exactly how the first attempt at this fix
  // moved `scrubMs` and left `duration` behind.
  const bare = fn.split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .filter(l => /\bduration\b(?!Ref)/.test(l));
  assert.deepStrictEqual(bare, [],
    `the responder still reads the frozen duration: ${bare.join(' | ').trim()}`);
});

test('…and so does the seek itself', () => {
  const at = vp.indexOf('function seekTo(');
  assert.ok(at > 0, 'seekTo moved');
  const fn = vp.slice(at, at + 260);
  assert.ok(/clampSeek\(ms, durationRef\.current\)/.test(fn),
    'seekTo clamps against a duration captured at first render, so it seeks to 0');
});

test('the speed control is wired to the player, not just to the rule', () => {
  assert.ok(/setRateAsync\(next, true\)/.test(vp),
    'the rate is never applied to the video, or applies it without pitch correction');
  assert.ok(/onPress=\{cycleSpeed\}/.test(vp), 'there is nothing to tap');
  assert.ok(/canChangeSpeed\(duration\)/.test(vp),
    'the control shows for a video with no duration, where it does nothing');
  assert.ok(/speedLabel\(rate\)/.test(vp), 'the label is written by hand');
});

// ── "Opening…" that never ends ──────────────────────────────────────────────
//
// Reported as: after downloading a video it sometimes sticks on opening and
// will not play until the app is closed and reopened — and the same happens to
// videos that were already downloaded.

test('A VIDEO IS OPEN WHEN IT IS LOADED, not when it starts playing', () => {
  // The bug. The player asked `positionMillis > 0 || isPlaying`, which is a
  // question about PLAYBACK. A video that loads fine but does not begin — the
  // audio focus is held elsewhere, the play call was refused, it is paused at
  // zero — looked exactly like one that never opened, so the spinner stayed
  // over a working picture for ever.
  assert.strictEqual(V.videoIsOpen({ isLoaded: true, isPlaying: false, positionMillis: 0 }), true,
    'a loaded video that has not started is still reported as not open');
  assert.strictEqual(V.videoIsOpen({ isLoaded: true, isPlaying: true, positionMillis: 400 }), true);
  assert.strictEqual(V.videoIsOpen({ isLoaded: false, error: 'boom' }), false);
  assert.strictEqual(V.videoIsOpen({ isLoaded: false }), false);
});

test('…and nothing else counts as open', () => {
  for (const st of [null, undefined, 'loaded', 42, {}, { isLoaded: 'yes' }, { isLoaded: 1 }]) {
    assert.strictEqual(V.videoIsOpen(st), false, JSON.stringify(st));
  }
});

test('THERE IS A WAY OUT if it really never opens', () => {
  // Without a deadline the spinner stays for the life of the screen: nothing
  // loaded, so nothing errored, so no Retry was ever offered. Killing the app
  // was the only exit, which is what was reported.
  assert.strictEqual(V.openTimedOut({ waitedMs: V.OPEN_TIMEOUT_MS }), true);
  assert.strictEqual(V.openTimedOut({ waitedMs: V.OPEN_TIMEOUT_MS - 1 }), false);
});

test('…but not once it has opened, or already failed', () => {
  // Firing after success would replace a playing video with an error screen.
  assert.strictEqual(V.openTimedOut({ ready: true, waitedMs: 999999 }), false);
  assert.strictEqual(V.openTimedOut({ failed: true, waitedMs: 999999 }), false);
});

test('the deadline is long enough for a big video on a slow line', () => {
  // Turning a legitimately slow load into a false failure would be its own
  // bug, and these connections are slow.
  assert.ok(V.OPEN_TIMEOUT_MS >= 15000, 'a slow but working load is called a failure');
  assert.ok(V.OPEN_TIMEOUT_MS <= 60000, 'a stuck video leaves the viewer waiting a minute');
});

test('a clock that cannot be read never fires the deadline', () => {
  for (const w of [null, undefined, NaN, 'x', {}]) {
    assert.strictEqual(V.openTimedOut({ waitedMs: w }), false, String(w));
  }
  assert.strictEqual(V.openTimedOut(null), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('THE PLAYER USES THE RULE, and the callback made for this', () => {
  assert.ok(/videoIsOpen\(st\)/.test(vp),
    'readiness is inferred from playback again, so a paused video reads as unopened');
  assert.ok(!/st\.positionMillis \|\| 0\) > 0 \|\| st\.isPlaying\) setReady/.test(vp),
    'the old playback-based test is back');
  // expo-av says explicitly when the first frame can be shown. Not using it
  // was why a loaded-but-paused video had nothing to announce itself with.
  assert.ok(/onReadyForDisplay=\{\(\) => setReady\(true\)\}/.test(vp),
    'the one callback that means "the picture is ready" is still unused');
});

test('FINISHING A VIDEO DOES NOT START THE NEXT ONE', () => {
  // Asked for. A video that runs on into the next one spends somebody's data
  // on something they did not choose to watch, and these connections are paid
  // for by the megabyte.
  assert.ok(!/didJustFinish/.test(vp),
    'the player advances to the next video by itself again');
  // The skip buttons stay: choosing the next one is not the same as being
  // given it.
  assert.ok(/hasNext && onSelect\(playlist\[index \+ 1\]\)/.test(vp),
    'the manual skip-forward button went with it');
  assert.ok(/hasPrev && onSelect\(playlist\[index - 1\]\)/.test(vp),
    'the manual skip-back button went with it');
});

test('…and gives up rather than spinning for ever', () => {
  assert.ok(/openTimedOut|OPEN_TIMEOUT_MS/.test(vp), 'there is still no way out of a stuck open');
  // Cleared, or the deadline fires into a video that opened perfectly.
  assert.ok(/clearTimeout/.test(vp), 'the deadline is never cancelled');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
