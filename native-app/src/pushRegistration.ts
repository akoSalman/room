// ── Why the phone went quiet ─────────────────────────────────────────────────
//
// Reported as: in the latest version of the APK, push notifications are not
// received at the time. They arrive when the app is opened, which is another
// way of saying they are not pushes at all — the socket is delivering them on
// reconnect and the shade stayed empty while the app was closed.
//
// The server was sending them. The device was never registered to receive
// them, because registration was one attempt with no second chance, and that
// one attempt was racing the permission dialog:
//
//   1. the app asks for notification permission, without waiting for an answer;
//   2. a moment later the stored token is read, the sign-in screen goes away,
//      and the registration effect runs;
//   3. it asks whether permission is granted. The dialog is still on screen and
//      the user has not tapped anything yet, so the answer is no;
//   4. it returns. Its effect never re-runs, so the FCM token is never sent to
//      the server, for the rest of that session and every session after it in
//      which the same thing happens.
//
// The user then grants permission. Everything the app raises ITSELF still
// works — that is why this looks like "late" rather than "broken" — but the
// server has no token to push to, so nothing arrives while the app is closed.
//
// Installing a new APK is exactly when that race is lost, which is why it was
// reported against a version rather than a feature.
//
// Two more ways the same silence happens, both fixed by the same rule:
//
//   • the POST failed. On these connections that is an ordinary Tuesday, and
//     one failed request should not cost somebody push notifications until
//     they next restart the app.
//   • the token changed. Firebase reissues tokens — on reinstall, on restore
//     to a new device, after a long idle. The server keeps pushing to the old
//     one until Firebase rejects it, and then it has nothing at all.
//
// So registration stops being an event and becomes a state: this is the last
// token the server was told about, and while that is not the current one, keep
// trying. App-side only — the web is pushed through Web Push, which subscribes
// through an entirely different route.

/** Where the last token the server accepted is remembered. */
export const SENT_TOKEN_KEY = 'push-token-sent';

/** Where the moment the server last accepted a token is remembered. */
export const SENT_AT_KEY = 'push-token-sent-at';

/**
 * How long a registration is trusted before it is simply redone.
 *
 * Not a retry — a refresh. Cheap enough to be unconditional, rare enough not
 * to matter: one small POST a day per device.
 */
export const REREGISTER_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Is there anything to tell the server?
 *
 * THIS IS THE REGRESSION, and it is the answer to "push notifications worked
 * until build 255".
 *
 * Build 255 sent the token on every launch. No memory, no comparison — just a
 * small idempotent POST each time the app started. That looked wasteful, so
 * build 256 made it remember what it had already sent and stay quiet unless
 * the token changed.
 *
 * What that overlooked is that the SERVER's copy can disappear without the
 * token changing. It deletes a row whenever a send looks like Firebase
 * rejecting the token — and on a network that filters fcm.googleapis.com, a
 * middlebox 404 looked exactly like that (see tokenIsDead in notify.js, now
 * fixed too). The moment the row went, the device stopped receiving anything,
 * and the app never sent the token again because it remembered having sent
 * it. Build 255 healed from this on the next launch without anybody noticing
 * it had happened; build 256 turned it into permanent silence.
 *
 * So the memory stays — it is what keeps this quiet across foregrounds within
 * a session — but it can no longer outlive a cold start or a day. Those are
 * the two ways back from a server-side deletion, and neither of them can be
 * reached by a device that only speaks up when Firebase reissues its token.
 *
 * The comparison is still what stops a POST on every foreground, which was
 * the real thing worth fixing.
 */
export function needsSend(o: {
  granted: boolean;
  token: string | null | undefined;
  sentToken: string | null | undefined;
  /** First registration attempt of this process. */
  coldStart?: boolean;
  /** When the server last accepted it, as a timestamp. */
  sentAt?: number | null;
  now?: number;
}): boolean {
  if (!o || !o.granted) return false;
  const token = String(o.token || '');
  if (!token) return false;
  // A changed token must always be sent: the server cannot know the old one
  // is useless until it tries it.
  if (token !== String(o.sentToken || '')) return true;
  // What build 255 did, and the reason it never suffered this.
  if (o.coldStart) return true;
  const at = Number(o.sentAt) || 0;
  const now = Number(o.now) || Date.now();
  // No record of WHEN is a record we cannot trust — treat it as due.
  if (!at) return true;
  // A clock that has gone backwards must not postpone this for a day.
  if (now < at) return true;
  return now - at >= REREGISTER_AFTER_MS;
}

/** How many times a failing registration is retried before it waits for the next foreground. */
export const MAX_ATTEMPTS = 6;

/**
 * How long to wait before attempt number `attempt` (1 is the first retry).
 *
 * The first retry is quick, because the overwhelmingly likely reason for
 * failure is the permission dialog still being on screen — a second or two,
 * not a network problem. It then backs off, because the second most likely
 * reason is a connection that is not there yet, and hammering it helps nobody.
 *
 * Capped at half a minute: coming back to the app re-runs all of this anyway,
 * so there is no value in a retry an hour from now.
 */
export function retryDelay(attempt: number): number {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(30000, 1500 * Math.pow(2, n - 1));
}

/** Is another attempt worth making? */
export function shouldRetry(o: { attempt: number; registered: boolean }): boolean {
  if (!o || o.registered) return false;
  return (Number(o.attempt) || 0) < MAX_ATTEMPTS;
}

/**
 * The one name a notification for a message goes by.
 *
 * The server puts this on its FCM notification as `tag` and the app puts it on
 * its own as `identifier`. Android treats a matching tag as the SAME
 * notification and replaces it, so the two paths cannot stack — whichever
 * arrives first is the one that is seen, and the other quietly takes its
 * place. That property is the whole reason both are allowed to run, and it
 * lives or dies on the two strings being identical, so there is one of them.
 */
export function notificationTag(msgId: string | number | null | undefined): string {
  const id = String(msgId ?? '');
  return id ? `msg-${id}` : '';
}

/**
 * May the app raise a notification from the socket itself?
 *
 * Only when Firebase is NOT covering this device — which is what the builds
 * that worked did, and is what was asked for after four builds of mine failed
 * to beat them:
 *
 *     if (pushRegisteredRef.current) return;  // FCM push covers notifications
 *
 * I removed that gate in 264 because the reasoning behind it looked wrong, and
 * on paper it still does: the shared tag means a second arrival replaces the
 * first, so the duplicate it guards against cannot happen, and switching the
 * socket off makes every notification wait for Google.
 *
 * The phones disagreed, four times. Whatever the mechanism — and I have
 * proposed four and been wrong about four — a registered device that ALSO
 * raises its own notification ends up showing nothing, while a registered
 * device that leaves Firebase alone shows notifications reliably and with
 * sound. v243 is the evidence and my reasoning is not.
 *
 * So the socket is the FALLBACK it used to be: it covers a device Firebase
 * has not registered, and stays out of the way of one it has.
 *
 * Fails closed for a message with no id, because without one there is no tag.
 */
export function socketRaiseAllowed(o: {
  msgId: string | number | null | undefined;
  pushRegistered?: boolean;
}): boolean {
  if (!o) return false;
  // Registered with Firebase: Firebase does it, alone.
  if (o.pushRegistered) return false;
  return !!notificationTag(o.msgId);
}
