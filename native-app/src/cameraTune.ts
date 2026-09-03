// ── Tapping to set the brightness ────────────────────────────────────────────
//
// Asked for as: the camera should have brightness control by tapping the
// object.
//
// This file also held a "makeup" pass — a blur-and-warm skin smoother, offered
// on the camera and in the image editor. Asked for its removal, in full, so it
// is gone rather than hidden behind a flag: a softening filter nobody wants is
// a second of processing and a generation of JPEG quality spent on making a
// photo worse.
//
// What the tap does, and what it cannot do
// ----------------------------------------
// On a phone's own camera app, tapping a face tells the SENSOR to expose for
// that spot. expo-camera does not expose that: its exposure, ISO and white
// balance settings are web-only (see Camera.types.d.ts — `WebCameraSettings`),
// and there is no API for a focus/metering point at all on Android. Nothing in
// this file can change what the sensor does.
//
// What it CAN do is take the picture the sensor gives and correct it — which
// is the same answer for the person holding the phone, as long as two things
// hold: the preview must show the correction while they are choosing it, and
// the photo must be corrected by exactly the amount the preview showed.
// Both are the whole point of keeping the numbers here, in one place, rather
// than having the preview approximate one thing and the encoder do another.
//
// Video is the honest exception. A translucent layer over the preview is not
// in the recorded frames, and there is no way to reach those frames without
// replacing the camera stack. Brightness is therefore offered for photos and
// NOT for video, rather than offered everywhere and silently doing nothing on
// half of it.

/** How far the brightness can be pushed, in stops. */
export const EV_MIN = -1;
export const EV_MAX = 1;


export function clampEv(ev: number): number {
  if (!isFinite(ev)) return 0;
  return Math.max(EV_MIN, Math.min(EV_MAX, ev));
}

/**
 * The exposure after dragging the slider.
 *
 * Up is brighter, which is why the drag is negated: on a screen, y grows
 * downwards, and a slider that got darker as you pushed it up would be
 * backwards from every camera app there is.
 */
export function evFromDrag(startEv: number, dy: number, trackPx: number): number {
  if (!(trackPx > 0)) return clampEv(startEv);
  const span = EV_MAX - EV_MIN;
  return clampEv(startEv - (dy / trackPx) * span);
}

/** Where the slider's knob sits, 0 at the bottom and 1 at the top. */
export function knobFraction(ev: number): number {
  return (clampEv(ev) - EV_MIN) / (EV_MAX - EV_MIN);
}

/**
 * The live preview's approximation of the correction.
 *
 * A translucent white or black layer over the preview is not the same
 * operation as the multiply applied to the photo, but at these strengths it
 * looks near enough, and it is the only thing available: the preview is a
 * native surface with no filter of its own.
 *
 * The opacities are deliberately gentle. Overstating it here would be the
 * worst outcome — a preview that promises more than the photo delivers.
 */
export function previewOverlay(ev: number): { color: 'white' | 'black'; opacity: number } {
  const e = clampEv(ev);
  if (e >= 0) return { color: 'white', opacity: Math.min(0.35, e * 0.32) };
  return { color: 'black', opacity: Math.min(0.45, -e * 0.42) };
}

/**
 * A colour matrix for the exposure, in Skia's 4x5 row-major form.
 *
 * Exposure is a MULTIPLY, not an add: doubling the light doubles every
 * channel. Adding a constant instead is the classic mistake and it washes the
 * blacks out to grey, which looks like fog rather than like a brighter photo.
 */
export function exposureMatrix(ev: number): number[] {
  const g = Math.pow(2, clampEv(ev));
  return [
    g, 0, 0, 0, 0,
    0, g, 0, 0, 0,
    0, 0, g, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/**
 * Is there anything to do at all?
 *
 * A photo that needs no correction must come back byte-for-byte as it was
 * taken: decoding and re-encoding it for a no-op costs a second of the user's
 * time, a generation of JPEG quality, and its EXIF.
 */
export function needsProcessing(o: { ev: number }): boolean {
  return Math.abs(clampEv(o.ev)) > 0.01;
}

/**
 * Are these controls available in this mode?
 *
 * False for video, and the reason is not squeamishness: the preview overlay is
 * not recorded, and the recorded frames cannot be reached without replacing
 * the camera stack. Offering a control that silently does nothing to half the
 * things it appears on is worse than not offering it.
 */
export function tuningAvailable(mode: 'photo' | 'video'): boolean {
  return mode === 'photo';
}

// ── Where the tap target goes ────────────────────────────────────────────────

export type Target = {
  /** Centre of the focus ring. */
  x: number; y: number;
  /** Left edge of the brightness slider, which sits beside the ring. */
  sliderX: number;
  /** Top edge of the slider track. */
  sliderY: number;
};

/**
 * Place the ring and its slider, keeping both fully on screen.
 *
 * A ring tapped near the right edge would otherwise put its slider off the
 * side of the phone, where it cannot be dragged — the control would appear to
 * exist and be impossible to use. Tapped near the bottom, the slider would run
 * off under the shutter button.
 */
export function placeTarget(
  tap: { x: number; y: number },
  screen: { w: number; h: number },
  ring = 72, slider = { w: 34, h: 150 }, gap = 10,
  inset = { top: 90, bottom: 190, left: 12, right: 12 },
): Target {
  const halfRing = ring / 2;
  const x = clamp(tap.x, inset.left + halfRing, screen.w - inset.right - halfRing);
  const y = clamp(tap.y, inset.top + halfRing, screen.h - inset.bottom - halfRing);

  // Beside the ring, on whichever side has room — right by preference, since
  // most people hold the phone in their right hand.
  const rightX = x + halfRing + gap;
  const fitsRight = rightX + slider.w <= screen.w - inset.right;
  const sliderX = fitsRight ? rightX : x - halfRing - gap - slider.w;

  const sliderY = clamp(y - slider.h / 2, inset.top, screen.h - inset.bottom - slider.h);
  return { x, y, sliderX: Math.max(inset.left, sliderX), sliderY };
}

function clamp(n: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * How long the ring stays after the last touch.
 *
 * It is a control, so it should not vanish while somebody is deciding; it is
 * also drawn over the picture, so it must not stay forever. Every phone camera
 * settles on a few seconds.
 */
export const TARGET_FADE_MS = 4000;
