// ── The blue tick was lying in every room ───────────────────────────────────
//
// "seen double check in rooms should be under all members seen circumstance".
// It turned blue when one member had read, in a room of any size, because the
// rule was written for a DM — where the maximum and the minimum are the same
// number — and then reused everywhere.
const assert = require('assert');
const { seenByAllUpTo } = require('../readReceipts');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE BUG: one reader in a room of five is not "seen"', () => {
  const answer = seenByAllUpTo({
    marks: { 2: 100 },              // only one person has read anything
    memberIds: [1, 2, 3, 4, 5],
    authorId: 1,
  });
  assert.strictEqual(answer, 0);
  // And the old rule, kept here so the difference is visible rather than
  // asserted: Math.max over the same input answers 100.
  assert.strictEqual(Math.max(0, ...Object.values({ 2: 100 })), 100);
});

test('…and everyone having read IS', () => {
  assert.strictEqual(seenByAllUpTo({
    marks: { 2: 100, 3: 140, 4: 120, 5: 300 },
    memberIds: [1, 2, 3, 4, 5],
    authorId: 1,
  }), 100, 'the answer must be the SLOWEST reader, not the fastest');
});

test('A MEMBER WHO HAS NEVER OPENED THE ROOM HAS NO ROW', () => {
  // The heart of it. Read positions are stored one row per reader, so the
  // people who have read nothing are exactly the ones missing from the map —
  // and a minimum taken over the rows that exist skips them completely.
  assert.strictEqual(seenByAllUpTo({
    marks: { 2: 100, 3: 100, 4: 100 },
    memberIds: [1, 2, 3, 4, 5],     // 5 has never read
    authorId: 1,
  }), 0, 'a member with no read mark was treated as having read everything');
});

test('the author\'s own reading does not count', () => {
  // Sending a message is not reading it, and a sender is always caught up in
  // their own chat — counting them would make every message seen by the one
  // person guaranteed to have seen it.
  assert.strictEqual(seenByAllUpTo({
    marks: { 1: 999, 2: 50 },
    memberIds: [1, 2],
    authorId: 1,
  }), 50);
});

test('A DM BEHAVES EXACTLY AS IT DID', () => {
  // This is the case that was always right, and the change must not touch it.
  assert.strictEqual(seenByAllUpTo({ marks: { 2: 80 }, memberIds: [1, 2], authorId: 1 }), 80);
  assert.strictEqual(seenByAllUpTo({ marks: {}, memberIds: [1, 2], authorId: 1 }), 0);
});

test('ids are compared as numbers, because JSON keys are strings', () => {
  // The marks arrive as an object, so every key is a string, and the member
  // ids arrive from SQLite as numbers. `marks[2]` and `marks['2']` are the
  // same property in JavaScript, but relying on that silently is how this
  // breaks the day the ids become UUIDs.
  assert.strictEqual(seenByAllUpTo({
    marks: { '2': 100, '3': 100 }, memberIds: ['1', '2', '3'], authorId: '1',
  }), 100);
});

test('NOTHING IS CLAIMED WHEN NOTHING IS KNOWN', () => {
  // Every one of these is a case where the honest answer is "no ticks". Wrong
  // in this direction costs a blue tick that should have been grey; wrong in
  // the other tells somebody their message was read when it was not.
  assert.strictEqual(seenByAllUpTo({}), 0);
  assert.strictEqual(seenByAllUpTo(), 0);
  assert.strictEqual(seenByAllUpTo({ marks: { 2: 100 } }), 0, 'no membership, no answer');
  assert.strictEqual(seenByAllUpTo({ marks: {}, memberIds: [], authorId: 1 }), 0);
  // A room of one: everyone who could read it has, and there is nobody. Two
  // blue ticks on a message nobody has read would be worse than none.
  assert.strictEqual(seenByAllUpTo({ marks: {}, memberIds: [1], authorId: 1 }), 0);
  // Number(null) is 0 and 0 is finite, so a null member id would sail through
  // a plain isFinite check and become "member 0" — whose mark is never there.
  assert.strictEqual(seenByAllUpTo({
    marks: { 2: 100 }, memberIds: [1, 2, null], authorId: 1,
  }), 0);
  assert.strictEqual(seenByAllUpTo({
    marks: { 2: 100 }, memberIds: [1, 2, 'zzz'], authorId: 1,
  }), 0);
  // A mark of 0 is a member who has opened nothing, not a member who has read.
  assert.strictEqual(seenByAllUpTo({
    marks: { 2: 0, 3: 100 }, memberIds: [1, 2, 3], authorId: 1,
  }), 0);
});

