// ── Comments on a message ────────────────────────────────────────────────────
//
// Asked for as: messages can have comments, which are messages; comments
// cannot themselves have comments; comments open in their own screen; the
// count shows as a badge at the bottom-left of the message, and only when
// there is one; and a Comment entry lives in the message menu.
//
// A comment IS a message — a row in the same table with a parent — rather than
// a new kind of thing. That is the whole design, and it is what makes "the
// comments have all the features" true instead of a promise: a comment can be
// a photo, a voice note, a reply, a forward; it can be reacted to, edited,
// deleted, searched and jumped to, because every one of those paths already
// works on messages and none of them had to learn about comments.
//
// What DOES have to be decided, in one place, is where the line falls: which
// messages can be commented on, and what the badge says. Those are here, and
// mirrored by public/js/comments.js.

/** Exactly one level. A thread that can branch needs a tree to read it. */
export const MAX_DEPTH = 1;

/** Past this the badge stops counting and starts saying "a lot". */
export const BADGE_CAP = 99;

export type Commentable = {
  id?: number | string;
  /** Set when this message is itself a comment. */
  parent_id?: number | string | null;
  /** Burns on being read; there is nothing left to comment on. */
  one_time_seconds?: number | null;
  type?: string | null;
};

/**
 * May this message be commented on?
 *
 * Two refusals, and both would otherwise produce something unreachable:
 *
 *   • A COMMENT. This is the one-level rule. Allowing it would need a screen
 *     that can show a thread of threads, and the badge on a comment would open
 *     a screen whose messages have badges of their own.
 *   • A ONE-TIME message, which is gone the moment it is read. Comments on it
 *     would outlive the thing they are about, and open a screen headed by a
 *     message nobody can ever see again.
 */
export function canComment(msg: Commentable | null | undefined): boolean {
  if (!msg || msg.id == null) return false;
  if (isComment(msg)) return false;
  if (msg.one_time_seconds) return false;
  // A join/leave line is not somebody's message to comment on.
  return msg.type !== 'system' && msg.type !== 'invite';
}

/** Is this message a comment on another one? */
export function isComment(msg: Commentable | null | undefined): boolean {
  return !!msg && msg.parent_id != null && msg.parent_id !== '';
}

/**
 * Is there a badge at all?
 *
 * Asked for explicitly: a badge only when there are comments. A "0" on every
 * message in the room would be noise on the one thing people are trying to
 * read.
 */
export function showsBadge(count: number | null | undefined): boolean {
  return normaliseCount(count) > 0;
}

/** What the badge reads. */
export function badgeLabel(count: number | null | undefined): string {
  const n = normaliseCount(count);
  return n > BADGE_CAP ? `${BADGE_CAP}+` : String(n);
}

/** A count from the server, or from nowhere, as a number. */
export function normaliseCount(count: number | null | undefined): number {
  const n = Number(count);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The count after one arrives or goes.
 *
 * Kept here so the badge can move the moment a comment is sent, rather than
 * waiting for the room to be reloaded — and so it can never go below zero on
 * a delete that arrives twice.
 */
export function countAfter(count: number | null | undefined, delta: number): number {
  return Math.max(0, normaliseCount(count) + (Number(delta) || 0));
}

/** What the screen full of comments is called, given how many there are. */
export function commentsTitle(count: number | null | undefined): string {
  const n = normaliseCount(count);
  if (n === 0) return 'Comments';
  if (n === 1) return '1 comment';
  return `${n} comments`;
}

/** What to say to somebody looking at a message nobody has commented on. */
export const EMPTY_HINT = 'No comments yet. Write the first one.';
