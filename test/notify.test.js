// Who a notification goes to (notify.js).
//
// This exists because the rule could not previously be tested at all. Push
// delivery sits behind a check for Firebase credentials that a test
// environment has no way to satisfy, so a mute filter written inside that
// function was unreachable — and a mutation that inverted it, notifying ONLY
// the people who had asked not to be notified, passed the entire suite.
const assert = require('assert');
const { recipientsFor, tokenIsDead } = require('../notify');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** 2 has muted 1; nobody else has muted anyone. */
const isMuted = (who, about) => who === 2 && about === 1;
const never = () => false;

test('with nobody muted, everyone is notified', () => {
  assert.deepStrictEqual(recipientsFor([2, 3, 4], 1, never), [2, 3, 4]);
});

test('THE POINT: someone who muted the sender is not notified', () => {
  assert.deepStrictEqual(recipientsFor([2, 3, 4], 1, isMuted), [3, 4]);
});

test('THE INVERSION THAT SLIPPED THROUGH: muting is not a whitelist', () => {
  // A filter written the wrong way round notifies exactly the people who
  // asked not to be. Spelled out as its own test because it is the mistake
  // that actually happened, and it looks almost identical in the source.
  const out = recipientsFor([2, 3, 4], 1, isMuted);
  assert.ok(!out.includes(2), 'the one person who muted the sender was notified');
  assert.ok(out.includes(3) && out.includes(4), 'everyone else was silenced instead');
});

test('a mute is about ONE person, not about notifications in general', () => {
  // 2 muted 1. A message from 5 must still reach them.
  assert.deepStrictEqual(recipientsFor([2, 3], 5, isMuted), [2, 3]);
});

test('nobody is notified about their own message', () => {
  // Every caller filters this out already. Doing it here as well means a
  // caller that forgets cannot cause it.
  assert.deepStrictEqual(recipientsFor([1, 2, 3], 1, never), [2, 3]);
});

test('a notification with no sender is not filtered', () => {
  // A system notice has nobody to have muted.
  assert.deepStrictEqual(recipientsFor([1, 2, 3], null, isMuted), [1, 2, 3]);
  assert.deepStrictEqual(recipientsFor([1, 2, 3], undefined, isMuted), [1, 2, 3]);
});

test('an empty or missing list is not an error', () => {
  assert.deepStrictEqual(recipientsFor([], 1, isMuted), []);
  assert.deepStrictEqual(recipientsFor(null, 1, isMuted), []);
  assert.deepStrictEqual(recipientsFor(undefined, null, isMuted), []);
});

test('the caller\'s list is never modified', () => {
  const original = [1, 2, 3];
  recipientsFor(original, 1, isMuted);
  assert.deepStrictEqual(original, [1, 2, 3]);
  // …including on the no-sender path, which returns a copy rather than the
  // array it was handed.
  const same = [1, 2];
  assert.notStrictEqual(recipientsFor(same, null, isMuted), same);
});

// ── When a device token is thrown away ──────────────────────────────────────
//
// Deleting a push token is not a small thing: the device then gets no push
// notifications at all until the app is next opened and registers again, which
// from the outside looks exactly like "notifications are not received at the
// time".
//
// The rule has been wrong twice, in the same way both times: reading a STATUS
// CODE as a verdict about the token.
//
//   1. `status === 400` — FCM answers 400 INVALID_ARGUMENT for a malformed
//      MESSAGE, which says nothing about the token. One such payload deleted
//      the token of every device it was sent to.
//   2. `status === 404` — which assumed a 404 could only have come from
//      Firebase. These servers reach fcm.googleapis.com across a network that
//      filters it, and a middlebox 404 is identical from here except in the
//      body. That one silenced real devices, and is what "notifications worked
//      until build 255" turned out to be.
//
// Only the BODY says a token is dead. The status alone never does.

test('THE BUG: a malformed message does not cost a phone its notifications', () => {
  const invalidArgument = JSON.stringify({
    error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid value at message.android' },
  });
  assert.strictEqual(tokenIsDead(400, invalidArgument), false,
    'a payload Firebase disliked deleted a perfectly good token');
  // …and a 500 from Google, or a proxy's HTML error page, is not a verdict on
  // the token either.
  assert.strictEqual(tokenIsDead(500, '<html>502 Bad Gateway</html>'), false);
  assert.strictEqual(tokenIsDead(503, ''), false);
  assert.strictEqual(tokenIsDead(401, JSON.stringify({ error: { status: 'UNAUTHENTICATED' } })), false);
});

test('a token Firebase no longer knows IS thrown away', () => {
  // Otherwise the table fills with tokens for uninstalled apps and every send
  // pays for them. But it has to be FIREBASE saying so — see the test below,
  // which is the case this line used to get wrong.

  assert.strictEqual(tokenIsDead(404, JSON.stringify({
    error: { details: [{ errorCode: 'UNREGISTERED' }] },
  })), true);
  assert.strictEqual(tokenIsDead(200, JSON.stringify({
    error: { details: [{ errorCode: 'UNREGISTERED' }] },
  })), true, 'an UNREGISTERED token is kept because the status was not 404');
});

test('THE SILENCE: a bare 404 is not Firebase saying anything', () => {
  // Reported as: push notifications worked until build 255 and not since.
  //
  // This asserted tokenIsDead(404, '') === true, which was the belief that a
  // 404 could only have come from Firebase. These servers reach
  // fcm.googleapis.com across a network that filters it, and a middlebox
  // answering 404 with an HTML page looks identical from here — except in the
  // body, which is exactly what was not being read.
  //
  // So a filtered request deleted a live token, and that phone got nothing
  // afterwards. Until build 256 the app re-sent its token on every launch and
  // the row came back unnoticed; from 256 it only spoke up when the token
  // changed, and the deletion became permanent.
  assert.strictEqual(tokenIsDead(404, '<html>404 Not Found</html>'), false,
    'a proxy error page still costs a device every notification it will get');
  assert.strictEqual(tokenIsDead(404, ''), false,
    'a 404 with no body is still read as proof the token is gone');
  assert.strictEqual(tokenIsDead(404, 'null'), false);
  assert.strictEqual(tokenIsDead(404, '{}'), false);
  // A transient failure was never a dead token, and still is not.
  assert.strictEqual(tokenIsDead(502, 'Bad Gateway'), false);
  assert.strictEqual(tokenIsDead(500, ''), false);
  assert.strictEqual(tokenIsDead(429, ''), false);
});

test('a token belonging to another Firebase project is thrown away too', () => {
  // This server can never deliver to it, so keeping it is just a failing send
  // on every message for ever.
  assert.strictEqual(tokenIsDead(403, JSON.stringify({
    error: { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] },
  })), true);
  // But not every 403 — a credentials problem on this side must not delete
  // everybody's tokens.
  assert.strictEqual(tokenIsDead(403, JSON.stringify({
    error: { status: 'PERMISSION_DENIED' },
  })), false);
});

test('an unparseable body is not read as a verdict', () => {
  assert.strictEqual(tokenIsDead(400, undefined), false);
  assert.strictEqual(tokenIsDead(400, null), false);
  assert.strictEqual(tokenIsDead(400, '{'), false);
  assert.strictEqual(tokenIsDead(400, '{"error":null}'), false);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
