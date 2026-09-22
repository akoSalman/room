// ── Who has seen a message ──────────────────────────────────────────────────
//
// Reported as two things that turn out to be one:
//
//   "in rooms, a one-time message should be seen by ALL members, not
//    disappear after the first user opens it"
//   "any message should have an info option showing who has seen it and
//    what time"
//
// The first was broken because messages.viewed_at is a single column on the
// message. The first member to open a one-time message started one global
// timer and it was destroyed for everyone — including members it had never
// been shown to. Right in a DM with one recipient; wrong in every room.
//
// These rules decide whether somebody sees a message and whether a message is
// destroyed. A destroyed message cannot be got back, so each one is tested in
// both directions: destroying too early, and never destroying at all.
const assert = require('assert');
const V = require('../messageViews');

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Who is owed a sight of it ───────────────────────────────────────────────

test('THE SENDER IS NOT THE AUDIENCE', () => {
  // Their own view must not start anybody's clock, and they are not waiting
  // to see a message they wrote. Counting them would leave every one-time
  // message waiting forever for a view that never comes.
  assert.deepStrictEqual(V.audienceFor({ memberIds: [1, 2, 3], senderId: 2 }), [1, 3]);
});

test('…and the audience is de-duplicated and numeric', () => {
  // Member ids arrive from SQLite as numbers and from sockets as strings, and
  // a duplicate would make the message wait for the same person twice.
  // Number(null) is 0 and IS finite, so a null id became "member 0" — a user
  // who does not exist and can never open anything, which would leave every
  // one-time message waiting on them forever.
  assert.deepStrictEqual(V.audienceFor({ memberIds: [1, '1', 2, 2, null, 'x', 0, -3, 1.5], senderId: 9 }), [1, 2]);
  assert.deepStrictEqual(V.audienceFor({ memberIds: ['3'], senderId: '3' }), []);
  assert.deepStrictEqual(V.audienceFor(null), []);
});

// ── When a one-time message is finished with ────────────────────────────────

const base = { memberIds: [1, 2, 3], senderId: 1, oneTimeSeconds: 10, now: 100_000 };

test('THE BUG: one member opening it does NOT destroy it for the others', () => {
  // This is the whole report. Member 2 opened it and their ten seconds ran
  // out; member 3 has never seen it. Destroying now is destroying a message
  // somebody was owed.
  const views = [{ user_id: 2, viewed_at: 50_000 }];
  assert.strictEqual(V.allViewsExpired({ ...base, views }), false,
    'the message is destroyed while a member has still never seen it');
});

test('…and it IS destroyed once everyone has seen it and their time is up', () => {
  const views = [{ user_id: 2, viewed_at: 50_000 }, { user_id: 3, viewed_at: 80_000 }];
  assert.strictEqual(V.allViewsExpired({ ...base, views }), true);
  // One second before the last member's countdown ends: not yet.
  assert.strictEqual(V.allViewsExpired({ ...base, views, now: 89_999 }), false);
  assert.strictEqual(V.allViewsExpired({ ...base, views, now: 90_000 }), true);
});

test('the SENDER\'s own view never counts', () => {
  // Otherwise opening your own one-time message in a room of one other person
  // would destroy it before they ever got it.
  const views = [{ user_id: 1, viewed_at: 10 }];
  assert.strictEqual(V.allViewsExpired({ ...base, views }), false);
});

test('a message with nobody left to see it does not linger forever', () => {
  // Everyone else left the room, or it is a note to self. The audience is
  // empty, so there is nobody who could still see it.
  assert.strictEqual(V.allViewsExpired({ ...base, memberIds: [1], views: [] }), true);
});

test('nonsense inputs never destroy anything', () => {
  // Every false here is a message NOT destroyed. That is the safe direction.
  assert.strictEqual(V.allViewsExpired({ ...base, oneTimeSeconds: null, views: [] }), false);
  assert.strictEqual(V.allViewsExpired({ ...base, now: null, views: [] }), false);
  // true here means DESTROY. An unknown input must never be an instruction
  // to delete somebody's message.
  assert.strictEqual(V.allViewsExpired(null), false);
  assert.strictEqual(V.allViewsExpired({}), false);
  assert.strictEqual(V.allViewsExpired({ ...base, memberIds: null, views: [] }), false);
});

// ── What each member still sees ─────────────────────────────────────────────

test('a member who has not opened it still sees it', () => {
  assert.strictEqual(V.visibleTo({ userId: 3, senderId: 1, viewedAt: null, oneTimeSeconds: 10, now: 100 }), true);
});

