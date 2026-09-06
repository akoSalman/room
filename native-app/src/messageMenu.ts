// ── What a message will let you do, and what it says afterwards ──────────────
//
// Two small rules that were each written out by hand in several places, and
// were each wrong in at least one of them.
//
// Mirrored by public/js/messageMenu.js, compared function by function in
// test/messageMenu.test.js.

export type MenuMsg = {
  _uploading?: boolean;
  _uploadFailed?: boolean;
} | null | undefined;

/**
 * Can this message's menu be opened?
 *
 * Not while it is still uploading. Reported as: the menu pops up on a message
 * that is still going out — and everything in it is a lie at that moment. The
 * message has no id yet (it is a local placeholder), so Reply, Forward, Edit,
 * Comment, "Show in chat" and Delete all name something the server has never
 * heard of; Copy copies a file that is not there. The bubble is a promise, not
 * a message, and a menu of things to do with it is a menu of ways to be
 * confused.
 *
 * A FAILED upload keeps its menu: that one still needs deleting, and its own
 * bubble offers a retry.
 */
export function canOpenMenu(msg: MenuMsg): boolean {
  return !!msg && !msg._uploading;
}

/**
 * What to say once a forward has gone.
 *
 * Reported as: after forwarding, tell the user it was forwarded and to whom.
 * It used to say nothing at all unless it failed — so the only difference
 * between "sent to the right person" and "the tap missed" was silence.
 *
 * The DESTINATION is the point of the sentence. "Forwarded" alone leaves the
 * one question a person actually has — which chat did that just go to? —
 * unanswered, and forwarding to the wrong chat is the mistake this feature
 * invites.
 */
export function forwardedTo(target: string | null | undefined, count = 1): string {
  const name = String(target || '').trim();
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const what = n === 1 ? 'Forwarded' : `${n} messages forwarded`;
  return name ? `${what} to ${name}` : what;
}
