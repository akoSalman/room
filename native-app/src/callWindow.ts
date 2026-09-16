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

// ── Which video fills the screen ─────────────────────────────────────────────
//
// Asked for first as: on a video call the user should be able to swap between
// their own minimized video and the other side's maximized one.
//
// Then reported as: sometimes both windows show one side's video, or it changes
// instantly — it should show ME on the big window and the other side on the
// small one.
//
// The second report is about the moment a video call connects, and the cause
// was the default. A call starts with only one video in existence, your own,
// and one video belongs on the screen rather than in the corner of a black
// rectangle — so for the first second or two you filled the screen. Then the
// other side's stream arrived and the old default put THEM on the screen and
// you in the corner. Nothing was wrong with either state; the fault was that
// they disagreed, so every video call began by throwing the picture across the
// screen the instant it connected. "It changes instantly" is exactly that.
//
// So the default is now the one the user asked for and the one the call
// already starts in: you on the screen, the other side in the corner. The flip
// does not need to be suppressed, because there is no longer anything to flip
// — the remote stream arriving fills the corner that was empty and moves
// nothing. Tapping the corner still swaps, which is the original request.
//
// The rest is about NOT stranding somebody with a blank screen:
//   • there is nothing to put in the corner until the other side's video
//     arrives;
//   • turning your own camera off while you are the big pane must put the
//     other person there, not leave a black rectangle with a name on it.

export type VideoPanes = {
  /** Whose stream fills the screen. */
  big: 'remote' | 'local';
  /** Whose stream sits in the corner, or none when there is only one. */
  small: 'remote' | 'local' | null;
};

/**
 * Where the two video streams go.
 *
 * You are the big pane and the other side is the corner, which is both what
 * was asked for and what the call already looks like before the other side's
 * video arrives — so connecting no longer rearranges the screen.
 *
 * `swapped` is the user's own choice, made by tapping the corner, and it is
 * respected only while it means something. The two cases below come first
 * because both of them are somebody looking at black if they are got wrong.
 */
export function videoPanes(o: {
  swapped: boolean; hasRemote: boolean; hasLocal: boolean; cameraOff?: boolean;
}): VideoPanes {
  // Your own camera off means your pane has nothing in it, so you cannot be
  // the big one whatever anybody chose: that fills the screen with black and
  // hides the person talking.
  const localShowable = !!o.hasLocal && !o.cameraOff;
  if (!localShowable) return { big: 'remote', small: null };
  // Nothing from the other side yet. One video, and it goes on the screen
  // rather than into the corner of a black rectangle — which is also why this
  // is the default arrangement rather than a special case of it.
  if (!o.hasRemote) return { big: 'local', small: null };
  return o.swapped
    ? { big: 'remote', small: 'local' }
    : { big: 'local', small: 'remote' };
}

/**
 * Is there anything a tap on the small pane would achieve?
 *
 * Offering the gesture when there is only one video teaches people it does
 * nothing, which is worse than not offering it.
 */
export function canSwapVideos(o: {
  hasRemote: boolean; hasLocal: boolean; cameraOff?: boolean;
}): boolean {
  return !!o.hasRemote && !!o.hasLocal && !o.cameraOff;
}

/**
 * Only your OWN camera is mirrored, and only on the front lens.
 *
 * A mirrored self-view is what everyone expects — it is what a mirror does —
 * but mirroring the other person, or the back camera, shows their text
 * backwards. Which pane it is in makes no difference to that, which is exactly
 * the bug swapping would introduce if the mirror followed the pane instead of
 * the stream.
 */
export function mirrors(pane: 'remote' | 'local', frontCamera: boolean): boolean {
  return pane === 'local' && !!frontCamera;
}
