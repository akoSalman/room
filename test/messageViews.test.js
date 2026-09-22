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

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
