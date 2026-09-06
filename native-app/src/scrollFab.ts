// ── The floating button at the bottom of a chat ──────────────────────────────
//
// One button, one job: go to the newest messages. It also carries the count of
// what arrived while the user was reading further up.
//
// It used to have a second job. Having jumped to an old message — from a reply
// quote, a search result, or "show in chat" — it turned into a back button that
// walked the trail of jumps in reverse, and only once that trail was exhausted
// did it mean "newest" again. That was reasonable in the abstract and wrong in
// practice: stepping through ten search results left ten jumps on the trail, so
// the way out of the search was ten taps backwards through results already
// looked at, and the count of new messages was hidden the whole time because
// the button was busy being something else. Landing on the message you asked
// for is the end of that errand, not the start of a journey you need help
// retracing.
//
// What remains subtle is that "at the end of the list" is NOT "at the present":
// after a jump the loaded window sits in the middle of the chat, so the end of
// the list is the end of the WINDOW and more history follows it.

export type FabMode = 'hidden' | 'bottom';

export function atPresent(o: { atEndOfWindow: boolean; hasNewer: boolean }): boolean {
  return o.atEndOfWindow && !o.hasNewer;
}

export function fabMode(o: {
  /** Scrolled to the end of what is loaded. */
  atEndOfWindow: boolean;
  /** More history exists after the loaded window. */
  hasNewer: boolean;
  /** Messages that arrived while the user was reading further up. */
  unseen?: number;
}): FabMode {
  // Something arrived and has not been looked at, so there is somewhere to go,
  // whatever the scroll position last reported. Without this the badge could
  // be sitting on a button that had decided to hide itself — which is the
  // "button with the count does not act correctly" report: onScroll is
  // throttled and its last reading is not always the true resting place.
  if ((o.unseen || 0) > 0) return 'bottom';
  return atPresent(o) ? 'hidden' : 'bottom';
}

/**
 * Does tapping the button mean "I have seen the new messages"?
 *
 * Always, now that the button only ever goes to the newest messages.
 *
 * It is asked on the tap itself rather than inferred later from a scroll
 * position, and that is the fix for a badge that would not go away. The count
 * and the button were cleared only by the scroll handler, which is throttled —
 * a programmatic scroll finishes between two ticks, so the last position ever
 * reported is part-way there and the button stays up over a chat that is
 * already at the bottom. A tap is a statement of intent and does not need a
 * scroll event to confirm it.
 */
export function clearsUnseenOnTap(mode: FabMode): boolean {
  return mode === 'bottom';
}

/**
 * How far to lift the button clear of what is stacked under it.
 *
 * Reported as: while "… is typing" is showing, the go-to-newest button does
 * not work. The typing line is drawn AFTER the button and adds its own height
 * at the bottom of the screen, so it lands on top of a button pinned a fixed
 * distance from that edge — and a tap goes to the text rather than to the
 * control underneath it. The reply and edit banners had already been given a
 * lift for the same reason; the typing and recording lines never were.
 *
 * Returned in the same units both clients use for that offset (px), so neither
 * has to remember the numbers.
 */
export const FAB_BASE = 148;
/**
 * The clearance between the button and whatever is under it.
 *
 * The web measures where the conversation actually ends — the browser knows,
 * and the stack under it changes size — and adds this. The app cannot measure
 * as cheaply, so it counts in the offsets below and uses the same gap.
 */
export const FAB_GAP = 12;
export const FAB_BANNER_LIFT = 66;
export const FAB_ACTIVITY_LIFT = 26;
/**
 * The live-location bar, which is the same shape of mistake again.
 *
 * Reported with a screenshot: the go-to-newest button sitting exactly on top
 * of that bar's Stop. Worse than the typing line, because the control being
 * covered is the one that ends a broadcast of where you are — the tap that
 * looks like Stop scrolls the chat instead, and the sharing carries on.
 *
 * Its own height plus the gap: one row of text at 8px padding top and bottom.
 */
export const FAB_LIVE_LIFT = 38;

export function fabBottom(o: {
  /** A reply or edit banner is above the composer. */
  banner?: boolean;
  /** Somebody is typing or recording, which draws its own line. */
  activity?: boolean;
  /** A live location is being shared, which draws its own bar with Stop on it. */
  liveBar?: boolean;
}): number {
  return FAB_BASE
    + (o?.banner ? FAB_BANNER_LIFT : 0)
    + (o?.activity ? FAB_ACTIVITY_LIFT : 0)
    + (o?.liveBar ? FAB_LIVE_LIFT : 0);
}
