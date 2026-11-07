// Sends that answer, and resends that do not duplicate
// (native-app ChatScreen + outbox, public/js/app.js, server.js).
//
// Two reports, one pipeline:
//
//   "when a message is not sent and the user tries again it seems that some
//    times it causes a message to be sent multiple times"
//   "on sending some images and videos it sticks on 100 percent and nothing
//    happens after that"
//
// THE DUPLICATES. The ack had an 8-second deadline. On these networks a send
// routinely takes longer, so the server stored the message and the answer
// missed the deadline — the sender was shown "failed" for a message that had
// been delivered. They retried, and because every retry carries a brand-new
// clientId by design (outbox.ts: "Each retry dispatches a brand-new
// clientId"), the server could not tell the resend from a new message.
//
// THE HANG. The text send waited for an ack and could mark itself failed.
// The three MEDIA sends emitted with no ack and no timeout at all. The
// upload finished, the bar reached 100%, and if that one emit never reached
// the server nothing came back, nothing timed out, and the bubble sat at
// 100% for ever — not sent, not failed, offering no retry, because
// markUploadFailed is the only thing that offers one and nothing could call
// it.
//
// The two fixes depend on each other: an ack deadline is only safe to act on
// once a resend cannot duplicate, and a resend is only recoverable once
// something notices the send never landed.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const chat = fs.readFileSync(
  path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const outbox = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'outbox.ts'), 'utf8');
const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

const code = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const chatCode = code(chat);
const webCode = code(web);

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('EVERY send waits for an answer', () => {
  // A bare emit is the bug: it cannot fail, so nothing can retry it and the
  // bubble has no way to stop saying 100%.
  const emits = chatCode.match(/emit\('send_message'/g) || [];
  assert.ok(emits.length >= 4, `expected the send sites, found ${emits.length}`);
  const timed = chatCode.match(/timeout\(outbox\.SEND_ACK_TIMEOUT_MS\)\.emit\('send_message'/g) || [];
  assert.strictEqual(timed.length, emits.length,
    `${emits.length - timed.length} send(s) still emit with no deadline`);
});

test('…and every one of them can mark itself failed', () => {
  // Each send site's callback must reach markUploadFailed, or a lost emit is
  // still a bubble stuck at 100%.
  const sites = chatCode.split("emit('send_message'").slice(1);
  let withRecovery = 0;
  for (const site of sites) {
    const cb = site.slice(0, 900);
    if (/markUploadFailed\(clientId\)/.test(cb)) withRecovery++;
    // The location send has no bubble to fail; it alerts instead.
    else if (/Could not share location/.test(cb)) withRecovery++;
  }
  assert.strictEqual(withRecovery, sites.length,
    `${sites.length - withRecovery} send(s) have no way to report a failure`);
});

test('A TIMED CALLBACK TAKES TWO ARGUMENTS', () => {
  // socket.io calls a timed ack as (err, res). Adding a deadline to an emit
  // whose callback was written as (res) silently reads the error slot as the
  // reply — null on success, so a genuine refusal passes unnoticed, and a
  // timeout hands it an Error whose .error is undefined, which looks the
  // same. Found by adding the deadline and then reading the callback.
  const sites = chatCode.split("timeout(outbox.SEND_ACK_TIMEOUT_MS).emit('send_message'").slice(1);
  for (const site of sites) {
    const cb = /\}, \(([^)]*)\) =>/.exec(site.slice(0, 700));
    assert.ok(cb, 'a timed send has no callback at all');
    const args = cb[1].split(',').map(a => a.trim()).filter(Boolean);
    assert.ok(args.length === 2,
      `a timed ack callback takes (${cb[1]}) — socket.io passes (err, res)`);
  }
});

test('the ack deadline is long enough to stop inventing failures', () => {
  // 8 seconds is what produced the duplicates. It is only safe to lengthen
  // because a resend can no longer duplicate; it is only worth lengthening
  // because a delivered message shown as failed is what starts the retry.
  const m = /SEND_ACK_TIMEOUT_MS = (\d+)/.exec(outbox);
  assert.ok(m, 'the timeout is not a named constant');
  const ms = Number(m[1]);
  assert.ok(ms >= 12000, `${ms}ms still invents failures on a slow network`);
  assert.ok(ms <= 60000, `${ms}ms leaves somebody staring at a spinner`);
  // Only the SEND sites. message_info has its own deadline and is a
  // different operation — the first version of this assertion matched any
  // timeout(8000) anywhere and failed on that, which is a test complaining
  // about code it was not written to judge.
  for (const src of [chatCode, webCode]) {
    const sends = src.split("emit('send_message'").slice(0, -1);
    for (const before of sends) {
      const tail = before.slice(-80);
      assert.doesNotMatch(tail, /timeout\(8000\)/,
        'a send still has the 8 second deadline that invented the failures');
    }
  }
});

