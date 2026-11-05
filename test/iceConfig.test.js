// What a phone is told about finding itself (iceConfig.js).
//
// Reported as: on some devices the call never connects. Measured, from three
// real calls, identical on every end:
//
//     host=1 srflx=0 relay=0 ans=1 turn=1
//
// srflx=0 means STUN told the calling phone nothing about how the world sees
// it, so its entire offer was one candidate — its own address on its own
// network. ICE cannot succeed from that against anybody who is not on the same
// network, which is why these calls failed in about a second.
//
// The STUN server was stun.l.google.com. Google is blocked or throttled from
// these networks, and this app already knows it: the map tiles are proxied
// through its own server for exactly that reason. Nobody had applied the same
// reasoning to ICE. coturn answers STUN on the same port it answers TURN, and
// both servers already run it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const I = require('../iceConfig');

const tests = [];
const test = (n, f) => tests.push({ n, f });
const FALLBACK = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
const full = {
  TURN_URL: 'turn:chat.example.org:3478',
  TURN_USERNAME: 'u',
  TURN_PASSWORD: 'p',
};
const urlsOf = (list) => list.flatMap(e => e.urls);

// ── The STUN url for a TURN url ─────────────────────────────────────────────

test('THE FIX: a TURN host is a STUN host, on the same port', () => {
  assert.strictEqual(I.stunFor('turn:chat.example.org:3478'), 'stun:chat.example.org:3478');
  assert.strictEqual(I.stunFor('turns:chat.example.org:5349'), 'stun:chat.example.org:5349');
});

test('…with any transport dropped', () => {
  // ?transport describes how to reach a RELAY. It means nothing to a binding
  // request, and some implementations reject a url carrying it rather than
  // ignoring it.
  assert.strictEqual(I.stunFor('turn:h:3478?transport=tcp'), 'stun:h:3478');
  assert.strictEqual(I.stunFor('turn:h:3478?transport=udp'), 'stun:h:3478');
});

test('…and nothing at all for something that is not a TURN url', () => {
  // The SCHEME decides. "stun:turn.example.org" is not a TURN url, and
  // treating it as one would advertise a relay that does not exist.
  for (const bad of ['stun:turn.example.org', 'stun:h:3478', 'xturn:h', 'h:3478',
    '', '   ', 'turn:', 'turn:?transport=tcp', null, undefined, 42, {}, ['turn:h']]) {
    assert.strictEqual(I.stunFor(bad), null, `${JSON.stringify(bad)} produced a STUN url`);
  }
});

test('…and whitespace does not produce a broken url', () => {
  assert.strictEqual(I.stunFor('  turn:h:3478  '), 'stun:h:3478');
  assert.strictEqual(I.stunFor('turn:  '), null);
});

// ── The list, and the order it is tried in ──────────────────────────────────

test('OUR OWN STUN COMES FIRST', () => {
  // The whole point: the phone asks the host it is already talking to before
  // it asks one it may not be able to reach at all.
  const list = I.iceServersFor(full, FALLBACK);
  assert.strictEqual(list[0].urls[0], 'stun:chat.example.org:3478',
    'the phone asks a foreign STUN server first again');
});

test('…and the public ones are kept, after it', () => {
  // Free for a phone that can reach neither, and a real fallback on a network
  // where ours is the blocked one. Not a guess worth making either way.
  const urls = urlsOf(I.iceServersFor(full, FALLBACK));
  for (const f of FALLBACK) assert.ok(urls.includes(f), `${f} was dropped`);
  assert.ok(urls.indexOf('stun:chat.example.org:3478') < urls.indexOf(FALLBACK[0]),
    'the fallback is offered before ours');
});

test('the relay is offered with both transports and its credentials', () => {
  const relay = I.iceServersFor(full, FALLBACK).find(e => e.urls.some(u => /^turns?:/.test(u)));
  assert.ok(relay, 'no relay is offered at all');
  assert.deepStrictEqual(relay.urls,
    ['turn:chat.example.org:3478', 'turn:chat.example.org:3478?transport=tcp'],
    'the TCP fallback is gone — a phone whose carrier blocks UDP cannot allocate');
  assert.strictEqual(relay.username, 'u');
  assert.strictEqual(relay.credential, 'p');
});

