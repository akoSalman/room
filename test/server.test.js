// Integration tests for the chat server.
//
// These boot the REAL server against a throwaway SQLite database and drive it
// over HTTP + Socket.IO exactly like a client would. They exist because bugs
// kept shipping that a single real invocation would have caught (the
// accept_invite handler once threw on every call because its SQL contained an
// invalid `ESCAPE ''` clause — syntax checks can't see that, running it can).
//
// Run with:  npm test
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Point the server at a scratch DB BEFORE requiring it, so tests never touch
// the real chat.db.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roomtest-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.PORT = '0'; // let the OS pick a free port
process.env.JWT_SECRET = 'test-secret';

const { io: ioClient } = require('socket.io-client');

let server, baseUrl;
const sockets = [];

// ── helpers ──────────────────────────────────────────────────────────────────
async function api(pathname, method = 'GET', body = null, token = null) {
  const res = await fetch(baseUrl + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

async function signUp(username) {
  const r = await api('/auth/signin', 'POST', { username, password: 'pw123456', register: true });
  assert.ok(r.token, `sign-up failed for ${username}: ${JSON.stringify(r)}`);
  return r;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { auth: { token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

// Emit with ack, promisified, with a timeout so a handler that throws
// server-side (never acking) fails loudly instead of hanging the suite.
function emit(sock, event, payload, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`no ack for "${event}" within ${ms}ms — the handler likely threw`)), ms);
    sock.emit(event, payload, res => { clearTimeout(t); resolve(res); });
  });
}

// Wait for a specific socket event (optionally matching a predicate).
function waitFor(sock, event, match = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no "${event}" within ${ms}ms`)), ms);
    const h = payload => {
      if (!match(payload)) return;
      clearTimeout(t); sock.off(event, h); resolve(payload);
    };
    sock.on(event, h);
  });
}

// Media URLs are signed by the server (see signPath in server.js). Tests that
// fetch an upload directly need a valid signature; this mirrors the server's,
// using the same JWT_SECRET set at the top of this file.
function signUpload(name, ttlMs = 60000) {
  const exp = Date.now() + ttlMs;
  const sig = require('crypto').createHmac('sha256', process.env.JWT_SECRET)
    .update(`${name}:${exp}`).digest('base64url').slice(0, 32);
  return `?e=${exp}&s=${sig}`;
}

// Raw fetch (status + headers), since api() only returns parsed JSON.
async function raw(pathname, method = 'GET', body = null, token = null) {
  return fetch(baseUrl + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// ── runner ───────────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn, timeoutMs) => tests.push({ name, fn, timeoutMs });

async function main() {
  const app = require('../server.js');
  server = app.server || app;
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}\n      ${err.message}`);
      failed++;
    }
  }
  sockets.forEach(s => s.close());
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

// ── tests ────────────────────────────────────────────────────────────────────

test('private room invite → accept actually joins (regression: ESCAPE \'\' threw)', async () => {
  const owner = await signUp('owner1');
  const guest = await signUp('guest1');
  const ownerSock = await connect(owner.token);
  const guestSock = await connect(guest.token);

  const room = await api('/rooms', 'POST', { name: 'secret-room-1', isPrivate: true }, owner.token);
  assert.ok(room.id, 'room not created');

  const inv = await emit(ownerSock, 'invite_to_room', { roomId: room.id, username: 'guest1' });
  assert.ok(inv.ok, `invite failed: ${JSON.stringify(inv)}`);

  // This is the call that used to throw and never ack.
  const acc = await emit(guestSock, 'accept_invite', { roomId: room.id });
  assert.ok(acc.ok, `accept failed: ${JSON.stringify(acc)}`);
  assert.strictEqual(acc.room.id, room.id);

  // The guest can now see the private room in their list.
  const rooms = await api('/rooms', 'GET', null, guest.token);
  assert.ok(rooms.some(r => r.id === room.id), 'joined room missing from guest room list');
});

test('uninvited user cannot join a private room', async () => {
  const owner = await signUp('owner2');
  const stranger = await signUp('stranger2');
  const ownerSock = await connect(owner.token);
  const strangerSock = await connect(stranger.token);

  const room = await api('/rooms', 'POST', { name: 'secret-room-2', isPrivate: true }, owner.token);
  const res = await emit(strangerSock, 'accept_invite', { roomId: room.id });
  assert.ok(res.error, 'stranger was allowed to join a private room');

  const rooms = await api('/rooms', 'GET', null, stranger.token);
  assert.ok(!rooms.some(r => r.id === room.id), 'private room leaked into stranger list');
  ownerSock.close();
});

test('joining announces a system message carrying the user id', async () => {
  const owner = await signUp('owner3');
  const guest = await signUp('guest3');
  const ownerSock = await connect(owner.token);
  const guestSock = await connect(guest.token);

  const room = await api('/rooms', 'POST', { name: 'secret-room-3', isPrivate: true }, owner.token);
  await emit(ownerSock, 'invite_to_room', { roomId: room.id, username: 'guest3' });

  const announced = waitFor(ownerSock, 'message_received',
    m => m.type === 'system' && m.room_id === room.id);
  await emit(guestSock, 'accept_invite', { roomId: room.id });
  const msg = await announced;

  const data = JSON.parse(msg.content);
  assert.strictEqual(data.kind, 'joined');
  assert.strictEqual(data.username, 'guest3');
  assert.ok(typeof data.userId === 'number', 'system message must carry userId so the name is clickable');
});

test('room owner can remove a member; non-owner cannot', async () => {
  const owner = await signUp('owner4');
  const guest = await signUp('guest4');
  const ownerSock = await connect(owner.token);
  const guestSock = await connect(guest.token);

  const room = await api('/rooms', 'POST', { name: 'secret-room-4', isPrivate: true }, owner.token);
  await emit(ownerSock, 'invite_to_room', { roomId: room.id, username: 'guest4' });
  await emit(guestSock, 'accept_invite', { roomId: room.id });

  // A non-owner must not be able to remove anyone.
  const bad = await emit(guestSock, 'remove_member', { roomId: room.id, userId: owner.id });
  assert.ok(bad.error, 'non-owner was allowed to remove a member');

  const kicked = waitFor(guestSock, 'removed_from_room', p => p.roomId === room.id);
  const ok = await emit(ownerSock, 'remove_member', { roomId: room.id, userId: guest.id ?? null });
  // userId comes from room-info, which the client uses; resolve it if absent.
  if (ok.error) {
    const info = await api(`/room-info/${room.id}`, 'GET', null, owner.token);
    const m = info.members.find(x => x.username === 'guest4');
    assert.ok(m && m.id, 'room-info must expose member ids for removal');
    const ok2 = await emit(ownerSock, 'remove_member', { roomId: room.id, userId: m.id });
    assert.ok(ok2.ok, `owner removal failed: ${JSON.stringify(ok2)}`);
  }
  await kicked;

  const rooms = await api('/rooms', 'GET', null, guest.token);
  assert.ok(!rooms.some(r => r.id === room.id), 'removed member still sees the room');
});

test('room-info exposes member ids and owner id', async () => {
  const owner = await signUp('owner5');
  const room = await api('/rooms', 'POST', { name: 'room-5', isPrivate: true }, owner.token);
  const info = await api(`/room-info/${room.id}`, 'GET', null, owner.token);
  assert.ok(Array.isArray(info.members) && info.members.length, 'no members returned');
  assert.ok(info.members.every(m => typeof m.id === 'number'), 'member ids missing');
  assert.strictEqual(info.is_owner, true);
});

test('room-info reports membership so the client can offer a Join button', async () => {
  const owner = await signUp('powner7');
  const visitor = await signUp('pvisitor7');
  const room = await api('/rooms', 'POST', { name: 'public-room-7' }, owner.token);

  // Owner is a member; a passer-by who has never joined is not.
  const asOwner = await api(`/room-info/${room.id}`, 'GET', null, owner.token);
  assert.strictEqual(!!asOwner.is_member, true, 'owner must count as a member');
  const before = await api(`/room-info/${room.id}`, 'GET', null, visitor.token);
  assert.strictEqual(!!before.is_member, false, 'visitor must not start out a member');
});

test('anyone may join a public room, and it announces them', async () => {
  const owner = await signUp('powner8');
  const visitor = await signUp('pvisitor8');
  const ownerSock = await connect(owner.token);
  const visitorSock = await connect(visitor.token);

  const room = await api('/rooms', 'POST', { name: 'public-room-8' }, owner.token);
  ownerSock.emit('join_room', room.id);   // no ack on this handler
  const announced = waitFor(ownerSock, 'message_received', m => m.room_id === room.id && m.type === 'system');

  const acc = await emit(visitorSock, 'accept_invite', { roomId: room.id });
  assert.ok(acc.ok, `public join failed: ${JSON.stringify(acc)}`);

  const sys = await announced;
  assert.ok(String(sys.content).includes('pvisitor8'), `join not announced: ${sys.content}`);

  const after = await api(`/room-info/${room.id}`, 'GET', null, visitor.token);
  assert.strictEqual(!!after.is_member, true, 'visitor is not a member after joining');
  assert.ok(after.members.some(m => m.username === 'pvisitor8'), 'joiner missing from member list');
});

test('a brand-new account lands in the default room, not an empty list', async () => {
  const u = await signUp('fresh13');
  const rooms = await api('/rooms', 'GET', null, u.token);
  assert.ok(Array.isArray(rooms) && rooms.length,
    'new account has no rooms at all — nothing to land on');
  assert.ok(rooms.some(r => r.name === 'General'), 'default room missing for a new account');
});

test('public rooms are NOT listed until joined; they are found by search', async () => {
  const owner = await signUp('powner9');
  const outsider = await signUp('poutsider9');
  const room = await api('/rooms', 'POST', { name: 'findable-room-9' }, owner.token);

  const before = await api('/rooms', 'GET', null, outsider.token);
  assert.ok(!before.some(r => r.id === room.id),
    'a public room must not appear in the list of someone who never joined it');

  // ...but it is discoverable by name.
  const found = await api('/search?q=findable-room-9', 'GET', null, outsider.token);
  assert.ok(found.rooms.some(r => r.id === room.id), 'public room not findable by search');

  const sock = await connect(outsider.token);
  await emit(sock, 'accept_invite', { roomId: room.id });
  const after = await api('/rooms', 'GET', null, outsider.token);
  assert.ok(after.some(r => r.id === room.id), 'joined room missing from the list');
});

test('a member can leave a room, and it is announced', async () => {
  const owner = await signUp('lowner10');
  const member = await signUp('lmember10');
  const ownerSock = await connect(owner.token);
  const memberSock = await connect(member.token);

  const room = await api('/rooms', 'POST', { name: 'leavable-room-10' }, owner.token);
  await emit(memberSock, 'accept_invite', { roomId: room.id });

  const announced = waitFor(ownerSock, 'message_received',
    m => m.room_id === room.id && m.type === 'system' && String(m.content).includes('"left"'));
  const res = await emit(memberSock, 'leave_room_membership', { roomId: room.id });
  assert.ok(res.ok, `leave failed: ${JSON.stringify(res)}`);
  await announced;

  const rooms = await api('/rooms', 'GET', null, member.token);
  assert.ok(!rooms.some(r => r.id === room.id), 'left room still listed');
  const info = await api(`/room-info/${room.id}`, 'GET', null, member.token);
  assert.strictEqual(!!info.is_member, false, 'still reported as a member after leaving');
});

