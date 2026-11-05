// Ringing from the socket instead of from Google
// (native-app/src/callRing.ts, callRinger.ts, incomingCall.ts, callPush.ts).
//
// Reported as: I am calling this phone, the connection is fine, and it does
// not ring on the receiver until I open the app.
//
// THE CAUSE. ringIncoming() — the looping, full-screen, Accept/Decline ring —
// had exactly one caller in the whole app: the FCM background task in
// callPush.ts. So the phone rang if and only if a Google push was delivered.
// The push report says what that means here:
//
//     NAJVA configured in the service environment: NO
//     tokens by provider:  fcm|6
//     users who have sent a message in the last 7 days: 15
//     …of those, how many have NO push token:            9
//
// Nine of fifteen active users have no token at all, and the networks these
// phones are on throttle what is left.
//
// Meanwhile the offer was ALREADY ARRIVING on the socket the whole time. The
// server emits call_offer to the callee before it even considers a push; the
// keep-alive foreground service holds that socket open with the app closed,
// and every device in the report says keepalive=running. What callManager did
// with the offer was startTone('callee') — an in-app expo-av tone — and a
// React screen. With the app closed there is no screen and no audio session,
// so the offer landed and nothing happened. Opening the app makes the server
// re-deliver the pending offer, which is why it rings THEN, and why this
// looked like a push fault rather than a missing route.
//
// keepAlive.ts's own first line is "Keeping the socket alive, so notifications
// do not need Google". Messages have used that route for weeks through
// socketNotifier.ts. Calls were never wired to it.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NATIVE = path.join(__dirname, '..', 'native-app');
const SRC = path.join(NATIVE, 'src');
const TSC = path.join(NATIVE, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping call-ring tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'callring-'));
execFileSync(TSC, [
  path.join(SRC, 'callRing.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
], { stdio: 'pipe' });
const R = require(path.join(OUT, 'callRing.js'));

const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const ringerSrc = read('callRinger.ts');
const incomingSrc = read('incomingCall.ts');
const pushSrc = read('callPush.ts');
const appSrc = fs.readFileSync(path.join(NATIVE, 'App.tsx'), 'utf8');
const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Comments describe the bug at length in these files; a regex that matches
// them proves nothing. Every structural assertion below runs on this.
const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

const tests = [];
const test = (n, f) => tests.push({ n, f });

const OFFER = { event: 'call_offer', fromUserId: 7, appState: 'background' };

// ── THE RULES ───────────────────────────────────────────────────────────────

test('THE FIX: a DM offer with the app closed rings', () => {
  // The whole report in one assertion. Before this module the answer was
  // "nothing happens unless Google delivered a push".
  const d = R.ringDecision({ ...OFFER, ringingFrom: null, now: 1000 });
  assert.strictEqual(d.ring, true, 'a DM offer with the app in the background must ring');
  assert.strictEqual(d.reason, 'ok');
});

test('onAny delivers every event, so anything but an offer is refused', () => {
  // callRinger attaches with onAny — see the test further down for why — so
  // this function is the filter, and it sees message_received, presence,
  // typing and everything else the socket carries.
  for (const event of ['message_received', 'call_answer', 'call_ice', 'typing', '', null]) {
    const d = R.ringDecision({ ...OFFER, event });
    assert.strictEqual(d.ring, false, `${event} must not ring`);
    assert.strictEqual(d.reason, 'not-an-offer');
  }
});

test('a ROOM call never rings', () => {
  // The server draws this line itself: `if (!roomId)` guards both the pending
  // call and the push. Joining a room call is a choice, not something that
  // rings at you — ringing here would set off every member's phone whenever
  // any two of them spoke.
  for (const roomId of [1, '1', 42, '42']) {
    const d = R.ringDecision({ ...OFFER, roomId });
    assert.strictEqual(d.ring, false, `roomId=${roomId} must not ring`);
    assert.strictEqual(d.reason, 'room-call');
  }
  // …and the absence of a room must not be mistaken for one. The server sends
  // `roomId: roomId || null` on every offer, so null is what a DM looks like
  // and an empty string is what a sloppy client would send.
  for (const roomId of [null, undefined, '']) {
    assert.strictEqual(R.ringDecision({ ...OFFER, roomId }).ring, true,
      `roomId=${JSON.stringify(roomId)} is a DM and must ring`);
  }
});

test('an offer with no sender is refused', () => {
  // The notification's Decline action and App.tsx's auto-accept both key off
  // data.fromUserId, so a ring without one is a dead end: it cannot be
  // answered and cannot be declined.
  // 0 is in this list deliberately. String(0) is '0', which is TRUTHY, so a
  // truthiness test on the string form rings for sender 0 and then hands 0 to
  // a notification whose Accept and Decline both open with
  // `if (!fromUserId) return` — a ring that is real and two buttons that do
  // nothing. The first version of this module had exactly that bug and this
  // case is what found it.
  for (const fromUserId of [null, undefined, '', 0, '0', -1, NaN, 'nobody', {}]) {
    const d = R.ringDecision({ ...OFFER, fromUserId });
    assert.strictEqual(d.ring, false, `fromUserId=${JSON.stringify(fromUserId)} must not ring`);
    assert.strictEqual(d.reason, 'no-sender');
  }
  // A real id in either of the shapes it actually arrives in.
  for (const fromUserId of [7, '7']) {
    assert.strictEqual(R.ringDecision({ ...OFFER, fromUserId }).ring, true,
      `fromUserId=${JSON.stringify(fromUserId)} is a real sender and must ring`);
  }
});

test('not while the app is in front of the person', () => {
  // callManager's own incoming-call screen and its callee tone are already
  // doing this; a full-screen notification over the top is a second ring over
  // the first. Same rule and same reason as socketNotifier's 'app-active'.
  const d = R.ringDecision({ ...OFFER, appState: 'active' });
  assert.strictEqual(d.ring, false);
  assert.strictEqual(d.reason, 'app-active');
  // Every other state is the case this module exists for. 'background' is the
  // app swiped away with the keep-alive service holding the socket;
  // 'inactive' is the transition; null is a headless process that has no
  // AppState worth the name.
  for (const appState of ['background', 'inactive', null, undefined, 'unknown']) {
    assert.strictEqual(R.ringDecision({ ...OFFER, appState }).ring, true,
      `appState=${JSON.stringify(appState)} must ring`);
  }
});

// ── ONE RING PER CALLER ─────────────────────────────────────────────────────

test('the same offer arriving again does not restart the ring', () => {
  // The server re-delivers the pending offer on EVERY reconnect, and one
  // device in the report drops and returns every 26 to 161 seconds. Each
  // delivery re-posts the notification, and re-posting a loopSound
  // notification restarts the tone from the beginning — so an unanswered call
  // would ring in bursts for as long as the socket flapped.
  const d = R.ringDecision({ ...OFFER, ringingFrom: 7, ringingSince: 1000, now: 1500 });
  assert.strictEqual(d.ring, false);
  assert.strictEqual(d.reason, 'already-ringing');
  // Matching on value, not identity: fromUserId arrives as a number from the
  // socket and as a string from the notification payload, and a === between
  // those is the oldest bug in this app.
  assert.strictEqual(
    R.ringDecision({ ...OFFER, fromUserId: '7', ringingFrom: 7, ringingSince: 1000, now: 1500 }).reason,
    'already-ringing');
  assert.strictEqual(
    R.ringDecision({ ...OFFER, fromUserId: 7, ringingFrom: '7', ringingSince: 1000, now: 1500 }).reason,
    'already-ringing');
});

test('a DIFFERENT caller replaces the ring', () => {
  // What the single notification id does anyway, and what the server's push
  // tag has always done: "One tag, so a second offer replaces the first
  // rather than stacking." Refusing here would silently drop a second
  // caller's call while the first was still ringing unanswered.
  const d = R.ringDecision({ ...OFFER, fromUserId: 9, ringingFrom: 7, ringingSince: 1000, now: 1500 });
  assert.strictEqual(d.ring, true);
});

test('a claim EXPIRES, so the next real call from the same person rings', () => {
  // Without the age test this is "the same caller is refused for the life of
  // the process": ring once, miss it, and that person can never make your
  // phone ring again until the app is force-killed.
  const atTheLimit = R.ringDecision({
    ...OFFER, ringingFrom: 7, ringingSince: 1000, now: 1000 + R.RING_CLAIM_MS,
  });
  assert.strictEqual(atTheLimit.ring, true, 'a claim as old as the ring itself is spent');
  const after = R.ringDecision({
    ...OFFER, ringingFrom: 7, ringingSince: 1000, now: 1000 + R.RING_CLAIM_MS + 1,
  });
  assert.strictEqual(after.ring, true);
  // Just inside it is still held.
  assert.strictEqual(R.ringDecision({
    ...OFFER, ringingFrom: 7, ringingSince: 1000, now: 1000 + R.RING_CLAIM_MS - 1,
  }).ring, false);
});

test('a claim with no timestamp does not block for ever', () => {
  // Defensive, and the reason is specific: ringingSince comes from module
  // state, and a claim recorded without a clock would otherwise be
  // permanent — the same "never expires" shape as the bug above.
  assert.strictEqual(R.ringDecision({
    ...OFFER, ringingFrom: 7, ringingSince: 0, now: 5000,
  }).ring, true);
  assert.strictEqual(R.ringDecision({
    ...OFFER, ringingFrom: 7, ringingSince: null, now: 5000,
  }).ring, true);
});

// ── THE CLAIM, WHICH IS WHAT THE TWO ROUTES SHARE ───────────────────────────

test('claimRing takes the claim on a yes and not on a no', () => {
  R.releaseRing();
  assert.deepStrictEqual(R._state(), { ringingFrom: null, ringingSince: 0 });

  const first = R.claimRing({ event: 'call_offer', fromUserId: 7, appState: 'background' }, 1000);
  assert.strictEqual(first.ring, true);
  assert.deepStrictEqual(R._state(), { ringingFrom: '7', ringingSince: 1000 });

  // The second route for the SAME call — this is the double-ring the shared
  // claim exists to prevent, for the six devices that do have an FCM token
  // and so receive the offer twice.
  const second = R.claimRing({ event: 'call_offer', fromUserId: 7, appState: 'background' }, 1200);
  assert.strictEqual(second.ring, false);
  assert.strictEqual(second.reason, 'already-ringing');
  // And a refusal must not move the claim, or each duplicate would push the
  // expiry out and the claim would never age while they kept arriving.
  assert.deepStrictEqual(R._state(), { ringingFrom: '7', ringingSince: 1000 });

  // A refused offer of any other kind must not take the claim either.
  R.claimRing({ event: 'call_offer', fromUserId: 9, roomId: 3, appState: 'background' }, 1300);
  assert.deepStrictEqual(R._state(), { ringingFrom: '7', ringingSince: 1000 });
});

test('releaseRing frees it immediately', () => {
  R.releaseRing();
  R.claimRing({ event: 'call_offer', fromUserId: 7, appState: 'background' }, 1000);
  R.releaseRing();
  assert.deepStrictEqual(R._state(), { ringingFrom: null, ringingSince: 0 });
  // The point of releasing: the same person can ring again at once, rather
  // than after the claim times out. Answering and hanging up then being
  // called straight back is ordinary behaviour.
  assert.strictEqual(
    R.claimRing({ event: 'call_offer', fromUserId: 7, appState: 'background' }, 1001).ring,
    true);
  R.releaseRing();
});

// ── ONE CONSTANT, NOT TWO COPIES ────────────────────────────────────────────

test('the ring notification and the claim on it are the SAME value', () => {
  // The calls channel and the push tag have each been broken before by one
  // value living in two files and being changed in one. So incomingCall.ts
  // does not repeat 45000 — it imports it, and there is no second literal to
  // drift.
  const c = code(incomingSrc);
  assert.match(c, /timeoutAfter:\s*RING_CLAIM_MS/,
    'the notification must take its timeout from the shared constant');
  assert.match(c, /import\s*\{[^}]*RING_CLAIM_MS[^}]*\}\s*from\s*'\.\/callRing'/,
    'and must import it from callRing');
  assert.doesNotMatch(c, /timeoutAfter:\s*\d/,
    'no literal timeout may remain beside the shared one');
  assert.strictEqual(typeof R.RING_CLAIM_MS, 'number');
  assert.ok(R.RING_CLAIM_MS > 0);
});

