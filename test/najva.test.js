// ── The rules for the service that replaces Firebase ────────────────────────
//
// Firebase accepted dozens of pushes for the reporter's phone over a full day
// — HTTP 200 every time, no failures, nothing suppressed — and delivered none
// of them, with a VPN too. Six genuine app-side bugs were fixed on the way to
// discovering that, and none of them was the cause.
//
// So the transport changes. What must NOT change is the standard of evidence:
// every rule that decides what gets sent, and what a failure means, is a pure
// function tested here rather than a belief buried in a request.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const N = require('../najva');

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Configuration ───────────────────────────────────────────────────────────

test('BOTH CREDENTIALS OR NEITHER: a half-configured server does not pretend', () => {
  // An api_key with no auth token is a 401 on every single message, and a 401
  // looks from the phone exactly like the silence this is here to end. It has
  // to be caught once, up front.
  assert.strictEqual(N.configured({ NAJVA_API_KEY: 'k', NAJVA_AUTH_TOKEN: 't' }), true);
  assert.strictEqual(N.configured({ NAJVA_API_KEY: 'k' }), false, 'no auth token, still claims to work');
  assert.strictEqual(N.configured({ NAJVA_AUTH_TOKEN: 't' }), false, 'no api key, still claims to work');
  assert.strictEqual(N.configured({}), false);
  assert.strictEqual(N.configured(null), false);
  assert.strictEqual(N.configured({ NAJVA_API_KEY: '', NAJVA_AUTH_TOKEN: '' }), false);
});

test('Token, not Bearer', () => {
  // Najva's samples use Token. The two are not interchangeable, and a
  // rejected send is invisible from the handset.
  assert.strictEqual(N.authHeader('abc'), 'Token abc');
  assert.ok(!/Bearer/i.test(N.authHeader('abc')));
});

// ── The request body ────────────────────────────────────────────────────────

test('the body carries the api key, the tokens, and high priority', () => {
  const b = N.buildBody({ apiKey: 'K', title: 'ali', body: 'New message', tokens: ['t1', 't2'] });
  assert.strictEqual(b.api_key, 'K');
  assert.deepStrictEqual(b.subscriber_tokens, ['t1', 't2']);
  assert.strictEqual(b.priority, 'high');
  assert.strictEqual(b.title, 'ali');
  assert.strictEqual(b.body, 'New message');
});

test('THE TAP OPENS THE APP, not a web page', () => {
  // 'open-link' is Najva's default in the python client, and it would send
  // somebody who tapped a chat notification into a browser.
  assert.strictEqual(N.buildBody({ apiKey: 'K', tokens: ['t'] }).onclick_action, 'open-app');
});

test('NO sent_time, because its default is a three-minute delay', () => {
  // The python client defaults sent_time to now + 3 minutes. For a chat
  // message that is not a notification, it is an alarm clock. Omitted, Najva
  // sends immediately.
  const b = N.buildBody({ apiKey: 'K', title: 't', body: 'b', tokens: ['t1'] });
  assert.ok(!('sent_time' in b), 'a scheduled send would delay every notification by 3 minutes');
});

test('the routing data is carried, so a tap opens the right room', () => {
  const b = N.buildBody({ apiKey: 'K', tokens: ['t'], data: { roomId: '7', msgId: '99' } });
  assert.strictEqual(typeof b.json, 'string', 'the json field must be a string');
  assert.deepStrictEqual(JSON.parse(b.json), { roomId: '7', msgId: '99' });
});

test('…and an empty data object does not become an empty json field', () => {
  // '{}' in a field the panel may render is noise, and a field Najva does not
  // expect is a 400 on every message.
  assert.ok(!('json' in N.buildBody({ apiKey: 'K', tokens: ['t'], data: {} })));
  assert.ok(!('json' in N.buildBody({ apiKey: 'K', tokens: ['t'] })));
});

test('empty and non-string tokens are dropped, not sent as ""', () => {
  const b = N.buildBody({ apiKey: 'K', tokens: ['t1', null, '', undefined, 7] });
  assert.deepStrictEqual(b.subscriber_tokens, ['t1', '7']);
});

test('a missing title or body is an empty string, never the text "undefined"', () => {
  // String(undefined) is 'undefined', and it would be displayed, on a real
  // phone, as the title of a real notification.
  const b = N.buildBody({ apiKey: 'K', tokens: ['t'] });
  assert.strictEqual(b.title, '');
  assert.strictEqual(b.body, '');
  assert.ok(!/undefined/.test(JSON.stringify(b)));
});

// ── Reading the answer ──────────────────────────────────────────────────────

