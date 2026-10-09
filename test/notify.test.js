// Who a notification goes to (notify.js).
//
// This exists because the rule could not previously be tested at all. Push
// delivery sits behind a check for Firebase credentials that a test
// environment has no way to satisfy, so a mute filter written inside that
// function was unreachable — and a mutation that inverted it, notifying ONLY
// the people who had asked not to be notified, passed the entire suite.
const assert = require('assert');
const N = require('../notify');
const { recipientsFor, tokenIsDead } = N;

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


// ── The burst Firebase drops ────────────────────────────────────────────────

test('THE BURST: messages in one room share a collapse key', () => {
  // Measured, from the server's own log: thirteen high-priority pushes for
  // ONE device inside three seconds, every one accepted by Firebase — nothing
  // suppressed, no send failed — and the phone showed a single notification.
  // FCM rate-limits per device and DROPS the excess rather than queueing it.
  //
  // A shared key does not raise the limit. It decides what survives: the
  // latest message in the conversation, instead of whichever push happened to
  // get through. That is the difference between "late" and "nothing".
  assert.strictEqual(N.collapseKeyFor({ roomId: '7', msgId: '101' }), 'room-7');
  assert.strictEqual(N.collapseKeyFor({ roomId: '7', msgId: '102' }), 'room-7',
    'two messages in the same room got different keys, so nothing collapses');
  assert.notStrictEqual(N.collapseKeyFor({ roomId: '8', msgId: '103' }), 'room-7',
    'different conversations must not replace each other');
});

test('…but a CALL is never collapsed', () => {
  // A missed call cannot be replaced by a later one. Calls are already sent
  // with a ttl and direct_boot_ok precisely so nothing holds them back.
  assert.strictEqual(N.collapseKeyFor({ callId: 'abc', roomId: '7' }), null,
    'a call would be dropped in favour of a chat message in the same room');
  assert.strictEqual(N.collapseKeyFor({ msgId: '1' }), null);
  assert.strictEqual(N.collapseKeyFor({}), null);
  assert.strictEqual(N.collapseKeyFor(null), null);
  assert.strictEqual(N.collapseKeyFor(undefined), null);
});

test('the server actually sends the collapse key', () => {
  const fs2 = require('fs'), path2 = require('path');
  const src = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf("priority: 'high',");
  assert.ok(i > 0, 'the android block moved');
  const block = code.slice(i, code.indexOf('notification: {', i));
  assert.ok(/collapse_key: collapseKeyFor\(data\)/.test(block),
    'collapseKeyFor exists but nothing sends its result, so bursts still drop');
});


// ── Does the socket survive the app closing? ────────────────────────────────

test('THE REASON IS THE DIAGNOSIS: it is recorded verbatim', () => {
  // socket.io's disconnect reason separates two failures that look identical
  // from the phone and need opposite fixes:
  //   ping timeout   — the connection is open, the app stopped answering. The
  //                    JavaScript is frozen or dead and the foreground service
  //                    is not keeping it alive.
  //   transport close — the connection itself went away.
  const t1 = N.presenceLine({ connected: false, userId: 1, reason: 'ping timeout', heldMs: 90_000, remaining: 0 });
  assert.ok(/reason=ping-timeout/.test(t1), t1);
  assert.ok(/held=90s/.test(t1), t1);
  const t2 = N.presenceLine({ connected: false, userId: 1, reason: 'transport close', heldMs: 1000, remaining: 0 });
  assert.ok(/reason=transport-close/.test(t2), t2);
});

test('every line is greppable by one fixed prefix', () => {
  // The push report pulls these off a live server. A diagnosis that depends
  // on somebody having logged the right thing at the time is not a diagnosis.
  assert.ok(N.presenceLine({ connected: true, userId: 3, remaining: 1 }).startsWith('[presence] connect '));
  assert.ok(N.presenceLine({ connected: false, userId: 3, remaining: 0 }).startsWith('[presence] disconnect '));
});

test('a connect line does not claim a duration it cannot know', () => {
  const line = N.presenceLine({ connected: true, userId: 3, remaining: 1 });
  assert.ok(!/held=/.test(line), line);
  assert.ok(!/reason=/.test(line), line);
});

