// Getting this app onto an iPhone, and getting an iPhone to ring.
//
// Asked as: "can't we build an iOS version and install it manually without the
// App Store?" — no. iOS installs only what Apple has signed, the signature
// expires, and Apple does not enrol developers from Iran. What an iPhone CAN
// have, today, with no account and no signing, is this page added to the home
// screen: a standalone app, and since iOS 16.4 one that can be pushed to.
//
// So two things, both here:
//
//   1. Safari never offers. Android and desktop Chrome fire an install prompt;
//      iOS hides "Add to Home Screen" in the share sheet, where almost nobody
//      finds it — the one platform that needs the PWA most is the one that
//      never mentions it.
//   2. A home-screen PWA is notified by WEB PUSH, which needs no Google
//      credentials and no Apple account: a VAPID key pair this server makes
//      for itself, and a subscription per browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
require(path.join(ROOT, 'public', 'js', 'installHint.js'));
const H = global.window.InstallHint;
const P = require(path.join(ROOT, 'webPush.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 13; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';

// ── Which browsers are told ─────────────────────────────────────────────────

test('THE POINT: an iPhone in Safari is told how to install', () => {
  assert.strictEqual(H.isIOS(IPHONE_SAFARI, 5), true);
  assert.strictEqual(H.isSafari(IPHONE_SAFARI), true);
  assert.strictEqual(H.shouldOffer({
    signedIn: true, ios: true, safari: true, standalone: false, dismissedAt: 0, now: 1e12,
  }), true);
});

test('an iPad pretending to be a Mac is still an iPad', () => {
  // iPadOS 13+ sends a Mac user agent; the touch points give it away.
  assert.strictEqual(H.isIOS(MAC_SAFARI, 5), true);
  assert.strictEqual(H.isIOS(MAC_SAFARI, 0), false, 'a real Mac was told to add to its home screen');
});

test('Chrome on iOS is NOT told — its share sheet is different', () => {
  // Same engine, different menu: the instructions would send somebody looking
  // for an item that is not there.
  assert.strictEqual(H.isSafari(IPHONE_CHROME), false);
  assert.strictEqual(H.isSafari('Mozilla/5.0 (iPhone) FxiOS/120 Safari/604'), false);
  assert.strictEqual(H.isSafari('Mozilla/5.0 (iPhone) EdgiOS/120 Safari/604'), false);
});

test('Android and desktop are not told, because they have a real prompt', () => {
  assert.strictEqual(H.isIOS(ANDROID_CHROME, 5), false);
  assert.strictEqual(H.isSafari(ANDROID_CHROME), false);
  assert.strictEqual(H.shouldOffer({
    signedIn: true, ios: false, safari: false, standalone: false, dismissedAt: 0, now: 1e12,
  }), false);
});

test('THE ONE THAT WOULD BE ABSURD: never inside the installed app', () => {
  // Advice to do the thing you have already done, shown inside the thing you
  // did it to.
  assert.strictEqual(H.shouldOffer({
    signedIn: true, ios: true, safari: true, standalone: true, dismissedAt: 0, now: 1e12,
  }), false);
  assert.strictEqual(H.isStandalone({ standalone: true }, null), true);
  assert.strictEqual(H.isStandalone({}, () => ({ matches: true })), true);
  assert.strictEqual(H.isStandalone({}, () => ({ matches: false })), false);
  assert.strictEqual(H.isStandalone({}, () => { throw new Error('no'); }), false);
});

test('and not before there is anything to install', () => {
  // The first thing on this page should be the sign-in form.
  assert.strictEqual(H.shouldOffer({
    signedIn: false, ios: true, safari: true, standalone: false, dismissedAt: 0, now: 1e12,
  }), false);
});

test('dismissing it means dismissed, for a good while', () => {
  const now = 1e12;
  assert.strictEqual(H.shouldOffer({
    signedIn: true, ios: true, safari: true, standalone: false, dismissedAt: now - 1000, now,
  }), false);
  assert.strictEqual(H.shouldOffer({
    signedIn: true, ios: true, safari: true, standalone: false,
    dismissedAt: now - H.SNOOZE_MS - 1, now,
  }), true, 'it never comes back, even months later');
  assert.ok(H.SNOOZE_MS >= 7 * 24 * 3600 * 1000, 'a dismissal barely lasts');
});

test('the steps are the ones Safari actually has, in order', () => {
  const s = H.steps();
  assert.ok(/share/i.test(s[0]), s[0]);
  assert.ok(/home screen/i.test(s[1]), s[1]);
});

// ── Web push ────────────────────────────────────────────────────────────────

test('a subscription is checked before it is stored', () => {
  // The endpoint is a URL this server will make requests to.
  const good = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'k', auth: 'a' } };
  assert.strictEqual(P.validSubscription(good), true);
  for (const bad of [
    null, {}, 'x',
    { endpoint: 'http://insecure.example/x', keys: { p256dh: 'k', auth: 'a' } },
    { endpoint: 'file:///etc/passwd', keys: { p256dh: 'k', auth: 'a' } },
    { endpoint: 'https://a/x' },
    { endpoint: 'https://a/x', keys: { p256dh: 'k' } },
    { endpoint: 'https://a/' + 'x'.repeat(1200), keys: { p256dh: 'k', auth: 'a' } },
  ]) {
    assert.strictEqual(P.validSubscription(bad), false, JSON.stringify(bad));
  }
});

