// ── A photo you have to ask to see ─────────────────────────────────────────
//
// Asked for: a picture arrives blurred. One tap clears it, a second opens it.
// Once a picture has been cleared it stays cleared — that exact picture never
// asks again. And every picture has a button to blur it back whenever the
// person wants, after which it behaves as it did when it arrived.
//
// The point is somebody else's eyes: a phone handed over, a shoulder on a bus,
// a chat opened in a room with other people in it. Scrolling past a
// conversation should not put its photographs on display.
//
// Two decisions are worth stating because they are judgements, not mechanics:
//
//  • YOUR OWN pictures arrive clear. You chose the file seconds ago; blurring
//    it back at you is a step that protects nobody. The button still blurs it
//    whenever you want, which is the part that serves the same purpose.
//
//  • The state is keyed by the FILE, not the message. The same photo
//    forwarded into another chat is the same photo, and having cleared it
//    once is an answer about that picture.

/**
 * How much blur.
 *
 * Enough that a face or a document is not readable from across a table, and
 * not so much that the picture becomes a grey rectangle — the shape and the
 * colours are what let somebody recognise which photo it is and decide
 * whether to open it, which is the whole point of showing it at all.
 */
export const BLUR_RADIUS = 28;

/** The button, exactly as asked for. */
export const BLUR_BUTTON = '🙈';

/**
 * What a tap on a picture does.
 *
 * Blurred: the tap clears it and does nothing else. Opening a viewer in the
 * same motion would defeat the feature — the picture would be full-screen
 * before anybody could decide they did not want it there.
 */
export function tapAction(o: { blurred?: unknown }): 'reveal' | 'open' {
  return (o && o.blurred) ? 'reveal' : 'open';
}

/**
 * Does this picture arrive blurred?
 *
 * Only the first time, and only somebody else's. `revealed` is the record of
 * every picture already cleared, which is what "that exact image does not
 * have the mechanism next time" means.
 */
export function startsBlurred(o: {
  mine?: unknown; revealed?: unknown; hidden?: unknown; hiddenOneTime?: unknown;
}): boolean {
  const e = o || {};
  // A one-time message has its own cover and its own rules. Two covers over
  // one picture is a picture nobody can open.
  if (e.hiddenOneTime) return false;
  // An explicit "cover this" beats everything, including the picture being
  // yours. This is what was missing: `mine` returned false before anything
  // else was consulted, so your own photos could never be covered and the
  // button appeared to do nothing — it changed a state the rule then ignored.
  if (e.hidden) return true;
  if (e.revealed) return false;
  // Nobody has said either way: theirs arrives covered, yours does not.
  return !e.mine;
}

/**
 * Which bottom corner the button sits in.
 *
 * Asked for: left for your own pictures, right for theirs. That puts it on
 * the outside edge of the bubble in both cases — away from the tail, and away
 * from the middle of the picture, which is the part somebody is looking at.
 */
export function buttonCorner(mine: unknown): 'left' | 'right' {
  return mine ? 'left' : 'right';
}

/**
 * Is the button worth showing at all?
 *
 * Not on a picture that is still uploading — there is nothing to hide yet and
 * the corner is where the progress goes — and not on a one-time message,
 * which already has its own way of being covered.
 */
export function showsButton(o: {
  uploading?: unknown; hiddenOneTime?: unknown;
}): boolean {
  const e = o || {};
  return !e.uploading && !e.hiddenOneTime;
}
