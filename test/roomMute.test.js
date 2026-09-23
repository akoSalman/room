// ── Muting a ROOM, which is not the same as muting its members ──────────────
//
// Asked for as a mute button on rooms. Muting a PERSON already existed; a room
// did not — so the one chat somebody actually wants quiet, the busy group, was
// the only thing they could not silence. A room of ten needed ten separate
// mutes and still made a noise the day an eleventh person joined.
//
// The rule lives in notify.js beside the person mute, and for the same reason:
// there are seven call sites that send a push, and filtering at each of them is
// how one of them eventually gets forgotten.
const assert = require('assert');
const { recipientsFor } = require('../notify');

const tests = [];
const test = (n, f) => tests.push({ n, f });

const noMutes = () => false;
/** user 2 has muted room 7. */
const mutedRoom7 = (userId, roomId) => Number(userId) === 2 && String(roomId) === '7';

test('A MUTED ROOM DROPS ITS NOTIFICATIONS', () => {
  assert.deepStrictEqual(
    recipientsFor([1, 2, 3], 9, noMutes, { roomId: '7', isRoomMuted: mutedRoom7 }),
    [1, 3],
  );
});

test('…and only for the room that was muted', () => {
  // Muting one group must not silence every other chat, which is the failure
  // that would be reported as "notifications stopped working" all over again.
  assert.deepStrictEqual(
    recipientsFor([1, 2, 3], 9, noMutes, { roomId: '8', isRoomMuted: mutedRoom7 }),
    [1, 2, 3],
  );
});

test('A ROOM IS MUTED WHOEVER IS TALKING IN IT', () => {
  // The entire point of muting a room rather than each of its members one at
  // a time: the rule cannot depend on who sent this particular message.
  for (const sender of [1, 3, 4, 99]) {
    assert.ok(
      !recipientsFor([1, 2, 3], sender, noMutes, { roomId: '7', isRoomMuted: mutedRoom7 }).includes(2),
      `a message from ${sender} still notified the person who muted the room`,
    );
  }
});

test('the person mute still works, and the two stack', () => {
  // Neither filter may quietly replace the other.
  const mutedPerson = (userId, otherId) => Number(userId) === 1 && Number(otherId) === 9;
  // Person mute alone.
  assert.deepStrictEqual(recipientsFor([1, 2, 3], 9, mutedPerson), [2, 3]);
  // Both at once: 1 muted the sender, 2 muted the room.
  assert.deepStrictEqual(
    recipientsFor([1, 2, 3], 9, mutedPerson, { roomId: '7', isRoomMuted: mutedRoom7 }),
    [3],
  );
});

test('THE SENDER IS STILL NEVER NOTIFIED OF THEIR OWN MESSAGE', () => {
  // The existing guarantee, which the new filter runs before and must not
  // disturb.
  assert.deepStrictEqual(
    recipientsFor([1, 2, 3], 3, noMutes, { roomId: '7', isRoomMuted: mutedRoom7 }),
    [1],
  );
});

test('nothing is filtered when there is nothing to filter on', () => {
  // Every push that is not about a room — a call, a system notice — goes
  // through this same function. None of them may be dropped by a rule that
  // has no room to check.
  assert.deepStrictEqual(recipientsFor([1, 2, 3], 9, noMutes), [1, 2, 3]);
  assert.deepStrictEqual(recipientsFor([1, 2, 3], 9, noMutes, {}), [1, 2, 3]);
  assert.deepStrictEqual(
    recipientsFor([1, 2, 3], 9, noMutes, { roomId: null, isRoomMuted: mutedRoom7 }), [1, 2, 3]);
  assert.deepStrictEqual(
    recipientsFor([1, 2, 3], 9, noMutes, { roomId: '', isRoomMuted: mutedRoom7 }), [1, 2, 3]);
  // A room id with no checker, which is what an older server passes.
  assert.deepStrictEqual(recipientsFor([1, 2, 3], 9, noMutes, { roomId: '7' }), [1, 2, 3]);
  // Room 0 is not a room, but it is also not a reason to throw.
  assert.deepStrictEqual(
    recipientsFor([1, 2], 9, noMutes, { roomId: 0, isRoomMuted: mutedRoom7 }), [1, 2]);
});

test('a system notice with no sender is still filtered by room', () => {
  // `fromUserId` absent used to return early, before any other rule could
  // run. A room mute has nothing to do with who sent the message, so it must
  // apply on that path too.
  assert.deepStrictEqual(
    recipientsFor([1, 2, 3], null, noMutes, { roomId: '7', isRoomMuted: mutedRoom7 }),
    [1, 3],
  );
});

// ── The wiring ──────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const serverCode = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('THE TABLE EXISTS', () => {
  const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  assert.ok(/CREATE TABLE IF NOT EXISTS room_mutes/.test(db), 'there is nowhere to record a mute');
  const t = db.slice(db.indexOf('CREATE TABLE IF NOT EXISTS room_mutes'));
  assert.ok(/UNIQUE\(user_id, room_id\)/.test(t.slice(0, t.indexOf('`'))),
    'a room can be muted twice, so unmuting once leaves it muted');
});

test('THE FILTER IS APPLIED WHERE EVERY PUSH PASSES', () => {
  // Not at the call sites. There are seven, and the eighth is the one that
  // would be written without it.
  const i = serverCode.indexOf('async function sendPushToUsers');
  assert.ok(i > 0);
  const fn = serverCode.slice(i, serverCode.indexOf('sendWebPushToUsers(', i));
  assert.ok(/isRoomMuted: hasMutedRoom/.test(fn),
    'a muted room is never checked on the path every push takes');
  assert.ok(/roomId: data && data\.roomId/.test(fn),
    'the room id is not read from the payload every message push already carries');
});

test('THE ROOM ID IS COMPARED AS A NUMBER', () => {
  // It arrives from a push payload, where every value is a string, and goes
  // to SQLite, where '7' and 7 are different. A mute that silently never
  // matched would look exactly like the button doing nothing.
  const fn = serverCode.slice(serverCode.indexOf('function hasMutedRoom'));
  assert.ok(/parseInt\(String\(roomId\), 10\)/.test(fn.slice(0, fn.indexOf('\n}'))),
    'the room id is passed to SQLite as whatever the payload happened to hold');
});

test('THE BUTTON EXISTS, BOTH WAYS, and the list shows the state', () => {
  assert.ok(/'\/room-mute\/:roomId'/.test(serverCode), 'nothing serves the mute');
  assert.ok(/app\.post\('\/room-mute/.test(serverCode) && /app\.delete\('\/room-mute/.test(serverCode),
    'a room can be muted but not unmuted, or the other way about');
  assert.ok(/canAccessRoom/.test(serverCode.slice(serverCode.indexOf('function setRoomMute'))),
    'anyone can mute any room, including ones they cannot see');
  // And the list carries it, so the screen does not need a request per row.
  const list = serverCode.slice(serverCode.indexOf("app.get('/rooms'"));
  assert.ok(/room_mutes/.test(list.slice(0, list.indexOf('res.json'))),
    'the rooms list never says which rooms are muted');

  const rooms = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');
  const code = rooms.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/toggleRoomMute/.test(code), 'there is no button');
  assert.ok(/room-mute\//.test(code), 'the button calls nothing');
  assert.ok(/'POST' : 'DELETE'/.test(code), 'the button only mutes, or only unmutes');
  assert.ok(/notifications-off/.test(code), 'a muted room looks identical to a silent one');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
