// Thumbnails without a native image library
// (thumbScale.js, thumbnailer.js, thumbWorker.js, server.js).
//
// bistbarg cannot run sharp, and no version of sharp fixes it. Two walls,
// both measured on the machine:
//
//   THE CPU. "Common KVM processor", with no popcnt, sse3, ssse3, sse4_1 or
//   sse4_2 — instructions from 2004, so a hypervisor is presenting a generic
//   baseline model rather than genuinely old hardware. sharp 0.33+ needs
//   x86-64-v2; its WebAssembly fallback needs SIMD, which V8 will not enable
//   without SSE4.1.
//
//   THE NETWORK. sharp 0.32.6, the last release under that baseline, fetches
//   a libvips tarball from GitHub at install time: "Installation error:
//   aborted". GitHub downloads are blocked or throttled from these networks,
//   which is why this app proxies its map tiles and runs its own STUN.
//
// So 1336 JPEGs averaging 550 KB are sent at full size, to people on metered
// connections, on every view. A 400px thumbnail of the same photo is ~5 KB.
//
// jimp was tested on the machine and works — 4000x3000 to 400x400 in 3.6
// seconds — and brings 91 packages to a server that has nine, over the same
// throttled link that just killed sharp's install. jpeg-js is one package
// with no dependencies, and the resizing it does not do is below, where it
// can be tested exactly instead of eyeballed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const scale = require(path.join(ROOT, 'thumbScale'));
const thumbnailer = require(path.join(ROOT, 'thumbnailer'));
const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const srvCode = code(srv);

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** An RGBA image where every pixel's red channel encodes its x position. */
function ramp(w, h) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = x; d[i + 1] = y; d[i + 2] = 0; d[i + 3] = 255;
    }
  }
  return d;
}

/** A solid colour. */
function solid(w, h, r, g, b, a = 255) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
  return d;
}

// ── THE CROP ────────────────────────────────────────────────────────────────

test('a square crop is taken from the centre', () => {
  // fit: 'cover', the same framing the sharp path produces, so a server with
  // sharp and a server without do not show different pictures.
  assert.deepStrictEqual(scale.coverBox(100, 60), { sx: 20, sy: 0, side: 60 });
  assert.deepStrictEqual(scale.coverBox(60, 100), { sx: 0, sy: 20, side: 60 });
  assert.deepStrictEqual(scale.coverBox(80, 80), { sx: 0, sy: 0, side: 80 });
});

test('an odd difference does not read past the edge', () => {
  // Floor, not round. Rounding (101-60)/2 = 20.5 up to 21 would start the
  // crop at 21 and run to 81 on a 101-wide image… which is fine, but on the
  // other parity it reads one column beyond the right edge.
  const b = scale.coverBox(101, 60);
  assert.strictEqual(b.sx, 20);
  assert.ok(b.sx + b.side <= 101, 'the crop runs past the right edge');
  const c = scale.coverBox(60, 101);
  assert.ok(c.sy + c.side <= 101, 'the crop runs past the bottom edge');
});

test('a nonsense size gives null rather than a crop', () => {
  for (const [w, h] of [[0, 10], [10, 0], [-5, 10], [NaN, 10], ['x', 10], [null, 5]]) {
    assert.strictEqual(scale.coverBox(w, h), null, `${w}x${h} must not produce a box`);
  }
});

// ── THE SCALING ─────────────────────────────────────────────────────────────

test('a solid colour stays exactly that colour', () => {
  // The simplest check that the averaging is right: any weighting error, any
  // off-by-one in the box, shows up as a changed value or a black edge.
  const out = scale.squareThumb(solid(64, 64, 10, 200, 30), 64, 64, 8);
  assert.strictEqual(out.length, 8 * 8 * 4);
  for (let i = 0; i < out.length; i += 4) {
    assert.strictEqual(out[i], 10, `red wrong at byte ${i}`);
    assert.strictEqual(out[i + 1], 200, `green wrong at byte ${i}`);
    assert.strictEqual(out[i + 2], 30, `blue wrong at byte ${i}`);
    assert.strictEqual(out[i + 3], 255, `alpha wrong at byte ${i}`);
  }
});

