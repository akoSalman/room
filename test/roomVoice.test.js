// ── "Voice call in rooms doesn't work at all" ───────────────────────────────
//
// The signalling was never the problem. Offers, answers and ICE all relay
// correctly, and the mesh rule — existing members offer to each newcomer — is
// right. None of it ever ran, because a room call cannot connect until a
// SECOND person joins, and nothing told anybody that a first person had.
//
// In the app, voice_count was handled in one place and gated on being in the
// call already:
//
//     s.on('voice_count', ({ roomId, count }) => {
//       if (this.mode === 'room-voice' && …) …
//     });
//
// and the server addressed it to the chat's own socket room, which reaches
// only people who have that chat open. So the first person to tap the button
// sat alone in "waiting for others…" while every other phone stayed exactly
// as it was. Nobody joined, nothing connected, and the accurate report is the
// one that was filed.
const assert = require('assert');
const RV = require('../roomVoice');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('EVERY MEMBER IS TOLD, not just the ones with the chat open', () => {
  // The bug. A person reading another chat is exactly who needs telling; a
  // person already looking at this one is the one who needs it least.
  assert.deepStrictEqual(RV.notifyTargets({ memberIds: [1, 2, 3] }), [1, 2, 3]);
  // The joiner included: their own client uses the count for its status line,
  // and two sources for one number is how they end up disagreeing.
  assert.ok(RV.notifyTargets({ memberIds: [1, 2, 3] }).includes(1));
});

test('…once each, and never a member id that is not one', () => {
  // Two sockets for one person is ordinary — a phone and a laptop — and
  // notifying them twice would double the count they are shown.
  assert.deepStrictEqual(RV.notifyTargets({ memberIds: [2, 2, 3, 3, 3] }), [2, 3]);
  // Number(null) is 0 and 0 is finite, so a null would sail through a plain
  // isFinite check and become "member 0", who does not exist.
  assert.deepStrictEqual(RV.notifyTargets({ memberIds: [1, null, 2, undefined, '', 'x'] }), [1, 2]);
  assert.deepStrictEqual(RV.notifyTargets({}), []);
  assert.deepStrictEqual(RV.notifyTargets(), []);
  assert.deepStrictEqual(RV.notifyTargets({ memberIds: 'nope' }), []);
});

test('A CALL STARTING IS NEWS; a third person arriving is not', () => {
  // Pushing for every join would ring phones repeatedly through one
  // conversation, and teach people to ignore the notification that matters.
  assert.strictEqual(RV.isCallStarting({ countBefore: 0 }), true);
  assert.strictEqual(RV.isCallStarting({ countBefore: 1 }), false);
  assert.strictEqual(RV.isCallStarting({ countBefore: 5 }), false);
  // Read BEFORE the joiner is added, which is the only moment the two cases
  // can be told apart.
  for (const o of [{}, undefined, { countBefore: 'x' }, { countBefore: null }]) {
    assert.strictEqual(RV.isCallStarting(o), false, JSON.stringify(o));
  }
});

test('THE PERSON WHO STARTED IT IS NOT PUSHED', () => {
  // Their phone is in their hand with the call open on it.
  assert.deepStrictEqual(RV.pushTargets({ memberIds: [1, 2, 3], starterId: 1 }), [2, 3]);
  assert.deepStrictEqual(RV.pushTargets({ memberIds: [1, 2, 3], starterId: '1' }), [2, 3]);
  // An unknown starter pushes everybody rather than nobody: a spare
  // notification is recoverable, a call nobody hears about is the bug.
  assert.deepStrictEqual(RV.pushTargets({ memberIds: [1, 2] }), [1, 2]);
});

