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

// ── The comments bar ─────────────────────────────────────────────────────────
//
// Asked for as: I do not like the design and colour of the badge or the
// comments section — make it more like Telegram.
//
// The first version was a green circle straddling the message's corner, which
// is how a LAUNCHER badges an app icon. That was what I was asked for and it
// was the wrong reference: a launcher badge says "unread things exist" about a
// whole app, and shouts, because it is competing with a screen full of other
// icons. Here it sat on somebody's words, in a colour the app uses nowhere
// else, and every message with a thread had a green dot fighting the text.
//
// Telegram does something quieter and more useful: a full-width strip along
// the bottom of the message, inside its outline, separated by a hairline, in
// the app's own accent colour — "3 Comments ›". It reads as part of the
// message rather than an alarm on top of it, it says what it is instead of
// leaving a number to be decoded, and the whole strip is the tap target
// rather than a 20-pixel dot.

/** How the strip names what it opens. */
export function commentsBarLabel(count: number): string {
  const n = Number(count) || 0;
  return n === 1 ? '1 Comment' : `${n} Comments`;
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

// ── The back button ──────────────────────────────────────────────────────────

/**
 * What closing the thread should do to the history entry it pushed.
 *
 * Asked for as: back should close the comments and return to the chat. On the
 * app that is one BackHandler; on the web the thread is not a page, so opening
 * one pushes a history entry and back pops it.
 *
 * The trap is the loop. Closing by hand must undo the entry it pushed —
 * otherwise the next back press pops an entry belonging to a thread that is
 * already gone, and the page goes wherever it went before. But a close that
 * CAME from a back press must not call back again: the entry is already
 * spent, and going back once more leaves the app entirely, which is the exact
 * thing being fixed.
 */
export function backAction(o: {
  /** Did this close come from a popstate rather than a tap or a swipe? */
  fromHistory: boolean;
  /** How many entries this screen believes it has pushed. */
  pushed: number;
}): 'back' | 'none' {
  if (o.fromHistory) return 'none';
  return o.pushed > 0 ? 'back' : 'none';
}