test('A FAILED SEND IS NOT A DEAD TOKEN', () => {
  // The exact mistake that cost this project a week on the Firebase side: a
  // bare 404 was treated as "this device unsubscribed", the row was deleted,
  // and that phone got nothing until the app was next opened. Narrow on
  // purpose.
  assert.strictEqual(N.tokenIsDead(500, 'server error'), false);
  assert.strictEqual(N.tokenIsDead(502, '<html>bad gateway</html>'), false);
  assert.strictEqual(N.tokenIsDead(400, 'bad request'), false);
  assert.strictEqual(N.tokenIsDead(401, 'unauthorized'), false,
    'a wrong auth token would delete every device in the database');
  assert.strictEqual(N.tokenIsDead(404, ''), false, 'a bare 404 is not proof of anything');
});

test('…but an explicit "unknown subscriber" is', () => {
  assert.strictEqual(N.tokenIsDead(404, '{"detail":"subscriber not found"}'), true);
  assert.strictEqual(N.tokenIsDead(400, '{"error":"invalid_token"}'), true);
  assert.strictEqual(N.tokenIsDead(200, 'unsubscribed'), true);
});

test('the failure line is greppable and does not dump a whole HTML page', () => {
  // The push report pulls these off the server by prefix. A diagnosis that
  // depends on somebody having logged the right thing at the time is not one.
  const line = N.najvaFailure(500, 'x'.repeat(5000));
  assert.ok(line.startsWith('[najva] send failed (status 500)'), line);
  assert.ok(line.length < 400, 'a 5 KB HTML error page went into the log verbatim');
});

// ── Nothing secret in the repository ────────────────────────────────────────

test('NO CREDENTIAL IS COMMITTED, anywhere', () => {
  // This repository has been public for long stretches and the key was pasted
  // into a chat. Credentials come from the environment or they do not exist.
  const root = path.join(__dirname, '..');
  for (const f of ['najva.js', 'server.js', 'db.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/\b[0-9a-f]{40,}\b/.test(src.replace(/^\s*\/\/.*$/gm, '')),
      `${f} contains something shaped like an auth token`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(
      src.replace(/^\s*(\/\/|\*).*$/gm, '')),
      `${f} contains something shaped like a Najva api_key UUID`);
  }
});

test('the endpoint is the per-subscriber one, not send-to-everybody', () => {
  // app.najva.com/api/v1/notifications/ is send_to_all — every subscriber of
  // the whole site. Sending one person's chat message to that would be a
  // spectacular way to leak who is talking to whom.
  assert.ok(/\/notification\/api\/v1\/notifications\/$/.test(N.ENDPOINT), N.ENDPOINT);
  assert.ok(N.ENDPOINT.startsWith('https://'), 'credentials would go over plain http');
});

test('THE TWO SERVICES NEVER GET EACH OTHER\'S TOKENS', () => {
  // A Najva subscriber token posted to Firebase is a rejected send, and an
  // FCM token posted to Najva is the same in reverse — and a rejected send is
  // indistinguishable, from the phone, from the silence all of this exists to
  // end. Both queries must name their provider.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const queries = code.match(/SELECT token FROM push_tokens[^`]*/g) || [];
  assert.ok(queries.length >= 2, `expected an FCM query and a Najva query, found ${queries.length}`);
  for (const q of queries) {
    assert.ok(/provider = '(fcm|najva)'/.test(q),
      `a push_tokens query does not filter by provider, so one service gets the other's tokens: ${q}`);
  }
  assert.ok(queries.some(q => /provider = 'fcm'/.test(q)), 'no FCM-only query');
  assert.ok(queries.some(q => /provider = 'najva'/.test(q)), 'no Najva-only query');
});

test('Najva is sent BEFORE the Firebase early-return', () => {
  // sendPushToUsers returns early when there are no Google credentials. A
  // server with none must still notify the phones Najva reaches — and on
  // these networks that is the path that arrives.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const call = code.indexOf('sendNajvaToUsers(userIds, title, body, data);');
  const ret = code.indexOf('if (!fcmCreds) return;');
  assert.ok(call > 0, 'nothing ever sends through Najva');
  assert.ok(ret > 0 && call < ret,
    'Najva is sent after the FCM early-return, so a server without Google keys notifies nobody');
});

test('the migration adds provider without rewriting existing rows', () => {
  // Every row that existed before Najva is an FCM token, which is what the
  // default says. A migration that dropped or defaulted them wrong would
  // silently stop notifying every current device.
  const dbsrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.ok(/ALTER TABLE push_tokens ADD COLUMN provider TEXT NOT NULL DEFAULT 'fcm'/.test(dbsrc),
    'no provider migration, so the new queries match nothing on an existing server');
  assert.ok(!/DROP TABLE push_tokens/.test(dbsrc), 'the migration destroys the existing tokens');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
