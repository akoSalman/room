// ── The floating button at the bottom of a chat ──────────────────────────────
//
// It does two different jobs and shows a count, and getting any of the three
// wrong strands the user somewhere they cannot easily leave — so the rules live
// here rather than being spread across a scroll handler and a press handler.
//
// Two things make it less obvious than it looks:
//
//  • "at the end of the list" is not the same as "at the present". After
//    jumping to an old message the loaded window sits in the middle of the
//    chat, so the end of the list is the end of the WINDOW and there is more
//    history beyond it.
//  • the button doubles as a way back. Having jumped to a message, the button
//    returns to where the jump started, and only once that trail is exhausted
//    does it mean "go to the newest".

export type FabMode = 'hidden' | 'back' | 'bottom';

export function atPresent(o: { atEndOfWindow: boolean; hasNewer: boolean }): boolean {
  return o.atEndOfWindow && !o.hasNewer;
}

export function fabMode(o: {
  /** How many jumps can still be walked back. */
  backStackSize: number;
  /** Scrolled to the end of what is loaded. */
  atEndOfWindow: boolean;
  /** More history exists after the loaded window. */
  hasNewer: boolean;
}): FabMode {
  // Walking back takes priority: a trail of jumps is the thing the user is
  // least able to reconstruct by hand, and it is offered even at the bottom.
  if (o.backStackSize > 0) return 'back';
  return atPresent(o) ? 'hidden' : 'bottom';
}

/**
 * Does tapping the button mean "I have seen the new messages"?
 *
 * Only when it is the go-to-newest button. In its back-walking mode the tap
 * goes to an OLD message, so clearing the count would hide the fact that
 * something new is waiting.
 *
 * This is asked on the tap itself rather than being inferred later from a
 * scroll position, and that is the fix for a badge that would not go away. The
 * count and the button were cleared only by the scroll handler, which is
 * throttled — a programmatic scroll finishes between two ticks of the throttle,
 * so the last position ever reported is part-way there and the button stays up
 * over a chat that is already at the bottom. A tap is a statement of intent and
 * does not need a scroll event to confirm it.
 */
export function clearsUnseenOnTap(mode: FabMode): boolean {
  return mode === 'bottom';
}