test('…and stops seeing it when THEIR OWN countdown ends, not somebody else\'s', () => {
  const o = { userId: 3, senderId: 1, oneTimeSeconds: 10, now: 100_000 };
  assert.strictEqual(V.visibleTo({ ...o, viewedAt: 95_000 }), true);   // 5s left
  assert.strictEqual(V.visibleTo({ ...o, viewedAt: 90_000 }), false);  // just over
});

test('THE SENDER KEEPS THEIRS until the message is destroyed', () => {
  // Hiding it from the author the moment a recipient opened it was never the
  // behaviour, and it would make a one-time message vanish from the sender's
  // own chat while others were still reading it.
  assert.strictEqual(V.visibleTo({
    userId: 1, senderId: 1, viewedAt: 1, oneTimeSeconds: 10, now: 999_999,
  }), true);
});

// ── Who has seen it, and WHEN ───────────────────────────────────────────────

const marks = [
  { user_id: 2, upto_msg_id: 40, at: 1_000 },   // before this message
  { user_id: 2, upto_msg_id: 55, at: 2_000 },   // first mark that passed it
  { user_id: 2, upto_msg_id: 90, at: 9_000 },   // later, irrelevant
  { user_id: 3, upto_msg_id: 60, at: 5_000 },
  { user_id: 1, upto_msg_id: 99, at: 1_500 },   // the sender
];

test('THE TIME IS THE EARLIEST MARK THAT PASSED IT, not the latest read', () => {
  // A single "last read" timestamp would say member 2 saw message 50 at
  // 9,000 — the time of their most recent read, minutes or days later. An
  // info panel confidently reporting the wrong time is worse than none.
  const seen = V.seenBy({ messageId: 50, senderId: 1, marks });
  assert.deepStrictEqual(seen, [
    { userId: 2, at: 2_000 },
    { userId: 3, at: 5_000 },
  ]);
});

test('…ordered oldest first, and the sender is not listed as a reader', () => {
  const seen = V.seenBy({ messageId: 50, senderId: 1, marks });
  assert.ok(seen[0].at <= seen[1].at, 'not ordered by when they saw it');
  assert.ok(!seen.some(s => s.userId === 1), 'the sender is listed as having read their own message');
});

test('a mark that never reached the message does not count', () => {
  assert.deepStrictEqual(V.seenBy({ messageId: 95, senderId: 1, marks }), []);
  // Member 2's mark to 90 DID pass message 60, so they saw it — at 9,000,
  // the earliest of their marks that reached it. (This expectation was wrong
  // in the first draft of this test, which is what the test is for.)
  assert.deepStrictEqual(V.seenBy({ messageId: 60, senderId: 1, marks }),
    [{ userId: 3, at: 5_000 }, { userId: 2, at: 9_000 }]);
});

test('the order marks arrive in does not change the answer', () => {
  const a = V.seenBy({ messageId: 50, senderId: 1, marks });
  const b = V.seenBy({ messageId: 50, senderId: 1, marks: [...marks].reverse() });
  assert.deepStrictEqual(a, b, 'the answer depends on the query\'s ORDER BY');
});

test('WHO HAS NOT SEEN IT is named, because "2 of 5" is not an answer', () => {
  const not = V.notSeenBy({ messageId: 50, senderId: 1, memberIds: [1, 2, 3, 4], marks });
  assert.deepStrictEqual(not, [4]);
  // And the sender is in neither list.
  assert.ok(!not.includes(1));
});

// ── Keeping the history from growing without bound ──────────────────────────

test('nothing is pruned until there is more than the limit', () => {
  const rows = [{ rowid: 1, upto_msg_id: 1 }, { rowid: 2, upto_msg_id: 2 }];
  assert.deepStrictEqual(V.marksToPrune({ rows, keep: 5 }), []);
  assert.deepStrictEqual(V.marksToPrune({ rows: [], keep: 5 }), []);
});

test('pruning THINS the history rather than cutting off the old end', () => {
  // Dropping every mark below some id would make old messages unanswerable —
  // "seen by" would go blank for anything more than a few days back. Keeping
  // a spread leaves every part of the history answerable to within one mark.
  const rows = [];
  for (let i = 1; i <= 100; i++) rows.push({ rowid: i, upto_msg_id: i });
  const drop = new Set(V.marksToPrune({ rows, keep: 10 }));
  const kept = rows.filter(r => !drop.has(r.rowid)).map(r => r.upto_msg_id);
  assert.ok(kept.length <= 11, `kept ${kept.length}, expected about 10`);
  assert.ok(kept.includes(100), 'the live read position was pruned');
  assert.ok(Math.min(...kept) < 20, `the oldest kept mark is ${Math.min(...kept)} — old messages became unanswerable`);
});

