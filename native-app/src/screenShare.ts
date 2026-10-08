// ── Getting a phone screen through a call negotiated for a camera ──────────
//
// Where this stands, from the device's own report rather than from reasoning:
//
//     captured=1  senders=1  switched=1
//
// The capture starts, the call has exactly one video sender, and that sender
// ends up holding the screen track. The swap works. And the far end still
// freezes on the last camera frame, which is what a receiver shows when the
// frames stop arriving.
//
// So the track is in the call and nothing is coming out of it. The remaining
// explanation is the encoder. A camera call here negotiates something like
// 640×480; a phone screen is about 1080×2400 — more than eight times the
// pixels, in the other orientation. WebRTC normally adapts a camera source
// down to fit, but a SCREENCAST source is deliberately exempt from that: the
// library creates it with `createVideoSource(isScreencast = true)`, which
// turns adaptation off so that text stays sharp. Nothing then brings the
// frame size down to what was negotiated, and the encoder is handed something
// it will not produce output for.
//
// Hence an explicit scale. It is the cheap thing to try before renegotiating
// the call, which is the expensive thing: a second offer mid-call is treated
// by the web client as a NEW INCOMING CALL and hangs up, so renegotiation
// means changing the signalling on both ends.
//
// Whether this works is not something I can tell from here, so the same
// change reports what the encoder actually did. See encodedNothing.

/**
 * The largest dimension a shared screen is sent at.
 *
 * Comfortably above the call's camera size, so text stays readable, and far
 * below a modern phone's panel, so there is something for the encoder to do
 * other than refuse. Screen content survives scaling much better than it
 * survives not arriving.
 */
export const MAX_DIMENSION = 1280;

/**
 * A ceiling on the bitrate for a shared screen.
 *
 * Higher than speech-over-video needs, because a screen is mostly still and
 * then changes all at once, and lower than a connection paid for by the
 * megabyte should ever be asked to carry continuously.
 */
export const MAX_BITRATE = 1_200_000;

/**
 * How much to divide the capture by so it fits.
 *
 * Never below 1: scaleResolutionDownBy is a DIVISOR, and a value under one
 * would be an instruction to upscale, which is both wasteful and, on some
 * encoders, refused outright.
 *
 * Unknown dimensions mean no scaling rather than a guessed one. Guessing here
 * would mean shrinking a screen that was already fine.
 */
export function scaleFor(o: {
  width?: unknown; height?: unknown; max?: unknown;
}): number {
  const e = o || {};
  const w = Number(e.width);
  const h = Number(e.height);
  const max = Number.isFinite(Number(e.max)) && Number(e.max) > 0
    ? Number(e.max) : MAX_DIMENSION;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 1;
  const longest = Math.max(w, h);
  if (longest <= max) return 1;
  // Rounded to two places: the exact ratio is a long decimal and the encoder
  // only needs to be told roughly how much smaller.
  return Math.round((longest / max) * 100) / 100;
}

/**
 * Did the encoder produce nothing at all?
 *
 * The question the whole diagnosis turns on, and it cannot be answered by
 * looking at the app: frames encoded is a counter inside WebRTC.
 *
 *   • frames encoded climbing  → the picture is going out, and whatever is
 *     wrong is at the far end or in the network;
 *   • frames encoded stuck at zero while the track is live → the encoder is
 *     refusing the source, which is what the scaling above is for.
 *
 * "Stuck at zero" is only meaningful once the share has been running for a
 * moment, which is why the sample is taken after a delay rather than
 * immediately.
 */
export function encodedNothing(o: { framesEncoded?: unknown; seconds?: unknown }): boolean {
  const e = o || {};
  const frames = Number(e.framesEncoded);
  const secs = Number(e.seconds);
  // Too early to say. A share sampled instantly has encoded nothing yet and
  // that is normal, not a failure.
  if (!Number.isFinite(secs) || secs < 2) return false;
  if (!Number.isFinite(frames)) return false;
  // NEGATIVE MEANS THE QUESTION WAS NOT ANSWERED, not that the answer was
  // zero. The sampler starts the counter at -1 and leaves it there when
  // getStats returns no outbound video report — which is a platform that
  // does not expose the statistic, not an encoder that refused the screen.
  //
  // This read `frames <= 0`, so an unanswered question told the person "the
  // screen is being captured but nothing is going out". That is a
  // measurement they cannot check and I could not either: on a build where
  // the statistic is missing, that sentence appears on every share, working
  // or not. A diagnostic that cannot be wrong is not a diagnostic.
  if (frames < 0) return false;
  return frames === 0;
}

/** How long to let a share run before asking the encoder how it is doing. */
export const SAMPLE_AFTER_MS = 5000;
