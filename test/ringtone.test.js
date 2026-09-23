// ── "The call ringtone is too much sharp" ───────────────────────────────────
//
// Measured before it was changed, because "softer" is otherwise a matter of
// opinion and the next person to touch this file will have a different one:
//
//     old ring.wav   centroid 1989 Hz   11.2% of energy above 2 kHz
//                    strongest partials 1314, 1760 and 5281 Hz
//
// A spectral centroid near 2 kHz sits in the band the ear is most sensitive
// to, and a 5.3 kHz partial on top is what "sharp" means. The replacement is
// a soft bell with nothing above 1.6 kHz in it at all.
//
// These thresholds exist so that a future ringtone — dropped in by someone who
// has not read any of this — cannot quietly be a bright one again. The numbers
// are deliberately loose: they rule out a piercing tone, not a tasteful one.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RING = path.join(__dirname, '..', 'native-app', 'assets', 'ring.wav');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** Read a 16-bit mono PCM wav into samples. Enough for our own assets. */
function readWav(file) {
  const b = fs.readFileSync(file);
  assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF', `${file} is not a RIFF file`);
  assert.strictEqual(b.toString('ascii', 8, 12), 'WAVE');
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = { channels: b.readUInt16LE(pos + 10), rate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
    } else if (id === 'data') {
      data = b.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  assert.ok(fmt && data, `${file} has no fmt/data chunk`);
  assert.strictEqual(fmt.bits, 16, 'expected 16-bit PCM');
  const n = Math.floor(data.length / 2 / fmt.channels);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2 * fmt.channels);
  return { samples: out, rate: fmt.rate, channels: fmt.channels };
}

/** Iterative radix-2 FFT, so this test needs no dependency to measure pitch. */
function fftMag(re) {
  const N = re.length;
  const im = new Float64Array(N);
  const x = Float64Array.from(re);
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [x[i], x[j]] = [x[j], x[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = x[i + k], ui = im[i + k];
        const vr = x[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = x[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        x[i + k] = ur + vr; im[i + k] = ui + vi;
        x[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mag = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(x[i], im[i]);
  return mag;
}

/** Spectral centroid and the share of energy above 2 kHz, at the loudest spot. */
function brightness(file) {
  const { samples, rate } = readWav(file);
  const N = 8192;
  // Measured where the sound actually IS. A window landing in a gap between
  // phrases would measure silence and pass anything.
  let best = 0, bestAt = 0;
  for (let s = 0; s + N < samples.length; s += N / 2) {
    let e = 0;
    for (let i = 0; i < N; i++) e += samples[s + i] * samples[s + i];
    if (e > best) { best = e; bestAt = s; }
  }
  const seg = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    seg[i] = samples[bestAt + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  }
  const mag = fftMag(seg);
  let sum = 0, weighted = 0, above = 0;
  for (let i = 0; i < mag.length; i++) {
    const f = i * rate / N;
    sum += mag[i];
    weighted += mag[i] * f;
    if (f > 2000) above += mag[i];
  }
  return { centroid: weighted / sum, aboveShare: above / sum, rate };
}

test('THE RING IS NOT SHARP', () => {
  // The old one measured 1989 Hz. Anything close to that is the bug again.
  const b = brightness(RING);
  assert.ok(b.centroid < 1100,
    `spectral centroid is ${Math.round(b.centroid)} Hz — the ringtone is bright again `
    + '(the one reported as "too much sharp" measured 1989 Hz)');
});

test('…and has almost nothing in the band that hurts', () => {
  // 2–5 kHz is where the ear canal resonates and where the old ring put a
  // ninth of its energy, including a partial at 5.3 kHz.
  const b = brightness(RING);
  assert.ok(b.aboveShare < 0.04,
    `${(b.aboveShare * 100).toFixed(1)}% of its energy is above 2 kHz (the sharp one had 11.2%)`);
});

test('BUT IT IS STILL A RINGTONE', () => {
  // Soft must not mean inaudible. A ringtone nobody hears is a worse bug than
  // one that is too bright, and "make it softer" is easy to overshoot.
  const { samples } = readWav(RING);
  let peak = 0, sq = 0;
  for (const v of samples) { const a = Math.abs(v); if (a > peak) peak = a; sq += v * v; }
  const rms = Math.sqrt(sq / samples.length);
  assert.ok(peak > 12000, `peak is only ${Math.round(peak)} of 32767 — too quiet to hear`);
  assert.ok(rms > 2500, `rms is only ${Math.round(rms)} — this will be missed in a pocket`);
  assert.ok(peak < 32767, 'the ring is clipped, which is its own kind of harsh');
});

test('it rings long enough to be answered', () => {
  const { samples, rate, channels } = readWav(RING);
  const secs = samples.length / rate;
  assert.ok(secs >= 10, `only ${secs.toFixed(1)}s long — a call has to ring while somebody reaches for the phone`);
  assert.strictEqual(channels, 1, 'a mono file, as every other sound asset here is');
});

test('AND IT CAN BE REGENERATED, rather than being a binary nobody can touch', () => {
  // The reason the old one could not be softened: it was a wav in a folder
  // with no record of where it came from, so the only options were "find
  // another file on the internet" or "leave it".
  const gen = path.join(__dirname, '..', 'native-app', 'assets', 'make-ring.py');
  assert.ok(fs.existsSync(gen), 'the ringtone is an unreproducible binary again');
  const src = fs.readFileSync(gen, 'utf8');
  assert.ok(/1989|centroid/.test(src),
    'the generator does not record what was wrong with the sound it replaced');
});

test('the app still asks for it by the name the server sends', () => {
  // The channel names the sound; a rename here and not there gives every call
  // the default chime, which is the opposite of the complaint being fixed.
  const app = fs.readFileSync(path.join(__dirname, '..', 'native-app', 'app.json'), 'utf8');
  assert.ok(/assets\/ring\.wav/.test(app), 'ring.wav is no longer bundled');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/sound: 'ring'/.test(server), "the server no longer names 'ring' on the call push");
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