test('THE 401 TRAP: no relay is offered without credentials', () => {
  // TURN answers an unauthenticated allocate with 401, which yields no relay
  // candidate and looks exactly like a blocked network. Offering the url
  // anyway would report "a relay was offered and could not be reached" — the
  // reading that sends somebody to inspect a firewall that is working.
  for (const partial of [
    { TURN_URL: full.TURN_URL },
    { TURN_URL: full.TURN_URL, TURN_USERNAME: 'u' },
    { TURN_URL: full.TURN_URL, TURN_PASSWORD: 'p' },
    { TURN_URL: full.TURN_URL, TURN_USERNAME: '  ', TURN_PASSWORD: 'p' },
    { TURN_URL: full.TURN_URL, TURN_USERNAME: 'u', TURN_PASSWORD: '' },
  ]) {
    const urls = urlsOf(I.iceServersFor(partial, FALLBACK));
    assert.ok(!urls.some(u => /^turns?:/.test(u)),
      `a relay was offered with ${JSON.stringify(partial)}`);
    // …but its STUN still is: the host answers binding requests regardless of
    // whether a relay allocation would be authorised, and that is the half
    // that was missing from the failing phone.
    assert.ok(urls.includes('stun:chat.example.org:3478'),
      'the STUN half was dropped along with the relay');
  }
});

test('with no TURN configured at all, the fallbacks are still offered', () => {
  // A server with no coturn must still let anybody call who can reach a
  // public STUN server.
  for (const empty of [{}, null, undefined, { TURN_URL: '' }, { TURN_URL: '   ' }]) {
    const urls = urlsOf(I.iceServersFor(empty, FALLBACK));
    assert.deepStrictEqual(urls, FALLBACK, `${JSON.stringify(empty)} produced ${urls}`);
  }
});

test('and with nothing configured anywhere, an empty list — not a broken one', () => {
  for (const bad of [null, undefined, 'stun:x', 42]) {
    assert.deepStrictEqual(I.iceServersFor({}, bad), [],
      `fallbacks ${JSON.stringify(bad)} produced something`);
  }
  // Every entry that IS produced must be usable: a urls array of strings.
  for (const e of I.iceServersFor(full, FALLBACK)) {
    assert.ok(Array.isArray(e.urls) && e.urls.length > 0, 'an entry has no urls');
    for (const u of e.urls) assert.strictEqual(typeof u, 'string');
  }
});

// ── The wiring ──────────────────────────────────────────────────────────────

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('the endpoint uses it, and no longer builds the list itself', () => {
  // The call must BE the value, not merely appear near it. Without the
  // `iceServers:` anchor a mutation putting `[…] || ` in front of it passed,
  // which is the same shape of weak assertion this work has produced three
  // times now: present is not the same as used.
  assert.ok(/iceServers: iceConfig\.iceServersFor\(process\.env/.test(srv),
    '/ice-config builds its own list again');
  const route = /app\.get\('\/ice-config'[\s\S]*?\n\}\);/.exec(srv);
  assert.ok(route, 'the route is gone');
  assert.ok(!/credential: process\.env\.TURN_PASSWORD/.test(route[0]),
    'the old hand-built relay entry is still there, so there are two rules again');
});

test('…and the module is deployed, or the servers keep the old one', () => {
  // server.js requires it, and a module missing from the deploy paths means
  // the change is committed, the tests pass, the push succeeds, no deploy
  // runs, and the servers quietly keep running without it. That has happened
  // twice in this repository; test/deployPaths.test.js is why it cannot again.
  const wf = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'deploy-servers.yml'), 'utf8');
  assert.ok(/'iceConfig\.js'/.test(wf), 'iceConfig.js is not in the deploy paths');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