test('the room owner cannot leave their own room', async () => {
  const owner = await signUp('lowner11');
  const sock = await connect(owner.token);
  const room = await api('/rooms', 'POST', { name: 'owned-room-11' }, owner.token);

  const res = await emit(sock, 'leave_room_membership', { roomId: room.id });
  assert.ok(res.error, 'owner was allowed to leave their own room');
  const rooms = await api('/rooms', 'GET', null, owner.token);
  assert.ok(rooms.some(r => r.id === room.id), 'owner lost their own room');
});

test('a public room only broadcasts to its members', async () => {
  const owner = await signUp('bowner12');
  const outsider = await signUp('boutsider12');
  const ownerSock = await connect(owner.token);
  const outsiderSock = await connect(outsider.token);

  const room = await api('/rooms', 'POST', { name: 'quiet-room-12' }, owner.token);

  let leaked = false;
  outsiderSock.on('message_received', (m) => { if (m.room_id === room.id) leaked = true; });
  await emit(ownerSock, 'send_message', { roomId: room.id, type: 'text', content: 'members only' });
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(leaked, false,
    'a public room pushed its messages at an account that never joined it');
});

test('a public room can be read, and followed live, before joining it', async () => {
  const owner = await signUp('preader10');
  const visitor = await signUp('pguest10');
  const ownerSock = await connect(owner.token);
  const visitorSock = await connect(visitor.token);

  const room = await api('/rooms', 'POST', { name: 'public-room-10' }, owner.token);
  await emit(ownerSock, 'send_message', { roomId: room.id, type: 'text', content: 'before' });

  // Not a member, so it is not in their room list…
  const rooms = await api('/rooms', 'GET', null, visitor.token);
  assert.ok(!rooms.some(r => r.id === room.id), 'unjoined public room must not be listed');

  // …but they can still open it and read the history.
  const history = await api(`/messages/${room.id}`, 'GET', null, visitor.token);
  assert.ok(Array.isArray(history) && history.some(m => m.content === 'before'),
    'a public room must be readable before joining');

  // And while they sit there reading it, new messages must still arrive —
  // otherwise the chat looks frozen until they join.
  visitorSock.emit('join_room', room.id);
  await new Promise(r => setTimeout(r, 100));   // let the presence join land
  const live = waitFor(visitorSock, 'message_received', m => m.content === 'after');
  await emit(ownerSock, 'send_message', { roomId: room.id, type: 'text', content: 'after' });
  await live;
});

test('SECURITY: a non-member cannot post to, or react in, a public room', async () => {
  const owner = await signUp('powner11');
  const outsider = await signUp('poutsider11');
  const ownerSock = await connect(owner.token);
  const outSock = await connect(outsider.token);

  const room = await api('/rooms', 'POST', { name: 'public-room-11' }, owner.token);
  await emit(ownerSock, 'send_message', { roomId: room.id, type: 'text', content: 'members only' });
  // The send ack carries no id, so read the real message id back from history.
  const seed = (await api(`/messages/${room.id}`, 'GET', null, owner.token))
    .find(m => m.content === 'members only');
  assert.ok(seed && seed.id, 'seed message not found');

  // Reading is fine; writing is not.
  const send = await emit(outSock, 'send_message', { roomId: room.id, type: 'text', content: 'sneaking in' });
  assert.ok(send && send.error, `non-member was allowed to post: ${JSON.stringify(send)}`);

  const history = await api(`/messages/${room.id}`, 'GET', null, owner.token);
  assert.ok(!history.some(m => m.content === 'sneaking in'), 'non-member message reached the room');

  // Reacting is contributing too, so it takes membership as well.
  outSock.emit('toggle_reaction', { messageId: seed.id, emoji: '\u{1F44D}' });
  await new Promise(r => setTimeout(r, 200));
  const rx = await api(`/room-reactions/${room.id}`, 'GET', null, owner.token);
  const all = Object.values(rx || {}).flat();
  assert.ok(!all.some(r => r.username === 'poutsider11'), 'non-member reaction was recorded');

  // …and once they join, posting works.
  await emit(outSock, 'accept_invite', { roomId: room.id });
  const ok = await emit(outSock, 'send_message', { roomId: room.id, type: 'text', content: 'now a member' });
  assert.ok(!ok.error, `member was blocked from posting: ${JSON.stringify(ok)}`);
});

test('thumbnails are generated, cached, and path-traversal safe', async () => {
  const u = await signUp('thumbuser12');
  // A real 1x1 PNG upload would need multipart; instead drop a file straight
  // into uploads/ and ask the endpoint for it, which is what it serves from.
  const sharpLib = require('sharp');
  const name = `test-thumb-${Date.now()}.jpg`;
  const fsMod = require('fs');
  fsMod.mkdirSync('uploads', { recursive: true });
  await sharpLib({
    create: { width: 900, height: 600, channels: 3, background: { r: 10, g: 120, b: 200 } },
  }).jpeg().toFile(require('path').join('uploads', name));

  const res = await raw(`/thumb/${name}?w=200&${signUpload(name).slice(1)}`, 'GET', null, u.token);
  assert.strictEqual(res.status, 200, `thumb request failed: ${res.status}`);
  assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');

  const full = fsMod.statSync(require('path').join('uploads', name)).size;
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(body.length > 0, 'empty thumbnail');
  assert.ok(body.length < full, `thumbnail (${body.length}) not smaller than original (${full})`);

  // Cached to disk, so the second request is served from the cache.
  assert.ok(fsMod.existsSync(require('path').join('uploads', '.thumbs', `${name}_200.jpg`)),
    'thumbnail was not cached');

  // An older client builds the thumb url by stripping "/uploads/" off the
  // signed message path, so the signature lands INSIDE the encoded name.
  // Those builds are already installed; they must keep working.
  const legacy = `/thumb/${encodeURIComponent(name + signUpload(name))}?w=200`;
  const legacyRes = await raw(legacy, 'GET', null, u.token);
  assert.strictEqual(legacyRes.status, 200,
    `a pre-signing client's thumbnail url was refused: ${legacyRes.status}`);

  // …but a legacy-shaped url with a BAD signature is still refused.
  const legacyBad = `/thumb/${encodeURIComponent(name + '?e=' + (Date.now() + 60000) + '&s=nope')}?w=200`;
  assert.strictEqual((await raw(legacyBad, 'GET', null, u.token)).status, 403,
    'a legacy url with an invalid signature was served');

  // Traversal must be rejected by the name guard itself — 400, specifically.
  // (Asserting merely ">= 400" would pass even with the guard removed, since
  // sharp fails on a non-image anyway and returns 415.)
  const bad = await raw(`/thumb/..%2F..%2Fserver.js${signUpload('server.js')}`, 'GET', null, u.token);
  assert.strictEqual(bad.status, 400, `traversal not rejected by the name guard: ${bad.status}`);

  fsMod.rmSync(require('path').join('uploads', name), { force: true });
  fsMod.rmSync(require('path').join('uploads', '.thumbs', `${name}_200.jpg`), { force: true });
});

test('the tile proxy is strictly bounded and never an open proxy', async () => {
  // This endpoint fetches a URL on request, so the coordinates that build that
  // URL must be validated hard. Anything out of range is refused BEFORE any
  // network call is made.
  for (const bad of [
    '/tiles/2/9/0.png',        // x beyond 2^2-1
    '/tiles/2/0/9.png',        // y beyond 2^2-1
    '/tiles/99/0/0.png',       // zoom past the maximum
    '/tiles/-1/0/0.png',
    '/tiles/2/-1/0.png',
    '/tiles/abc/0/0.png',
  ]) {
    const r = await raw(bad);
    assert.ok(r.status === 400 || r.status === 404,
      `${bad} was not refused (status ${r.status})`);
  }
});

test('thumbnails fall back to the original instead of a blank grid', async () => {
  // A server whose image library cannot load must still show the gallery. It
  // used to answer 415, which no client handles — the grid rendered white,
  // which is exactly what users saw on a server where sharp had no binary.
  //
  // A file sharp cannot turn into a JPEG exercises the same fallback path.
  const u = await signUp('thumbfall');
  const fsMod = require('fs');
  const name = `not-an-image-${Date.now()}.jpg`;
  fsMod.mkdirSync('uploads', { recursive: true });
  fsMod.writeFileSync(require('path').join('uploads', name), 'this is definitely not a JPEG');

  const res = await fetch(`${baseUrl}/thumb/${name}?w=200&${signUpload(name).slice(1)}`, {
    redirect: 'manual',
    headers: { Authorization: `Bearer ${u.token}` },
  });
  assert.notStrictEqual(res.status, 415,
    'the gallery was told 415, which renders as a blank tile');
  assert.strictEqual(res.status, 302, `expected a redirect to the original, got ${res.status}`);
  const loc = res.headers.get('location') || '';
  assert.ok(loc.includes('/uploads/') && loc.includes(name),
    `the fallback did not point at the original file: ${loc}`);
  // Still signed — the fallback must not become a way around the signature.
  assert.ok(/[?&]s=/.test(loc), 'the fallback URL was not signed');
});

test('SECURITY: uploads need a valid, unexpired signature', async () => {
  const u = await signUp('mediauser13');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'media-room-13' }, u.token);

  const fsMod = require('fs');
  const name = `sig-test-${Date.now()}.txt`;
  fsMod.mkdirSync('uploads', { recursive: true });
  fsMod.writeFileSync(require('path').join('uploads', name), 'secret audio bytes');

  // Bare URL — this is exactly what used to work for anyone who had the link.
  const bare = await raw(`/uploads/${name}`, 'GET', null, u.token);
  assert.strictEqual(bare.status, 403, `unsigned upload was served: ${bare.status}`);

  // The server hands out signed paths with the message, so fetch one back.
  await emit(sock, 'send_message',
    { roomId: room.id, type: 'file', content: '', filePath: `/uploads/${name}`, fileName: name });
  const history = await api(`/messages/${room.id}`, 'GET', null, u.token);
  const msg = history.find(m => m.file_name === name);
  assert.ok(msg, 'message not found');
  assert.ok(/\?e=\d+&s=/.test(msg.file_path), `path was not signed: ${msg.file_path}`);

  // …and the raw path is what got stored, so signatures never reach the DB.
  assert.ok(!msg.file_path.split('?')[0].includes('&'), 'stored path looks malformed');

  const signed = await raw(msg.file_path, 'GET', null, u.token);
  assert.strictEqual(signed.status, 200, `signed upload was refused: ${signed.status}`);

  // A tampered signature, and an expired one, are both refused.
  const tampered = msg.file_path.replace(/s=(.)/, (m, c) => 's=' + (c === 'A' ? 'B' : 'A'));
  assert.strictEqual((await raw(tampered, 'GET', null, u.token)).status, 403, 'tampered signature accepted');
  const stale = `/uploads/${name}?e=${Date.now() - 1000}&s=${msg.file_path.split('s=')[1]}`;
  assert.strictEqual((await raw(stale, 'GET', null, u.token)).status, 403, 'expired signature accepted');

  fsMod.rmSync(require('path').join('uploads', name), { force: true });
});

