// ── Najva, because Firebase does not reach these phones ─────────────────────
//
// Measured over a full day on the reporter's handset, before this existed:
//
//     pushes handed to Firebase ....... dozens, every one accepted (HTTP 200)
//     sends that failed ............... none
//     pushes that reached the phone ... 0, with a VPN as well
//
// Six real app-side faults were found and fixed on the way to that number and
// not one of them was the cause. Google accepts every message and the handset
// never sees it, and nothing in this repository reaches the part in between.
// Najva is an Iranian push service whose delivery does not depend on a
// connection to Google, which is the one thing that had to change.
//
// This module is the RULES only — what to send and how to read the answer.
// Nothing here performs a request, so all of it is testable without a network
// or a credential, which matters: every wrong turn in this saga came from a
// belief that was never checked against anything.
//
// ── CREDENTIALS ─────────────────────────────────────────────────────────────
//
// Three, and they are NOT interchangeable:
//
//   api_key     a UUID, e.g. 8b84ad3a-3daa-4520-9adc-d7528ea95a54
//               goes in the request BODY, and in the app's initialise call
//   auth token  hex, sent as `Authorization: Token <…>`
//   websiteId   a number, e.g. 12383 — the app's initialise call only
//
// None of them belongs in this repository. They are read from the environment
// and the repository has been public for long stretches.

/** Where a notification to specific devices is posted. */
const ENDPOINT = 'https://app.najva.com/notification/api/v1/notifications/';

/**
 * Is Najva usable right now?
 *
 * Both halves or neither: an api_key with no auth token is a 401 on every
 * message, and the failure would look exactly like the silence this is meant
 * to end. Checked once, up front, rather than discovered per-send.
 */
function configured(env) {
  const e = env || {};
  return !!(e.NAJVA_API_KEY && e.NAJVA_AUTH_TOKEN);
}

/**
 * The Authorization header value.
 *
 * "Token", not "Bearer". Najva's own samples use Token and the two are not
 * interchangeable — Bearer is rejected, and rejected sends are invisible from
 * the phone, which is the failure mode this whole module exists to escape.
 */
function authHeader(authToken) {
  return `Token ${authToken}`;
}

/**
 * The request body for a notification to specific subscribers.
 *
 * ── WHY UNDERSCORES ────────────────────────────────────────────────────────
 *
 * Najva's own two samples disagree about the field names for this endpoint:
 *
 *   python-api-client send_to_users … 'api-key',  'onclick-action'  (hyphens)
 *   najva-reactnative-sample App.js … 'api_key',  'onclick_action'  (under-
 *                                                                    scores)
 *
 * Both post to this same URL. The React Native sample is followed here
 * because it is a complete, runnable client of this exact endpoint, while the
 * python helper's other method (send_to_all) uses underscores against a
 * different URL — which reads like the hyphens are the stale spelling.
 *
 * This is a guess between two of the vendor's own documents, and it is the
 * only guess in this module. If Najva answers 400, the field names are why,
 * and the server logs the response body so it says so rather than going
 * quiet. See najvaFailure.
 *
 * ── NO sent_time ───────────────────────────────────────────────────────────
 *
 * Deliberately absent. The python client defaults it to THREE MINUTES from
 * now, which is a scheduled send — for a chat message that is not a
 * notification, it is an alarm clock. Omitted, Najva sends immediately, which
 * is what the React Native sample does too.
 */
function buildBody(o) {
  const opts = o || {};
  const tokens = (opts.tokens || []).filter(Boolean).map(String);
  return {
    api_key: opts.apiKey,
    title: String(opts.title == null ? '' : opts.title),
    body: String(opts.body == null ? '' : opts.body),
    // Open the app, NOT a web page. 'open-link' would send someone reading a
    // chat notification into a browser.
    onclick_action: 'open-app',
    priority: 'high',
    subscriber_tokens: tokens,
    // Carried through so a tap can open the right room, exactly as the FCM
    // payload's data does. Stringified because the field is a string field.
    ...(opts.data && Object.keys(opts.data).length
      ? { json: JSON.stringify(opts.data) }
      : {}),
  };
}

/**
 * Is this token gone for good, or did the send merely fail?
 *
 * The same distinction that cost this project a week on the Firebase side: a
 * bare failure is not proof a device has unsubscribed, and deleting a token on
 * one means that phone gets nothing until the app is next opened. So this
 * stays deliberately narrow — only an explicit statement that the subscriber
 * is unknown counts, and everything else is a failed send to be retried by the
 * next message.
 */
function tokenIsDead(status, body) {
  const text = String(body == null ? '' : body);
  if (status === 404 && /subscriber|token|not.?found/i.test(text)) return true;
  return /\b(unsubscribed|invalid[_ -]?token|unknown[_ -]?subscriber)\b/i.test(text);
}

/**
 * A one-line description of a failed send, for the log.
 *
 * Written as a function so the shape is fixed and greppable: the push report
 * pulls [najva] lines off the server, and a diagnosis that depends on someone
 * having logged the right thing at the time is not a diagnosis.
 */
function najvaFailure(status, body) {
  const text = String(body == null ? '' : body).slice(0, 300);
  return `[najva] send failed (status ${status}): ${text}`;
}

module.exports = {
  ENDPOINT, configured, authHeader, buildBody, tokenIsDead, najvaFailure,
};
