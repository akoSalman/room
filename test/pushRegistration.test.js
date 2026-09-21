// Why the phone went quiet.
//
// Reported as: in the latest version of the APK, push notifications are not
// received at the time. They turn up when the app is opened — which is another
// way of saying they were not pushes at all. The socket delivered them on
// reconnect and the shade stayed empty for as long as the app was closed.
//
// The server was sending them. The device was never registered to receive
// them, because registration was one attempt with no second chance, and that
// attempt was racing the permission dialog:
//
//   1. the app asks for notification permission, without waiting for an answer;
//   2. the stored sign-in token resolves a moment later and the screen leaves
//      'auth', which is what runs the registration effect;
//   3. it asks whether permission is granted. The dialog is still on screen and
//      nothing has been tapped, so the honest answer is no;
//   4. it returns — and its dependency was `[screen === 'auth']`, which never
//      changes again, so it never ran a second time.
//
// The user grants permission a second later to an app that has already given
// up. Everything the app raises ITSELF still works, which is why this reads as
// "late" rather than "broken", but the server has no token to push to.
//
// Installing a new APK is exactly when that race is lost, which is why it was
// reported against a version rather than a feature.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping push-registration tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pushreg-'));
execFileSync(TSC, [path.join(NAT, 'src', 'pushRegistration.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const P = require(path.join(OUT, 'pushRegistration.js'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Is there anything to tell the server? ───────────────────────────────────

test('THE BUG: permission arriving late still results in a registration', () => {
  // The dialog is open: nothing to send YET. The old code treated this as
  // nothing to send EVER.
  assert.strictEqual(P.needsSend({ granted: false, token: 'abc', sentToken: null }), false);
  // The user taps Allow. This is the state the old code could never reach.
  assert.strictEqual(P.needsSend({ granted: true, token: 'abc', sentToken: null }), true);
});

test('…and there IS a second chance, which is the whole fix', () => {
  // A single attempt at a moment when the answer is "not yet" is the bug. The
  // retry has to survive that first no.
  assert.strictEqual(P.shouldRetry({ attempt: 1, registered: false }), true);
  assert.strictEqual(P.shouldRetry({ attempt: P.MAX_ATTEMPTS - 1, registered: false }), true);
  assert.ok(P.MAX_ATTEMPTS >= 3, 'one or two tries is the bug with extra steps');
});

test('a token the server already has is not sent again DURING a session', () => {
  // Otherwise every return to the foreground is a POST that changes nothing.
  // This is the part of build 256's change that was worth keeping.
  assert.strictEqual(P.needsSend({
    granted: true, token: 'abc', sentToken: 'abc',
    coldStart: false, sentAt: 1000, now: 1000,
  }), false);
});

test('THE 255 REGRESSION: a cold start re-sends the token anyway', () => {
  // Reported: push notifications worked until build 255 and not since.
  //
  // Build 255 sent the token on every launch, with no memory. Build 256 made
  // it remember, and stay quiet unless the token changed. But the SERVER's
  // copy can vanish without the token changing — it deletes the row whenever
  // a send looks like a rejection, and on a filtered network a middlebox 404
  // looked exactly like one. After that the device got nothing, for ever,
  // because it believed it had already registered.
  //
  // Build 255 healed from that on the next launch. This is that behaviour,
  // put back.
  assert.strictEqual(P.needsSend({
    granted: true, token: 'abc', sentToken: 'abc',
    coldStart: true, sentAt: Date.now(),
  }), true, 'a launch does not re-register, so a deleted row is never noticed');
});

test('…and a registration older than a day is redone without one', () => {
  // The other way back, for an app that is left running for days.
  assert.strictEqual(P.needsSend({
    granted: true, token: 'abc', sentToken: 'abc',
    coldStart: false, sentAt: 1, now: P.REREGISTER_AFTER_MS + 2,
  }), true);
  assert.ok(P.REREGISTER_AFTER_MS <= 7 * 24 * 60 * 60 * 1000,
    'a device that has lost its row waits a week to find out');
});

test('a registration with no recorded time is treated as due', () => {
  // Upgrading from a build that stored the token but not the moment. Assuming
  // it is fresh is assuming exactly the thing that caused this.
  assert.strictEqual(P.needsSend({
    granted: true, token: 'abc', sentToken: 'abc', coldStart: false, sentAt: 0, now: 5000,
  }), true);
});

test('a clock that jumped backwards does not postpone it for a day', () => {
  assert.strictEqual(P.needsSend({
    granted: true, token: 'abc', sentToken: 'abc',
    coldStart: false, sentAt: 9000, now: 1000,
  }), true);
});

test('THE OTHER SILENCE: a reissued token is noticed on its own', () => {
  // Firebase reissues tokens — on reinstall, on restore to a new device, after
  // a long idle. The server keeps pushing to the old one until Firebase
  // rejects it, and then has nothing at all.
  assert.strictEqual(P.needsSend({ granted: true, token: 'new', sentToken: 'old' }), true);
});

test('nothing to send is not sent', () => {
  assert.strictEqual(P.needsSend({ granted: true, token: '', sentToken: null }), false);
  assert.strictEqual(P.needsSend({ granted: true, token: null, sentToken: null }), false);
  assert.strictEqual(P.needsSend(null), false);
});

test('retrying stops once it has worked', () => {
  assert.strictEqual(P.shouldRetry({ attempt: 1, registered: true }), false);
  assert.strictEqual(P.shouldRetry({ attempt: P.MAX_ATTEMPTS, registered: false }), false);
});

test('the first retry is quick, and the backoff is bounded', () => {
  // The likeliest reason for the first failure is the permission dialog still
  // being on screen — seconds, not a network problem — so waiting half a
  // minute for the first retry would lose the very case this exists for.
  assert.ok(P.retryDelay(1) <= 2000, `${P.retryDelay(1)}ms before the first retry`);
  assert.ok(P.retryDelay(2) > P.retryDelay(1), 'the backoff does not back off');
  assert.ok(P.retryDelay(99) <= 30000, 'a retry is scheduled for half an hour away');
  assert.ok(P.retryDelay(0) > 0 && P.retryDelay(-5) > 0, 'a nonsense attempt retries instantly, forever');
});

test('the whole retry sequence covers a human tapping Allow', () => {
  // Somebody reading a permission dialog takes a few seconds. If the attempts
  // are all spent before they finish, the fix does not fix anything.
  let total = 0;
  for (let i = 1; i <= P.MAX_ATTEMPTS; i++) total += P.retryDelay(i);
  assert.ok(total >= 30000,
    `registration gives up after ${Math.round(total / 1000)}s, before a slow tap on Allow`);
});

test('THE REGRESSION: a registered device may still raise from the socket', () => {
  // This is the bug that was reported as "notifications arrive minutes late",
  // three times. The rule used to be "only if the device is NOT registered
  // with Firebase", which reads as caution but switched off the fast path for
  // exactly the devices it was working for: before registration was fixed
  // nothing was registered, so the socket was quietly doing the work, and
  // fixing registration silenced it everywhere.
  assert.strictEqual(P.socketRaiseAllowed({ msgId: 42 }), true);
  assert.strictEqual(P.socketRaiseAllowed({ msgId: '42' }), true);
});

test('…but not for a message with no id, which is the one real duplicate', () => {
  // No id means no tag, and without the tag Firebase's notification and this
  // one are two different notifications — the double the old rule imagined.
  assert.strictEqual(P.socketRaiseAllowed({ msgId: null }), false);
  assert.strictEqual(P.socketRaiseAllowed({ msgId: undefined }), false);
  assert.strictEqual(P.socketRaiseAllowed({ msgId: '' }), false);
  assert.strictEqual(P.socketRaiseAllowed({}), false);
  assert.strictEqual(P.socketRaiseAllowed(null), false);
});

test('THE PROPERTY IT ALL RESTS ON: server and app name a message identically', () => {
  // Both paths now run. They do not stack ONLY because Android sees one tag
  // and replaces. If these two ever drift, every message arrives twice —
  // which is worse than the late notification this fixes, so it is pinned
  // here rather than left to the two files agreeing by habit.
  const N = require(path.join(ROOT, 'notify.js'));
  for (const id of [1, 42, '42', 'tmp-abc', 0, '0', 999999]) {
    assert.strictEqual(N.notificationTag(id), P.notificationTag(id),
      `the server and the app disagree about what to call message ${id}`);
  }
  assert.strictEqual(N.notificationTag(42), 'msg-42');
  assert.strictEqual(N.notificationTag(null), '');
  assert.strictEqual(P.notificationTag(null), '');
});

test('THE OTHER HALF: a bare 404 no longer deletes a working token', () => {
  // These servers reach fcm.googleapis.com across a network that filters it.
  // A middlebox answering 404 with an HTML page is indistinguishable from
  // Firebase answering 404 UNREGISTERED — except by the body, which the old
  // check ignored. So a filtered request deleted a live token and silenced
  // that phone.
  const N = require(path.join(ROOT, 'notify.js'));
  assert.strictEqual(N.tokenIsDead(404, '<html>404 Not Found</html>'), false,
    'a proxy error page still costs a device its notifications');
  assert.strictEqual(N.tokenIsDead(404, ''), false,
    'a 404 with no body is treated as proof the token is gone');
  assert.strictEqual(N.tokenIsDead(404, 'null'), false);
  // …while Firebase actually saying so is still believed.
  assert.strictEqual(N.tokenIsDead(404, JSON.stringify(
    { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })), true);
  assert.strictEqual(N.tokenIsDead(200, JSON.stringify(
    { error: { status: 'UNREGISTERED' } })), true);
  assert.strictEqual(N.tokenIsDead(403, JSON.stringify(
    { error: { details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } })), true);
  // A transient network failure is not a dead token either.
  assert.strictEqual(N.tokenIsDead(502, 'Bad Gateway'), false);
  assert.strictEqual(N.tokenIsDead(500, ''), false);
});

test('THE SUPPRESSION: a notification is shown when the app is NOT in front', () => {
  // This returned false for everything, on the belief that the handler only
  // runs in the foreground. server.js records the opposite, learned from a
  // call that would not ring with the app CLOSED: expo-notifications
  // intercepts every FCM message and builds the notification itself — which
  // means it asks this handler, and the answer was always no.
  //
  // Matches the report exactly: nothing at all, then occasionally one twenty
  // minutes late. Alive-but-backgrounded goes through expo and is suppressed;
  // process killed outright has no expo to intercept, so the tray draws it.
  const fn = app.slice(app.indexOf('setNotificationHandler'),
    app.indexOf('setNotificationChannelAsync'));
  assert.ok(fn.length > 100, 'the notification handler moved');
  assert.ok(/AppState\.currentState === 'active'/.test(fn),
    'the handler does not ask whether the user is actually in the app');
  assert.ok(/shouldShowAlert: !inApp/.test(fn),
    'the handler still refuses to show notifications while the app is in the background');
  assert.ok(/shouldPlaySound: !inApp/.test(fn),
    'a background notification is shown silently, which reads as not arriving');
  // The literal that caused it must not come back.
  assert.ok(!/shouldShowAlert: false/.test(fn),
    'shouldShowAlert is hardcoded false again, which suppresses every notification');
});

test('THE SILENT ONE: the app\'s own notification names the message channel', () => {
  // Reported as "notification sound is not there", and it is worse than
  // silence. `trigger: null` means "immediately" AND "on Android's default
  // channel" — no custom sound, no heads-up.
  //
  // And this notification carries the SAME tag as the server's FCM one, so
  // Android treats the FCM notification as an update of this silent one
  // rather than as a new alert. An update does not make a sound. So the
  // app's own notification was swallowing the proper, sounded push behind it.
  //
  // That is also why older builds were fine: the socket notification was
  // gated off, so the FCM one was the only notification and Android drew it
  // on messages-v3 with its sound.
  assert.ok(/trigger: \{ channelId: MESSAGES_CHANNEL \}/.test(app),
    'the socket notification lands on the default channel, silent, and swallows the FCM one');
  // Comment lines stripped first. The explanation above this call contains
  // the words "trigger: null", and a check against the raw source matches the
  // prose rather than the code — which is how a test ends up agreeing with
  // its own description instead of with the program.
  const code = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/trigger: null/.test(code),
    'a notification is still posted with trigger: null, onto the default channel');
});

test('…and the channel is named once, not spelled out twice', () => {
  // The server names 'messages-v3' in every push. Two spellings in the app is
  // how one of them quietly becomes a different channel.
  assert.ok(/export const MESSAGES_CHANNEL = 'messages-v3'/.test(app));
  assert.ok(/setNotificationChannelAsync\(MESSAGES_CHANNEL/.test(app),
    'the channel is created under a different name from the one used to post');
  const literals = (app.match(/'messages-v3'/g) || []).length;
  assert.strictEqual(literals, 1,
    `'messages-v3' is written ${literals} times; it should exist once, as the constant`);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');
const at = app.indexOf('// Register the device FCM token');
const effect = at > 0 ? app.slice(at, app.indexOf('// Global notifications:')) : '';

test('the cold-start send is WIRED, not just available', () => {
  // A rule nothing calls is a rule that does nothing. The flag must be read by
  // needsSend and cleared only after the server has accepted the token.
  assert.ok(/coldStart: coldStartRef\.current/.test(app),
    'needsSend is never told whether this is a fresh launch');
  assert.ok(/coldStartRef\.current = false;/.test(app),
    'the launch flag is never cleared, so every foreground re-POSTs');
  const at = app.indexOf('coldStartRef.current = false;');
  const before = app.slice(Math.max(0, at - 300), at);
  assert.ok(/if \(res\?\.ok\) \{/.test(before),
    'the launch flag is cleared before the server accepted the token');
  assert.ok(/AsyncStorage\.setItem\(pushReg\.SENT_AT_KEY/.test(app),
    'the moment of registration is never recorded, so it can never go stale');
});

test('THE FIX IS WIRED: registration retries instead of giving up', () => {
  assert.ok(effect.length > 400, 'the registration effect moved');
  assert.ok(/pushReg\.shouldRetry\(/.test(effect), 'one failed attempt still ends registration');
  assert.ok(/setTimeout\(attemptRegister, pushReg\.retryDelay\(attempt\)\)/.test(effect),
    'nothing is ever scheduled, so the retry rule is decoration');
  // The specific shape of the old bug: a `return` on ungranted permission that
  // ends the effect for good.
  assert.ok(!/if \(!perm\.granted\) return;/.test(effect),
    'an ungranted permission still ends registration permanently');
});

test('coming back to the app is another chance', () => {
  // The case this catches: permission refused in the dialog and granted later
  // from Settings.
  assert.ok(/AppState\.addEventListener\('change'/.test(effect),
    'returning to the app does not retry registration');
  assert.ok(/st !== 'active' \|\| pushRegisteredRef\.current/.test(effect),
    'every foreground re-registers, or none does');
});

test('a reissued token is picked up', () => {
  assert.ok(/addPushTokenListener\(/.test(effect),
    'a token Firebase reissues is never sent, and the server pushes into nothing');
});

test('the token is remembered only after the server accepts it', () => {
  // Recording it before would turn one failed POST into permanent silence —
  // the same shape of bug in a different place.
  const i = effect.indexOf('const res = await apiFetch');
  assert.ok(i > 0, 'the POST moved');
  const after = effect.slice(i, i + 700);
  assert.ok(/if \(res\?\.ok\)/.test(after), 'the response is not checked');
  const ok = after.indexOf('if (res?.ok)');
  assert.ok(after.slice(ok).indexOf('AsyncStorage.setItem(pushReg.SENT_TOKEN_KEY') > -1,
    'the token is not remembered, so it is re-sent on every foreground');
  assert.ok(after.indexOf('AsyncStorage.setItem(pushReg.SENT_TOKEN_KEY') > ok,
    'the token is recorded before the server accepted it');
});

test('…and App.tsx asks it before raising one', () => {
  assert.ok(/pushReg\.socketRaiseAllowed\(\{ msgId: msg\.id \}\)/.test(app),
    'the socket handler decides for itself whether it may raise a notification');
  // Gating on registration is what caused the late notifications. It must not
  // come back by someone "restoring" it while editing this file.
  const handler = app.slice(app.indexOf('// Global notifications:'),
    app.indexOf('// When a message is deleted, dismiss its notification'));
  assert.ok(handler.length > 400, 'the notification handler moved');
  assert.ok(!/socketFallbackAllowed|pushRegistered/.test(handler),
    'the socket is gated on registration again, which silences it once FCM works');
  // The identifier comes from the shared helper, not a second copy of the
  // format — a hand-written `msg-${id}` here is how the two drift apart and
  // every message starts arriving twice.
  assert.ok(/identifier: pushReg\.notificationTag\(msg\.id\)/.test(app),
    'the notification is named by hand rather than by the shared rule');
  // stayConnected was the abandoned half of the first socket-first attempt and
  // must stay gone. keepAlive is NOT: it was asked for once the phone's own
  // numbers came back — 2 delivered by Firebase against 11 raised by the
  // socket — and the rules that stop it crashing live in keepAlive.test.js.
  assert.ok(!/stayConnected/.test(app),
    'the abandoned socket-first scaffolding is wired in again');
});

test('the foreground service is back, but only on the terms that make it safe', () => {
  // This test used to assert the opposite — that no foreground service
  // existed anywhere — written when reverting to Firebase removed the reason
  // for one. The phone's own counters then showed Firebase delivering 2 to
  // the socket's 11, the service was asked for, and that assertion became a
  // record of a decision that had been reversed.
  //
  // It is not deleted, because the thing it was guarding is still real: the
  // service crashed the app by starting from the BACKGROUND. So it now pins
  // the constraint rather than the absence.
  assert.ok(fs.existsSync(path.join(NAT, 'src', 'keepAlive.ts')));
  const appJson = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));
  assert.ok(appJson.expo.android.permissions.includes('android.permission.FOREGROUND_SERVICE_DATA_SYNC'),
    'the service declares a type the app cannot back up, which Android answers by killing it');
  // The battery prompt was a separate idea and is still not one of these.
  assert.ok(!appJson.expo.android.permissions.includes('android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS'),
    'a permission is declared for a prompt nobody asked to bring back');
  // stayConnected really is gone for good.
  assert.ok(!fs.existsSync(path.join(NAT, 'src', 'stayConnected.ts')));
  // …and the rule that cost a release is enforced where it can be tested.
  const ka = fs.readFileSync(path.join(NAT, 'src', 'keepAlive.ts'), 'utf8');
  assert.ok(/export function mayStart/.test(ka) && /appState === 'active'/.test(ka),
    'the start rule is not a testable function, which is how it went wrong before');
});

test('THE TRAP THIS INTRODUCES: signing out forgets the registered token', () => {
  // It records "the server has been told this token", and the server stores it
  // against whoever was signed in at the time. Left behind, the next person to
  // sign in on this phone has the same device token — so registration decides
  // there is nothing to send, and they get no push notifications at all while
  // everything appears to work.
  const at = app.indexOf('async function logout()');
  assert.ok(at > 0, 'logout moved');
  const fn = app.slice(at, at + 900);
  assert.ok(/pushReg\.SENT_TOKEN_KEY/.test(fn),
    'signing out leaves the token recorded, so the next account gets no pushes');
  assert.ok(/pushRegisteredRef\.current = false/.test(fn),
    'the next account inherits "already registered" and never registers');
});

test('the effect cleans up after itself', () => {
  // An AppState listener and a timer left behind by a screen change would
  // stack up a new pair on every sign-in.
  assert.ok(/clearTimeout\(timer\)/.test(effect), 'a pending retry outlives the effect');
  assert.ok(/appSub\.remove\(\)/.test(effect), 'the AppState listener is never removed');
  assert.ok(/tokSub\?\.remove\?\.\(\)/.test(effect), 'the token listener is never removed');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