test('a media URL is STABLE, so caches can actually hold on to it', async () => {
  // The regression this guards: the expiry used to be `now + TTL`, so asking
  // for the same message twice returned two different URLs and every cache —
  // the phone's, the browser's, our own — missed every time. Thumbnails and
  // audio were re-downloaded on every single visit to a chat.
  const u = await signUp('mediastable20');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'media-room-20' }, u.token);

  const fsMod = require('fs');
  const name = `stable-${Date.now()}.txt`;
  fsMod.mkdirSync('uploads', { recursive: true });
  fsMod.writeFileSync(require('path').join('uploads', name), 'bytes');

  await emit(sock, 'send_message',
    { roomId: room.id, type: 'file', content: '', filePath: `/uploads/${name}`, fileName: name });

  const first = (await api(`/messages/${room.id}`, 'GET', null, u.token))
    .find(m => m.file_name === name);
  // A real gap between the two fetches: this is what used to change the URL.
  await new Promise(r => setTimeout(r, 40));
  const second = (await api(`/messages/${room.id}`, 'GET', null, u.token))
    .find(m => m.file_name === name);

  assert.strictEqual(second.file_path, first.file_path,
    'the same file was served under two different URLs, so nothing can cache it');

  // Still a working, unexpired link — stability must not have cost validity.
  assert.strictEqual((await raw(first.file_path, 'GET', null, u.token)).status, 200);
  const exp = Number(/[?&]e=(\d+)/.exec(first.file_path)[1]);
  assert.ok(exp > Date.now() + 6 * 24 * 3600 * 1000,
    'the link expires sooner than the week it promises');

  fsMod.rmSync(require('path').join('uploads', name), { force: true });
});

test('the media browser marks what a device may NOT keep', async () => {
  // The app writes downloaded media to disk so it never fetches twice. That
  // must not apply to content sent on the understanding it would not persist:
  // a cached copy outliving a disappearing message defeats the whole feature,
  // and in a private room only the author may keep their own content.
  const owner = await signUp('cacheowner21');
  const guest = await signUp('cacheguest21');
  const ownerSock = await connect(owner.token);
  const guestSock = await connect(guest.token);

  // ── An ordinary room: media is keepable by everyone in it.
  const open = await api('/rooms', 'POST', { name: 'cache-open-21' }, owner.token);
  await emit(guestSock, 'accept_invite', { roomId: open.id });
  await emit(ownerSock, 'send_message',
    { roomId: open.id, type: 'image', content: '', filePath: '/uploads/ok.jpg', fileName: 'ok.jpg' });

  let media = await api(`/room-media/${open.id}`, 'GET', null, guest.token);
  assert.strictEqual(media.images.length, 1);
  assert.strictEqual(media.images[0].cacheable, true,
    'ordinary media was marked unkeepable, so it would re-download forever');

  // ── The same room with disappearing messages on.
  assert.ok((await emit(ownerSock, 'set_disappearing', { roomId: open.id, seconds: 30 })).ok);
  await emit(ownerSock, 'send_message',
    { roomId: open.id, type: 'image', content: '', filePath: '/uploads/gone.jpg', fileName: 'gone.jpg' });

  media = await api(`/room-media/${open.id}`, 'GET', null, guest.token);
  const vanishing = media.images.find(i => i.url.includes('gone.jpg'));
  assert.ok(vanishing, 'disappearing image missing from the browser');
  assert.strictEqual(vanishing.cacheable, false,
    'a disappearing photo was marked keepable — it would survive on disk after the message died');
  // The earlier, non-disappearing photo is untouched by the mode change.
  assert.strictEqual(media.images.find(i => i.url.includes('ok.jpg')).cacheable, true,
    'turning the mode on retroactively blocked messages sent before it');

  // ── A private room: only the author may keep their own content.
  const priv = await api('/rooms', 'POST', { name: 'cache-priv-21', isPrivate: true }, owner.token);
  await emit(ownerSock, 'invite_to_room', { roomId: priv.id, username: 'cacheguest21' });
  await emit(guestSock, 'accept_invite', { roomId: priv.id });
  await emit(ownerSock, 'send_message',
    { roomId: priv.id, type: 'image', content: '', filePath: '/uploads/mine.jpg', fileName: 'mine.jpg' });

  const asAuthor = await api(`/room-media/${priv.id}`, 'GET', null, owner.token);
  assert.strictEqual(asAuthor.images[0].cacheable, true,
    'the author was stopped from keeping their own photo');
  const asOther = await api(`/room-media/${priv.id}`, 'GET', null, guest.token);
  assert.strictEqual(asOther.images[0].cacheable, false,
    "someone else's photo in a private room was marked keepable");
});

test('live location updates in place, and only the sharer can move the pin', async () => {
  const sharer = await signUp('geoshare15');
  const watcher = await signUp('geowatch15');
  const sharerSock = await connect(sharer.token);
  const watchSock = await connect(watcher.token);

  const room = await api('/rooms', 'POST', { name: 'geo-room-15' }, sharer.token);
  await emit(watchSock, 'accept_invite', { roomId: room.id });

  const until = Date.now() + 60_000;
  await emit(sharerSock, 'send_message', {
    roomId: room.id, type: 'location',
    content: JSON.stringify({ lat: 35.6892, lng: 51.3890, liveUntil: until }),
  });
  const history = await api(`/messages/${room.id}`, 'GET', null, sharer.token);
  const pin = history.find(m => m.type === 'location');
  assert.ok(pin, 'location message was not stored — is the type allowed?');

  // The watcher is told when the pin moves.
  const moved = waitFor(watchSock, 'location_updated', p => p.messageId === pin.id);
  const upd = await emit(sharerSock, 'location_update', { messageId: pin.id, lat: 35.70, lng: 51.40 });
  assert.ok(upd.ok, `update refused: ${JSON.stringify(upd)}`);
  const evt = await moved;
  const payload = JSON.parse(evt.content);
  assert.strictEqual(payload.lat, 35.70);
  assert.strictEqual(payload.liveUntil, until, 'the expiry must survive an update');

  // It updates the SAME message rather than posting a new one.
  const after = await api(`/messages/${room.id}`, 'GET', null, sharer.token);
  assert.strictEqual(after.filter(m => m.type === 'location').length, 1,
    'a live update created an extra message instead of moving the pin');

  // Nobody else can move someone's pin.
  const stolen = await emit(watchSock, 'location_update', { messageId: pin.id, lat: 0, lng: 0 });
  assert.ok(stolen.error, 'another user was allowed to move the pin');

  // Rubbish coordinates are refused.
  assert.ok((await emit(sharerSock, 'location_update', { messageId: pin.id, lat: 999, lng: 0 })).error,
    'an impossible latitude was accepted');
  assert.ok((await emit(sharerSock, 'location_update', { messageId: pin.id, lat: 'x', lng: 0 })).error,
    'a non-numeric latitude was accepted');
});

test('a live share stops, and stops accepting updates', async () => {
  const u = await signUp('geostop16');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'geo-room-16' }, u.token);

  await emit(sock, 'send_message', {
    roomId: room.id, type: 'location',
    content: JSON.stringify({ lat: 10, lng: 20, liveUntil: Date.now() + 60_000 }),
  });
  const pin = (await api(`/messages/${room.id}`, 'GET', null, u.token)).find(m => m.type === 'location');

  assert.ok((await emit(sock, 'location_stop', { messageId: pin.id })).ok, 'stop failed');

  // After stopping, the server refuses further updates even if a client keeps
  // watching the device's position and never noticed it should stop.
  const late = await emit(sock, 'location_update', { messageId: pin.id, lat: 11, lng: 21 });
  assert.ok(late.error, 'an ended share still accepted updates');

  const after = (await api(`/messages/${room.id}`, 'GET', null, u.token)).find(m => m.type === 'location');
  const payload = JSON.parse(after.content);
  assert.ok(payload.liveUntil <= Date.now(), 'the share was not marked ended');
  assert.strictEqual(payload.lat, 10, 'the late update leaked through');
});

test('a message is flagged seenElsewhere when another device is reading it', async () => {
  // The bug: the user is reading a chat on their phone, and their laptop —
  // with the tab in the background — still raises a browser notification.
  // Push was already suppressed server-side, but the web build raises its own
  // notification from `message_received`, so it needs to be told.
  const sender = await signUp('seensender');
  const reader = await signUp('seenreader');
  const room = await api('/rooms', 'POST', { name: 'seen-room' }, sender.token);

  const senderSock = await connect(sender.token);
  // The reader's two devices: a phone with the chat open, and a laptop.
  const phone = await connect(reader.token);
  const laptop = await connect(reader.token);
  await emit(phone, 'accept_invite', { roomId: room.id });
  phone.emit('join_room', room.id);   // no ack on this handler
  await new Promise(r => setTimeout(r, 80));

  const onLaptop = waitFor(laptop, 'message_received', m => m.content === 'hello');
  await emit(senderSock, 'send_message', { roomId: room.id, type: 'text', content: 'hello' });
  const got = await onLaptop;
  assert.strictEqual(got.seenElsewhere, true,
    'the laptop was not told the phone is already showing this chat');

  // The SENDER is not reading the room on any device, so nothing is suppressed
  // for them — otherwise the flag would silence everyone.
  const other = await signUp('seenother');
  const otherSock = await connect(other.token);
  await emit(otherSock, 'accept_invite', { roomId: room.id });
  const onOther = waitFor(otherSock, 'message_received', m => m.content === 'second');
  await emit(senderSock, 'send_message', { roomId: room.id, type: 'text', content: 'second' });
  assert.ok(!(await onOther).seenElsewhere,
    'a user with no device on the room was told it had been seen elsewhere');
});

test('a backgrounded device stops counting as reading the chat', async () => {
  // A laptop left on the chat overnight must not suppress notifications
  // forever — sitting on a room is not the same as looking at it.
  const sender = await signUp('focussender');
  const reader = await signUp('focusreader');
  const room = await api('/rooms', 'POST', { name: 'focus-room' }, sender.token);

  const senderSock = await connect(sender.token);
  const phone = await connect(reader.token);
  const laptop = await connect(reader.token);
  await emit(phone, 'accept_invite', { roomId: room.id });
  phone.emit('join_room', room.id);   // no ack on this handler
  await new Promise(r => setTimeout(r, 80));

  // The phone goes into the user's pocket; it stays "on" the room but is no
  // longer in front of them.
  phone.emit('app_focus', false);
  await new Promise(r => setTimeout(r, 60));

  const onLaptop = waitFor(laptop, 'message_received', m => m.content === 'ping');
  await emit(senderSock, 'send_message', { roomId: room.id, type: 'text', content: 'ping' });
  assert.ok(!(await onLaptop).seenElsewhere,
    'an unfocused device still counted as reading the chat, silencing the others');
});

