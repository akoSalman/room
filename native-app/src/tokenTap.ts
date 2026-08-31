// ── A tap on a link or a number is not a tap on the message ──────────────────
//
// Reported, again: tapping a link or a number pops up the message menu.
//
// It was supposed to have been fixed twice — once for numbers, once for a
// tapped reply — and both fixes were built the same way: the token's handler
// set a `spent` flag, and the bubble's release handler checked the flag before
// scheduling the menu. That works only if the events arrive in the order the
// code assumes, and on a real phone they do not:
//
//   touch down → touch end → [menu scheduled, 300 ms] → … → the Text's onPress
//
// The press is dispatched by Android's own text-press machinery, separately
// from the touch that carried it. When the list is long and the JS thread is
// busy — which is exactly when somebody is scrolling through a chat looking
// for a number to copy — that press can arrive AFTER the 300 ms double-tap
// window has already expired and opened the menu. The flag is then set on a
// menu that is already on screen, and clearing a timer that has already fired
// does nothing.
//
// So the rule stops being "was a flag set before I ran" and becomes a question
// about TIME, which both sides can ask whenever they happen to run:
//
//   • before opening the menu: was a token pressed a moment ago?
//   • when a token is pressed: did a menu open a moment ago, because of the
//     very touch that is only now reaching me? Then it was never meant.
//
// The second half is the one that actually fixes the report, because it is the
// only one that works when the press comes last.

/**
 * How long a token press speaks for.
 *
 * Comfortably longer than the 300 ms the menu waits out, since the whole point
 * is a press that arrives after that window; short enough that a deliberate
 * tap on the bubble a moment later still opens the menu. Around half a second
 * is what a delayed press costs on a slow phone; a second would start
 * swallowing taps people meant.
 */
export const TOKEN_GRACE_MS = 600;

/**
 * Has a link, number, @name or reply quote just answered this touch?
 *
 * Asked by everything that would otherwise open the message menu.
 */
export function spentByToken(o: {
  pressedAt: number | null | undefined;
  now: number;
  graceMs?: number;
}): boolean {
  if (!o.pressedAt) return false;
  const grace = o.graceMs ?? TOKEN_GRACE_MS;
  // A clock that went backwards (or a stale timestamp from a previous chat)
  // must not silence the menu forever.
  const age = o.now - o.pressedAt;
  return age >= 0 && age <= grace;
}

/**
 * Was this menu opened by the same touch that is now pressing a token?
 *
 * If it went up within the grace window before the press, nothing else can
 * have opened it: the user's finger was on the link. Close it.
 */
export function menuWasStrayTap(o: {
  menuOpenedAt: number | null | undefined;
  now: number;
  graceMs?: number;
}): boolean {
  if (!o.menuOpenedAt) return false;
  const grace = o.graceMs ?? TOKEN_GRACE_MS;
  const age = o.now - o.menuOpenedAt;
  return age >= 0 && age <= grace;
}
