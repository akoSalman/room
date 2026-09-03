// ── Image editor geometry ────────────────────────────────────────────────────
//
// The editor shows a photo scaled to fit the screen, and the user drags a crop
// box over that scaled version. The crop actually has to be applied in the
// photo's OWN pixels, which may be five times larger — so every number the
// finger produces has to be translated, and if that translation is even
// slightly wrong the result is a picture cropped to the wrong place. It is
// also invisible in review and awkward to check on a device, so it lives here
// where it can be tested.

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Where a photo lands inside the area available to it, scaled to fit whole
 * ("contain") and centred — the same rule as resizeMode="contain", which is
 * what the editor renders with.
 */
export function fitRect(natural: Size, container: Size): Rect {
  if (!(natural.width > 0) || !(natural.height > 0)
      || !(container.width > 0) || !(container.height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(container.width / natural.width, container.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
}

// ── The crop box, as a fraction of the picture ───────────────────────────────
//
// The box is stored as fractions of the photo (0..1), never as screen pixels.
//
// It WAS stored in screen pixels, and that produced a crop nobody asked for.
// The box starts out equal to the whole displayed picture, and "has the user
// cropped anything?" was answered by comparing the two. But the displayed
// picture is only as big as the space left over on screen — so the moment
// anything else appeared and the canvas got shorter, the picture shrank, the
// stored box no longer matched it, and the editor concluded the user had
// cropped. Drawing a single line was enough to trigger it, because the button
// that confirms the drawing takes up room.
//
// As a fraction the box means the same thing at every screen size, and "the
// whole picture" is 0,0,1,1 no matter what the layout does.

export type FracRect = { x: number; y: number; w: number; h: number };

export const WHOLE_IMAGE: FracRect = { x: 0, y: 0, w: 1, h: 1 };

/** Where a fractional box sits on screen, given where the photo is drawn. */
export function fracToScreen(f: FracRect, displayed: Rect): Rect {
  return {
    x: displayed.x + f.x * displayed.width,
    y: displayed.y + f.y * displayed.height,
    width: f.w * displayed.width,
    height: f.h * displayed.height,
  };
}

/** The reverse: a box drawn on screen as a fraction of the photo. */
export function screenToFrac(rect: Rect, displayed: Rect): FracRect {
  if (!(displayed.width > 0) || !(displayed.height > 0)) return { ...WHOLE_IMAGE };
  return {
    x: (rect.x - displayed.x) / displayed.width,
    y: (rect.y - displayed.y) / displayed.height,
    w: rect.width / displayed.width,
    h: rect.height / displayed.height,
  };
}

/** Keep a fractional box inside the picture, and never below `min` of it. */
export function clampFrac(f: FracRect, min = 0.05): FracRect {
  const w = Math.min(Math.max(f.w, min), 1);
  const h = Math.min(Math.max(f.h, min), 1);
  return {
    x: Math.min(Math.max(f.x, 0), 1 - w),
    y: Math.min(Math.max(f.y, 0), 1 - h),
    w,
    h,
  };
}

/**
 * Has the user actually cropped anything?
 *
 * The tolerance is in fractions, so it is a proportion of the picture rather
 * than a number of screen pixels — the same answer on any display.
 */
export function isWholeFrac(f: FracRect, tolerance = 0.005): boolean {
  return Math.abs(f.x) <= tolerance
    && Math.abs(f.y) <= tolerance
    && Math.abs(f.w - 1) <= tolerance
    && Math.abs(f.h - 1) <= tolerance;
}

/**
 * A fractional box in the photo's own pixels, ready for the cropper.
 *
 * Rounded and clamped, because native image code rejects a rectangle that runs
 * even one pixel past the edge rather than trimming it.
 */
export function fracToNatural(f: FracRect, natural: Size): Rect {
  const x = Math.min(Math.max(0, Math.round(f.x * natural.width)), Math.max(0, natural.width - 1));
  const y = Math.min(Math.max(0, Math.round(f.y * natural.height)), Math.max(0, natural.height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(f.w * natural.width), natural.width - x)),
    height: Math.max(1, Math.min(Math.round(f.h * natural.height), natural.height - y)),
  };
}

// ── Freehand strokes ─────────────────────────────────────────────────────────

export type Point = { x: number; y: number };
export type Stroke = { color: string; width: number; points: Point[]; seq: number; arrow?: boolean };

// ── Undo ─────────────────────────────────────────────────────────────────────

/** What a press of undo should take back, given everything outstanding. */
export type UndoStep = 'stroke' | 'crop' | 'revert' | null;

/**
 * What undo does next.
 *
 * The editor holds two different kinds of change at once: edits still pending
 * on screen (a crop box being dragged, strokes not yet burnt in) and edits
 * already APPLIED, each of which produced a real file. Undo has to walk back
 * through both, newest first.
 *
 * Strokes carry a sequence number rather than being counted. An earlier version
 * compared a caption's `Date.now()` id against the NUMBER of strokes — two
 * quantities with nothing to do with each other — so which edit came off was
 * effectively arbitrary.
 */
export function nextUndo(o: {
  /** Sequence of the newest stroke not yet applied, if any. */
  lastStrokeSeq?: number | null;
  /** Whether the crop box currently differs from the whole picture. */
  cropped: boolean;
  /** How many applied steps sit behind the current image. */
  committed: number;
}): UndoStep {
  const st = o.lastStrokeSeq ?? null;
  // A stroke on screen is always the most recent thing. `!== null` and not a
  // truthiness check, or the very first stroke — sequence 0 — reads as absent.
  if (st !== null) return 'stroke';
  // Then the crop box.
  if (o.cropped) return 'crop';
  // Nothing pending at all, so step back through the applied versions.
  if (o.committed > 0) return 'revert';
  return null;
}

/**
 * A freehand stroke as one path to draw.
 *
 * Reported as: the pen is dotted; it should draw a solid line.
 *
 * It used to be a run of thin rotated rectangles, one per pair of points,
 * because there was no canvas here. Each was its own native view, and at every
 * joint two of them met at an angle with nothing filling the wedge between —
 * so a quick stroke, whose points are far apart, came out as a string of beads
 * rather than a line. (It also meant a few hundred views for one drawing,
 * which is why drawing on a big photo crawled.)
 *
 * Now it is a single path, stroked once with round caps and round joins, so
 * there are no joints to fall between.
 */
export function strokePath(points: Point[]): string {
  const pts = (points || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) return '';
  // A tap with no movement is a dot, and has to be drawn as one: a path with a
  // single point strokes nothing at all.
  if (pts.length === 1) return `M${r(pts[0].x)} ${r(pts[0].y)}L${r(pts[0].x)} ${r(pts[0].y)}`;
  let d = `M${r(pts[0].x)} ${r(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += `L${r(pts[i].x)} ${r(pts[i].y)}`;
  return d;
}

/** Two decimals is finer than a pixel and keeps the path string short. */
function r(n: number): number {
  return Math.round(n * 100) / 100;
}

/** How long an arrowhead is, for a line of this thickness. */
export function arrowHeadLength(width: number): number {
  // Proportional to the line, or a thin arrow gets a huge head and a thick one
  // a stub. Floored so the head on the thinnest pen is still a head.
  return Math.max(12, (width || 1) * 4.5);
}

/**
 * An arrow from the first point to the last.
 *
 * Asked for alongside the solid pen: a way to point AT something in a photo.
 * Only the two ends matter — everything in between is the finger wandering on
 * the way, and an arrow that follows the wander is not an arrow.
 *
 * The head is two straight barbs rather than a filled triangle, so it strokes
 * with the same paint as the shaft and needs no second draw.
 */
export function arrowPath(points: Point[], width: number): string {
  const pts = (points || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return '';
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  // A tap, or a shake: an arrow shorter than its own head is not an arrow, and
  // drawing one would leave a splat where somebody expected nothing.
  if (len < arrowHeadLength(width)) return '';
  const angle = Math.atan2(dy, dx);
  const head = arrowHeadLength(width);
  const spread = Math.PI / 7;   // ~26° each side: a recognisable arrow, not a spike
  const b1x = b.x - head * Math.cos(angle - spread);
  const b1y = b.y - head * Math.sin(angle - spread);
  const b2x = b.x - head * Math.cos(angle + spread);
  const b2y = b.y - head * Math.sin(angle + spread);
  return `M${r(a.x)} ${r(a.y)}L${r(b.x)} ${r(b.y)}`
    + `M${r(b1x)} ${r(b1y)}L${r(b.x)} ${r(b.y)}L${r(b2x)} ${r(b2y)}`;
}

/** The path for one finished or in-progress stroke, whichever kind it is. */
export function pathFor(stroke: { points: Point[]; width: number; arrow?: boolean }): string {
  return stroke.arrow ? arrowPath(stroke.points, stroke.width) : strokePath(stroke.points);
}

// ── Turning the outstanding edits into one file ──────────────────────────────
//
// Reported as: after drawing on a photo and sending it, the drawing is not
// there and the original goes.
//
// Two faults, both here in spirit even though the code was in the component.
//
// The first: a drawing can only be got at by photographing the screen, and a
// crop is best done on the FILE (which keeps the photo's full resolution). The
// old code did one OR the other and returned after the crop, so when both were
// outstanding the strokes were silently discarded. A comment claimed that
// could not happen; the code did not enforce it, and a promise like that stops
// being true at the next change.
//
// The second: when the edits could not be turned into a file at all, the
// component fell back to the untouched photo and sent THAT. Substituting the
// original for the edit, quietly, is the worst of the options available.
//
// The plan is separated out so both can be tested, which is what neither had.

export type SavePlan = {
  /** Photograph the screen, because there are strokes on it. */
  capture: boolean;
  /** Crop afterwards, by the same fractions. */
  crop: boolean;
  /** Nothing outstanding: the current version is already the answer. */
  unchanged: boolean;
};

export function savePlan(o: { annotated: boolean; cropped: boolean }): SavePlan {
  return {
    capture: !!o.annotated,
    crop: !!o.cropped,
    unchanged: !o.annotated && !o.cropped,
  };
}

/**
 * What a save may hand back.
 *
 * `null` means the edits could not be produced — and the caller must NOT treat
 * that as "send the original". There is no third option that is honest: either
 * the edit was made, or the user is told it was not.
 */
export function canSend(out: { uri?: string } | null): boolean {
  return !!(out && out.uri);
}