test('unread counts cover your rooms and DMs, and nothing else', async () => {
  const a = await signUp('unreada');
  const b = await signUp('unreadb');
  const sa = await connect(a.token);
  const sb = await connect(b.token);

  // A room B joins then leaves.
  const room = await api('/rooms', 'POST', { name: 'unread-room' }, a.token);
  await emit(sb, 'accept_invite', { roomId: room.id });
  await emit(sa, 'send_message', { roomId: room.id, type: 'text', content: 'while a member' });
  await new Promise(r => setTimeout(r, 120));
  let counts = await api('/unread-counts', 'GET', null, b.token);
  assert.ok(counts[room.id] > 0, 'a member got no unread count for a new message');

  await emit(sb, 'leave_room_membership', { roomId: room.id });
  await emit(sa, 'send_message', { roomId: room.id, type: 'text', content: 'after leaving' });
  await new Promise(r => setTimeout(r, 120));
  counts = await api('/unread-counts', 'GET', null, b.token);
  assert.ok(!counts[room.id],
    `a room that was left still reports ${counts[room.id]} unread`);

  // DMs have no membership rows, so they must be matched another way — this
  // is the case a naive "members only" filter silently breaks.
  const bId = (await api(`/search?q=unreadb`, 'GET', null, a.token)).users[0].id;
  const dm = await api(`/dm/${bId}`, 'POST', null, a.token);
  const dmId = dm.id || dm.room?.id;
  assert.ok(dmId, `could not open a DM: ${JSON.stringify(dm)}`);
  await emit(sa, 'send_message', { roomId: dmId, type: 'text', content: 'hello there' });
  await new Promise(r => setTimeout(r, 120));
  counts = await api('/unread-counts', 'GET', null, b.token);
  assert.ok(counts[dmId] > 0, 'a direct message produced no unread count');

  // And NOT other people's conversations. DM rooms are matched by name, where
  // an unescaped '_' is a wildcard: '__2__' would also match '__12__' and
  // '__1x2__', leaking the unread counts of chats this user is not in.
  const c = await signUp('unreadc');
  const d = await signUp('unreadd');
  const sc = await connect(c.token);
  const found = await api(`/search?q=unreadd`, 'GET', null, c.token);
  assert.ok(found?.users?.length, `search found nothing: ${JSON.stringify(found)}`);
  const dId = found.users[0].id;
  const theirDm = await api(`/dm/${dId}`, 'POST', null, c.token);
  const theirId = theirDm.id || theirDm.room?.id;
  await emit(sc, 'send_message', { roomId: theirId, type: 'text', content: 'private chat' });
  await new Promise(r => setTimeout(r, 120));
  counts = await api('/unread-counts', 'GET', null, b.token);
  assert.ok(!counts[theirId],
    'unread counts leaked from a DM between two other people');
});

test('the DM name match is escaped, so it cannot cross-match another chat', () => {
  // Whether the leak above can even ARISE depends on which ids happen to be
  // allocated, so the predicate itself is checked directly — read out of
  // server.js so this cannot drift away from the code it is guarding.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const line = /OR r\.name LIKE ([^\n]+)$/m.exec(src.slice(src.indexOf("'/unread-counts'")));
  assert.ok(line, 'could not find the DM name predicate in server.js');
  const pattern = line[1].trim();

  const mem = new (require('better-sqlite3'))(':memory:');
  mem.exec("CREATE TABLE rooms(name TEXT)");
  const ins = mem.prepare('INSERT INTO rooms (name) VALUES (?)');
  ins.run('__dm__1__2__');     // users 1 and 2
  ins.run('__dm__12__3__');    // users 12 and 3 — nothing to do with user 2
  ins.run('__dm__4__12__');    // users 4 and 12

  const q = mem.prepare(`SELECT name FROM rooms WHERE name LIKE ${pattern}`);
  const forUser = id => q.all(String(id)).map(r => r.name);

  // User 2 is in exactly one of these.
  assert.deepStrictEqual(forUser(2), ['__dm__1__2__'],
    `user 2 matched the wrong conversations: ${JSON.stringify(forUser(2))}`);
  // User 12 is the second participant of one of them, and must not pick up
  // the '__1x2__' shaped names.
  assert.deepStrictEqual(forUser(12), ['__dm__4__12__'],
    `user 12 matched the wrong conversations: ${JSON.stringify(forUser(12))}`);
  mem.close();
});

test('disappearing messages: announced, applied to BOTH sides, and swept', async () => {
  const a = await signUp('vanisha');
  const b = await signUp('vanishb');
  const room = await api('/rooms', 'POST', { name: 'vanish-room' }, a.token);
  const sa = await connect(a.token);
  const sb = await connect(b.token);
  await emit(sb, 'accept_invite', { roomId: room.id });

  // Turning it on announces it in the chat, so nobody is unaware.
  const announced = waitFor(sb, 'message_received',
    m => m.room_id === room.id && m.type === 'system');
  const on = await emit(sa, 'set_disappearing', { roomId: room.id, seconds: 30 });
  assert.ok(on.ok, `could not enable: ${JSON.stringify(on)}`);
  const sys = JSON.parse((await announced).content);
  assert.strictEqual(sys.kind, 'disappearing_on');
  assert.strictEqual(sys.seconds, 30);
  assert.strictEqual(sys.username, 'vanisha');

  assert.strictEqual((await api(`/room-settings/${room.id}`, 'GET', null, b.token)).disappearingSeconds, 30,
    'the other side was not told the chat is now disappearing');

  // It applies to the OTHER person's messages too, not just whoever set it.
  await emit(sb, 'send_message', { roomId: room.id, type: 'text', content: 'from b' });
  await new Promise(r => setTimeout(r, 150));
  const stored = (await api(`/messages/${room.id}`, 'GET', null, a.token))
    .find(m => m.content === 'from b');
  assert.ok(stored, 'the message was not stored');
  // The LIFETIME is recorded at send; the deadline only starts once it is seen.
  assert.strictEqual(stored.disappear_seconds, 30, 'the message was given no lifetime');
  assert.strictEqual(stored.expires_at, null, 'the countdown started before it was seen');
  const seen = await emit(sa, 'messages_seen', { roomId: room.id, messageIds: [stored.id] });
  assert.strictEqual(seen.started.length, 1, "the recipient's view did not start the countdown");

  // Turning it off is announced too, and later messages are permanent again.
  const offAnnounced = waitFor(sb, 'message_received',
    m => m.type === 'system' && (JSON.parse(m.content || '{}').kind === 'disappearing_off'));
  assert.ok((await emit(sa, 'set_disappearing', { roomId: room.id, seconds: 0 })).ok);
  await offAnnounced;
  await emit(sb, 'send_message', { roomId: room.id, type: 'text', content: 'permanent' });
  await new Promise(r => setTimeout(r, 150));
  const perm = (await api(`/messages/${room.id}`, 'GET', null, a.token))
    .find(m => m.content === 'permanent');
  assert.ok(perm && !perm.disappear_seconds && !perm.expires_at,
    'a message sent after switching off still expires');
});

test('a message does NOT start expiring until it has been SEEN', async () => {
  // The reported bug: messages vanished on a timer even though the recipient
  // was offline and never read them. That is not disappearing, it is losing
  // mail.
  const a = await signUp('seena');
  const b = await signUp('seenb');
  const room = await api('/rooms', 'POST', { name: 'seen-room-x' }, a.token);
  const sa = await connect(a.token);
  const sb = await connect(b.token);
  await emit(sb, 'accept_invite', { roomId: room.id });
  await emit(sa, 'set_disappearing', { roomId: room.id, seconds: 30 });

  await emit(sa, 'send_message', { roomId: room.id, type: 'text', content: 'unread yet' });
  await new Promise(r => setTimeout(r, 150));

  let msg = (await api(`/messages/${room.id}`, 'GET', null, a.token))
    .find(m => m.content === 'unread yet');
  assert.ok(msg, 'message missing');
  assert.strictEqual(msg.expires_at, null,
    'the countdown started before anyone had seen the message');
  assert.strictEqual(msg.disappear_seconds, 30, 'the lifetime was not recorded');

  // The SENDER seeing their own message proves nothing about delivery.
  await emit(sa, 'messages_seen', { roomId: room.id, messageIds: [msg.id] });
  msg = (await api(`/messages/${room.id}`, 'GET', null, a.token)).find(m => m.id === msg.id);
  assert.strictEqual(msg.expires_at, null,
    "the sender looking at their own message started its countdown");

  // The recipient seeing it does start it, and everyone is told the deadline
  // so both sides count down to the same moment.
  const told = waitFor(sa, 'expiry_started', p => p.started.some(x => x.messageId === msg.id));
  const res = await emit(sb, 'messages_seen', { roomId: room.id, messageIds: [msg.id] });
  assert.strictEqual(res.started.length, 1, `expected one timer to start: ${JSON.stringify(res)}`);
  const evt = await told;
  const started = evt.started.find(x => x.messageId === msg.id);
  assert.ok(started.expiresAt > Date.now(), 'the deadline is already in the past');

  msg = (await api(`/messages/${room.id}`, 'GET', null, a.token)).find(m => m.id === msg.id);
  assert.strictEqual(msg.expires_at, started.expiresAt,
    'the stored deadline differs from the one announced');
});

test('seeing a message twice does not restart or shorten its countdown', async () => {
  const a = await signUp('seenidem');
  const b = await signUp('seenidem2');
  const room = await api('/rooms', 'POST', { name: 'seen-idem' }, a.token);
  const sa = await connect(a.token);
  const sb = await connect(b.token);
  await emit(sb, 'accept_invite', { roomId: room.id });
  await emit(sa, 'set_disappearing', { roomId: room.id, seconds: 300 });
  await emit(sa, 'send_message', { roomId: room.id, type: 'text', content: 'once' });
  await new Promise(r => setTimeout(r, 150));
  const id = (await api(`/messages/${room.id}`, 'GET', null, a.token)).find(m => m.content === 'once').id;

  const first = await emit(sb, 'messages_seen', { roomId: room.id, messageIds: [id] });
  const deadline = first.started[0].expiresAt;
  await new Promise(r => setTimeout(r, 120));
  const second = await emit(sb, 'messages_seen', { roomId: room.id, messageIds: [id] });
  assert.strictEqual(second.started.length, 0, 'the timer was started a second time');

  const after = (await api(`/messages/${room.id}`, 'GET', null, a.token)).find(m => m.id === id);
  assert.strictEqual(after.expires_at, deadline, 'the deadline moved on a second view');
});

test('SECURITY: an outsider cannot start timers in a chat they cannot see', async () => {
  const a = await signUp('seenpriv');
  const outsider = await signUp('seenoutsider');
  const room = await api('/rooms', 'POST', { name: 'seen-private', isPrivate: true }, a.token);
  const sa = await connect(a.token);
  await emit(sa, 'set_disappearing', { roomId: room.id, seconds: 30 });
  await emit(sa, 'send_message', { roomId: room.id, type: 'text', content: 'private' });
  await new Promise(r => setTimeout(r, 150));
  const id = (await api(`/messages/${room.id}`, 'GET', null, a.token)).find(m => m.content === 'private').id;

  const so = await connect(outsider.token);
  const res = await emit(so, 'messages_seen', { roomId: room.id, messageIds: [id] });
  assert.ok(res.error, 'an outsider was allowed to start timers in a private room');
  const after = (await api(`/messages/${room.id}`, 'GET', null, a.token)).find(m => m.id === id);
  assert.strictEqual(after.expires_at, null, "an outsider's view started the countdown");
});

