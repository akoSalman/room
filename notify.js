// ── Who a notification actually goes to ──────────────────────────────────────
//
// A tiny module of its own because the code it came from cannot be reached by
// a test: push delivery is behind a check for Firebase credentials, which a
// test environment does not have, so a rule written inside that function is a
// rule nothing can verify. A mutation that inverted the mute filter — so that
// ONLY muted people were notified — passed the whole suite.
//
// The rule is pure and takes its lookup as an argument, so the database stays
// on the server side of the line and the decision stays on this one.

/**
 * The subset of `userIds` that should actually be sent a notification.
 *
 * `fromUserId` is who the notification is ABOUT. Anyone who has muted that
 * person is dropped.
 *
 * Muting is about not being interrupted, so it stops the notification and
 * nothing else: the message is still delivered, still shown in the chat, and
 * still counted as unread. A mute that hid the message would be a block
 * wearing a different name, and someone who chose "mute" did not choose that.
 */
function recipientsFor(userIds, fromUserId, isMuted) {
  const ids = Array.isArray(userIds) ? userIds : [];
  // No sender attributed to this notification — a system notice, say. There is
  // nobody to have muted, so nobody is filtered out.
  if (!fromUserId) return ids.slice();
  // Never notify someone about their own message. Every caller filters this
  // already; doing it here too means a caller that forgets cannot cause it.
  return ids.filter(id => id !== fromUserId && !isMuted(id, fromUserId));
}

module.exports = { recipientsFor };
