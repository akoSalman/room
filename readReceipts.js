// ── "Seen" in a room means seen by everyone ─────────────────────────────────
//
// Asked for as: "seen double check in rooms should be under all members seen
// circumstance". The tick was turning blue as soon as ONE member opened the
// chat, because both clients did the same thing with the read positions:
//
//     maxOtherReadMsgId = Math.max(0, ...Object.values(receipts));
//
// In a two-person chat max and min are the same number, which is why this was
// never noticed: the DM it was written for behaved correctly and the rooms it
// was reused in did not. In a room of six, one person glancing at the chat
// told the sender that all six had read it.
//
// Two things have to be right, and only one of them is the max/min swap.
//
// The read positions are stored one row per reader, and a member who has
// never opened the room HAS NO ROW. Taking the minimum over the rows that
// exist would skip exactly the people who have not read anything — so a room
// where five of six have read would report the minimum of those five, and the
// sixth, who has read nothing, would not lower it. The absent member is the
// whole question, so membership is what this iterates, not receipts.
//
// This lives outside server.js because it is the sort of rule that is easy to
// write plausibly and wrongly, and a phone, a room and five other people is an
// expensive way to find that out.

/**
 * The highest message id that EVERY other member has read up to.
 *
 * @param marks      user id -> last read message id, for whoever has a mark
 * @param memberIds  every member of the room, the author included
 * @param authorId   whose ticks these are; their own reading does not count
 * @returns 0 when anyone has not read, or when the answer is unknowable
 */
function seenByAllUpTo(o) {
  const marks = (o && o.marks) || {};
  const memberIds = (o && o.memberIds) || [];
  if (!Array.isArray(memberIds)) return 0;
  const author = numberOrNull(o && o.authorId);

  const others = [];
  for (const raw of memberIds) {
    const id = numberOrNull(raw);
    // A member id that is not a number is not a member this can reason about.
    // Skipping it would quietly raise the answer — the safe direction is to
    // report nothing rather than claim everyone has read.
    if (id === null) return 0;
    if (author !== null && id === author) continue;
    others.push(id);
  }
  // Nobody else in the room. A message sent into a room of one has been seen
  // by everyone who could see it, but claiming "seen" for an audience of zero
  // would put two blue ticks on a message nobody has read, so: no.
  if (others.length === 0) return 0;

  let lowest = Infinity;
  for (const id of others) {
    // The absent member is the point: no row means they have read nothing.
    const mark = numberOrNull(marks[id]) ?? numberOrNull(marks[String(id)]) ?? 0;
    if (mark <= 0) return 0;   // one unread member settles it
    if (mark < lowest) lowest = mark;
  }
  return lowest === Infinity ? 0 : lowest;
}

/**
 * Number(null) is 0, and 0 is a finite number, so a null member id would pass
 * a plain isFinite check and be treated as "member 0" — whose read mark is
 * always absent, which would peg every room at 0 for ever.
 */
function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { seenByAllUpTo };