test('IT AVERAGES, rather than sampling one pixel in a hundred', () => {
  // The reason this is a box filter and not three lines of nearest
  // neighbour. On a left-to-right ramp each output pixel must land on the
  // MEAN of the column it covers, not on whichever single pixel the rounding
  // happened to pick — that difference is what makes a downscaled photo look
  // speckled.
  const w = 8, h = 8;
  const out = scale.squareThumb(ramp(w, h), w, h, 4);   // each output = 2x2 box
  // Output column 0 covers source x 0 and 1, so red = (0+1)/2 = 0.5 -> 0.
  // Column 1 covers 2 and 3 -> 2.5 -> 2. Column 2: 4.5 -> 4. Column 3: 6.5 -> 6.
  const red = x => out[(0 * 4 + x) * 4];
  assert.deepStrictEqual([red(0), red(1), red(2), red(3)], [0, 2, 4, 6]);
  // Nearest-neighbour would have given 0,2,4,6 for this ramp too, so the real
  // check is a hard edge: half black, half white, down to ONE pixel. Sampling
  // gives black or white; averaging gives grey, and only one of those is
  // what a thumbnail of a half-dark photo should look like.
  //
  // A 2x2 rather than the 4x1 this first used — a 4x1 has no square crop, so
  // the hand-made rect read three rows that did not exist and came back
  // black. The assertion was right and the input was impossible.
  const edge = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < 4; i++) {
    const o = i * 4;
    const white = (i % 2) === 1;          // left column black, right white
    edge[o] = edge[o + 1] = edge[o + 2] = white ? 255 : 0;
    edge[o + 3] = 255;
  }
  const one = scale.squareThumb(edge, 2, 2, 1);
  assert.ok(one[0] > 100 && one[0] < 155,
    `averaging two black and two white pixels should be about grey, got ${one[0]}`);
  assert.strictEqual(one[3], 255, 'alpha was averaged away');
  // And a crop that does not fit its image is refused rather than read.
  assert.strictEqual(scale.boxScale(edge, 2, { sx: 0, sy: 0, side: 4 }, 1), null);
  assert.strictEqual(scale.boxScale(edge, 2, { sx: -1, sy: 0, side: 2 }, 1), null);
});

test('UPSCALING DOES NOT DIVIDE BY ZERO', () => {
  // When the source is smaller than the thumbnail the box collapses: both
  // edges land on the same pixel, the loop runs zero times, and the mean is
  // 0/0. That writes transparent black — a thumbnail that is an empty square
  // — for every image smaller than the size asked for, which on a chat server
  // is every sticker and every tiny avatar.
  const out = scale.squareThumb(solid(4, 4, 90, 120, 150), 4, 4, 16);
  assert.strictEqual(out.length, 16 * 16 * 4);
  for (let i = 0; i < out.length; i += 4) {
    assert.strictEqual(out[i], 90, 'an upscaled pixel came out black');
    assert.strictEqual(out[i + 3], 255, 'an upscaled pixel came out transparent');
  }
});

test('a truncated image is refused, not averaged with whatever follows it', () => {
  // A decoder that returned fewer bytes than its header promised would
  // otherwise have the rest of the heap read as pixels.
  const short = new Uint8Array(10 * 10 * 4 - 20);
  assert.strictEqual(scale.squareThumb(short, 10, 10, 4), null);
  assert.strictEqual(scale.squareThumb(null, 10, 10, 4), null);
  assert.strictEqual(scale.squareThumb(solid(8, 8, 1, 2, 3), 8, 8, 0), null);
});

test('END TO END through a real JPEG', () => {
  // The unit tests above all work on arrays this file made. This one encodes
  // a real JPEG, decodes it the way the worker does, scales it, and encodes
  // again — so the decoder's actual output shape, which is the thing not
  // under this file's control, is exercised too.
  let jpeg;
  try { jpeg = require('jpeg-js'); }
  catch { console.log('      (jpeg-js not installed — skipping the round trip)'); return; }
  const W = 240, H = 160;
  const src = jpeg.encode({ data: Buffer.from(solid(W, H, 20, 140, 220)), width: W, height: H }, 90);
  const img = jpeg.decode(src.data, { useTArray: true, maxMemoryUsageInMB: 64 });
  assert.strictEqual(img.width, W);
  assert.strictEqual(img.height, H);
  const thumb = scale.squareThumb(img.data, img.width, img.height, 48);
  assert.ok(thumb && thumb.length === 48 * 48 * 4);
  const out = jpeg.encode({ data: Buffer.from(thumb), width: 48, height: 48 }, 72);
  assert.ok(out.data.length > 100, 'the encoder produced nothing');
  // A 48x48 thumbnail must be far smaller than the original — the whole point.
  assert.ok(out.data.length < src.data.length,
    `the thumbnail (${out.data.length}B) is not smaller than the source (${src.data.length}B)`);
  // And the colour survived the round trip, within JPEG's tolerance.
  const back = jpeg.decode(out.data, { useTArray: true, maxMemoryUsageInMB: 64 });
  const mid = ((24 * 48) + 24) * 4;
  assert.ok(Math.abs(back.data[mid] - 20) < 12
         && Math.abs(back.data[mid + 1] - 140) < 12
         && Math.abs(back.data[mid + 2] - 220) < 12,
    `the colour changed: ${back.data[mid]},${back.data[mid + 1]},${back.data[mid + 2]}`);
});