test('the notification says who, and where', () => {
  const t = RV.startedPush({ username: 'sara', roomName: 'Family' });
  assert.strictEqual(t.title, 'Family');
  assert.ok(/sara/.test(t.body) && /voice chat/i.test(t.body));
  // Missing pieces degrade rather than print "undefined started a voice chat".
  assert.ok(!/undefined|null/.test(RV.startedPush({}).title + RV.startedPush({}).body));
  assert.ok(RV.startedPush({}).title.length > 0);
  assert.ok(!/undefined/.test(RV.startedPush({ roomName: 'Family' }).body));
});

// ── The wiring ──────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const serverCode = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('THE SERVER TELLS THE MEMBERS, not the open chats', () => {
  const i = serverCode.indexOf("socket.on('voice_join'");
  assert.ok(i > 0, 'the server no longer handles voice_join');
  const handler = serverCode.slice(i, serverCode.indexOf('function announceVoice', i));
  assert.ok(/getRoomMemberIds/.test(handler),
    'the join is announced to sockets in the chat, so members reading elsewhere hear nothing');
  assert.ok(/announceVoice\(/.test(handler));
  // And the announcement itself is addressed per user.
  const ann = serverCode.slice(serverCode.indexOf('function announceVoice'));
  assert.ok(/io\.to\('user:' \+ id\)/.test(ann.slice(0, ann.indexOf('\n  }'))),
    'the count is not delivered per user, so it reaches only open chats');
});

test('…and a starting call is pushed, exactly once', () => {
  const i = serverCode.indexOf("socket.on('voice_join'");
  const handler = serverCode.slice(i, serverCode.indexOf('function announceVoice', i));
  assert.ok(/isCallStarting/.test(handler), 'every join pushes, or none does');
  assert.ok(/sendPushToUsers\(/.test(handler), 'nothing rings anybody when a call starts');
  assert.ok(/pushTargets/.test(handler), 'the starter is pushed their own call');
});

test('LEAVING UPDATES IT TOO, or the badge lies after the call ends', () => {
  const i = serverCode.indexOf('const leaveVoice = ');
  assert.ok(i > 0);
  const fn = serverCode.slice(i, serverCode.indexOf('socket.on(\'voice_leave\'', i));
  assert.ok(/announceVoice\(/.test(fn),
    'the count is not re-announced on leave, so "2 in" stays on screen forever');
});

test('THE APP RECORDS EVERY ROOM, not only the one it is calling in', () => {
  // The gate that made this invisible. A count you can only see once you are
  // in the call is no use to the person deciding whether to join it.
  const cm = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'callManager.ts'), 'utf8');
  const code = cm.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf("s.on('voice_count'");
  assert.ok(i > 0, 'the app no longer listens for the count');
  const handler = code.slice(i, code.indexOf('});', i));
  const gate = handler.indexOf("this.mode === 'room-voice'");
  const record = handler.indexOf('this.roomVoice.set');
  assert.ok(record > 0, 'the count is not recorded anywhere');
  assert.ok(gate === -1 || record < gate,
    'the count is still recorded only when already in the call');
  assert.ok(/voiceIn\(/.test(code) && /onRoomVoice\(/.test(code),
    'nothing can read the record, so nothing can show it');
});

test('THE SCREEN ACTUALLY SHOWS IT, and offers to join', () => {
  // A module nothing renders is the same as no module, and that is precisely
  // how this bug survived: every piece of the mechanism existed.
  const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const code = chat.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/callManager\.voiceIn\(/.test(code), 'the screen never asks who is in the voice chat');
  assert.ok(/callManager\.onRoomVoice\(/.test(code),
    'the screen reads it once and never updates, so a call starting changes nothing on screen');
  assert.ok(/voiceDot/.test(code), 'the call button looks the same whether a call is happening or not');
  assert.ok(/voiceBanner/.test(code), 'there is nothing to tap to join');
  // The banner must offer the join, not merely announce it.
  const b = code.indexOf('s.voiceBanner');
  assert.ok(/toggleRoomVoice/.test(code.slice(b - 400, b + 400)),
    'the banner says a call is happening but does not join it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
