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
  await signUp('CaseSensitiveBob');
  const me = await signUp('searcher7');
  const lower = await api('/search?q=casesensitive', 'GET', null, me.token);
  const upper = await api('/search?q=CASESENSITIVE', 'GET', null, me.token);
  assert.ok(lower.users.some(u => u.username === 'CaseSensitiveBob'), 'lowercase query found nothing');
  assert.ok(upper.users.some(u => u.username === 'CaseSensitiveBob'), 'uppercase query found nothing');
  const self = await api('/search?q=searcher7', 'GET', null, me.token);
  assert.ok(!self.users.some(u => u.username === 'searcher7'), 'search returned the caller');
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

  const res = await fetch(baseUrl + up.url);
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

main().catch(err => { console.error(err); process.exit(1); });