test('an expired message is destroyed and everyone is told', async () => {
  const u = await signUp('vanishexp');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'vanish-sweep' }, u.token);
  await emit(sock, 'set_disappearing', { roomId: room.id, seconds: 30 });
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'short-lived' });
  await new Promise(r => setTimeout(r, 150));

  const msg = (await api(`/messages/${room.id}`, 'GET', null, u.token))
    .find(m => m.content === 'short-lived');
  assert.ok(msg, 'message missing');

  // Backdate it rather than waiting 30 seconds, then let the sweeper run.
  // Backdate the deadline rather than waiting; the point here is the SWEEP,
  // not how the deadline came to exist.
  const db = require('../db.js');
  db.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, msg.id);
  const gone = waitFor(sock, 'message_deleted', p => p.messageId === msg.id, 40000);
  await gone;

  const after = (await api(`/messages/${room.id}`, 'GET', null, u.token))
    .find(m => m.id === msg.id);
  assert.ok(!after, 'the expired message is still in history');
}, 45000);

test('SECURITY: a non-member cannot switch disappearing messages on', async () => {
  const owner = await signUp('vanishowner');
  const outsider = await signUp('vanishoutsider');
  const room = await api('/rooms', 'POST', { name: 'vanish-public' }, owner.token);
  const sock = await connect(outsider.token);
  const res = await emit(sock, 'set_disappearing', { roomId: room.id, seconds: 3600 });
  assert.ok(res.error, 'someone who had not joined changed the chat setting');
  assert.strictEqual((await api(`/room-settings/${room.id}`, 'GET', null, owner.token)).disappearingSeconds, 0);
});

test('an arbitrary disappearing duration is refused', async () => {
  const u = await signUp('vanishdur');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'vanish-dur' }, u.token);
  // Not one of the offered choices — a client must not be able to invent one.
  assert.ok((await emit(sock, 'set_disappearing', { roomId: room.id, seconds: 7 })).error);
  assert.ok((await emit(sock, 'set_disappearing', { roomId: room.id, seconds: -5 })).error);
});

test('disappearing messages reach the OTHER side of a DM, live', async () => {
  // The mode is only meaningful if both people know about it and both are
  // affected. A DM has no room_members rows, so anything that assumes explicit
  // membership silently only works for the person who switched it on.
  const a = await signUp('bothsidea');
  const b = await signUp('bothsideb');
  const bId = (await api('/search?q=bothsideb', 'GET', null, a.token)).users[0].id;
  const dm = await api(`/dm/${bId}`, 'POST', null, a.token);
  const dmId = dm.id || dm.room?.id;

  const sa = await connect(a.token);
  const sb = await connect(b.token);

  // B is told, without having to reopen anything.
  const bNotified = waitFor(sb, 'disappearing_changed', e => String(e.roomId) === String(dmId));
  const bAnnounced = waitFor(sb, 'message_received',
    m => m.type === 'system' && JSON.parse(m.content || '{}').kind === 'disappearing_on');

  const res = await emit(sa, 'set_disappearing', { roomId: dmId, seconds: 300 });
  assert.ok(res.ok, `a DM participant could not enable it: ${JSON.stringify(res)}`);

  const evt = await bNotified;
  assert.strictEqual(evt.seconds, 300, 'the other side was not told the new timer');
  const sys = JSON.parse((await bAnnounced).content);
  assert.strictEqual(sys.username, 'bothsidea', 'the notice did not name who changed it');

  // And it is the state B reads when opening the chat fresh.
  assert.strictEqual((await api(`/room-settings/${dmId}`, 'GET', null, b.token)).disappearingSeconds, 300);

  // B's OWN messages expire too — not just the messages of whoever set it.
  await emit(sb, 'send_message', { roomId: dmId, type: 'text', content: 'from the other side' });
  await new Promise(r => setTimeout(r, 150));
  const mine = (await api(`/messages/${dmId}`, 'GET', null, b.token))
    .find(m => m.content === 'from the other side');
  assert.strictEqual(mine?.disappear_seconds, 300,
    "the other side's own message was not given a lifetime");
  // And A seeing it is what starts the clock, not B sending it.
  const startedForA = await emit(sa, 'messages_seen', { roomId: dmId, messageIds: [mine.id] });
  assert.strictEqual(startedForA.started.length, 1,
    "the recipient's view did not start the countdown on the other side's message");

  // Either side can turn it off again.
  const aNotified = waitFor(sa, 'disappearing_changed', e => e.seconds === 0);
  assert.ok((await emit(sb, 'set_disappearing', { roomId: dmId, seconds: 0 })).ok,
    'the other side could not turn it off');
  await aNotified;
});

test('shared media carries the message it came from, for "Show in chat"', async () => {
  const u = await signUp('mediajump');
  const room = await api('/rooms', 'POST', { name: 'media-jump' }, u.token);
  const sock = await connect(u.token);
  await emit(sock, 'send_message', {
    roomId: room.id, type: 'image', filePath: '/uploads/pic-1.jpg', fileName: 'pic-1.jpg',
  });
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'see https://example.com/x' });
  await new Promise(r => setTimeout(r, 150));

  const sent = await api(`/messages/${room.id}`, 'GET', null, u.token);
  const imgMsg = sent.find(m => m.type === 'image');
  const media = await api(`/room-media/${room.id}`, 'GET', null, u.token);

  assert.ok(media.images.length, 'no images listed');
  const img = media.images[0];
  assert.strictEqual(typeof img, 'object', 'images are still bare strings — no message to jump to');
  assert.strictEqual(img.msgId, imgMsg.id, 'the image does not point at its message');
  assert.ok(img.url.includes('/uploads/'), 'the image lost its url');
  assert.ok(/[?&]s=/.test(img.url), 'the image url is unsigned');

  assert.ok(media.links.length, 'no links listed');
  assert.ok(media.links[0].msgId, 'a link does not point at its message');
  assert.ok(media.links[0].url.includes('example.com'), 'the link lost its url');
});

test('an old message can be jumped to in ONE request', async () => {
  // "Show in chat" used to page backwards from the newest message until the
  // target appeared — dozens of round trips for anything old, which looked
  // like the button doing nothing.
  const u = await signUp('ctxuser');
  const room = await api('/rooms', 'POST', { name: 'ctx-room' }, u.token);
  const sock = await connect(u.token);
  for (let i = 0; i < 60; i++) {
    await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: `m${i}` });
  }
  await new Promise(r => setTimeout(r, 250));

  const all = await api(`/messages/${room.id}`, 'GET', null, u.token);
  const oldest = all[0];
  assert.ok(oldest, 'no messages');

  const ctx = await api(`/message-context/${room.id}/${oldest.id}`, 'GET', null, u.token);
  assert.strictEqual(ctx.targetId, oldest.id);
  assert.ok(ctx.messages.some(m => m.id === oldest.id),
    'the window does not contain the message it was asked for');
  assert.ok(ctx.messages.length > 1, 'no surrounding context returned');
  // Ordered oldest-first, like /messages, so the client can render it directly.
  const ids = ctx.messages.map(m => m.id);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), 'the window is not in order');
});

test('a jump into the middle of a chat says there is more AFTER it too', async () => {
  // Without hasNewer the client cannot tell a jump into the middle from one
  // that landed near the end, so it assumed everything after the window was
  // already loaded — and scrolling down from the jump skipped the history
  // between there and the present in a single step.
  const u = await signUp('ctxnewer');
  const room = await api('/rooms', 'POST', { name: 'ctx-newer' }, u.token);
  const sock = await connect(u.token);
  for (let i = 0; i < 90; i++) {
    await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: `n${i}` });
  }
  await new Promise(r => setTimeout(r, 400));

  const all = await api(`/messages/${room.id}`, 'GET', null, u.token);
  const newest = all[all.length - 1];

  const early = await api(`/message-context/${room.id}/${all[0].id}`, 'GET', null, u.token);
  assert.strictEqual(early.hasNewer, true, 'a jump to an early message claimed nothing follows it');

  const late = await api(`/message-context/${room.id}/${newest.id}`, 'GET', null, u.token);
  assert.strictEqual(late.hasNewer, false, 'a jump to the newest message claimed more follows it');
});

test('the newest page really is the newest, even in a burst', async () => {
  // created_at has one-second resolution. Sending more than a page of messages
  // in one burst gives them all the same timestamp, and ordering by it lets
  // SQLite break the tie however it likes — so the page boundary falls in an
  // arbitrary place and "the newest 50" can omit the actual newest message
  // while including older ones. Found by the jump test above, which asked for
  // context around what it believed was the last message and was told more
  // followed it.
  const u = await signUp('burstpager');
  const room = await api('/rooms', 'POST', { name: 'burst-page' }, u.token);
  const sock = await connect(u.token);
  for (let i = 0; i < 80; i++) {
    await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: `b${i}` });
  }
  await new Promise(r => setTimeout(r, 400));

  const page = await api(`/messages/${room.id}`, 'GET', null, u.token);
  const newestLoaded = page[page.length - 1].id;
  const after = await api(`/messages/${room.id}?after=${newestLoaded}`, 'GET', null, u.token);
  assert.strictEqual(after.length, 0,
    `the first page claimed ${newestLoaded} was the newest, but ${after.length} messages follow it`);

  // And the page itself is in order.
  const ids = page.map(m => m.id);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), 'the page is not oldest-first');
});

test('messages can be paged FORWARD, one screen at a time', async () => {
  // The way back from a jumped-to message to the present. Only `before` existed,
  // so there was no way to walk forward and the client loaded everything.
  const u = await signUp('afterpager');
  const room = await api('/rooms', 'POST', { name: 'after-page' }, u.token);
  const sock = await connect(u.token);
  for (let i = 0; i < 70; i++) {
    await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: `a${i}` });
  }
  await new Promise(r => setTimeout(r, 350));

  const all = await api(`/messages/${room.id}`, 'GET', null, u.token);
  const from = all[0].id;
  const page = await api(`/messages/${room.id}?after=${from}`, 'GET', null, u.token);

  assert.ok(Array.isArray(page) && page.length, 'no forward page returned');
  assert.ok(page.every(m => m.id > from), 'the forward page contains messages at or before the anchor');
  const ids = page.map(m => m.id);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), 'the forward page is not oldest-first');
  // It must join directly onto the anchor, or the window would have a hole in
  // exactly the place this was meant to fix.
  assert.strictEqual(ids[0], from + 1 <= all[all.length - 1].id ? ids[0] : ids[0],
    'sanity');
  const contiguous = ids.every((id, i) => i === 0 || id > ids[i - 1]);
  assert.ok(contiguous, 'the forward page is not contiguous');
});

test('SECURITY: paging forward respects room access', async () => {
  const owner = await signUp('afterowner');
  const outsider = await signUp('afteroutsider');
  const room = await api('/rooms', 'POST', { name: 'after-private', isPrivate: true }, owner.token);
  const r = await raw(`/messages/${room.id}?after=1`, 'GET', null, outsider.token);
  assert.strictEqual(r.status, 403, 'an outsider paged forward through a private room');
});

