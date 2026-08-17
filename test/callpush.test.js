// Tests the shape of the push that rings an incoming call.
//
// This one field decides whether the phone rings at all. A Firebase message
// carrying a `notification` block is drawn by Android itself and the app's JS
// never runs while it is backgrounded or closed — so the ring sound plays once
// and stops, which is exactly the "it doesn't ring when the app is closed"
// report. Only a DATA-ONLY message wakes the app to raise a real ringing call
// notification.
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

test('an incoming call is pushed DATA-ONLY, so the app wakes up and rings', async () => {
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
  assert.ok(!msg.notification,
    'the call push carried a notification block — Android would draw it itself and '
    + 'the app would never run, so it chimes once instead of ringing');
  assert.strictEqual(msg.android.priority, 'high', 'a call push must be high priority');
  assert.strictEqual(msg.data.type, 'call');
  assert.strictEqual(msg.data.kind, 'voice');
  // The ringing notification is built on the device, which cannot look
  // anything up — the caller's name has to be in the payload.
  assert.strictEqual(msg.data.fromUsername, 'ringcaller',
    'the callee would have nothing to show as the caller');
  assert.ok(!msg.android.notification,
    'the android block still declared a notification');
  // THE SECOND HALF OF THE SAME BUG. Omitting the top-level notification block
  // is not enough: expo-notifications presents a notification of its own
  // whenever the DATA payload carries title/body, on the default channel with
  // the default sound. That is a single chime, and it is what arrived instead
  // of a ring.
  assert.ok(!('title' in msg.data),
    'the call push carries data.title — expo-notifications will draw its own '
    + 'plain notification from it and the phone chimes once instead of ringing');
  assert.ok(!('body' in msg.data), 'the call push carries data.body');
  callee && sock.close();
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
