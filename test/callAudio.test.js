// Where call audio comes out, and what the caller is told while they wait.
//
// Two reports, one call screen:
//
//   "When calling, the first rings are not on speaker but are in a loud
//    state."  — the outgoing ringback played before any call audio session
//    existed, so Android treated it as ordinary media: full loudspeaker, at
//    media volume, held against an ear. It only dropped to the earpiece when
//    the callee answered and InCallManager.start() ran for the first time.
//
//   "On calling, check if the user is online or available then show ringing,
//    otherwise connecting." — the screen said "Ringing…" the instant the offer
//    was handed to the socket, which is a claim about the OTHER phone made
//    without hearing from it, and simply untrue when nobody was there.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping call-audio tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'callaudio-'));
execFileSync(TSC, [path.join(NAT, 'src', 'callAudio.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const A = require(path.join(OUT, 'callAudio.js'));

// The web's copy of the status rule, loaded as the browser would.
global.window = global;
require(path.join(__dirname, '..', 'public', 'js', 'callStatus.js'));
const W = global.window.CallStatus;

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Routing ─────────────────────────────────────────────────────────────────

test('THE BUG: an outgoing voice call rings in the earpiece, not the loudspeaker', () => {
  const r = A.routeFor({ mode: 'dm-voice', phase: 'outgoing' });
  assert.strictEqual(r.speaker, false, 'the ringback was put on the loudspeaker');
  assert.strictEqual(r.earpiece, true, 'our own ring tone was left on the media route');
});

test('THE OTHER HALF: the session is open while it is still ringing out', () => {
  // Opening it only on connect is what made the ringback media rather than
  // call audio; there is no route to speak of until start() has run.
  assert.strictEqual(A.sessionNeeded('outgoing'), true,
    'no audio session while ringing — the ringback is plain media again');
  assert.strictEqual(A.sessionNeeded('connected'), true);
});

test('an INCOMING ring stays on the loudspeaker', () => {
  // The one tone that must not go to the earpiece: the phone is ringing at
  // somebody who is not holding it, and an earpiece ring is a missed call.
  const r = A.routeFor({ mode: 'dm-voice', phase: 'incoming' });
  assert.strictEqual(r.speaker, true, 'the incoming ring was routed to the earpiece');
  assert.strictEqual(r.earpiece, false);
  assert.strictEqual(A.sessionNeeded('incoming'), false,
    'the call session was opened before the call was even accepted');
});

test('video and group calls are hands-free from the first ring', () => {
  assert.strictEqual(A.routeFor({ mode: 'dm-video', phase: 'outgoing' }).speaker, true);
  assert.strictEqual(A.routeFor({ mode: 'dm-video', phase: 'outgoing' }).media, 'video');
  assert.strictEqual(A.routeFor({ mode: 'room-voice', phase: 'connected' }).speaker, true);
});

test('once connected, the speaker button wins over the default', () => {
  // Otherwise re-applying the route — which happens on connect — would undo a
  // choice the user had already made.
  assert.strictEqual(A.routeFor({ mode: 'dm-voice', phase: 'connected', speakerOn: true }).speaker, true);
  assert.strictEqual(A.routeFor({ mode: 'dm-video', phase: 'connected', speakerOn: false }).speaker, false);
  // …but not before the call exists, where there is no choice to respect yet.
  assert.strictEqual(A.routeFor({ mode: 'dm-voice', phase: 'outgoing', speakerOn: true }).speaker, false);
});

test('a voice call never opens a video session', () => {
  for (const phase of ['outgoing', 'connected']) {
    assert.strictEqual(A.routeFor({ mode: 'dm-voice', phase }).media, 'audio');
    assert.strictEqual(A.routeFor({ mode: 'room-voice', phase }).media, 'audio');
  }
});

// ── What the caller is told ─────────────────────────────────────────────────

test('THE BUG: nothing says "Ringing" until the other phone says it is ringing', () => {
  assert.strictEqual(A.outgoingStatus({}), 'Connecting…',
    'the call claimed to be ringing before it had been delivered anywhere');
  assert.strictEqual(A.outgoingStatus({ delivered: true }), 'Calling…',
    'delivered is not the same as alerting — their screen may still be dark');
  assert.strictEqual(A.outgoingStatus({ delivered: true, ringing: true }), 'Ringing…');
});

test('an offline callee is never described as ringing', () => {
  // They are being woken by a push, and may be face down in a drawer.
  assert.strictEqual(A.outgoingStatus({ delivered: false }), 'Connecting…');
});

test('answering and connecting outrank ringing, in that order', () => {
  assert.strictEqual(A.outgoingStatus({ delivered: true, ringing: true, answered: true }), 'Connecting…');
  assert.strictEqual(
    A.outgoingStatus({ delivered: true, ringing: true, answered: true, connected: true }), 'Connected');
  // Connected without a recorded answer still reads as connected.
  assert.strictEqual(A.outgoingStatus({ connected: true }), 'Connected');
});

test('the web says exactly what the app says, for every combination', () => {
  // A call that reads "Ringing" on one platform and "Connecting" on the other
  // for the same facts is a bug in whichever is behind.
  const flags = ['delivered', 'ringing', 'answered', 'connected'];
  let checked = 0;
  for (let mask = 0; mask < 16; mask++) {
    const s = {};
    flags.forEach((f, i) => { s[f] = !!(mask & (1 << i)); });
    assert.strictEqual(W.outgoingStatus(s), A.outgoingStatus(s),
      `web and app disagree for ${JSON.stringify(s)}`);
    checked++;
  }
  assert.strictEqual(checked, 16, 'the drift check did not actually run');
  // And the shapes the callers really pass: undefined, not false.
  assert.strictEqual(W.outgoingStatus({}), A.outgoingStatus({}));
  assert.strictEqual(W.outgoingStatus({ ringing: true }), A.outgoingStatus({ ringing: true }));
});

// ── The wiring, which no unit test can reach ────────────────────────────────

test('the call manager routes BEFORE it makes a noise', () => {
  const src = fs.readFileSync(path.join(NAT, 'src', 'callManager.ts'), 'utf8');
  const start = src.indexOf('async startDM(');
  assert.ok(start > 0, 'startDM is gone — this check is vacuous');
  const body = src.slice(start, src.indexOf('async accept()', start));
  const route = body.indexOf("applyRoute('outgoing')");
  const ring = body.indexOf('this.startRing()');
  assert.ok(route > 0, 'an outgoing call no longer opens its audio session — the ringback is media again');
  assert.ok(ring > route, 'the ring starts before the route is set, which is the original bug');
});

test('the caller asks the server whether anyone got the offer', () => {
  const src = fs.readFileSync(path.join(NAT, 'src', 'callManager.ts'), 'utf8');
  assert.ok(/emit\('call_offer',[\s\S]{0,300}?\},\s*\(res/.test(src),
    'call_offer is emitted with no ack, so nothing knows whether it was delivered');
  assert.ok(src.includes("s.on('call_ringing'"), 'the caller never listens for the ringing confirmation');
  assert.ok(/emit\('call_ringing'/.test(src), 'the callee never confirms that it is ringing');
});

test('the server answers the ack and relays the confirmation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/socket\.on\('call_offer', \(\{[^}]*\}, ack\)/.test(src),
    'the server ignores the ack, so the caller waits on a promise nobody settles');
  assert.ok(/ack\(\{ delivered/.test(src), 'the ack carries no delivery answer');
  assert.ok(/socket\.on\('call_ringing'/.test(src), 'the server does not relay call_ringing');
});

test('the web page uses the shared rule rather than a hard-coded word', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calls.js'), 'utf8');
  assert.ok(!/setStatus\('Ringing…'\)/.test(src), 'the web still asserts "Ringing…" on its own');
  assert.ok(src.includes('CallStatus.outgoingStatus'), 'the web does not use the shared rule');
});

test('no function in calls.js calls itself unconditionally', () => {
  // markConnected() ended with `markConnected();` — unconditional recursion,
  // so every connected call on the web blew the stack, the status never left
  // "Connecting…" and the timer never appeared. It shipped in July and nothing
  // noticed, because a thrown RangeError inside a socket handler is silent.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calls.js'), 'utf8');
  const bad = [];
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
    const name = m[1];
    // The statement immediately before the function's closing brace, found by
    // matching braces from the opening one.
    let depth = 0, i = m.index + m[0].length - 1, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const body = src.slice(m.index + m[0].length, end);
    // Only the function's OWN top level counts: a self-call inside an `if`, a
    // callback or a nested function may well be deliberate recursion. Nested
    // brace blocks are removed, innermost first, until none are left.
    let top = body, before;
    do { before = top; top = top.replace(/\{[^{}]*\}/g, ' '); } while (top !== before);
    if (new RegExp(`(^|[;\\s])${name}\\s*\\(\\s*\\)\\s*;`).test(top)) bad.push(name);
  }
  assert.deepStrictEqual(bad, [], `these functions recurse forever: ${bad.join(', ')}`);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