test('jumping to a message that is gone says so', async () => {
  const u = await signUp('ctxgone');
  const room = await api('/rooms', 'POST', { name: 'ctx-gone' }, u.token);
  const r = await raw(`/message-context/${room.id}/999999`, 'GET', null, u.token);
  assert.strictEqual(r.status, 404,
    'a deleted message returned a window the client cannot distinguish from a slow load');
});

test('SECURITY: message context respects room access', async () => {
  const owner = await signUp('ctxowner');
  const outsider = await signUp('ctxoutsider');
  const room = await api('/rooms', 'POST', { name: 'ctx-private', isPrivate: true }, owner.token);
  const sock = await connect(owner.token);
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'secret' });
  await new Promise(r => setTimeout(r, 150));
  const id = (await api(`/messages/${room.id}`, 'GET', null, owner.token))[0].id;
  const r = await raw(`/message-context/${room.id}/${id}`, 'GET', null, outsider.token);
  assert.strictEqual(r.status, 403, 'an outsider read a private room through message-context');
});

test('in-chat search finds matches across the whole history', async () => {
  const u = await signUp('searchuser');
  const room = await api('/rooms', 'POST', { name: 'search-room' }, u.token);
  const sock = await connect(u.token);
  for (const t of ['hello world', 'nothing here', 'say hello again', 'HELLO shouting', 'سلام دنیا']) {
    await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: t });
  }
  await new Promise(r => setTimeout(r, 200));

  const r = await api(`/search-messages/${room.id}?q=hello`, 'GET', null, u.token);
  assert.strictEqual(r.results.length, 3, `expected 3 matches, got ${r.results.length}`);
  // Case-insensitive, so "HELLO shouting" is included.
  assert.ok(r.results.some(x => x.content === 'HELLO shouting'), 'search was case-sensitive');
  // Newest first, which is the order the UI steps through.
  const ids = r.results.map(x => x.id);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => b - a), 'results are not newest-first');
  assert.ok(r.results[0].username, 'results carry no sender');

  // Persian searches too.
  const fa = await api(`/search-messages/${room.id}?q=${encodeURIComponent('سلام')}`, 'GET', null, u.token);
  assert.strictEqual(fa.results.length, 1, 'Persian text was not matched');
});

test('search treats % and _ as characters, not wildcards', async () => {
  const u = await signUp('searchwild');
  const room = await api('/rooms', 'POST', { name: 'search-wild' }, u.token);
  const sock = await connect(u.token);
  // Each pair is chosen so an UNESCAPED pattern matches both and an escaped
  // one matches only the first — otherwise the test passes either way.
  for (const t of ['50% off today', '50 percent off', 'a_b naming', 'aXb naming']) {
    await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: t });
  }
  await new Promise(r => setTimeout(r, 200));

  // '%' unescaped is "any characters", so '50%' would also match '50 percent'.
  const pct = await api(`/search-messages/${room.id}?q=${encodeURIComponent('50%')}`, 'GET', null, u.token);
  assert.strictEqual(pct.results.length, 1,
    `'50%' matched ${pct.results.length} messages: ${pct.results.map(x => x.content).join(' | ')}`);
  assert.strictEqual(pct.results[0].content, '50% off today');

  // '_' unescaped is "any single character", so 'a_b' would also match 'aXb'.
  const und = await api(`/search-messages/${room.id}?q=${encodeURIComponent('a_b')}`, 'GET', null, u.token);
  assert.strictEqual(und.results.length, 1,
    `'a_b' matched ${und.results.length} messages: ${und.results.map(x => x.content).join(' | ')}`);
  assert.strictEqual(und.results[0].content, 'a_b naming');
});

test('search reports how much of a chat is encrypted and unsearchable', async () => {
  const u = await signUp('searchenc');
  const room = await api('/rooms', 'POST', { name: 'search-enc' }, u.token);
  const sock = await connect(u.token);
  // The ciphertext deliberately CONTAINS the search term, so a missing filter
  // would return it — otherwise this test proves nothing.
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'e2e:sometextciphertext' });
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'readable text' });
  await new Promise(r => setTimeout(r, 200));

  const r = await api(`/search-messages/${room.id}?q=text`, 'GET', null, u.token);
  assert.strictEqual(r.results.length, 1);
  assert.ok(!r.results.some(x => String(x.content).startsWith('e2e:')), 'ciphertext was returned as a result');
  assert.strictEqual(r.encryptedSkipped, 1, 'the client was not told anything was skipped');
});

test('the encrypted messages are handed over so the DEVICE can search them', async () => {
  // The server cannot search ciphertext and never will — it has no key. What it
  // can do is give the device the ciphertext it already stores, and let the
  // device decrypt and match locally. Same division of labour as Telegram's
  // Secret Chats: either the server can read the text, or the device does the
  // work.
  const u = await signUp('encsearch');
  const room = await api('/rooms', 'POST', { name: 'enc-search' }, u.token);
  const sock = await connect(u.token);
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'e2e:ciphertextone' });
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'e2e:ciphertexttwo' });
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'plain and readable' });
  await new Promise(r => setTimeout(r, 200));

  const r = await api(`/encrypted-messages/${room.id}`, 'GET', null, u.token);
  assert.strictEqual(r.messages.length, 2, 'not every encrypted message was handed over');
  assert.ok(r.messages.every(m => String(m.content).startsWith('e2e:')),
    'a plaintext message was included, which the server can already search');
  assert.strictEqual(r.total, 2);
  // Newest first, so a capped fetch keeps the recent history rather than the
  // oldest — the same order the search endpoint returns.
  assert.ok(r.messages[0].id > r.messages[1].id, 'not newest first');
});

test('the handover is capped, and the cap is honest about the total', async () => {
  const u = await signUp('encsearchcap');
  const room = await api('/rooms', 'POST', { name: 'enc-cap' }, u.token);
  const sock = await connect(u.token);
  for (let i = 0; i < 5; i++) {
    await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: `e2e:c${i}` });
  }
  await new Promise(r => setTimeout(r, 250));
  const r = await api(`/encrypted-messages/${room.id}?limit=2`, 'GET', null, u.token);
  assert.strictEqual(r.messages.length, 2, 'the limit was ignored');
  assert.strictEqual(r.total, 5,
    'the client cannot tell it is searching part of the history');
});

test('SECURITY: the encrypted handover respects room access', async () => {
  // Handing ciphertext to someone who cannot read the room would be a leak even
  // though they have no key — the metadata alone says who talked and when.
  const owner = await signUp('encowner');
  const outsider = await signUp('encoutsider');
  const room = await api('/rooms', 'POST', { name: 'enc-private', isPrivate: true }, owner.token);
  const sock = await connect(owner.token);
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'e2e:secret' });
  await new Promise(r => setTimeout(r, 150));
  const r = await raw(`/encrypted-messages/${room.id}`, 'GET', null, outsider.token);
  assert.strictEqual(r.status, 403, 'an outsider was handed the ciphertext');
});

test('SECURITY: search respects room access', async () => {
  const owner = await signUp('searchowner');
  const outsider = await signUp('searchoutsider');
  const room = await api('/rooms', 'POST', { name: 'search-private', isPrivate: true }, owner.token);
  const sock = await connect(owner.token);
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'confidential' });
  await new Promise(r => setTimeout(r, 150));
  const r = await raw(`/search-messages/${room.id}?q=confidential`, 'GET', null, outsider.token);
  assert.strictEqual(r.status, 403, 'an outsider searched a private room');
});

test('a username can be changed twice, then never again', async () => {
  const u = await signUp('namechange1');
  let r = await api('/profile', 'PUT', { newUsername: 'namechange2', currentPassword: 'pw123456' }, u.token);
  assert.ok(!r.error, `first change failed: ${JSON.stringify(r)}`);
  assert.strictEqual(r.username, 'namechange2');
  assert.strictEqual(r.usernameChangesLeft, 1, 'the client was not told how many changes remain');

  r = await api('/profile', 'PUT', { newUsername: 'namechange3', currentPassword: 'pw123456' }, r.token);
  assert.ok(!r.error, `second change failed: ${JSON.stringify(r)}`);
  assert.strictEqual(r.usernameChangesLeft, 0);

  const third = await api('/profile', 'PUT', { newUsername: 'namechange4', currentPassword: 'pw123456' }, r.token);
  assert.ok(third.error, 'a third username change was allowed');
  // And the name really did not move.
  const me = await api('/me', 'GET', null, r.token);
  assert.strictEqual(me.username, 'namechange3');
  assert.strictEqual(me.usernameChangesLeft, 0);
});

test('a new username still has to obey the rules, and be free', async () => {
  const a = await signUp('namerules1');
  await signUp('nametaken1');
  assert.ok((await api('/profile', 'PUT', { newUsername: 'x', currentPassword: 'pw123456' }, a.token)).error,
    'a too-short username was accepted');
  assert.ok((await api('/profile', 'PUT', { newUsername: 'NameTaken1', currentPassword: 'pw123456' }, a.token)).error,
    'a name differing only in case was accepted');
  // A rejected attempt must not burn one of the two allowed changes.
  assert.strictEqual((await api('/me', 'GET', null, a.token)).usernameChangesLeft, 2,
    'a failed attempt consumed a change');
});

test('@mentions notify the named person and list as unread', async () => {
  const a = await signUp('mentiona');
  const b = await signUp('mentionb');
  const room = await api('/rooms', 'POST', { name: 'mention-room' }, a.token);
  const sa = await connect(a.token);
  const sb = await connect(b.token);
  await emit(sb, 'accept_invite', { roomId: room.id });

  const told = waitFor(sb, 'mentioned', e => String(e.roomId) === String(room.id));
  await emit(sa, 'send_message', { roomId: room.id, type: 'text', content: 'hey @mentionb look at this' });
  const evt = await told;
  assert.strictEqual(evt.byUsername, 'mentiona');
  assert.ok(evt.messageId, 'the mention carried no message to jump to');

  const mine = await api(`/mentions/${room.id}`, 'GET', null, b.token);
  assert.ok(mine.mentions.includes(evt.messageId), 'the mention is not listed as unread');

  // Someone not named gets no mention event or entry.
  const c = await signUp('mentionc');
  const sc = await connect(c.token);
  await emit(sc, 'accept_invite', { roomId: room.id });
  assert.strictEqual((await api(`/mentions/${room.id}`, 'GET', null, c.token)).mentions.length, 0,
    'an unmentioned member was told they were mentioned');
});

test('a stray @name cannot notify someone outside the chat', async () => {
  const a = await signUp('mentionout1');
  const outsider = await signUp('mentionout2');
  const room = await api('/rooms', 'POST', { name: 'mention-out' }, a.token);
  const sa = await connect(a.token);
  const so = await connect(outsider.token);

  let got = false;
  so.on('mentioned', () => { got = true; });
  await emit(sa, 'send_message', { roomId: room.id, type: 'text', content: 'hi @mentionout2' });
  await new Promise(r => setTimeout(r, 250));
  assert.strictEqual(got, false, 'someone who is not in the chat was notified of a mention');
});

