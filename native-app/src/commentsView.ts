// ── How the comments screen behaves ──────────────────────────────────────────
//
// Reported together, and all four are about the thread being a second-class
// copy of the chat rather than the same thing:
//
//   1. The badge should be a circle — like a launcher notification badge —
//      sitting on the message's bottom-left corner, half on and half off it.
//   2. Comments have no margin on mobile, and the list does not follow the
//      keyboard opening or a comment being sent.
//   3. Swiping right should close the thread.
//   4. The jump-to-bottom button does nothing there.
//
// 2, 3 and 4 are decisions, so they live here and are mirrored by
// public/js/commentsView.js. 1 is presentation and lives in the styles, but
// the geometry is here so the two clients cannot drift apart on it.

// ── The badge ────────────────────────────────────────────────────────────────

/**
 * The badge sits on the CORNER of the message, not inside it.
 *
 * A notification badge is read as "there is something here" before it is read
 * as a number, and that only works if it breaks the outline of the thing it
 * belongs to. Half on and half off is what makes it look attached rather than
 * printed.
 */
export const BADGE_SIZE = 20;

/** How far it hangs outside the bubble — half of it, so it straddles the edge. */
export function badgeOffset(size = BADGE_SIZE): number {
  return Math.round(size / 2);
}

/**
 * A circle for one or two digits; a rounded pill for "99+".
 *
 * Forcing a circle around three characters either clips them or leaves a
 * disc the size of a thumbnail. The height never changes, so a row of
 * messages keeps its rhythm either way.
 */
export function badgeWidth(label: string, size = BADGE_SIZE): number {
  const n = String(label || '').length;
  return n <= 2 ? size : size + (n - 2) * 7;
}

// ── Following the conversation ───────────────────────────────────────────────

/**
 * How close to the end counts as "reading the newest".
 *
 * Generous, because the point is to answer "is this person at the bottom of
 * the thread" and a half-visible bubble still means yes.
 */
export const NEAR_BOTTOM_PX = 220;

export function isNearBottom(o: {
  scrollHeight: number; scrollTop: number; clientHeight: number;
}): boolean {
  const gap = Number(o.scrollHeight) - Number(o.scrollTop) - Number(o.clientHeight);
  if (!Number.isFinite(gap)) return true;   // nothing measured yet: it IS the bottom
  return gap < NEAR_BOTTOM_PX;
}

/**
 * Should the list jump to the end?
 *
 * Three different reasons, and only one of them is unconditional:
 *
 *   • MINE. Something I just sent must always be shown to me. Sending a
 *     comment and being left looking at older ones is the bug.
 *   • THEIRS. Only when I was already at the bottom — dragging somebody out
 *     of the middle of a thread they are reading is worse than making them
 *     tap the jump button.
 *   • THE KEYBOARD. Same rule as theirs: it halves the screen, and whatever
 *     was in front of you should stay in front of you.
 */
export function shouldStickToBottom(o: {
  reason: 'mine' | 'theirs' | 'keyboard' | 'opened';
  nearBottom: boolean;
}): boolean {
  if (o.reason === 'mine' || o.reason === 'opened') return true;
  return !!o.nearBottom;
}

/** Is the jump-to-bottom button worth showing? */
export function showsJumpButton(o: {
  scrollHeight: number; scrollTop: number; clientHeight: number;
}): boolean {
  // Only when there is something to scroll AND you are not already there.
  if (Number(o.scrollHeight) - Number(o.clientHeight) < NEAR_BOTTOM_PX) return false;
  return !isNearBottom(o);
}

// ── Swiping the thread away ──────────────────────────────────────────────────

/** How far right a finger must travel before it is a "go back". */
export const SWIPE_CLOSE_PX = 70;

/**
 * Does this drag close the thread?
 *
 * Rightward, far enough, and more horizontal than vertical — the last part is
 * what stops a diagonal scroll through the comments from throwing the screen
 * away. Deliberately NOT restricted to drags that begin at the screen edge:
 * that is a system gesture on both platforms, and asking for it competes with
 * the OS instead of the user.
 */
export function closesOnSwipe(o: { dx: number; dy: number }): boolean {
  const dx = Number(o.dx) || 0;
  const dy = Number(o.dy) || 0;
  if (dx < SWIPE_CLOSE_PX) return false;
  // 1.2, not 2 or 1.5: a real "go back" is often a diagonal flick, and the
  // 70px minimum above has already excluded the jitter of a vertical scroll.
  // Erring strict fails the gesture silently, which is indistinguishable from
  // not having built it — and this was asked for because it was missing.
  return Math.abs(dx) > Math.abs(dy) * 1.2;
}