test('only "it is gone" deletes a subscription', () => {
  // A timeout, a 500 or a rate limit is this delivery failing, not the
  // subscription — unsubscribing people because Apple had a bad afternoon
  // would be silent and permanent.
  assert.strictEqual(P.isGone(404), true);
  assert.strictEqual(P.isGone(410), true);
  for (const s of [200, 201, 429, 500, 503, undefined, null, 0]) {
    assert.strictEqual(P.isGone(s), false, String(s));
  }
});

test('the payload is small, and says which chat it is about', () => {
  const p = JSON.parse(P.payloadFor('Soran', 'see you at 8', { roomId: 42, msgId: 7 }));
  assert.strictEqual(p.title, 'Soran');
  assert.strictEqual(p.body, 'see you at 8');
  assert.strictEqual(p.roomId, '42', 'the notification could not open its chat');
  // Apple's push service has the tightest size limit of the three.
  const big = JSON.parse(P.payloadFor('t'.repeat(500), 'b'.repeat(2000), {}));
  assert.ok(big.title.length <= 120 && big.body.length <= 200, 'an over-long payload is refused whole');
  assert.strictEqual(JSON.parse(P.payloadFor(null, null, {})).title, 'New message');
});

test('THE KEYS ARE KEPT: a restart does not orphan every subscription', () => {
  // A VAPID public key is an identity — every subscription ever made is bound
  // to it. Generating a new pair on restart would silently stop notifying
  // every device that had already subscribed, with nothing to see.
  const store = new Map();
  const shim = { get: (k) => store.get(k) || '', set: (k, v) => store.set(k, v) };
  const first = P.ensureKeys({}, shim);
  if (!first) return;                       // web-push not installed here
  assert.ok(first.publicKey && first.privateKey);
  const second = P.ensureKeys({}, shim);
  assert.deepStrictEqual(second, first, 'a second start made a different key pair');
  assert.ok(store.get('vapid_public_key'), 'nothing was persisted');
});

