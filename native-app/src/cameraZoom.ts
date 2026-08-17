// ── Turning a zoom factor into what the camera wants ─────────────────────────
//
// expo-camera's `zoom` prop is 0..1, and the temptation is to read that as a
// fraction of the zoom FACTOR. It is not. On Android it maps to CameraX's
// linearZoom, which is defined so that the FIELD OF VIEW changes linearly — and
// field of view is inversely proportional to the zoom factor, so the factor
// climbs slowly at first and then runs away at the top of the range.
//
// Assuming it was linear in the factor is why the "2x" and "3x" buttons did
// almost nothing. `zoom = 0.25` was offered as 2x; on a phone that can reach 8x
// it is really about 1.3x, which looks like the button is broken rather than
// like a 2x zoom.
//
//   fov      ∝ 1 / factor
//   linear    = (1 - 1/factor) / (1 - 1/max)
//   factor    = 1 / (1 - linear * (1 - 1/max))
//
// The one thing that cannot be known from here is the phone's maximum factor:
// expo-camera does not report it, and it differs on every device. So it is an
// assumption, stated once, in the open. Being wrong about the maximum stretches
// the scale a little; being wrong about the SHAPE, as before, made the control
// useless.

/**
 * Zoom factor at the top of the range, assumed.
 *
 * Chosen as a middle-of-the-road digital maximum for the Android phones these
 * users actually have. On a device that can do more, the labelled stops will
 * fall slightly short of their number; on one that can do less, slightly over.
 * Either is much closer than treating the scale as linear in the factor.
 */
export const ASSUMED_MAX_FACTOR = 8;

/** The 0..1 value to hand expo-camera for a given zoom factor. */
export function factorToLinear(factor: number, max = ASSUMED_MAX_FACTOR): number {
  if (!(factor > 1)) return 0;
  if (!(max > 1)) return 0;
  const f = Math.min(factor, max);
  const linear = (1 - 1 / f) / (1 - 1 / max);
  return Math.min(1, Math.max(0, linear));
}

/** What zoom factor a 0..1 value actually corresponds to. */
export function linearToFactor(linear: number, max = ASSUMED_MAX_FACTOR): number {
  if (!(max > 1)) return 1;
  const l = Math.min(1, Math.max(0, linear || 0));
  return 1 / (1 - l * (1 - 1 / max));
}

/**
 * Where a pinch should land.
 *
 * Multiplying the factor rather than adding to the 0..1 value: pinching to
 * twice the size should double the magnification wherever the zoom already is,
 * which is what a pinch means everywhere else. Adding to the linear value gave
 * a gesture that barely moved down at 1x and shot to maximum near the top.
 */
export function pinchToLinear(
  startLinear: number, scale: number, max = ASSUMED_MAX_FACTOR,
): number {
  if (!(scale > 0)) return startLinear;
  return factorToLinear(linearToFactor(startLinear, max) * scale, max);
}

/** How a factor is written on a button: "1x", "2x", "3.5x". */
export function formatFactor(factor: number): string {
  const rounded = Math.round(factor * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}x`;
}

/**
 * The quick stops offered beside the shutter, dropping any the phone cannot
 * reach so a button never promises magnification that is not there.
 */
export function zoomStops(
  factors: number[] = [1, 2, 3, 5], max = ASSUMED_MAX_FACTOR,
): { label: string; factor: number; value: number }[] {
  return factors
    .filter(f => f <= max)
    .map(f => ({ label: formatFactor(f), factor: f, value: factorToLinear(f, max) }));
}