test('it never answers with a message id nobody has reached', () => {
  // A cheap property check over random rooms: whatever comes back, every
  // member must have a mark at least that high.
  for (let i = 0; i < 500; i++) {
    const n = 2 + Math.floor(Math.random() * 6);
    const memberIds = Array.from({ length: n }, (_, k) => k + 1);
    const marks = {};
    for (const id of memberIds) {
      if (Math.random() < 0.7) marks[id] = Math.floor(Math.random() * 200);
    }
    const answer = seenByAllUpTo({ marks, memberIds, authorId: 1 });
    if (answer === 0) continue;
    for (const id of memberIds) {
      if (id === 1) continue;
      assert.ok((marks[id] || 0) >= answer,
        `answered ${answer} while member ${id} had only read ${marks[id] || 0}`);
    }
  }
});

// ── The wiring, because a rule nothing calls is not a fix ───────────────────

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

test('THE SERVER ANSWERS IT, and does not break the old endpoint', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(/require\('\.\/readReceipts'\)/.test(server), 'the rule is never loaded');
  assert.ok(/'\/seen-by-all\/:roomId'/.test(server), 'nothing serves the group figure');
  // A NEW endpoint on purpose. Both clients read /read-receipts as a map of
  // ids to numbers and take the maximum of its values, so an extra key there
  // would break every build already on somebody's phone.
  assert.ok(/res\.json\(rows\.reduce/.test(server),
    '/read-receipts changed shape, which breaks every build already installed');
});

test('…and every sender is told the figure for THEIR messages', () => {
  // One number per room would be wrong: the author is the one reader who
  // never counts towards their own ticks, so the answer differs per member.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const code = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf("socket.on('mark_read'");
  assert.ok(i > 0);
  const end = code.indexOf("socket.on(", i + 10);
  const handler = code.slice(i, end);
  assert.ok(/authorId: id/.test(handler),
    'one figure is sent to everyone, so a sender is counted as a reader of their own message');
  assert.ok(/seenByAllUpTo: upto/.test(handler), 'the live event does not carry the figure');
  assert.ok(/lastReadMsgId: row\.last_read_msg_id/.test(handler),
    'the per-reader mark was replaced rather than added to, breaking installed builds');
});

test('BOTH CLIENTS USE IT, and neither takes a maximum any more', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  for (const [name, src] of [['the app', chat], ['the web client', web]]) {
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(/seen-by-all/.test(code), `${name} never asks for the group figure`);
    assert.ok(!/Math\.max\(0, \.\.\.Object\.values\(receipts\)\)/.test(code),
      `${name} still turns the tick blue when one member has read`);
  }
});

test('THE TICK IS NOT CLAMPED UPWARDS', () => {
  // "Seen by everyone" can go DOWN — someone joins the room, or a member who
  // was keeping up stops. The old value only ever climbed, which is right for
  // "the furthest anyone has read" and leaves a blue tick standing on a
  // message the room has no longer all seen.
  const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const code = chat.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf("onSock('messages_read'");
  const handler = code.slice(i, code.indexOf('});', i));
  assert.ok(/setMaxOtherReadMsgId\(seenByAllUpTo\)/.test(handler),
    'the group figure is clamped upwards, so the tick can never go back');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
