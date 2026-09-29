// ── Dragging the seek bar, and how fast it plays ─────────────────────────────
//
// Two reports about the video player:
//
//   "when playing video the seek bar doesn't work"
//   "video player should have speed control"
//
// THE SEEK BAR. It did not work for a reason that is invisible on the line
// that looks wrong. The gesture handler is built once —
//
//     const seekResponder = useRef(PanResponder.create({ … })).current;
//
// — so every handler inside it closes over the FIRST render's variables. On
// the first render the video has not loaded, so `duration` is 0, and it stays
// 0 inside those handlers for the life of the player however long the video
// turns out to be. Dragging computed `fraction * 0`, so the thumb reported
// zero wherever it was, and releasing seeked to the start.
//
// The file had already been bitten by this once: `scrubMs` is read through a
// ref with a comment saying the responder closes over the first render's
// state. Only that one value was moved, and `duration` was left behind — which
// is why the fix looked done and the bar still did nothing.
//
// So the arithmetic lives here, taking the duration as an argument. A pure
// function cannot capture a stale one, and the wiring test checks that the
// caller reads it from a ref rather than from the render it was created in.

/**
 * Where on the bar a touch landed, as a position in the video.
 *
 * `width` is the bar's measured width and `x` the touch's offset into it, both
 * in the same units. A zero or missing width means the bar has not been laid
 * out yet, and dividing by it would give Infinity or NaN — which as a seek
 * target is either the end of the video or a silent failure.
 */
export function msFromTouch(x: number, width: number, durationMs: number): number {
  const w = Number(width) || 0;
  const d = Number(durationMs) || 0;
  if (w <= 0 || d <= 0) return 0;
  const frac = Math.min(1, Math.max(0, (Number(x) || 0) / w));
  return Math.round(frac * d);
}

/**
 * How far along the bar to draw the thumb, 0 to 1.
 *
 * Clamped, because `playableDurationMillis` can briefly exceed the duration
 * while buffering and a fraction above 1 draws the bar past its own end.
 */
export function fraction(positionMs: number, durationMs: number): number {
  const d = Number(durationMs) || 0;
  if (d <= 0) return 0;
  return Math.min(1, Math.max(0, (Number(positionMs) || 0) / d));
}

/** Keep a seek inside the video. */
export function clampSeek(ms: number, durationMs: number): number {
  const d = Number(durationMs) || 0;
  if (d <= 0) return 0;
  return Math.min(d, Math.max(0, Number(ms) || 0));
}

// ── Speed ───────────────────────────────────────────────────────────────────

/**
 * The speeds offered, in the order tapping cycles through them.
 *
 * Starts at 1 so the first tap speeds up rather than slowing down — the thing
 * people want a speed control for is usually to get through something faster.
 * Nothing below 0.5, where speech stops being intelligible, and nothing above
 * 2, where it stops being speech.
 */
export const SPEEDS = [1, 1.25, 1.5, 2, 0.5] as const;

/** The next speed after this one, wrapping round. */
export function nextSpeed(current: number): number {
  const i = SPEEDS.indexOf(Number(current) as any);
  // An unrecognised rate — restored from somewhere, or set by another part of
  // the app — steps to the front of the list rather than off the end of it.
  if (i < 0) return SPEEDS[0];
  return SPEEDS[(i + 1) % SPEEDS.length];
}

/**
 * What the button says.
 *
 * "1×" rather than "1.0×": the label sits in a row of small controls and the
 * trailing zero buys nothing. The fractional speeds keep their decimals
 * because 1.25 and 1.5 are not integers and rounding them would be a lie.
 */
export function speedLabel(rate: number): string {
  const r = Number(rate) || 1;
  return `${Number.isInteger(r) ? r : r}×`;
}

/**
 * Should the speed control be offered at all?
 *
 * Not for something with no duration — a stream still loading, or an audio
 * track the player has not read yet. A control that cannot be applied to
 * anything teaches people it does nothing.
 */
export function canChangeSpeed(durationMs: number): boolean {
  return (Number(durationMs) || 0) > 0;
}

// ── "Opening…" that never ends ──────────────────────────────────────────────
//
// Reported as: after downloading a video it sometimes sticks on opening and
// will not play at all until the app is closed and reopened — and the same
// happens to videos that were already downloaded.
//
// The player decided it was open like this:
//
//     if ((st.positionMillis || 0) > 0 || st.isPlaying) setReady(true);
//
// which is not "is this video open", it is "has it started playing". A video
// that LOADS perfectly well but does not begin — because something else holds
// the audio focus, because the play call was refused, because it is simply
// paused at zero — is indistinguishable, under that test, from one that never
// opened at all. So the spinner sat over a working video for ever, and since
// nothing had errored there was no Retry either: the only way out was killing
// the process, which is exactly what was reported.
//
// A local file makes it worse rather than better, which is the other half of
// the report: it loads instantly, so there is no buffering to watch and the
// only thing standing between the viewer and the picture is a flag that never
// gets set.

/**
 * Has the video actually opened?
 *
 * `isLoaded` is the answer to that question. Whether it is PLAYING is a
 * different question and belongs to the play button.
 */
export function videoIsOpen(st: unknown): boolean {
  if (!st || typeof st !== 'object') return false;
  return (st as any).isLoaded === true;
}

/**
 * How long to wait before admitting it is not going to open.
 *
 * Without this there is no way out at all: if nothing loads and nothing
 * errors, the spinner stays up for the life of the screen. On a timeout the
 * player shows its failure and its Retry button — which is a poor outcome, but
 * a poor outcome the viewer can act on.
 *
 * Generous, because a large video on a slow connection is a legitimately long
 * wait and turning that into a false failure would be its own bug.
 */
export const OPEN_TIMEOUT_MS = 30000;

/** Should the player give up waiting and offer Retry? */
export function openTimedOut(o: {
  ready?: boolean;
  failed?: boolean;
  waitedMs?: unknown;
}): boolean {
  if (!o || o.ready || o.failed) return false;
  const waited = Number(o.waitedMs);
  if (!Number.isFinite(waited)) return false;
  return waited >= OPEN_TIMEOUT_MS;
}