// ── THE QUEUE ───────────────────────────────────────────────────────────────

test('the same thumbnail is not queued twice', () => {
  // A gallery opening sends a burst for the same few files, each missing the
  // cache until the work is done. Without this, one photo is rebuilt once per
  // view that arrives before the first finishes.
  thumbnailer._reset();
  const seen = [];
  thumbnailer._setRunner(job => { seen.push(job.out); return new Promise(() => {}); });
  try {
    assert.strictEqual(thumbnailer.queue('a.jpg', 'out/a_200.jpg', 200), true);
    assert.strictEqual(thumbnailer.queue('a.jpg', 'out/a_200.jpg', 200), false);
    assert.strictEqual(thumbnailer.queue('a.jpg', 'out/a_400.jpg', 400), true,
      'a different SIZE of the same photo is a different thumbnail');
    assert.strictEqual(seen.length, 1, 'more than one ran at once');
  } finally { thumbnailer._setRunner(null); thumbnailer._reset(); }
});

test('ONE AT A TIME, on the CPU that is the problem in the first place', async () => {
  thumbnailer._reset();
  let active = 0, peak = 0;
  const release = [];
  thumbnailer._setRunner(() => {
    active++; peak = Math.max(peak, active);
    return new Promise(res => release.push(() => { active--; res({ ok: true }); }));
  });
  try {
    for (let i = 0; i < 5; i++) thumbnailer.queue(`s${i}.jpg`, `o${i}.jpg`, 200);
    assert.strictEqual(peak, 1, `${peak} workers ran at once on a one-at-a-time queue`);
    assert.strictEqual(thumbnailer._state().queued, 4);
  } finally {
    release.forEach(f => f());
    // Settle before resetting: these resolve on a later microtask, and a
    // reset in between is exactly the case the generation guard covers.
    await new Promise(r => setTimeout(r, 10));
    thumbnailer._setRunner(null); thumbnailer._reset();
  }
});

test('the queue is bounded, and dropping is the safe answer', () => {
  // A queue that grows with every missed view would still be working through
  // a gallery somebody closed ten minutes ago while new views wait behind it.
  // Dropping costs nothing: the next request queues it again, and that
  // request was being served the original anyway.
  thumbnailer._reset();
  thumbnailer._setRunner(() => new Promise(() => {}));
  try {
    let accepted = 0;
    for (let i = 0; i < thumbnailer.MAX_QUEUE + 20; i++) {
      if (thumbnailer.queue(`s${i}.jpg`, `o${i}.jpg`, 200)) accepted++;
    }
    assert.ok(accepted <= thumbnailer.MAX_QUEUE + thumbnailer.CONCURRENCY,
      `${accepted} jobs accepted with a cap of ${thumbnailer.MAX_QUEUE}`);
    assert.ok(accepted >= thumbnailer.MAX_QUEUE, 'the cap is far below what it claims');
  } finally { thumbnailer._setRunner(null); thumbnailer._reset(); }
});

test('a finished job frees its slot, and a failed one does too', async () => {
  // A worker that throws must not hold the only slot for ever, or one bad
  // image stops every thumbnail on the server.
  thumbnailer._reset();
  let n = 0;
  thumbnailer._setRunner(() => {
    n++;
    return n === 1 ? Promise.reject(new Error('bad image')) : Promise.resolve({ ok: true });
  });
  try {
    thumbnailer.queue('a.jpg', 'a_200.jpg', 200);
    thumbnailer.queue('b.jpg', 'b_200.jpg', 200);
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(n, 2, 'the second job never ran after the first failed');
    assert.deepStrictEqual(thumbnailer._state(), { queued: 0, running: 0, claimed: 0 });
  } finally { thumbnailer._setRunner(null); thumbnailer._reset(); }
});