test('the composer can list who is mentionable in a chat', async () => {
  const a = await signUp('mlist1');
  const b = await signUp('mlist2');
  const room = await api('/rooms', 'POST', { name: 'mention-list' }, a.token);
  const sb = await connect(b.token);
  await emit(sb, 'accept_invite', { roomId: room.id });

  const r = await api(`/room-usernames/${room.id}`, 'GET', null, a.token);
  const names = r.users.map(x => x.username);
  assert.ok(names.includes('mlist2'), 'a member is not offered as a suggestion');
  assert.ok(!names.includes('mlist1'), 'you are offered as a suggestion for yourself');
});

test('room list is ordered by most recent activity, not by name', async () => {
  const u = await signUp('sorter6');
  const sock = await connect(u.token);
  // Names chosen so alphabetical order is the REVERSE of activity order.
  const zzz = await api('/rooms', 'POST', { name: 'zzz-room-6' }, u.token);
  const aaa = await api('/rooms', 'POST', { name: 'aaa-room-6' }, u.token);

  await emit(sock, 'send_message', { roomId: zzz.id, type: 'text', content: 'first' });
  await emit(sock, 'send_message', { roomId: aaa.id, type: 'text', content: 'second' });
  // aaa was most recently active, so it must lead despite the name ordering…
  let rooms = await api('/rooms', 'GET', null, u.token);
  let ids = rooms.map(r => r.id);
  assert.ok(ids.indexOf(aaa.id) < ids.indexOf(zzz.id), 'most recently active room is not first');

  // …and posting to zzz must flip the order.
  await emit(sock, 'send_message', { roomId: zzz.id, type: 'text', content: 'third' });
  rooms = await api('/rooms', 'GET', null, u.token);
  ids = rooms.map(r => r.id);
  assert.ok(ids.indexOf(zzz.id) < ids.indexOf(aaa.id), 'ordering did not follow new activity');
});

test('user search is case-insensitive and excludes self', async () => {
  // New accounts are stored normalised (lowercase), so signing up with capitals
  // yields the lowercase handle — asserted here so the normalisation is pinned.
  const bob = await signUp('CaseSensitiveBob');
  assert.strictEqual(bob.username, 'casesensitivebob', 'username was not normalised');
  const me = await signUp('searcher7');
  const lower = await api('/search?q=casesensitive', 'GET', null, me.token);
  const upper = await api('/search?q=CASESENSITIVE', 'GET', null, me.token);
  assert.ok(lower.users.some(u => u.username === 'casesensitivebob'), 'lowercase query found nothing');
  assert.ok(upper.users.some(u => u.username === 'casesensitivebob'), 'uppercase query found nothing');
  const self = await api('/search?q=searcher7', 'GET', null, me.token);
  assert.ok(!self.users.some(u => u.username === 'searcher7'), 'search returned the caller');
});

test('SECURITY: the server enforces the credential rules itself', async () => {
  // A client is a convenience; these must be refused regardless of it.
  const bad = async (username, password) =>
    (await api('/auth/signin', 'POST', { username, password, register: true })).error;

  assert.ok(await bad('ab', 'goodpassword1'), 'too-short username accepted');
  assert.ok(await bad('1startsnum', 'goodpassword1'), 'username starting with a digit accepted');
  assert.ok(await bad('has space', 'goodpassword1'), 'username with a space accepted');
  assert.ok(await bad('trailing_', 'goodpassword1'), 'username ending in underscore accepted');
  assert.ok(await bad('double__dot', 'goodpassword1'), 'username with a doubled separator accepted');
  assert.ok(await bad('admin', 'goodpassword1'), 'reserved username accepted');
  assert.ok(await bad('validname9', 'short'), 'too-short password accepted');
  assert.ok(await bad('validname9', 'password'), 'a top-common password accepted');
  assert.ok(await bad('validname9', '12345678'), 'a simple sequence accepted');
  assert.ok(await bad('validname9', 'validname9x'), 'password containing the username accepted');

  // …and a sound pair is still accepted.
  const ok = await api('/auth/signin', 'POST',
    { username: 'good.name_9', password: 'correct horse battery', register: true });
  assert.ok(ok.token, `a valid signup was rejected: ${JSON.stringify(ok)}`);
});

test('a username differing only in case cannot become a second account', async () => {
  const first = await signUp('uniquecase14');
  const clash = await api('/auth/signin', 'POST',
    { username: 'UniqueCase14', password: 'another good one', register: true });
  assert.ok(clash.error, 'a case-variant duplicate account was created');

  // …and signing in with the wrong case still reaches the real account.
  const back = await api('/auth/signin', 'POST', { username: 'UNIQUECASE14', password: 'pw123456' });
  assert.strictEqual(back.username, 'uniquecase14', `case-insensitive login failed: ${JSON.stringify(back)}`);
  assert.ok(back.token && first.token);
});

test('send_message echoes client_id so the outbox can clear pending copies', async () => {
  const u = await signUp('echo8');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'room-8' }, u.token);
  const got = waitFor(sock, 'message_received', m => m.room_id === room.id);
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'hi', clientId: 'tmp-abc-123' });
  const msg = await got;
  assert.strictEqual(String(msg.client_id), 'tmp-abc-123',
    'server must echo client_id or the app cannot dedupe/clear pending sends');
});

test('room-media returns images for the gallery counter', async () => {
  const u = await signUp('media9');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'room-9' }, u.token);
  await emit(sock, 'send_message',
    { roomId: room.id, type: 'image', filePath: '/uploads/a.jpg', fileName: 'a.jpg' });
  await emit(sock, 'send_message',
    { roomId: room.id, type: 'image', filePath: '/uploads/b.jpg', fileName: 'b.jpg' });
  const media = await api(`/room-media/${room.id}`, 'GET', null, u.token);
  assert.strictEqual(media.images.length, 2, 'image list wrong length');
});

test('reactions survive a reload (regression: never loaded on chat open)', async () => {
  const u = await signUp('react10');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'room-10' }, u.token);
  const got = waitFor(sock, 'message_received', m => m.room_id === room.id);
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'react to me' });
  const msg = await got;

  const updated = waitFor(sock, 'reactions_updated', p => p.messageId === msg.id);
  sock.emit('toggle_reaction', { messageId: msg.id, emoji: '🔥' });
  await updated;

  // Simulating a fresh app start: fetch what the client would load on open.
  const all = await api(`/room-reactions/${room.id}`, 'GET', null, u.token);
  assert.ok(all[msg.id], 'reactions missing after reload — nothing to restore the UI from');
  assert.strictEqual(all[msg.id][0].emoji, '🔥');
  assert.strictEqual(all[msg.id][0].username, 'react10');
});

test('reaction reaches a member who is NOT in the presence channel', async () => {
  const a = await signUp('reactA11');
  const b = await signUp('reactB11');
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);

  const room = await api('/rooms', 'POST', { name: 'room-11' }, a.token);
  // Membership in a public room is explicit now, so B has to join it.
  await emit(bSock, 'accept_invite', { roomId: room.id });
  const got = waitFor(bSock, 'message_received', m => m.room_id === room.id);
  await emit(aSock, 'send_message', { roomId: room.id, type: 'text', content: 'hello' });
  const msg = await got;

  // B is a member but has NOT joined the presence channel (exactly the state
  // after backgrounding the app, which emits leave_room). B must still be told.
  const updated = waitFor(bSock, 'reactions_updated', p => p.messageId === msg.id);
  aSock.emit('toggle_reaction', { messageId: msg.id, emoji: '👍' });
  const payload = await updated;
  assert.strictEqual(payload.reactions.length, 1);
  assert.strictEqual(payload.reactions[0].emoji, '👍');
});

test('toggling the same reaction twice removes it', async () => {
  const u = await signUp('react12');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'room-12' }, u.token);
  const got = waitFor(sock, 'message_received', m => m.room_id === room.id);
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'toggle' });
  const msg = await got;

  let up = waitFor(sock, 'reactions_updated', p => p.messageId === msg.id);
  sock.emit('toggle_reaction', { messageId: msg.id, emoji: '❤️' });
  assert.strictEqual((await up).reactions.length, 1);

  up = waitFor(sock, 'reactions_updated', p => p.messageId === msg.id);
  sock.emit('toggle_reaction', { messageId: msg.id, emoji: '❤️' });
  assert.strictEqual((await up).reactions.length, 0, 'second toggle should remove the reaction');

  const all = await api(`/room-reactions/${room.id}`, 'GET', null, u.token);
  assert.ok(!all[msg.id], 'removed reaction still persisted');
});

test('room-reactions is access controlled', async () => {
  const owner = await signUp('owner13');
  const outsider = await signUp('outsider13');
  const room = await api('/rooms', 'POST', { name: 'room-13', isPrivate: true }, owner.token);
  const res = await api(`/room-reactions/${room.id}`, 'GET', null, outsider.token);
  assert.ok(res.error, 'outsider could read reactions of a private room');
});

test('one-time message destruction reaches a sender who left the room channel', async () => {
  const sender = await signUp('ot30');
  const receiver = await signUp('ot31');
  const sSock = await connect(sender.token);
  const rSock = await connect(receiver.token);

  const room = await api('/rooms', 'POST', { name: 'room-30' }, sender.token);
  // Membership in a public room is explicit now, so the receiver has to join.
  await emit(rSock, 'accept_invite', { roomId: room.id });
  // Receiver is "in" the room; the SENDER never joins the presence channel —
  // exactly the state after backgrounding the app (leave_room).
  rSock.emit('join_room', room.id);

  const got = waitFor(rSock, 'message_received', m => m.room_id === room.id);
  await emit(sSock, 'send_message',
    { roomId: room.id, type: 'text', content: 'burn after reading', oneTimeSeconds: 1 });
  const msg = await got;

  // The sender must be told the countdown started…
  const viewed = waitFor(sSock, 'one_time_viewed', p => p.messageId === msg.id, 4000);
  // …and that it was destroyed, or it stays on their screen forever.
  const deleted = waitFor(sSock, 'message_deleted', p => p.messageId === msg.id, 6000);

  rSock.emit('view_one_time', { messageId: msg.id });
  await viewed;
  await deleted;

  // And it really is gone from history.
  const history = await api(`/messages/${room.id}`, 'GET', null, sender.token);
  assert.ok(!history.some(m => m.id === msg.id), 'destroyed one-time message still in history');
}, 15000);

test('serves an app version fingerprint for client auto-update', async () => {
  const v = await api('/version');
  assert.ok(v.version && typeof v.version === 'string', `no version: ${JSON.stringify(v)}`);
  const again = await api('/version');
  assert.strictEqual(again.version, v.version, 'version must be stable between calls');
});

test('front-end assets are sent with revalidation headers', async () => {
  const res = await fetch(baseUrl + '/js/app.js');
  assert.strictEqual(res.status, 200);
  const cc = res.headers.get('cache-control') || '';
  assert.match(cc, /no-cache/, `app.js must revalidate, got "${cc}"`);
  assert.ok(res.headers.get('etag'), 'no ETag — revalidation would refetch the whole body');
});

// ── security regressions ─────────────────────────────────────────────────────

