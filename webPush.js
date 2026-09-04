// ── Notifications for browsers, and for iPhones in particular ────────────────
//
// Asked for after "can we build an iOS version and install it manually": no —
// iOS installs only what Apple has signed, and Apple does not enrol developers
// from Iran. The way an iPhone gets this app is the home screen, and since
// iOS 16.4 a PWA added to the home screen can receive push notifications like
// any other app.
//
// That is what this file is for. The Android app is pushed through Firebase;
// a browser is pushed through the Web Push protocol, which every browser
// implements against whatever endpoint it chooses (Apple's, Google's,
// Mozilla's) and which is authenticated with a VAPID key pair belonging to
// this server.
//
// Two decisions worth stating:
//
//   • THE KEYS ARE THE SERVER'S, and are generated once and kept. A VAPID
//     public key is an identity: every existing subscription is bound to it,
//     so regenerating it on restart would silently orphan every device that
//     had ever subscribed. They are read from the environment when it supplies
//     them and otherwise made once and stored in the database — these servers
//     are set up by hand, and a step somebody has to remember is a step that
//     does not happen.
//
//   • A SUBSCRIPTION THAT IS GONE IS DELETED. A browser's endpoint dies when
//     the user clears site data, uninstalls the PWA or revokes permission, and
//     the push service says so with 404 or 410. Keeping those forever means
//     every notification costs a growing pile of requests that can never
//     arrive.
let webpush = null;
let loadFailed = false;

/** Loaded lazily, so a server without the dependency still starts and runs. */
function lib() {
  if (webpush || loadFailed) return webpush;
  try { webpush = require('web-push'); }
  catch { loadFailed = true; }
  return webpush;
}

/**
 * Is this something a browser actually gave us?
 *
 * Checked rather than trusted: the endpoint is a URL this server will make
 * requests to, and the two keys are what the payload is encrypted with. A
 * subscription missing either is a row that can only ever produce errors.
 */
function validSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  const endpoint = String(sub.endpoint || '');
  if (!/^https:\/\//i.test(endpoint) || endpoint.length > 1000) return false;
  const keys = sub.keys || {};
  return !!(keys.p256dh && keys.auth
    && String(keys.p256dh).length < 200 && String(keys.auth).length < 100);
}

/**
 * Has this subscription stopped existing?
 *
 * 404 and 410 are the push service saying the endpoint is gone for good;
 * anything else (a timeout, a 500, a rate limit) is this delivery failing, not
 * the subscription, and deleting on those would unsubscribe people because
 * Apple had a bad afternoon.
 */
function isGone(statusCode) {
  return statusCode === 404 || statusCode === 410;
}

/**
 * What the service worker receives.
 *
 * Kept small on purpose: a push payload is stored by the push service until
 * the device collects it, and Apple's limit is the tightest. The body is
 * already a preview rather than the message.
 */
function payloadFor(title, body, data = {}) {
  return JSON.stringify({
    title: String(title || 'New message').slice(0, 120),
    body: String(body || '').slice(0, 200),
    roomId: data.roomId ? String(data.roomId) : '',
    roomName: data.roomName ? String(data.roomName) : '',
    msgId: data.msgId ? String(data.msgId) : '',
    // A comment names the message it hangs off, so tapping the notification
    // can open that THREAD. A comment is never in the conversation itself, so
    // without this the tap led to a chat with nothing new in it.
    parentId: data.parentId ? String(data.parentId) : '',
  });
}

/**
 * The key pair this server signs with, made once and remembered.
 *
 * `store` is a two-function shim over wherever the server keeps small values,
 * so this file never touches the database directly and can be tested.
 */
function ensureKeys(env, store) {
  const fromEnv = {
    publicKey: (env && env.VAPID_PUBLIC_KEY) || '',
    privateKey: (env && env.VAPID_PRIVATE_KEY) || '',
  };
  if (fromEnv.publicKey && fromEnv.privateKey) return fromEnv;

  const saved = {
    publicKey: store.get('vapid_public_key') || '',
    privateKey: store.get('vapid_private_key') || '',
  };
  if (saved.publicKey && saved.privateKey) return saved;

  const w = lib();
  if (!w) return null;
  const made = w.generateVAPIDKeys();
  store.set('vapid_public_key', made.publicKey);
  store.set('vapid_private_key', made.privateKey);
  return made;
}

/**
 * Send one notification.
 *
 * Resolves `{ ok }` or `{ ok: false, gone }` — never throws, because one dead
 * subscription must not take down the loop sending to everybody else.
 */
async function sendOne(sub, payload, keys, subject) {
  const w = lib();
  if (!w || !keys) return { ok: false, gone: false };
  try {
    await w.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      {
        vapidDetails: {
          subject: subject || 'mailto:admin@example.com',
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
        TTL: 60 * 60 * 24,
      },
    );
    return { ok: true, gone: false };
  } catch (err) {
    return { ok: false, gone: isGone(err && err.statusCode) };
  }
}

/** Is web push usable at all on this server? */
function available(keys) {
  return !!(lib() && keys && keys.publicKey && keys.privateKey);
}

module.exports = { validSubscription, isGone, payloadFor, ensureKeys, sendOne, available };
