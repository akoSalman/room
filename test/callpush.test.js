// Tests the shape of the push that rings an incoming call.
//
// THIS FILE USED TO ASSERT THE OPPOSITE, and that is why the bug kept coming
// back. It required the call push to be DATA-ONLY, on the theory that a data
// message wakes the app so it can raise a real ringing notification, whereas a
// notification message is drawn by Android and merely chimes.
//
// The first half of that is wrong. expo-notifications hands data messages to
// JavaScript through Android's JobScheduler — see
// BackgroundRemoteNotificationTaskConsumer.scheduleJob in the library — and a
// JobScheduler job is DEFERRABLE. The system runs it when it suits the system,
// which under Doze is minutes later or never. A ringing phone cannot wait in a
// job queue, so data-only did not mean "wakes up and rings", it meant silence.
//
// The other half of onMessageReceived is immediate and runs no JavaScript at
// all: expo-notifications presents the message itself, on the channel it
// names. So a call is sent as a real notification on the calls channel, with a
// thirty-second ringtone, and it rings the moment it lands however dead the
// app is. The data payload rides along so that when JavaScript IS alive,
// notifee can upgrade it to a looping, full-screen ring with Accept and
// Decline.
//
// The outgoing FCM request is captured rather than sent.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway service account so the server's FCM path activates. The key is
// generated here; it never leaves this process.
const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const svcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-')), 'svc.json');
fs.writeFileSync(svcPath, JSON.stringify({
  project_id: 'test-project',
  client_email: 'test@test.iam.gserviceaccount.com',
  private_key: privateKey,
  token_uri: 'https://oauth2.example.com/token',
}));

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.DB_PATH = path.join(os.tmpdir(), `callpush-${Date.now()}.db`);
process.env.JWT_SECRET = 'test-secret';
process.env.FIREBASE_SERVICE_ACCOUNT = svcPath;

// Capture FCM sends; answer the OAuth token request locally.
const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('oauth2.example.com')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
  }
  if (u.includes('fcm.googleapis.com')) {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
  }
  return realFetch(url, opts);
};

const { io: ioClient } = require('socket.io-client');
const { server } = require('../server.js');
const db = require('../db.js');

const tests = [];
const test = (n, f) => tests.push({ n, f });

let baseUrl;
const api = async (p, m = 'GET', b = null, t = null) => {
  const r = await realFetch(baseUrl + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    ...(b ? { body: JSON.stringify(b) } : {}),
  });
  return r.json();
};
const signUp = u => api('/auth/signin', 'POST', { username: u, password: 'pw123456', register: true });
const connect = token => new Promise((res, rej) => {
  const s = ioClient(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const settle = () => new Promise(r => setTimeout(r, 250));

test('THE BUG: a call rings without needing any JavaScript to run', async () => {
  const caller = await signUp('ringcaller');
  const callee = await signUp('ringcallee');
  const calleeId = db.prepare('SELECT id FROM users WHERE username = ?').get('ringcallee').id;
  // The callee has a device registered for push.
  db.prepare('INSERT OR REPLACE INTO push_tokens (user_id, token) VALUES (?, ?)')
    .run(calleeId, 'device-token-1');

  const sock = await connect(caller.token);
  sent.length = 0;
  sock.emit('call_offer', { toUserId: calleeId, roomId: null, kind: 'voice', sdp: 'x' });
  await settle();

  assert.strictEqual(sent.length, 1, `expected one push, got ${sent.length}`);
  const msg = sent[0].message;

  // A notification block, so Android presents it the instant it arrives. This
  // is the assertion that was inverted before, and the reason the phone stayed
  // silent: without it the ring waited on a deferrable background job.
  assert.ok(msg.notification,
    'the call push has no notification block, so nothing rings until a '
    + 'deferrable background job happens to run — which under Doze is minutes '
    + 'later or never');
  assert.strictEqual(msg.notification.title, 'ringcaller');

  // On the CALLS channel, which is where the thirty-second ringtone lives. The
  // default channel chimes once, which is the complaint.
  assert.strictEqual(msg.android.notification.channel_id, 'calls-v2',
    'a call went out on the ordinary message channel, which chimes once');
  assert.strictEqual(msg.android.notification.sound, 'ring');
  assert.strictEqual(msg.android.notification.notification_priority, 'PRIORITY_MAX');
  // NOT click_action: it names an intent action the app declares no filter
  // for, so setting it makes tapping the ringing notification do nothing.
  assert.ok(!('click_action' in msg.android.notification),
    'the call notification sets click_action, so tapping it opens nothing');
  assert.strictEqual(msg.android.priority, 'high', 'a call push must be high priority');

  // A call is worthless once missed: it must expire rather than be delivered
  // late out of a queue.
  assert.strictEqual(msg.android.ttl, '45s');
  assert.strictEqual(msg.android.direct_boot_ok, true);

  // One tag, so a second offer replaces the first rather than stacking two
  // ringing notifications for one call.
  assert.strictEqual(msg.android.notification.tag, 'incoming-call');

  // The data still rides along, so that when JavaScript IS alive notifee can
  // upgrade this to a looping, full-screen ring. It is built on the device,
  // which cannot look anything up, so the caller has to be named in it.
  assert.strictEqual(msg.data.type, 'call');
  assert.strictEqual(msg.data.kind, 'voice');
  assert.strictEqual(msg.data.fromUsername, 'ringcaller',
    'the callee would have nothing to show as the caller');
  sock.close();
});

test('a video call is marked as one', async () => {
  const caller = await signUp('ringcaller2');
  await signUp('ringcallee2');
  const calleeId = db.prepare('SELECT id FROM users WHERE username = ?').get('ringcallee2').id;
  db.prepare('INSERT OR REPLACE INTO push_tokens (user_id, token) VALUES (?, ?)')
    .run(calleeId, 'device-token-2');

  const sock = await connect(caller.token);
  sent.length = 0;
  sock.emit('call_offer', { toUserId: calleeId, roomId: null, kind: 'video', sdp: 'x' });
  await settle();
  assert.strictEqual(sent[0].message.data.kind, 'video');
  sock.close();
});

test('an ordinary message still uses a normal notification', async () => {
  // The data-only treatment must NOT leak to messages: they should be drawn by
  // Android without waking the app, which is cheaper and survives every
  // battery restriction.
  const a = await signUp('ringmsga');
  const b = await signUp('ringmsgb');
  const bId = db.prepare('SELECT id FROM users WHERE username = ?').get('ringmsgb').id;
  db.prepare('INSERT OR REPLACE INTO push_tokens (user_id, token) VALUES (?, ?)')
    .run(bId, 'device-token-3');

  const room = await api('/rooms', 'POST', { name: 'ring-room' }, a.token);
  const sockB = await connect(b.token);
  await new Promise(r => sockB.emit('accept_invite', { roomId: room.id }, r));
  const sockA = await connect(a.token);
  sent.length = 0;
  sockA.emit('send_message', { roomId: room.id, type: 'text', content: 'hi' });
  await settle();

  assert.ok(sent.length >= 1, 'no push was sent for a message');
  const msg = sent[0].message;
  assert.ok(msg.notification, 'a message push lost its notification block');
  assert.ok(msg.android.notification, 'a message push lost its android notification settings');
  assert.strictEqual(msg.android.notification.channel_id, 'messages-v3');
  sockA.close(); sockB.close();
});

(async () => {
  await new Promise(r => setTimeout(r, 600));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  let passed = 0, failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