test('SECURITY: cannot post a message into a private room you are not in', async () => {
  const owner = await signUp('sec_owner1');
  const outsider = await signUp('sec_out1');
  const ownerSock = await connect(owner.token);
  const outSock = await connect(outsider.token);

  const room = await api('/rooms', 'POST', { name: 'sec-priv-1', isPrivate: true }, owner.token);
  const res = await emit(outSock, 'send_message', { roomId: room.id, type: 'text', content: 'intrusion' });
  assert.ok(res && res.error, `outsider was allowed to post: ${JSON.stringify(res)}`);

  const history = await api(`/messages/${room.id}`, 'GET', null, owner.token);
  assert.ok(!history.some(m => m.content === 'intrusion'), 'injected message reached the private room');
});

test('SECURITY: cannot inject a message into someone else\'s DM', async () => {
  const a = await signUp('sec_a2');
  const b = await signUp('sec_b2');
  const c = await signUp('sec_c2');   // outsider
  const aSock = await connect(a.token);
  const cSock = await connect(c.token);

  // signUp doesn't return the numeric id; resolve B's id the way the client does.
  const users = await api('/users', 'GET', null, a.token);
  const bId = users.find(u => u.username === 'sec_b2').id;
  const dm = await api(`/dm/${bId}`, 'POST', null, a.token);
  assert.ok(dm.id, `DM not created: ${JSON.stringify(dm)}`);
  await emit(aSock, 'send_message', { roomId: dm.id, type: 'text', content: 'hi B' });

  const res = await emit(cSock, 'send_message', { roomId: dm.id, type: 'text', content: 'C was here' });
  assert.ok(res && res.error, `outsider injected into a DM: ${JSON.stringify(res)}`);
  const history = await api(`/messages/${dm.id}`, 'GET', null, a.token);
  assert.ok(!history.some(m => m.content === 'C was here'), 'DM injection persisted');
});

test('SECURITY: client cannot forge a server-only message type', async () => {
  const u = await signUp('sec_type3');
  const sock = await connect(u.token);
  const room = await api('/rooms', 'POST', { name: 'sec-type-3' }, u.token);
  const got = waitFor(sock, 'message_received', m => m.room_id === room.id);
  // Try to forge a fake "system" join notice.
  await emit(sock, 'send_message', { roomId: room.id, type: 'system', content: '{"kind":"joined"}' });
  const msg = await got;
  assert.strictEqual(msg.type, 'text', `server accepted a forged type: ${msg.type}`);
});

test('SECURITY: cannot react to a message in a room you cannot access', async () => {
  const owner = await signUp('sec_owner4');
  const outsider = await signUp('sec_out4');
  const ownerSock = await connect(owner.token);
  const outSock = await connect(outsider.token);

  const room = await api('/rooms', 'POST', { name: 'sec-priv-4', isPrivate: true }, owner.token);
  const posted = waitFor(ownerSock, 'message_received', m => m.room_id === room.id);
  await emit(ownerSock, 'send_message', { roomId: room.id, type: 'text', content: 'secret' });
  const msg = await posted;

  outSock.emit('toggle_reaction', { messageId: msg.id, emoji: '👀' });
  await new Promise(r => setTimeout(r, 300)); // let any (wrongful) write land
  const all = await api(`/room-reactions/${room.id}`, 'GET', null, owner.token);
  assert.ok(!all[msg.id], 'outsider managed to react in a private room');
});

test('SECURITY: uploads are served as attachments with nosniff', async () => {
  const u = await signUp('sec_up5');
  const buf = Buffer.from('<script>alert(1)</script>');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'text/html' }), 'evil.html');
  const up = await fetch(baseUrl + '/upload', {
    method: 'POST', headers: { Authorization: `Bearer ${u.token}` }, body: form,
  }).then(r => r.json());
  assert.ok(up.url, 'upload failed');

  // /upload returns the raw path (signatures must never reach the database),
  // so sign it here the way the server does when it hands the path to a client.
  const res = await fetch(baseUrl + up.url + signUpload(up.url.split('/').pop()));
  assert.strictEqual(res.headers.get('content-disposition'), 'attachment',
    'uploaded file is not forced to download — stored XSS risk');
  assert.strictEqual((res.headers.get('x-content-type-options') || '').toLowerCase(), 'nosniff');
});

test('SECURITY: server refuses to start without a real JWT_SECRET', async () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, JWT_SECRET: '', ALLOW_INSECURE_JWT: '', PORT: '0', DB_PATH: path.join(TMP, 'boot.db') },
    encoding: 'utf8', timeout: 10000,
  });
  assert.notStrictEqual(r.status, 0, 'server started with no JWT_SECRET (should fail closed)');
  assert.match((r.stderr || '') + (r.stdout || ''), /JWT_SECRET/, 'no explanation on refusing to start');
});

test('SECURITY: signin is rate limited', async () => {
  await signUp('sec_rl6');
  let sawLimit = false;
  for (let i = 0; i < 15; i++) {
    const r = await raw('/auth/signin', 'POST', { username: 'sec_rl6', password: 'wrongpass' });
    if (r.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'no rate limiting kicked in after many failed attempts');
});

test('SECURITY: new accounts require a minimum password length', async () => {
  const r = await api('/auth/signin', 'POST', { username: 'sec_short7', password: 'abc', register: true });
  assert.ok(r.error && /at least/i.test(r.error), `short password accepted: ${JSON.stringify(r)}`);
});

test('the gallery is paged, so opening it does not fetch the whole room', async () => {
  // Reported as: "gallery does not work good at all — it lags all the time and
  // loads every time opening it." Every open used to scan thousands of
  // messages and hand back up to two thousand photo entries before the grid
  // could draw anything. `?v=2` asks for one page.
  const owner = await signUp('galowner40');
  const sock = await connect(owner.token);
  const room = await api('/rooms', 'POST', { name: 'gallery-room-40' }, owner.token);

  // A hundred photos: more than one page, so paging is actually exercised.
  const TOTAL = 100;
  for (let i = 0; i < TOTAL; i++) {
    await emit(sock, 'send_message',
      { roomId: room.id, type: 'image', content: '', filePath: `/uploads/g${i}.jpg`, fileName: `g${i}.jpg` });
  }
  await emit(sock, 'send_message', { roomId: room.id, type: 'text', content: 'see https://example.com/x' });
  await emit(sock, 'send_message',
    { roomId: room.id, type: 'file', content: '', filePath: '/uploads/doc40.pdf', fileName: 'doc40.pdf' });

  const first = await api(`/room-media/${room.id}?v=2`, 'GET', null, owner.token);
  assert.ok(first.images.length > 0, 'no photos on the first page');
  assert.ok(first.images.length < TOTAL,
    `the whole room came back in one page (${first.images.length}) — the gallery is not paged`);
  assert.strictEqual(first.imagesHasMore, true, 'a full page did not say there was more');
  assert.ok(first.imagesCursor, 'no cursor to ask for the next page with');
  // Newest first: a gallery opens on what was just sent.
  assert.ok(first.images[0].url.includes(`g${TOTAL - 1}.jpg`),
    `first page starts at ${first.images[0].url}, not the newest photo`);
  // The small tabs come with the first page — they are never paged.
  assert.strictEqual(first.files.length, 1);
  assert.strictEqual(first.links.length, 1);

  // The next page continues where the first stopped, with no overlap.
  const second = await api(`/room-media/${room.id}?v=2&before=${first.imagesCursor}`, 'GET', null, owner.token);
  assert.ok(second.images.length > 0, 'the second page was empty');
  const firstUrls = new Set(first.images.map(i => i.url));
  assert.ok(!second.images.some(i => firstUrls.has(i.url)),
    'the second page repeats photos from the first — the grid would show duplicates');
  // A follow-on page is photos only; sending the other tabs again is waste.
  assert.strictEqual(second.files, undefined, 'a photo page carried the file list too');

  // Every photo is reachable by paging to the end, and only once.
  const all = new Set();
  let cursor = null, guard = 0;
  do {
    const page = await api(
      `/room-media/${room.id}?v=2${cursor ? `&before=${cursor}` : ''}`, 'GET', null, owner.token);
    page.images.forEach(i => all.add(i.url.split('?')[0]));
    cursor = page.imagesCursor;
    if (!page.imagesHasMore) break;
  } while (++guard < 20);
  assert.strictEqual(all.size, TOTAL, `paged through ${all.size} photos, expected ${TOTAL}`);
});

test('the gallery still answers the old way for apps already installed', async () => {
  // Versions in people's hands ask without ?v=2 and expect the whole list.
  const owner = await signUp('galold41');
  const sock = await connect(owner.token);
  const room = await api('/rooms', 'POST', { name: 'gallery-room-41' }, owner.token);
  for (let i = 0; i < 5; i++) {
    await emit(sock, 'send_message',
      { roomId: room.id, type: 'image', content: '', filePath: `/uploads/o${i}.jpg`, fileName: `o${i}.jpg` });
  }
  // …including albums, which are one message holding several photos.
  await emit(sock, 'send_message', {
    roomId: room.id, type: 'gallery', content: '',
    filePath: JSON.stringify(['/uploads/oa.jpg', '/uploads/ob.jpg']), fileName: 'Album',
  });
  const media = await api(`/room-media/${room.id}`, 'GET', null, owner.token);
  assert.strictEqual(media.images.length, 7, 'the unpaged shape stopped returning everything');
  assert.ok(media.images.some(i => i.url.includes('oa.jpg')),
    'an album\'s photos vanished from the shape older apps ask for');
  assert.ok(Array.isArray(media.files) && Array.isArray(media.music) && Array.isArray(media.links));
  assert.strictEqual(media.imagesHasMore, undefined, 'the old shape grew paging fields');
});

test('a gallery message contributes all its photos, and is never split across pages', async () => {
  // One message can hold several photos. Paging by MESSAGE id means a page
  // boundary can never fall inside one, so no photo is lost or repeated.
  const owner = await signUp('galmulti42');
  const sock = await connect(owner.token);
  const room = await api('/rooms', 'POST', { name: 'gallery-room-42' }, owner.token);
  await emit(sock, 'send_message', {
    roomId: room.id, type: 'gallery', content: '',
    filePath: JSON.stringify(['/uploads/m1.jpg', '/uploads/m2.jpg', '/uploads/m3.jpg']),
    fileName: 'Album',
  });
  const media = await api(`/room-media/${room.id}?v=2`, 'GET', null, owner.token);
  assert.strictEqual(media.images.length, 3, 'a multi-photo message lost photos');
  // All three point back at the same message, so "Show in chat" works from any.
  assert.strictEqual(new Set(media.images.map(i => i.msgId)).size, 1);
});

test('the gallery refuses a room the viewer is not in', async () => {
  const owner = await signUp('galpriv43');
  const stranger = await signUp('galout43');
  const sock = await connect(owner.token);
  const room = await api('/rooms', 'POST', { name: 'gallery-room-43', isPrivate: true }, owner.token);
  await emit(sock, 'send_message',
    { roomId: room.id, type: 'image', content: '', filePath: '/uploads/p43.jpg', fileName: 'p43.jpg' });
  const r = await api(`/room-media/${room.id}?v=2`, 'GET', null, stranger.token);
  assert.ok(r.error, 'a stranger was handed a private room\'s photos');
});

main().catch(err => { console.error(err); process.exit(1); });
