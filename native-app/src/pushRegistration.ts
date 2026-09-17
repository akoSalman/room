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

/**
 * Is there anything to tell the server?
 *
 * The comparison against what was last sent is what keeps this from POSTing on
 * every foreground: the answer is normally no, and the work is a string
 * compare. When Firebase reissues the token the answer becomes yes on its own,
 * with nothing needing to notice the reissue.
 */
export function needsSend(o: {
  granted: boolean; token: string | null | undefined; sentToken: string | null | undefined;
}): boolean {
  if (!o || !o.granted) return false;
  const token = String(o.token || '');
  if (!token) return false;
  return token !== String(o.sentToken || '');
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

// `socketFallbackAllowed` used to live here: "raise the notification from the
// socket only while no push token is registered".
//
// It is gone because the premise turned out to be backwards. It treated the
// socket as a stand-in for a push that had not arrived, so once registration
// succeeded the app went quiet and waited for FCM — which, measured, is the
// slow path for these users by minutes. The socket is the FAST one.
//
// The decision now lives in stayConnected.ts as `shouldRaiseLocally`, which
// does not ask about registration at all; the two notifications share a tag so
// both arriving shows one.
