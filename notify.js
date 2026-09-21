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

/**
 * Has Firebase told us this device token is gone?
 *
 * The answer decides whether the row is deleted, and deleting it is not a
 * small thing: a device with no token gets no push notifications at all until
 * the app is next opened and registers again. "Notifications are not received
 * at the time" is exactly what that looks like from the outside.
 *
 * This used to be `status === 404 || status === 400`, and the 400 was wrong.
 * FCM answers 400 INVALID_ARGUMENT for a malformed MESSAGE — a field it does
 * not like, a value too long, a bad channel id — which says nothing whatever
 * about the token. One such payload deleted the token of every device it was
 * sent to, and every one of those phones went quiet until its owner happened
 * to open the app.
 *
 * The two things that really mean "this token is dead" are:
 *   • 404 UNREGISTERED — the app was uninstalled, or the token was reissued;
 *   • 403 SENDER_ID_MISMATCH — the token belongs to a different Firebase
 *     project, so this server can never deliver to it.
 *
 * A 400 is now reported and kept, because the fix for it is on this side.
 *
 * `body` is the response text; it is parsed defensively, since an error page
 * from a proxy is not the JSON this expects.
 */
function tokenIsDead(status, body) {
  let code = '';
  try {
    const j = JSON.parse(String(body || ''));
    code = String(j?.error?.details?.find?.(d => d.errorCode)?.errorCode || j?.error?.status || '');
  } catch { code = ''; }
  if (code === 'UNREGISTERED') return true;
  if (status === 403 && code === 'SENDER_ID_MISMATCH') return true;
  return false;
}

// A BARE 404 is no longer enough, and that is the point of this function now.
//
// Reported: push notifications worked until build 255 and not since. The app
// half of that is in pushRegistration.ts. This is the other half.
//
// `if (status === 404) return true` treated any 404 as Google saying the token
// is gone. It is not: these servers reach fcm.googleapis.com across a network
// that filters it, and a middlebox answering 404 with an HTML error page is
// indistinguishable here from Firebase answering 404 UNREGISTERED — except by
// the body, which is the one thing that check ignored.
//
// So a filtered request deleted a perfectly good token, and the phone it
// belonged to went silent. Before build 256 it healed itself, because the app
// re-sent its token on every launch. Build 256 made the app remember having
// sent it, and the two changes together turned a recoverable glitch into
// permanent silence for that device.
//
// Now the body has to say so. Keeping a dead token costs one wasted request
// per message until Firebase says UNREGISTERED with a body we can read;
// deleting a live one costs that user every notification they were ever going
// to get, and nothing on the server can tell it happened.

/**
 * The one name a notification for a message goes by.
 *
 * The server puts this on its FCM notification as `tag`; the app puts the same
 * string on the notification it raises from its own socket, as `identifier`.
 * Android treats a matching tag as the SAME notification and replaces it, so
 * the two paths cannot stack — whichever arrives first is the one that is
 * seen, and the other quietly takes its place.
 *
 * That is what lets both run at once, and it holds only while the two strings
 * are identical. Mirrored by notificationTag in
 * native-app/src/pushRegistration.ts, compared in test/pushRegistration.test.js.
 */
function notificationTag(msgId) {
  const id = String(msgId === null || msgId === undefined ? '' : msgId);
  return id ? `msg-${id}` : '';
}

/**
 * The FCM collapse key for a push, or null to leave it uncollapsed.
 *
 * MEASURED, from the server's own log on the day this was written:
 *
 *   16:48:50  [push] 1 device(s) for 1 user(s) [1] — send 159ms
 *   16:48:51  …×4
 *   16:48:52  …×5
 *   16:48:53  …×3
 *
 * Thirteen high-priority messages handed to Firebase for ONE device inside
 * three seconds, every one accepted — no send failed, nothing suppressed —
 * and the phone showed one notification. FCM applies a per-device rate limit
 * to exactly this shape of traffic, and what it does when a burst exceeds it
 * is drop messages, not queue them.
 *
 * A collapse key changes what gets dropped. Messages sharing a key are
 * replaced rather than discarded arbitrarily, so a burst in one conversation
 * arrives as its LATEST message instead of as whichever one survived. The
 * limit is not raised — it cannot be from here — but the outcome stops being
 * random, which is the difference between "a notification, late" and
 * "sometimes nothing at all".
 *
 * Per ROOM, not per message: collapsing by message id would give every push
 * its own key and change nothing at all.
 *
 * Calls are deliberately excluded. A missed call cannot be replaced by a
 * later one, and they are already sent with a ttl and direct_boot_ok because
 * they must not be held back. Anything without a roomId and msgId — a call,
 * an invite — keeps its own delivery.
 */
function collapseKeyFor(data) {
  if (!data || typeof data !== 'object') return null;
  if (!data.roomId || !data.msgId) return null;
  return `room-${data.roomId}`;
}

module.exports = { recipientsFor, tokenIsDead, notificationTag, collapseKeyFor };
