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

/** Keep a crop box inside its bounds, and never smaller than `min`. */
export function clampCrop(rect: Rect, bounds: Rect, min = 40): Rect {
  // A box larger than what contains it is pinned to the container.
  const width = Math.max(Math.min(rect.width, bounds.width), Math.min(min, bounds.width));
  const height = Math.max(Math.min(rect.height, bounds.height), Math.min(min, bounds.height));
  const x = Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width - width);
  const y = Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height - height);
  return { x, y, width, height };
}

/**
 * A crop box drawn on the SCREEN, expressed in the photo's own pixels.
 *
 * `displayed` is where the photo is drawn (from fitRect) and `natural` is its
 * real size; the box is given in the same coordinate space as `displayed`.
 * Results are rounded and clamped, because a crop that runs one pixel past the
 * edge is rejected outright by the native image code rather than trimmed.
 */
export function toNaturalCrop(box: Rect, displayed: Rect, natural: Size): Rect {
  if (!(displayed.width > 0) || !(displayed.height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scaleX = natural.width / displayed.width;
  const scaleY = natural.height / displayed.height;

  // Relative to the photo's top-left corner, not the screen's.
  const left = Math.round((box.x - displayed.x) * scaleX);
  const top = Math.round((box.y - displayed.y) * scaleY);
  const width = Math.round(box.width * scaleX);
  const height = Math.round(box.height * scaleY);

  const x = Math.min(Math.max(0, left), Math.max(0, natural.width - 1));
  const y = Math.min(Math.max(0, top), Math.max(0, natural.height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width, natural.width - x)),
    height: Math.max(1, Math.min(height, natural.height - y)),
  };
}

/** Has the user actually cropped anything, or is the box still the whole photo? */
export function isWholeImage(box: Rect, displayed: Rect, tolerance = 1): boolean {
  return Math.abs(box.x - displayed.x) <= tolerance
    && Math.abs(box.y - displayed.y) <= tolerance
    && Math.abs(box.width - displayed.width) <= tolerance
    && Math.abs(box.height - displayed.height) <= tolerance;
}

// ── Freehand strokes ─────────────────────────────────────────────────────────

export type Point = { x: number; y: number };
export type Stroke = { color: string; width: number; points: Point[] };
export type Segment = { x: number; y: number; length: number; angle: number };

/**
 * A freehand stroke as a list of straight segments to draw.
 *
 * There is no canvas here, so a stroke is drawn as a run of thin rotated
 * rectangles between consecutive points. Each segment is positioned at its
 * midpoint because a View rotates about its own centre.
 */
export function strokeSegments(points: Point[], width: number): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 0.5) continue;             // a jitter, not a movement
    out.push({
      // Top-left of a rectangle `length` long and `width` thick, centred on
      // the midpoint between the two points.
      x: (a.x + b.x) / 2 - length / 2,
      y: (a.y + b.y) / 2 - width / 2,
      length,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
  }
  return out;
}