test('stopRinging gives the claim back, whatever notifee does', () => {
  // Every ending — answered here, declined from the shade, cancelled by the
  // caller, timed out — arrives at stopRinging, so it is the one place the
  // release cannot be forgotten. And it must happen even if
  // cancelNotification throws, or a second call from the same person is
  // refused as a duplicate of a ring that has already stopped.
  const c = code(incomingSrc);
  const fn = c.slice(c.indexOf('export async function stopRinging'));
  const body = fn.slice(0, fn.indexOf('}', fn.indexOf('cancelNotification')) + 1);
  assert.match(body, /releaseRing\(\)/, 'stopRinging must release the claim');
  assert.ok(body.indexOf('releaseRing()') < body.indexOf('cancelNotification'),
    'the release must come BEFORE the call that can throw');
});

// ── THE WIRING, WHICH IS WHERE THIS CLASS OF BUG LIVES ──────────────────────

test('the ringer is attached per socket, not handed one and left', () => {
  // api.ts says it above onSocket: "Handing a socket out once and hoping
  // nothing replaces it is the bug." It has been found four times in this
  // app — locationManager.startSharing, callManager.doInit, the parked-push
  // collection, reportCall — so the ringer goes on the subscription that
  // already feeds socketNotifier rather than on a socket captured once.
  const c = code(appSrc);
  assert.match(c, /callRinger\.attach\(sock\)/,
    'App.tsx must attach the ringer to the subscribed socket');
  // Brace-matched rather than cut at the first '});'. The attach beside it —
  // socketNotifier.attach(sock, { pushRegistered: … }) — ends in '});' of its
  // own, so a naive slice stops one line into the block and reports the
  // ringer as outside a subscription it is inside. The first version of this
  // test did exactly that and failed on correct code.
  const start = c.indexOf('onSocket(sock =>');
  assert.ok(start >= 0, 'the onSocket subscription must still exist');
  let depth = 0, end = -1;
  for (let i = c.indexOf('{', start); i < c.length; i++) {
    if (c[i] === '{') depth++;
    else if (c[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > start, 'could not find the end of the onSocket callback');
  const block = c.slice(start, end);
  assert.match(block, /callRinger\.attach\(sock\)/,
    'and it must be INSIDE the onSocket subscription, not beside it');
  // Sign-out must let go, like the message notifier.
  assert.match(c, /callRinger\.detach\(\)/);
});

test('attach is idempotent per socket', () => {
  // Re-attaching on every onSocket callback is the normal case: the same
  // socket is handed to every new subscriber. Without this guard each one
  // adds another onAny and the phone rings once per attach.
  const c = code(ringerSrc);
  assert.match(c, /if\s*\(\s*!socket\s*\|\|\s*attachedTo\s*===\s*socket\s*\)\s*return/,
    'attach must refuse a socket it is already on');
});

test('onAny, so no screen can remove the ring listener', () => {
  // socket.io's off() with no handler removes EVERY listener for an event.
  // Two screens already do that to 'message_received' and took
  // socketNotifier's listener with them, from files that had never heard of
  // it — "works when open, not when closed" for weeks. Nothing does it to a
  // call event today, and onAny means nothing added later can.
  const c = code(ringerSrc);
  assert.match(c, /socket\.onAny\(/, 'the ringer must listen with onAny');
  assert.doesNotMatch(c, /socket\.on\(\s*['"]call_offer['"]/,
    'and must not use on(call_offer), which a stray off() would remove');
});

test('the ringer stops the ring when the caller gives up', () => {
  // callManager does this from its own call_end handler, and callManager is
  // exactly what is not running in the case this file exists for. Without it
  // a caller who dials by mistake and hangs up at once leaves a phone
  // ringing in somebody's pocket for the notification's full timeout.
  const c = code(ringerSrc);
  assert.match(c, /event\s*===\s*'call_end'/);
  const end = c.slice(c.indexOf("'call_end'"));
  assert.match(end.slice(0, 200), /stopRinging\(\)/,
    'call_end must stop the ring');
});

test('the caller is told the phone is actually ringing', () => {
  // The caller's screen sat on "Connecting…" while the other phone rang in
  // front of somebody, because call_ringing is emitted by callManager.onOffer
  // and callManager was not bound. Emitted only AFTER the ring is up, so it
  // is a report of something that happened rather than of something
  // attempted — the same mistake the diagnostics counter made when it
  // counted attempts and called them notifications.
  const c = code(ringerSrc);
  assert.match(c, /emit\('call_ringing',\s*\{\s*toUserId:/);
  const ring = c.indexOf('ringIncoming(');
  const tell = c.indexOf("emit('call_ringing'");
  assert.ok(ring >= 0 && tell > ring,
    'call_ringing must be emitted after ringIncoming, inside its result');
});

test('a ring that could not be drawn gives the claim back', () => {
  // ringIncoming returns false when the native ringer is unavailable — an old
  // build, Expo Go. Holding the claim then would refuse the FCM route, which
  // may still be able to draw it, as a duplicate of a notification that does
  // not exist.
  const c = code(ringerSrc);
  const after = c.slice(c.indexOf('ringIncoming('));
  assert.match(after, /if\s*\(!rang\)/);
  assert.match(after.slice(after.indexOf('if (!rang)')), /releaseRing\(\)/,
    'a failed ring must release the claim');
});

test('both routes to a ring claim through the same place', () => {
  // The FCM task and the socket can both deliver one call to a device that
  // has a token. The notification id is shared, so the second REPLACES the
  // first — and replacing a loopSound notification restarts the tone. So the
  // FCM path goes through claimRing too, and the loser does nothing.
  const c = code(pushSrc);
  assert.match(c, /callRing\.claimRing\(/,
    'the FCM task must claim rather than ring unconditionally');
  assert.match(c, /decision\.ring\s*\?/,
    'and must only ring when the claim was granted');
  // The plain notification Android drew must still be taken down when the
  // in-app UI is handling the call, or the shade keeps an entry for a call
  // already on screen.
  assert.match(c, /decision\.reason\s*===\s*'app-active'/);
});

// ── WHAT THE SERVER WILL SAY, AND WHAT IT MUST NOT ──────────────────────────

test('the server logs the ring decision', () => {
  // "It did not ring" has had several different causes this week and they are
  // indistinguishable from outside. The reason reaches the server rather than
  // a screen somebody has to photograph.
  const c = code(srvSrc);
  assert.match(c, /\[ring\] user=/, 'server.js must log a [ring] line');
  const h = c.slice(c.indexOf("word(d.what) === 'ring'"));
  const line = h.slice(0, h.indexOf('return;'));
  assert.match(line, /word\(d\.reason\)/,
    'the reason must go through word(), like every other field here');
});

test('the [ring] line carries no username and no address', () => {
  // diagnostics/*.md is committed to a repository that has been public, and
  // these reports are read out of it. The numeric user id is the most that
  // may appear, as in every other line in this handler.
  const c = code(srvSrc);
  const h = c.slice(c.indexOf("word(d.what) === 'ring'"));
  const line = h.slice(0, h.indexOf('return;'));
  assert.doesNotMatch(line, /username/, 'no username in the ring log');
  assert.doesNotMatch(line, /\bip\b|address|candidate/i, 'no address in the ring log');
  // word() keeps letters and hyphens only, so a reason carrying a path, a
  // name or an address cannot reach the log whatever the app sends.
  const word = v => String(v || 'unknown').replace(/[^a-z-]/gi, '').slice(0, 20) || 'unknown';
  assert.strictEqual(word('ok'), 'ok');
  assert.strictEqual(word('already-ringing'), 'already-ringing');
  assert.strictEqual(word('192.168.1.47'), 'unknown');
  assert.strictEqual(word('/data/user/0/com.app/files'), 'datausercomappfiles');
  assert.strictEqual(word('token=abc123'), 'tokenabc');
});

test('every reason the ringer reports survives word() intact', () => {
  // A reason mangled by the sanitiser is a log line that cannot be read back
  // to a rule, which is the whole value of having it.
  const word = v => String(v || 'unknown').replace(/[^a-z-]/gi, '').slice(0, 20) || 'unknown';
  const reasons = new Set(['ring-failed', 'ring-threw']);
  // Every reason ringDecision can produce, taken from the function itself
  // rather than from a list in this test that could fall behind it.
  for (const o of [
    {}, { event: 'x' }, { ...OFFER, roomId: 1 }, { ...OFFER, fromUserId: null },
    { ...OFFER, appState: 'active' }, OFFER,
    { ...OFFER, ringingFrom: 7, ringingSince: 1, now: 2 },
  ]) reasons.add(R.ringDecision(o).reason);
  assert.ok(reasons.size >= 7, `expected every rule to be covered, got ${[...reasons]}`);
  for (const r of reasons) {
    assert.strictEqual(word(r), r, `reason "${r}" is mangled by word() to "${word(r)}"`);
  }
});

let failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ok  ${n}`); }
  catch (e) { failed++; console.log(`  FAIL ${n}\n       ${e.message}`); }
}
fs.rmSync(OUT, { recursive: true, force: true });
if (failed) { console.log(`\n  ${failed} call-ring test(s) failed`); process.exit(1); }
console.log(`  ${tests.length} call-ring tests passed`);
