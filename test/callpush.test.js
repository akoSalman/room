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
  // Read from the app rather than written out here, because the two must be
  // the SAME STRING: a push naming a channel the app never created is played
  // by Android on a default channel it invents, silently. Android also freezes
  // a channel's settings at creation, so fixing the sound means a NEW id — and
  // a test with the old id spelled out by hand would pass while every call
  // went out on a channel that no longer exists.
  const chan = /CALL_CHANNEL = '([^']+)'/.exec(
    fs.readFileSync(path.join(__dirname, '..', 'native-app', 'src', 'incomingCall.ts'), 'utf8'));
  assert.ok(chan, 'CALL_CHANNEL is gone — this check is vacuous');
  assert.strictEqual(msg.android.notification.channel_id, chan[1],
    'the call push names a channel the app never created, so Android plays it '
    + 'on an invented default channel — silently');
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
  test('THE BUG: hanging up leaves a closed app ringing, so the ring is replaced', () => {
  // Reported as: the caller hangs up and the receiver is still ringing.
  //
  // A callee with no live socket is being rung BY A NOTIFICATION, and never
  // sees the call_end event — there is no JavaScript running to receive it. A
  // delivered notification cannot be recalled, but the same TAG replaces it,
  // so the ring is overwritten by a silent record of the missed call.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = src.indexOf("socket.on('call_end'");
  assert.ok(start > 0, 'call_end is gone — this check is vacuous');
  const body = src.slice(start, src.indexOf("socket.on('ping_check'", start));
  assert.ok(/rooms\.get\('user:' \+ toUserId\)/.test(body),
    'call_end never asks whether the callee is actually live, so either every '
    + 'hang-up sends a spurious missed-call push or none replaces the ring');
  assert.ok(/sendPushToUsers\(/.test(body), 'nothing replaces the delivered ring');
  assert.ok(/tag: 'incoming-call'/.test(body),
    'the replacement push carries a different tag, so it lands BESIDE the '
    + 'ringing notification instead of replacing it');
  assert.ok(/call_missed/.test(body), 'the replacement is not marked as a missed call');
  // On the ordinary channel: replacing a ring with another ring is worse than
  // leaving it.
  assert.ok(!/calls-v/.test(body), 'the replacement push rings all over again');
});

test('a call the callee can be pushed for is not reported as unreachable', async () => {
  // Reported as: they are looking at the notification and it still says
  // "connecting". Connecting must mean nothing reached them by any route.
  const caller = await signUp('ackcaller');
  const callee = await signUp('ackcallee');
  const calleeId = db.prepare('SELECT id FROM users WHERE username = ?').get('ackcallee').id;
  const noPush = await signUp('ackdark');
  const darkId = db.prepare('SELECT id FROM users WHERE username = ?').get('ackdark').id;
  db.prepare('INSERT OR REPLACE INTO push_tokens (user_id, token) VALUES (?, ?)')
    .run(calleeId, 'device-token-ack');

  const sock = await connect(caller.token);
  const offer = to => new Promise(res => {
    sock.emit('call_offer', { toUserId: to, roomId: null, kind: 'voice', sdp: 'x' }, res);
    setTimeout(() => res(null), 2000);
  });

  const withPush = await offer(calleeId);
  assert.ok(withPush, 'call_offer never acknowledged');
  assert.strictEqual(withPush.delivered, false, 'the callee has no socket in this test');
  assert.strictEqual(withPush.pushed, true,
    'a callee whose phone is being rung by a push is reported as unreachable');

  const dark = await offer(darkId);
  assert.strictEqual(dark.pushed, false,
    'a callee with no push route anywhere is reported as being alerted');
  sock.close();
  await settle();
});

test('THE CHANNEL IS NAMED WHERE THE APP LOOKS FOR IT', () => {
  // Reported as: with the app closed a call still does not ring.
  //
  // expo-notifications intercepts every FCM message and builds the
  // notification ITSELF rather than letting Firebase present it, and the
  // channel it builds on comes out of the DATA payload —
  // android.notification.channel_id only matters on the paths where the system
  // draws the notification directly. Named in one place and not the other, the
  // call was drawn on the default channel: one short chime, no ring.
  const call = sent.find(m => m.message.data.type === 'call');
  assert.ok(call, 'no call push was captured — this check would be vacuous');
  const msg = call.message;
  assert.strictEqual(msg.data.channelId, msg.android.notification.channel_id,
    'the data payload names a different channel from the notification block');
  const chan = /CALL_CHANNEL = '([^']+)'/.exec(
    fs.readFileSync(path.join(__dirname, '..', 'native-app', 'src', 'incomingCall.ts'), 'utf8'));
  assert.strictEqual(msg.data.channelId, chan[1]);
  // An ordinary message keeps its own channel, on both paths.
  const plain = sent.find(m => m.message.data.type !== 'call');
  if (plain) {
    assert.strictEqual(plain.message.data.channelId, plain.message.android.notification.channel_id);
    assert.notStrictEqual(plain.message.data.channelId, chan[1],
      'an ordinary message rings like a call');
  }
});

