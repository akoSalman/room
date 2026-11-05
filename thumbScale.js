// ── Making a thumbnail without a native image library ───────────────────────
//
// bistbarg cannot run sharp, and not for a reason any version of sharp can
// fix. Two independent walls, both measured on the machine:
//
//   THE CPU. /proc/cpuinfo says "Common KVM processor" and has no popcnt,
//   sse3, ssse3, sse4_1 or sse4_2 — instructions from 2004, so this is a
//   hypervisor presenting a generic baseline model rather than genuinely old
//   hardware. sharp 0.33+ prebuilt binaries require x86-64-v2, and the
//   WebAssembly fallback needs SIMD, which V8 will not enable without SSE4.1.
//
//   THE NETWORK. sharp 0.32.6, the last release under that baseline, fetches
//   a prebuilt libvips tarball from GitHub during install, and that died with
//   "Installation error: aborted". GitHub downloads are blocked or throttled
//   from these networks — the same fact behind this app proxying its map
//   tiles and running its own STUN.
//
// So every photo view pulls the full file: 1336 JPEGs averaging about 550 KB,
// to people on metered connections, every time. A 400px thumbnail of the same
// photo is about 5 KB. That is the saving, and it is the user's money.
//
// ── WHY THIS CODE AND NOT A LIBRARY ─────────────────────────────────────────
//
// jimp was tested on the machine first and works: 4000x3000 down to 400x400
// in 3.6 seconds. It also brings 91 packages. This server has nine
// dependencies in total, and its npm install runs over the same throttled
// link that just killed sharp's — 91 more packages is 91 more chances for a
// deploy to fail at the point it matters.
//
// jpeg-js is one package with no dependencies and 116 KB, and the part it
// does not do — resizing — is the part below, which is pure arithmetic over
// a pixel array and can therefore be tested exactly rather than eyeballed.

/**
 * The square crop to take from a WxH image, centred.
 *
 * This is `fit: 'cover'`: fill the square and lose the overhanging edges,
 * rather than letterbox. It is what the sharp path does, so a server with
 * sharp and a server without produce the same framing.
 */
function coverBox(srcW, srcH) {
  const w = Math.floor(Number(srcW));
  const h = Math.floor(Number(srcH));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const side = Math.min(w, h);
  return {
    // Floor, not round: a half-pixel offset on an odd difference would read
    // one column beyond the right edge on the widest crop.
    sx: Math.floor((w - side) / 2),
    sy: Math.floor((h - side) / 2),
    side,
  };
}

/**
 * Average an RGBA image down to `out` x `out` pixels.
 *
 * A box filter: each output pixel is the mean of the source pixels it covers.
 * Nearest-neighbour would be a line shorter and visibly wrong — downscaling a
 * 4000px photo to 400px by sampling one pixel in a hundred throws away
 * ninety-nine, which is how thumbnails end up speckled and aliased.
 *
 * @param {Uint8Array} data   RGBA, 4 bytes per pixel, srcW * srcH * 4 long
 * @param {object} rect       from coverBox
 * @param {number} out        side of the square result
 * @returns {Uint8Array}      RGBA, out * out * 4
 */
function boxScale(data, srcW, rect, out) {
  const size = Math.floor(Number(out));
  if (!rect || !Number.isFinite(size) || size <= 0) return null;
  // ── The crop must fit the image it is cropping ────────────────────────
  //
  // Checked once, outside the loops, so it costs nothing per pixel. Without
  // it a rect taller than the source walks off the end of the buffer and
  // averages whatever follows it in memory — reading as black, or as
  // somebody else's data. squareThumb derives the rect itself and could not
  // produce one, but this function is exported and the next caller might.
  if (!Number.isFinite(srcW) || srcW <= 0) return null;
  const srcH = Math.floor(data.length / 4 / srcW);
  if (rect.sx < 0 || rect.sy < 0 || rect.side <= 0
      || rect.sx + rect.side > srcW || rect.sy + rect.side > srcH) return null;
  const dst = new Uint8Array(size * size * 4);
  const { sx, sy, side } = rect;
  const step = side / size;
  for (let y = 0; y < size; y++) {
    // The source rows this output row covers. Computed from the float edges
    // so the boxes tile the crop exactly and none is skipped or counted
    // twice — rounding each edge independently leaves gaps at some sizes.
    const y0 = sy + Math.floor(y * step);
    let y1 = sy + Math.floor((y + 1) * step);
    // ── Upscaling, which must not read an empty box ──────────────────────
    //
    // When the source is smaller than the thumbnail, step < 1 and both edges
    // land on the same pixel. An empty box would divide by zero and write
    // transparent black, so a single pixel is taken instead — nearest
    // neighbour, which is all the information there is.
    if (y1 <= y0) y1 = y0 + 1;
    for (let x = 0; x < size; x++) {
      const x0 = sx + Math.floor(x * step);
      let x1 = sx + Math.floor((x + 1) * step);
      if (x1 <= x0) x1 = x0 + 1;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * srcW + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      // n is never 0: both edges were widened above if the box was empty.
      dst[o] = (r / n) | 0;
      dst[o + 1] = (g / n) | 0;
      dst[o + 2] = (b / n) | 0;
      dst[o + 3] = (a / n) | 0;
    }
  }
  return dst;
}

/**
 * The whole job: an RGBA image in, a square RGBA thumbnail out.
 *
 * Returns null rather than throwing for anything it cannot do, because the
 * caller is a background worker whose only sensible response to a bad image
 * is to leave the original alone.
 */
function squareThumb(data, srcW, srcH, out) {
  if (!data || typeof data.length !== 'number') return null;
  const rect = coverBox(srcW, srcH);
  if (!rect) return null;
  // The buffer must actually hold the image it claims to. A truncated decode
  // would otherwise be averaged with whatever follows it in memory.
  if (data.length < srcW * srcH * 4) return null;
  return boxScale(data, Math.floor(srcW), rect, out);
}

module.exports = { coverBox, boxScale, squareThumb };
