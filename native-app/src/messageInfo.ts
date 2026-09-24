// ── Who has seen this message, and when ─────────────────────────────────────
//
// Mirrored by public/js/messageInfo.js, compared function by function in
// test/messageInfo.test.js. These rules were written inline in ChatScreen
// first; they moved here when the web needed the same panel, because the
// alternative was typing them out a second time and letting the two clients
// drift over whether a message has been read.
//
// The answer itself comes from the server's `message_info`, which reads
// read-mark HISTORY rather than each member's current position — see seenBy in
// messageViews.js. This file is only about presenting it.

/**
 * Can this message be asked about at all?
 *
 * A message still being sent has a client-side id — a string, or a negative
 * number — and the server has never heard of it. Offering Info there opens a
 * panel that can only ever say "not found".
 */
export function canShowInfo(msg: { id?: unknown } | null | undefined): boolean {
  if (!msg) return false;
  const id = Number((msg as any).id);
  return Number.isFinite(id) && id > 0;
}

/**
 * A timestamp, in the reader's own locale and timezone.
 *
 * The server sends SQLite's "YYYY-MM-DD HH:MM:SS", which is UTC and which no
 * browser parses the same way: Safari returns Invalid Date for it, so the
 * space becomes a T and a Z is appended before parsing. On the phone this
 * matters less, but the two copies must agree exactly or the same message
 * carries two different times.
 */
export function fullWhen(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const d = typeof v === 'number'
    ? new Date(v)
    : new Date(String(v).includes('T') ? String(v) : String(v).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * The headings.
 *
 * Counted, because "Seen by" over a list of four names makes the reader count
 * them, and the count is the thing they opened this to learn.
 */
export function seenHeading(n: number | null | undefined): string {
  return `Seen by ${Math.max(0, Math.floor(Number(n) || 0))}`;
}

export function notSeenHeading(n: number | null | undefined): string {
  return `Not seen yet ${Math.max(0, Math.floor(Number(n) || 0))}`;
}

/** What stands in for an empty list — never a bare "0". */
export function emptySeenText(): string {
  return 'Nobody has seen this yet.';
}