test('…and the environment still wins, for a server that sets them by hand', () => {
  const store = new Map();
  const shim = { get: (k) => store.get(k) || '', set: (k, v) => store.set(k, v) };
  const keys = P.ensureKeys({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' }, shim);
  assert.deepStrictEqual(keys, { publicKey: 'pub', privateKey: 'priv' });
  assert.strictEqual(store.size, 0, 'keys from the environment were written to the database as well');
});

test('web push is reported unavailable rather than half-working', () => {
  assert.strictEqual(P.available(null), false);
  assert.strictEqual(P.available({ publicKey: '', privateKey: '' }), false);
  assert.strictEqual(P.available({ publicKey: 'a' }), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('a browser can be notified even with no Firebase credentials at all', () => {
  // This is the whole point for iPhones: Web Push needs nothing from Google.
  // The old function returned early when FCM was unconfigured.
  const fn = server.slice(server.indexOf('async function sendPushToUsers('), server.indexOf('// ── Web push'));
  assert.ok(fn.length > 0, 'sendPushToUsers is gone — this check would be vacuous');
  assert.ok(/sendWebPushToUsers\(userIds, title, body, data\)/.test(fn), 'browsers are never pushed to');
  assert.ok(fn.indexOf('sendWebPushToUsers') < fn.indexOf('if (!fcmCreds) return;'),
    'the web push happens after the Firebase check, so a server without Firebase sends nothing');
});

test('mutes still apply to browsers', () => {
  const fn = server.slice(server.indexOf('async function sendPushToUsers('), server.indexOf('// ── Web push'));
  assert.ok(fn.indexOf('recipientsFor(') < fn.indexOf('sendWebPushToUsers'),
    'a muted person is notified in their browser after all');
});

test('a subscription the push service calls gone is deleted', () => {
  const fn = server.slice(server.indexOf('async function sendWebPushToUsers('), server.indexOf('// Permanently remove a message'));
  assert.ok(/if \(r\.gone\)/.test(fn), 'dead endpoints are pushed to forever');
  assert.ok(/DELETE FROM web_push_subs WHERE endpoint = \?/.test(fn), 'nothing removes them');
});

test('the endpoints are there, and the key is public by definition', () => {
  assert.ok(/app\.get\('\/push\/public-key'/.test(server), 'a browser cannot get the key to subscribe with');
  assert.ok(/app\.post\('\/web-push', authMiddleware/.test(server), 'a browser cannot subscribe');
  assert.ok(/app\.delete\('\/web-push', authMiddleware/.test(server), 'a browser cannot unsubscribe');
  assert.ok(/CREATE TABLE IF NOT EXISTS web_push_subs/.test(
    fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8')), 'there is nowhere to keep a subscription');
});

test('the service worker shows the notification and opens the chat', () => {
  assert.ok(/addEventListener\('push'/.test(sw), 'a push arrives and nothing happens');
  assert.ok(/showNotification\(/.test(sw), 'nothing is shown');
  assert.ok(/addEventListener\('notificationclick'/.test(sw), 'tapping it does nothing');
  // One per chat rather than a stack of twenty from the same conversation.
  assert.ok(/tag: d\.roomId \? `room-\$\{d\.roomId\}` : 'chat'/.test(sw), 'notifications stack up');
  assert.ok(/postMessage\(\{ type: 'open-room'/.test(sw), 'an open window is reloaded instead of navigated');
  assert.ok(/const CACHE = 'chatroom-v4'/.test(sw), 'the cache name was not bumped, so old workers linger');
});

test('the page subscribes after permission, and unsubscribes on sign-out', () => {
  assert.ok(app.includes('async function subscribeWebPush()'), 'nothing ever subscribes');
  assert.ok(/Notification\.requestPermission\(\)\.then\(\(\) => subscribeWebPush\(\)\)/.test(app),
    'a granted permission does not lead to a subscription');
  assert.ok(/api\('\/web-push', 'POST', \{ subscription: sub\.toJSON\(\) \}\)/.test(app),
    'the subscription is never sent to the server');
  const out = app.slice(app.indexOf('function logout()'), app.indexOf('function logout()') + 400);
  assert.ok(out.includes('unsubscribeWebPush()'), 'signing out leaves the browser subscribed');
  assert.ok(out.indexOf('unsubscribeWebPush()') < out.indexOf('localStorage.clear()'),
    'the token is thrown away before the request that needs it');
});

test('the hint is on the page, above the composer, and can be dismissed', () => {
  assert.ok(/id="install-hint"/.test(html), 'there is no hint');
  const at = html.indexOf('id="install-hint"');
  const strip = html.indexOf('id="composer-strip"');
  assert.ok(at > 0 && strip > at, 'the hint is not in the chat column above the composer');
  assert.ok(app.includes('function maybeOfferInstall()'), 'nothing decides whether to show it');
  assert.ok(app.includes('InstallHint.shouldOffer({'), 'the page decides for itself');
  assert.ok(app.includes('function dismissInstallHint()'), 'it cannot be dismissed');
  assert.ok(/localStorage\.setItem\(InstallHint\.KEY/.test(app), 'a dismissal is forgotten on reload');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