test('the limit has a value, and pruning is not silently a no-op', () => {
  assert.ok(Number.isInteger(V.MARKS_KEPT) && V.MARKS_KEPT > 0);
  const rows = [];
  for (let i = 1; i <= V.MARKS_KEPT + 50; i++) rows.push({ rowid: i, upto_msg_id: i });
  assert.ok(V.marksToPrune({ rows }).length > 0, 'the default limit never prunes anything');
});


// ── The wiring, server and app ──────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const scode = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('view_one_time records the view PER MEMBER, not on the message', () => {
  // The bug in one line: messages.viewed_at is one column, so the first
  // opener destroyed it for everyone.
  const h = scode.slice(scode.indexOf("socket.on('view_one_time'"),
                        scode.indexOf("socket.on('message_info'"));
  assert.ok(h.length > 200, 'the view_one_time handler moved');
  assert.ok(/INSERT OR IGNORE INTO message_views/.test(h),
    'the view is still recorded only on the message, so one opener hides it from everyone');
  assert.ok(/allViewsExpired\(/.test(h),
    'the message is destroyed on a timer rather than on everyone having seen it');
  // And a second open must not restart that member's countdown.
  assert.ok(/SELECT viewed_at FROM message_views WHERE message_id = \? AND user_id = \?/.test(h),
    'reopening restarts the countdown, so the message lasts as long as somebody keeps reopening it');
});

test('…and the countdown starts only on the screen that opened it', () => {
  // Emitting to the whole room started the animation on screens whose owner
  // had not opened the message.
  const h = scode.slice(scode.indexOf("socket.on('view_one_time'"),
                        scode.indexOf("socket.on('message_info'"));
  assert.ok(!/io\.to\(String\(msg\.room_id\)\)\.emit\('one_time_viewed'/.test(h),
    "one_time_viewed is broadcast to the whole room again");
  assert.ok(/io\.to\('user:' \+ socket\.user\.id\)\.emit\('one_time_viewed'/.test(h));
});

test('message_info answers from read-mark HISTORY', () => {
  const h = scode.slice(scode.indexOf("socket.on('message_info'"));
  assert.ok(/FROM read_marks WHERE room_id = \? AND upto_msg_id >= \?/.test(h),
    'the info panel reads room_reads, which cannot say WHEN a message was passed');
  assert.ok(/canAccessRoom\(socket\.user\.id, room\)/.test(h.slice(0, 900)),
    'anyone can ask who has read a message in a room they are not in');
});

test('read marks are actually recorded, at BOTH places a mark advances', () => {
  // Recorded at only one of them and the history has holes, which show up as
  // "seen by nobody" on messages that were plainly read.
  assert.ok(/INSERT INTO read_marks/.test(scode), 'marks are never recorded');
  // Two CALL sites: mark_read, and the path that marks a room read on open.
  // The definition is `const recordReadMark = (` and does not match this.
  const calls = (scode.match(/recordReadMark\(/g) || []).length;
  assert.ok(calls >= 2, `recordReadMark is called ${calls} time(s); both mark_read and the room-open path need it`);
  assert.ok(/marksToPrune\(/.test(scode), 'the history grows without bound');
});

const chat = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const ccode = chat.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('THE MENU ITEM EXISTS AND DOES SOMETHING', () => {
  // A row that is registered and silently does nothing passes every check
  // that only reads for its label.
  assert.ok(/label="Info"/.test(ccode), 'there is no Info row in the message menu');
  assert.ok(/openMessageInfo\(m\)/.test(ccode), 'the Info row does not open anything');
  assert.ok(/emit\('message_info'/.test(ccode), 'nothing ever asks the server');
});

test('…on ANY message, not only my own', () => {
  // Knowing whether the person you are talking to has read you is the point.
  const row = ccode.slice(ccode.indexOf('label="Info"') - 300, ccode.indexOf('label="Info"') + 200);
  assert.ok(!/mineMsg/.test(row), 'Info is only offered on your own messages');
});

test('the panel distinguishes "still loading" from "nobody has seen it"', () => {
  // An empty list shown while the answer is still in flight reads as a fact,
  // and it is the opposite of one.
  assert.ok(/msgInfo\?\.loading/.test(ccode), 'there is no loading state, so an empty list shows first');
  assert.ok(/Nobody has seen this yet/.test(ccode));
  assert.ok(/msgInfo\?\.error/.test(ccode), 'a failed request looks identical to nobody having read it');
});

test('the time shown includes the DATE', () => {
  // A list of times with no dates cannot distinguish today from last month.
  assert.ok(/function fullWhen/.test(chat), 'no date-aware formatter');
  const f = chat.slice(chat.indexOf('function fullWhen'), chat.indexOf('function fmtTime'));
  assert.ok(/day: '2-digit'/.test(f) && /month: 'short'/.test(f),
    'the info panel shows a time with no date');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