test('A RESET DOES NOT LEAVE THE COUNTER NEGATIVE', async () => {
  // _reset cannot un-start a worker that is already running. Its completion
  // then decrements a counter that was already zeroed, and `running` goes
  // negative — after which the concurrency limit means nothing at all,
  // because running < CONCURRENCY stays true however many workers are live.
  thumbnailer._reset();
  let finish;
  thumbnailer._setRunner(() => new Promise(res => { finish = res; }));
  try {
    thumbnailer.queue('a.jpg', 'a_200.jpg', 200);
    assert.strictEqual(thumbnailer._state().running, 1);
    thumbnailer._reset();                 // the job is still in flight
    finish({ ok: true });                 // …and now it finishes
    await new Promise(r => setTimeout(r, 10));
    const st = thumbnailer._state();
    assert.ok(st.running >= 0, `running went to ${st.running}`);
    assert.deepStrictEqual(st, { queued: 0, running: 0, claimed: 0 });
  } finally { thumbnailer._setRunner(null); thumbnailer._reset(); }
});

test('nonsense is refused without reaching a worker', () => {
  thumbnailer._reset();
  let ran = 0;
  thumbnailer._setRunner(() => { ran++; return Promise.resolve({ ok: true }); });
  try {
    for (const [src, out, size] of [
      ['', 'o.jpg', 200], ['s.jpg', '', 200], [null, 'o.jpg', 200],
      ['s.jpg', 'o.jpg', 0], ['s.jpg', 'o.jpg', -4], ['s.jpg', 'o.jpg', 'big'],
    ]) assert.strictEqual(thumbnailer.queue(src, out, size), false,
      `queue(${JSON.stringify([src, out, size])}) should be refused`);
    assert.strictEqual(ran, 0);
  } finally { thumbnailer._setRunner(null); thumbnailer._reset(); }
});

// ── THE WIRING ──────────────────────────────────────────────────────────────

test('THE REQUEST STILL ANSWERS AT ONCE', () => {
  // The whole design. 3.6 seconds was measured for a 4000x3000 photo on the
  // machine this is for, and three and a half seconds inside a request
  // handler would stall every socket on the server — no messages, no call
  // signalling, no presence — for the duration. So the route queues and
  // redirects, exactly as it did before, and the NEXT view is the fast one.
  const r = srvCode.slice(srvCode.indexOf("app.get('/thumb/:name'"));
  const block = r.slice(0, r.indexOf('getSharp();') + 400);
  assert.match(block, /thumbnailer\.queue\(src, out, width\)/,
    'the no-sharp path still never builds a thumbnail');
  const q = block.indexOf('thumbnailer.queue(');
  const ret = block.indexOf('return original();', q);
  assert.ok(q > 0 && ret > q, 'the redirect no longer follows the queue call');
  assert.doesNotMatch(block, /await thumbnailer/,
    'the request waits for the thumbnail, which is the thing being avoided');
});

test('the worker runs off the event loop', () => {
  const w = code(fs.readFileSync(path.join(ROOT, 'thumbWorker.js'), 'utf8'));
  assert.match(w, /require\('worker_threads'\)/,
    'the thumbnail work is not on a worker thread');
  // A hostile or malformed JPEG must not be able to ask the decoder for
  // gigabytes; this runs on whatever anybody uploads.
  assert.match(w, /maxMemoryUsageInMB/, 'the decoder has no memory cap');
  // Written beside the target and renamed, so a reader never opens a file
  // that is half written.
  assert.match(w, /renameSync/, 'the thumbnail is written in place');
});

test('a runaway worker cannot hold the only slot for ever', () => {
  const t = code(fs.readFileSync(path.join(ROOT, 'thumbnailer.js'), 'utf8'));
  assert.match(t, /terminate\(\)/, 'nothing stops a worker that never finishes');
  assert.match(t, /setTimeout\(/);
});

(async () => {
  let failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ok  ${n}`); }
    catch (e) { failed++; console.log(`  FAIL ${n}\n       ${e.message}`); }
  }
  if (failed) { console.log(`\n  ${failed} thumb-scale test(s) failed`); process.exit(1); }
  console.log(`  ${tests.length} thumb-scale tests passed`);
})();
