// ── Who has seen a message, and what that means for a one-time one ─────────
//
// Two reports, one set of rules, because they turn out to be the same
// question asked twice.
//
//   "in rooms, a one-time message should be seen by ALL members, not
//    disappear after the first user opens it"
//
//   "any message should have an info option showing who has seen it and
//    what time"
//
// The first was broken because messages.viewed_at is a single column on the
// message: the first member to open a one-time message started one global
// timer, and the message was destroyed for everyone — including members it
// had never been shown to. Correct in a DM, where there is exactly one
// recipient. Wrong in any room with three people in it, which is where it was
// reported from.
//
// Both now read from per-member records, so the rules below are about SETS of
// people rather than a single flag. They are pure: every one of them decides
// whether somebody sees a message or whether a message is destroyed, and a
// destroyed message cannot be got back.

/**
 * Whose view of a one-time message actually counts.
 *
 * Not the sender: their own view must not start anybody's clock, and they are
 * not waiting to see a message they wrote. Not somebody who has left the
 * room. The message is destroyed when this set has been exhausted, so getting
 * it wrong in one direction destroys a message somebody was still owed, and
 * in the other leaves it on the server forever.
 */
function audienceFor(o) {
  const memberIds = Array.isArray(o && o.memberIds) ? o.memberIds : [];
  const senderId = o && o.senderId;
  const seen = new Set();
  const out = [];
  for (const raw of memberIds) {
    const id = Number(raw);
    // Positive integers only. Number(null) is 0 — finite, and it happily
    // became "member 0", a user who does not exist and would therefore never
    // open anything, leaving every one-time message waiting on them forever.
    if (!Number.isInteger(id) || id <= 0) continue;
    if (Number(senderId) === id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Is this one-time message finished with — safe to destroy for good?
 *
 * ONLY when every member who was owed a sight of it has both opened it and
 * had their own countdown run out. Anything less destroys a message somebody
 * has not seen, which is the bug being fixed.
 *
 * A room whose only other member is the sender (a note to self, or everyone
 * else left) has an empty audience: there is nobody left who could see it, so
 * it is finished. Returning false there would leave it forever.
 */
function allViewsExpired(o) {
  // FAILS CLOSED. Called with nothing, this returned true — because an empty
  // audience means "nobody left who could see it" — and true here means
  // destroy the message. An unknown input must never be an instruction to
  // delete, so the caller has to have actually supplied a member list.
  if (!o || typeof o !== 'object' || !Array.isArray(o.memberIds)) return false;
  const audience = audienceFor(o);
  const seconds = Number(o && o.oneTimeSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  const views = new Map();
  for (const v of (Array.isArray(o && o.views) ? o.views : [])) {
    const id = Number(v && v.user_id);
    const at = Number(v && v.viewed_at);
    if (Number.isFinite(id) && Number.isFinite(at)) views.set(id, at);
  }
  const now = Number(o && o.now);
  if (!Number.isFinite(now)) return false;
  for (const id of audience) {
    const at = views.get(id);
    if (at == null) return false;              // never opened it
    if (now < at + seconds * 1000) return false; // still counting down
  }
  return true;
}

/**
 * Should this member still be shown a one-time message?
 *
 * The sender always keeps theirs until the message is destroyed — they are
 * looking at something they wrote, and hiding it from them the moment a
 * recipient opened it was never the behaviour.
 */
function visibleTo(o) {
  const userId = Number(o && o.userId);
  if (!Number.isFinite(userId)) return false;
  if (Number(o && o.senderId) === userId) return true;
  const at = Number(o && o.viewedAt);
  if (!Number.isFinite(at) || at <= 0) return true; // not opened yet
  const seconds = Number(o && o.oneTimeSeconds);
  const now = Number(o && o.now);
  if (!Number.isFinite(seconds) || !Number.isFinite(now)) return true;
  return now < at + seconds * 1000;
}

/**
 * When did each member see message `messageId`?
 *
 * From read-mark history: the EARLIEST mark that reached this message. A
 * single "last read" timestamp would answer with the time of their most
 * recent read instead, which is wrong for every message but the newest — and
 * an info panel that confidently reports the wrong time is worse than one
 * that reports nothing.
 *
 * Marks are given newest-first or oldest-first indifferently; this does not
 * assume an order, because the query that feeds it may change.
 */
function seenBy(o) {
  const messageId = Number(o && o.messageId);
  if (!Number.isFinite(messageId)) return [];
  const senderId = Number(o && o.senderId);
  const earliest = new Map();
  for (const m of (Array.isArray(o && o.marks) ? o.marks : [])) {
    const user = Number(m && m.user_id);
    const upto = Number(m && m.upto_msg_id);
    const at = Number(m && m.at);
    if (!Number.isFinite(user) || !Number.isFinite(upto) || !Number.isFinite(at)) continue;
    if (user === senderId) continue;     // the sender is not a reader
    if (upto < messageId) continue;      // this mark had not reached it yet
    const prev = earliest.get(user);
    if (prev == null || at < prev) earliest.set(user, at);
  }
  return [...earliest.entries()]
    .map(([userId, at]) => ({ userId, at }))
    .sort((a, b) => a.at - b.at);
}

/**
 * Members who have NOT seen it — named, because "3 of 5" is not an answer.
 *
 * The sender is excluded from both halves: they are neither waiting to read
 * their own message nor a reader of it.
 */
function notSeenBy(o) {
  const seen = new Set(seenBy(o).map(s => s.userId));
  return audienceFor({ memberIds: o && o.memberIds, senderId: o && o.senderId })
    .filter(id => !seen.has(id));
}

/**
 * How many read marks to keep per member per room.
 *
 * This table grows with READING rather than with messages — a member
 * scrolling an active chat can add dozens in a minute — so it is pruned. The
 * oldest are kept and the newest dropped, which is the opposite of the usual
 * rule and is the point: the earliest mark that passed a message is the one
 * that answers "when did they see it", and a later mark answers nothing that
 * an even later one does not.
 */
const MARKS_KEPT = 500;

/**
 * Which marks to delete, given every mark a member has in a room.
 *
 * Returns rowids. Keeps a spread across the range rather than a contiguous
 * block: dropping every mark below some id would make old messages
 * unanswerable, while dropping every other mark leaves every part of the
 * history answerable to within one mark.
 */
function marksToPrune(o) {
  const rows = (Array.isArray(o && o.rows) ? o.rows : [])
    .filter(r => r && Number.isFinite(Number(r.rowid)));
  const keep = Number.isFinite(Number(o && o.keep)) ? Number(o.keep) : MARKS_KEPT;
  if (rows.length <= keep) return [];
  const sorted = [...rows].sort((a, b) => Number(a.upto_msg_id) - Number(b.upto_msg_id));
  const drop = [];
  // Thin evenly: walk the list and keep every nth, where n makes the survivors
  // come to `keep`.
  const step = sorted.length / keep;
  const kept = new Set();
  for (let i = 0; i < keep; i++) kept.add(Math.floor(i * step));
  // The newest mark is always kept — it is the live read position.
  kept.add(sorted.length - 1);
  for (let i = 0; i < sorted.length; i++) {
    if (!kept.has(i)) drop.push(Number(sorted[i].rowid));
  }
  return drop;
}

module.exports = {
  audienceFor, allViewsExpired, visibleTo, seenBy, notSeenBy,
  marksToPrune, MARKS_KEPT,
};
