// ── A call you can put down without hanging up ────────────────────────────────
//
// Asked for as: the call should be minimizable, and while calling the user
// should be able to work — with or without the app on screen.
//
// Two different things, and the call screen failed at both.
//
// 1. It was a full-screen view with no way out but "End". Looking up the
//    address you are being asked for, or the message somebody sent you an
//    hour ago, meant hanging up. Every phone in the world can shrink a call
//    to a bubble; this one could not.
//
// 2. Leaving the app was worse than that. With nothing holding the process in
//    the foreground, Android is free to freeze a backgrounded app — and a
//    frozen app is a call whose audio stops and whose socket dies, without
//    either side being told. The fix is a foreground service, which is also
//    what puts the call in the notification shade where it can be returned to.
//
// The geometry and the state rules are here, away from React and away from
// notifee, because a draggable bubble that can be flung off the edge of the
// screen and never recovered is the kind of thing that is obvious in a test
// and invisible in a review.

export type CallPhase = 'idle' | 'incoming' | 'outgoing' | 'connected';

/**
 * May this call be minimized?
 *
 * Not while it is ringing IN. An incoming call is a question that wants an
 * answer now; shrinking it to a bubble is how a call gets left ringing in the
 * corner of the screen while somebody carries on scrolling. Outgoing calls
 * are different — waiting for someone to pick up is exactly when there is
 * time to do something else.
 */
export function canMinimize(phase: CallPhase): boolean {
  return phase === 'outgoing' || phase === 'connected';
}

/** Is the foreground service warranted? Any live call, ringing included. */
export function serviceNeeded(phase: CallPhase): boolean {
  return phase !== 'idle';
}

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Keep the bubble on the screen.
 *
 * A drag that ends past the edge would otherwise leave the call unreachable —
 * no way back to it, no way to hang up, and no way to know it is still there
 * except that the other person can still hear you.
 *
 * The insets keep it clear of the status bar and of the home gesture area,
 * where a bubble is both hard to grab and easy to trigger the system with.
 */
export function clampToScreen(
  pos: { x: number; y: number },
  size: { w: number; h: number },
  screen: { w: number; h: number },
  inset = { top: 44, bottom: 24, left: 8, right: 8 },
): { x: number; y: number } {
  const maxX = Math.max(inset.left, screen.w - size.w - inset.right);
  const maxY = Math.max(inset.top, screen.h - size.h - inset.bottom);
  return {
    x: Math.min(Math.max(pos.x, inset.left), maxX),
    y: Math.min(Math.max(pos.y, inset.top), maxY),
  };
}

/**
 * Snap to whichever side it was let go nearest.
 *
 * Free-floating bubbles end up over the message you are trying to read. Every
 * phone snaps them to an edge for the same reason.
 */
export function snapToEdge(
  pos: { x: number; y: number },
  size: { w: number; h: number },
  screen: { w: number; h: number },
  inset = { top: 44, bottom: 24, left: 8, right: 8 },
): { x: number; y: number } {
  const centre = pos.x + size.w / 2;
  const left = inset.left;
  const right = Math.max(left, screen.w - size.w - inset.right);
  const snapped = { x: centre < screen.w / 2 ? left : right, y: pos.y };
  return clampToScreen(snapped, size, screen, inset);
}

/**
 * Where the bubble starts, before it has ever been dragged.
 *
 * Top-right, below the header: out of the way of the composer and of the
 * newest messages, which are the two things somebody on a call is most likely
 * to want.
 */
export function defaultPosition(
  size: { w: number; h: number }, screen: { w: number; h: number },
): { x: number; y: number } {
  return clampToScreen({ x: screen.w - size.w - 12, y: 96 }, size, screen);
}

/** Was that a drag, or a tap that wobbled? */
export function isDrag(dx: number, dy: number, slop = 6): boolean {
  return Math.abs(dx) > slop || Math.abs(dy) > slop;
}

// ── What the shade says ─────────────────────────────────────────────────────

/**
 * The ongoing-call notification's second line.
 *
 * It carries the state rather than a duration, because Android draws the
 * duration itself from a chronometer — a timer rendered by JavaScript into a
 * notification would need a re-post every second, which is both wasteful and
 * visibly jumpy.
 */
export function ongoingText(o: {
  phase: CallPhase; kind: 'voice' | 'video'; connected: boolean;
}): string {
  const what = o.kind === 'video' ? 'Video call' : 'Voice call';
  if (o.connected) return `${what} in progress`;
  if (o.phase === 'incoming') return `Incoming ${o.kind} call`;
  return `${what} · connecting`;
}

/**
 * Should the shade show a running timer?
 *
 * Only once connected: a chronometer started when the call was placed would
 * count the ringing as call time, and disagree with the timer on the call
 * screen.
 */
export function showsChronometer(connected: boolean): boolean {
  return !!connected;
}