test('NO USERNAME, because this is read into a public repository', () => {
  const line = N.presenceLine({
    connected: false, userId: 7, username: 'sara', reason: 'ping timeout',
    heldMs: 5000, remaining: 0,
  });
  assert.ok(!/sara/.test(line), `the presence log leaks who was online: ${line}`);
});

test('missing pieces read as "?" rather than as NaN or undefined', () => {
  const line = N.presenceLine({ connected: false });
  assert.ok(!/NaN|undefined/.test(line), line);
  assert.ok(/user=\?/.test(line), line);
  assert.ok(/reason=unknown/.test(line), line);
  assert.ok(!/NaN|undefined/.test(N.presenceLine(null)));
});

test('the server actually logs both events, with the reason', () => {
  const fs2 = require('fs'), path2 = require('path');
  const src = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/presenceLine\(\{\s*connected: true/.test(code), 'connects are never logged');
  assert.ok(/socket\.on\('disconnect', \(reason\)/.test(code),
    'the disconnect handler does not take the reason, which is the whole diagnosis');
  assert.ok(/heldMs: Date\.now\(\) - connectedAt/.test(code),
    'nothing records how long the socket lasted before it dropped');
});

// ── A notification for a message from hours ago ────────────────────────────
//
// Reported as: notifications for messages received hours earlier and already
// seen and read. Nothing re-sends them. Firebase QUEUES a push for a device
// that is offline and delivers it when the device returns — for four weeks,
// by default, and only calls ever said otherwise.

const HOUR = 60 * 60 * 1000;

test('A MESSAGE PUSH NOW HAS A LIFETIME AT ALL', () => {
  // The whole bug in one assertion. Without this Firebase keeps it for four
  // weeks and hands over the backlog whenever the phone reappears.
  assert.ok(N.PUSH_TTL_MS > 0, 'message pushes still live for ever');
  assert.ok(N.PUSH_TTL_MS <= 4 * HOUR,
    `a push is kept for ${N.PUSH_TTL_MS / HOUR}h, which is the reported problem`);
  assert.strictEqual(N.pushTtl(N.PUSH_TTL_MS), '3600s');
  assert.strictEqual(N.pushTtl(45000), '45s', 'a call ttl is written differently');
  assert.strictEqual(N.pushTtl(0), null, 'a meaningless lifetime is still sent');
  assert.strictEqual(N.pushTtl('x'), null);
});

test('THE SERVER STAMPS AND BOUNDS EVERY PUSH IN ONE PLACE', () => {
  // Seven call sites. Doing it at each is how one of them gets left out.
  const fs2 = require('fs'), path2 = require('path');
  const src = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
  const fn = /async function sendPushToUsers\(userIds, title, body, data = \{\}, android = \{\}\) \{([\s\S]*?)\n  if \(!fcmCreds\) return;/.exec(src);
  assert.ok(fn, 'could not find sendPushToUsers');
  assert.ok(/data = \{ sentAt: Date\.now\(\), \.\.\.data \}/.test(fn[1]),
    'pushes are not stamped with when they were sent');
  assert.ok(/android = \{ ttl: pushTtl\(PUSH_TTL_MS\), \.\.\.android \}/.test(fn[1]),
    'message pushes still have no lifetime');
  // The spread order matters — a call's own 45 seconds must survive it — and
  // that is proven by running it, in the next test, rather than by an
  // arithmetic comparison of string positions that cannot fail.
});

test('A CALL KEEPS ITS OWN SHORTER LIFETIME', () => {
  const fs2 = require('fs'), path2 = require('path');
  const src = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/ttl: '45s'/.test(src), 'a missed call can now be delivered an hour late');
  // Proving the spread order does what it claims, rather than reading it.
  const merge = (android) => ({ ttl: N.pushTtl(N.PUSH_TTL_MS), ...android });
  assert.strictEqual(merge({ ttl: '45s' }).ttl, '45s', "a call's lifetime was overwritten");
  assert.strictEqual(merge({}).ttl, '3600s', 'a message got no lifetime');
});

test('DIRECT BOOT STAYED WITH CALLS, and did not follow the lifetime', () => {
  // These were one condition. Giving messages a lifetime would have made
  // every message direct-boot deliverable as a side effect — and in direct
  // boot the app's own storage is still encrypted, so there is nothing
  // behind such a notification.
  const fs2 = require('fs'), path2 = require('path');
  const src = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!/ttl: android\.ttl, direct_boot_ok: true/.test(src),
    'direct boot is still tied to having a lifetime');
  assert.ok(/android\.directBootOk \? \{ direct_boot_ok: true \}/.test(src),
    'direct boot is no longer offered to calls at all');
  assert.ok(/directBootOk: true/.test(src), 'the call push no longer asks for direct boot');
});

test('A PUSH OLDER THAN THE BACKSTOP IS NOT DRAWN', () => {
  const now = 1_700_000_000_000;
  assert.strictEqual(N.pushIsStale({ sentAt: now - 7 * HOUR, now }), true);
  assert.strictEqual(N.pushIsStale({ sentAt: now - 5 * HOUR, now }), false);
  assert.strictEqual(N.pushIsStale({ sentAt: now - 1000, now }), false);
});

test('…AND IT FAILS OPEN EVERY OTHER WAY', () => {
  // Suppressing a notification is a SILENT failure: "I get no notifications"
  // is a worse report than "I got one late", and it is the report this whole
  // file exists because of. So every uncertainty shows the notification.
  const now = 1_700_000_000_000;
  assert.strictEqual(N.pushIsStale({ now }), false, 'an unstamped push is refused');
  assert.strictEqual(N.pushIsStale({ sentAt: 'nonsense', now }), false);
  assert.strictEqual(N.pushIsStale({ sentAt: 0, now }), false);
  assert.strictEqual(N.pushIsStale({ sentAt: -5, now }), false);
  assert.strictEqual(N.pushIsStale({ sentAt: now - HOUR }), false, 'no clock means no judgement');
  assert.strictEqual(N.pushIsStale(null), false);
  // A phone whose clock is BEHIND the server sees every push as from the
  // future. That is a clock disagreement, not an age — and the gap can be a
  // whole time zone, so it is tested well past the backstop. At three hours
  // this passed against a version that simply took the absolute difference,
  // which would silence a phone whose clock is wrong in the other direction.
  assert.strictEqual(N.pushIsStale({ sentAt: now + 3 * HOUR, now }), false,
    'a phone with a slow clock refuses everything it is sent');
  assert.strictEqual(N.pushIsStale({ sentAt: now + 13 * HOUR, now }), false,
    'a phone a time zone behind refuses everything it is sent');
  assert.strictEqual(N.pushIsStale({ sentAt: now + 400 * HOUR, now }), false,
    'a wildly wrong clock silences the phone instead of showing the message');
});

test('THE BACKSTOP IS FAR ENOUGH OUT THAT A WRONG CLOCK CANNOT SILENCE A PHONE', () => {
  // The two numbers are different on purpose. Firebase judges its hour by
  // its own clock; the phone judges this one by a clock that is routinely
  // wrong by an hour and occasionally by a day's worth of time zone.
  assert.ok(N.STALE_PUSH_MS >= 4 * HOUR,
    `a device whose clock is ${N.STALE_PUSH_MS / HOUR}h fast would refuse everything`);
  assert.ok(N.STALE_PUSH_MS > N.PUSH_TTL_MS,
    'the phone is stricter than Firebase, which is the dangerous way round');
});

// ── Not pushing what the socket already delivered ──────────────────────────
//
// Reported as: "don't send firebase notification of a message already arrived
// through socket and opened". Both routes are deliberate — Firebase does not
// reach every device on these networks, and the socket is gone once the
// process is killed — so when both work, both arrive. The phone draws only
// one of them, but the push was still sent and still queued to be handed over
// later if the phone drops off in between.

test('A MESSAGE TO A CONNECTED DEVICE WAITS', () => {
  assert.strictEqual(N.heldForSocket({ msgId: 5, online: true }), true);
  assert.strictEqual(N.heldForSocket({ msgId: '5', online: true }), true);
});

test('…AND ONE TO A DEVICE THAT IS GONE DOES NOT', () => {
  // The case the push exists for. Holding it here would delay every
  // notification to a phone whose app Android has killed, which is most of
  // them.
  assert.strictEqual(N.heldForSocket({ msgId: 5, online: false }), false);
  assert.strictEqual(N.heldForSocket({ msgId: 5 }), false);
});

test('A CALL IS NEVER HELD', () => {
  // A call is worth something for about thirty seconds in total. It also
  // carries no message id, so there would be nothing to acknowledge it by
  // and the hold could only ever expire.
  assert.strictEqual(N.heldForSocket({ online: true }), false, 'a ringing call waits five seconds');
  assert.strictEqual(N.heldForSocket({ msgId: null, online: true }), false);
  assert.strictEqual(N.heldForSocket({ msgId: '', online: true }), false);
  assert.strictEqual(N.heldForSocket(null), false);
});

test('THE WAIT IS SHORT, and shorter than the lifetime of the push', () => {
  assert.ok(N.SOCKET_GRACE_MS >= 1000, 'too short for a round trip and a native call');
  assert.ok(N.SOCKET_GRACE_MS <= 15000, 'a phone killed in the gap waits this long to be told');
  assert.ok(N.SOCKET_GRACE_MS < N.PUSH_TTL_MS, 'the push expires before it is even sent');
});

test('THE SERVER HOLDS, CANCELS, AND STILL SENDS WHEN NOBODY ANSWERS', () => {
  const fs2 = require('fs'), path2 = require('path');
  const src = fs2.readFileSync(path2.join(__dirname, '..', 'server.js'), 'utf8');

  // Held per recipient, by asking the rule about each one.
  assert.ok(/heldForSocket\(\{ msgId, online: isUserOnline\(id\) \}\)/.test(src),
    'the hold does not depend on whether that device is actually connected');
  // The waiting itself — that a hold ends in a send, that cancelling stops
  // it, that nothing is left behind — is run as code in pushHold.test.js.
  // What belongs here is that the server uses it, and with the real wait.
  assert.ok(/const pushHolder = createHolder\(SOCKET_GRACE_MS\)/.test(src),
    'the server holds pushes with its own timing rather than the shared rule');
  assert.ok(/require\('\.\/pushHold'\)/.test(src), 'the server keeps a second copy of the waiting');
  assert.ok(/pushHolder\.hold\(id, msgId,/.test(src), 'nothing is ever held');

  // And the cancel is keyed to the authenticated account, not to anything the
  // client chooses — otherwise a client could silence someone else.
  assert.ok(/pushHolder\.cancel\(socket\.user\.id, String\(id\)\)/.test(src),
    'a client can cancel a push for an account that is not its own');

  // One send path, used both immediately and after the wait: two would drift.
  assert.ok(/async function deliverPush\(userIds, title, body, data, android\)/.test(src),
    'the delayed send is a second copy of the sending code');
  assert.ok(/\(\) => deliverPush\(\[id\], title, body, data, android\)/.test(src),
    'the held push is sent by something other than the normal path');
});

test('THE APP ACKNOWLEDGES ONLY AFTER IT HAS ACTUALLY DRAWN ONE', () => {
  // Acknowledging optimistically would drop the push for a notification that
  // then failed to draw, and the message would arrive in silence.
  const fs2 = require('fs'), path2 = require('path');
  const sn = fs2.readFileSync(path2.join(__dirname, '..', 'native-app', 'src',
    'socketNotifier.ts'), 'utf8');
  assert.ok(/socket\.emit\('notified', \{ msgId: msg\.id \}\)/.test(sn),
    'the app never tells the server it drew the notification');
  const ok = sn.indexOf("socket.emit('notified'");
  const raised = sn.indexOf("notifyDiag.record('socket-raised')");
  const failed = sn.indexOf("notifyDiag.record('socket-failed'");
  assert.ok(raised > 0 && ok > raised, 'the acknowledgement does not follow the notification');
  assert.ok(failed > ok, 'the acknowledgement is sent on the failure path too');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