test('EVERY RETRYABLE SEND CARRIES A STABLE ORIGIN', () => {
  // Without it the server cannot tell a resend from a new message, which is
  // the duplicate. The location send is excluded: it has no retry path.
  const sites = chatCode.split("emit('send_message'").slice(1);
  for (const site of sites) {
    const head = site.slice(0, 500);
    if (!/clientId/.test(head)) continue;           // no retry, no origin needed
    assert.match(head, /originId: outbox\.originOf\(clientId\)\.originId/,
      'a retryable send carries no origin id, so a resend will duplicate');
  }
});

test('the origin is STABLE across attempts, which is the entire point', () => {
  // originOf() returns the id that survives retries; clientId does not.
  // Sending clientId as the origin would compile, pass a casual reading, and
  // restore the bug exactly.
  assert.doesNotMatch(chatCode, /originId: clientId/,
    'the origin is the per-attempt id, so every retry looks like a new message');
  assert.match(outbox, /Each retry dispatches a brand-new clientId/,
    'outbox.ts no longer documents why clientId cannot be the origin');
});

test('THE WEB MEDIA SENDS ANSWER TOO', () => {
  // The same hang, by the same route: both web media sends emitted with no
  // ack, and their catch only ever covered the UPLOAD. A send lost on the
  // wire produced nothing — not sent, not failed, no retry offered.
  const emits = webCode.match(/emit\('send_message'/g) || [];
  const timed = webCode.match(/timeout\(SEND_ACK_TIMEOUT_MS\)\.emit\('send_message'/g) || [];
  assert.strictEqual(timed.length, emits.length,
    `${emits.length - timed.length} web send(s) still emit with no deadline`);
  // …and each reaches markUploadFailed, which is the only thing that offers
  // a retry.
  const sites = webCode.split("emit('send_message'").slice(1);
  for (const site of sites) {
    assert.match(site.slice(0, 800), /markUploadFailed\(/,
      'a web send has no way to report a failure');
  }
});

test('the web media retries keep their origin as well', () => {
  // Their retry closures re-upload the whole file under a fresh clientId, so
  // without a stable origin every attempt is a new message to the server.
  for (const fn of ['uploadAndSendMedia', 'sendGallery']) {
    const at = webCode.indexOf('function ' + fn + '(');
    assert.ok(at > 0, `${fn} is gone`);
    const body = webCode.slice(at, at + 2500);
    assert.match(body, /originId = undefined/, `${fn} cannot be told its origin`);
    assert.match(body, /const origin = originId \|\| clientId;/, `${fn} mints a new origin`);
    assert.match(body, /const retryThis = \(\) =>[\s\S]*origin\)/,
      `${fn}'s retry does not pass the origin on`);
  }
});

test('the web retry reuses its first attempt\'s origin', () => {
  // The web retry re-called dispatchText, which minted a fresh clientId each
  // time — the same bug by a different route.
  assert.match(webCode, /function dispatchText\([^)]*originId\)/,
    'dispatchText cannot be told which send it is retrying');
  assert.match(webCode, /const origin = originId \|\| clientId;/);
  assert.match(webCode, /originId: origin,/, 'the web send carries no origin');
  // And the retry must pass it on, or every attempt is a new send again.
  const fail = webCode.slice(webCode.indexOf('markUploadFailed(wrapper, clientId'));
  assert.match(fail.slice(0, 300), /dispatchText\([^)]*, origin\)/,
    'the web retry starts a new origin, which is the bug it is meant to fix');
});

let failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ok  ${n}`); }
  catch (e) { failed++; console.log(`  FAIL ${n}\n       ${e.message}`); }
}
if (failed) { console.log(`\n  ${failed} send-reliability test(s) failed`); process.exit(1); }
console.log(`  ${tests.length} send-reliability tests passed`);
