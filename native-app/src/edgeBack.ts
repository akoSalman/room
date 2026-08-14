// ── Edge swipe to go back ────────────────────────────────────────────────────
//
// Messages already claim horizontal swipes — right to reply, left to delete —
// so a back gesture that listened anywhere on the screen would fight them and
// make replying unreliable. It only listens near a screen EDGE, where there is
// nothing else to hit.
//
// Both edges work: drag right from the left edge, or left from the right edge.
// One of the two matches the habit of any given user, and the "correct" side
// flips between LTR and RTL anyway — this app is used in both.
//
// Pure decision logic, so the thresholds can be tested rather than guessed at
// on a device.

/** How close to an edge a drag must start, in points. */
export const EDGE_WIDTH = 28;
/** Sideways movement before the gesture is claimed at all. */
export const START_SLOP = 12;
/** How far the drag must travel to actually go back. */
export const COMPLETE_DISTANCE = 70;
/** A flick this fast counts even if it did not travel far. */
export const COMPLETE_VELOCITY = 0.5;

export type EdgeSide = 'left' | 'right' | null;

/**
 * Which edge (if any) a drag starting at `x0` and moved by (dx, dy) belongs to.
 *
 * Returns null unless the movement is clearly horizontal: a mostly-vertical
 * drag is the message list being scrolled, and stealing that would make the
 * chat feel broken.
 */
export function edgeFor(
  x0: number, dx: number, dy: number, width: number, edge = EDGE_WIDTH,
): EdgeSide {
  if (Math.abs(dx) < START_SLOP) return null;
  // Clearly horizontal — a comfortable margin over vertical movement.
  if (Math.abs(dx) <= Math.abs(dy) * 1.5) return null;
  if (x0 <= edge && dx > 0) return 'left';
  if (x0 >= width - edge && dx < 0) return 'right';
  return null;
}

/** Whether a drag that has been following an edge should complete the back. */
export function shouldComplete(side: EdgeSide, dx: number, vx: number): boolean {
  if (!side) return false;
  // Travel and velocity are both measured in the direction of the drag, so
  // each edge is judged by its own sign.
  const travel = side === 'left' ? dx : -dx;
  const speed = side === 'left' ? vx : -vx;
  if (travel <= 0) return false;
  return travel >= COMPLETE_DISTANCE || speed >= COMPLETE_VELOCITY;
}

/** How far the screen has been dragged, 0..1, for the drag-follows-finger feel. */
export function backProgress(side: EdgeSide, dx: number): number {
  if (!side) return 0;
  const travel = side === 'left' ? dx : -dx;
  return Math.max(0, Math.min(1, travel / COMPLETE_DISTANCE));
}