test('the ringing channel is created even if the ringer never loads', () => {
  // ensureCallChannel swallows its errors — deliberately, because it runs in a
  // background task where a throw loses the call. That means a notifee that is
  // unavailable leaves NO channel, and the server's push then lands on a
  // default one with a default chime. Creating it from the other library too
  // costs nothing (a channel that exists is not recreated) and removes the
  // single point of failure.
  const app = fs.readFileSync(path.join(__dirname, '..', 'native-app', 'App.tsx'), 'utf8');
  assert.ok(/setNotificationChannelAsync\(CALL_CHANNEL/.test(app),
    'the call channel exists only if notifee loaded');
  assert.ok(/import \{ CALL_CHANNEL \} from '\.\/src\/incomingCall'/.test(app),
    'App.tsx spells the channel id out by hand, so it can drift from the app\'s');
  const block = app.slice(app.indexOf('setNotificationChannelAsync(CALL_CHANNEL'));
  assert.ok(/sound: 'ring\.wav'/.test(block.slice(0, 400)), 'the fallback channel is silent');
  assert.ok(/AndroidImportance\.MAX/.test(block.slice(0, 400)),
    'the fallback channel cannot interrupt, so it will not ring');
});

test('THE RING IS A RING: long, loud, and with gaps in it', () => {
  // Asked for: a tone of the app's own, like the notification sound. It is
  // generated by assets/make-ring.py rather than downloaded — these phones
  // cannot reach a sound library, and a stock Android ringtone is exactly what
  // an incoming call must not sound like.
  const wav = fs.readFileSync(path.join(__dirname, '..', 'native-app', 'assets', 'ring.wav'));
  assert.strictEqual(wav.slice(0, 4).toString(), 'RIFF');
  assert.strictEqual(wav.slice(8, 12).toString(), 'WAVE');
  const rate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  assert.strictEqual(bits, 16, 'not 16-bit PCM, which is what Android plays from res/raw');
  const samples = (wav.length - 44) / 2;
  const seconds = samples / rate;
  assert.ok(seconds > 8, `a ${seconds.toFixed(1)}s tone is a chime, not a ring`);

  // Loud enough to be heard from a pocket…
  let peak = 0;
  const rms = [];
  for (let sec = 0; sec + rate < samples; sec += rate) {
    let sum = 0;
    for (let i = 0; i < rate; i++) {
      const v = wav.readInt16LE(44 + (sec + i) * 2);
      sum += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    rms.push(Math.sqrt(sum / rate));
  }
  assert.ok(peak > 20000, `peak ${peak} is too quiet to hear from a pocket`);
  assert.ok(peak < 32767, 'the tone is clipped');
  // …and a RING, not a drone: it has to stop between phrases, or it is an
  // alarm.
  assert.ok(rms.some(r => r > 2000), 'no second of this is loud');
  assert.ok(rms.some(r => r < 500), 'the tone never stops, which is an alarm rather than a ring');

  // And the recipe is kept, so the next change is an edit rather than a guess.
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'native-app', 'assets', 'make-ring.py')),
    'the tone cannot be regenerated or adjusted');
  // Bundled, or none of the above reaches a phone.
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'native-app', 'app.json'), 'utf8'));
  const sounds = JSON.stringify(cfg);
  assert.ok(sounds.includes('./assets/ring.wav'),
    'ring.wav is not bundled into res/raw, so the channel names a sound that is not there');
});

let passed = 0, failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
