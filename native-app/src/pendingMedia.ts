// ── Photos staged in the composer, kept across leaving the chat ──────────────
//
// Reported as: after taking pictures and not sending them yet, or while
// editing one, swiping right or tapping back to the chat list and then
// returning — the images are gone.
//
// They were. Staged attachments lived only in the chat screen's state, and
// going back to the list unmounts that screen: React drops the state and the
// photos with it. The files themselves were still on the device, sitting in
// the cache with nothing pointing at them, which is the worst version of this
// — the work is not lost, it is unreachable.
//
// A message half-written keeps its text; a message half-assembled must keep
// its pictures the same way. So the staged list is written to storage as it
// changes and read back when the chat opens.
//
// What can go wrong lives here, away from React and away from the filesystem:
//   • restoring a photo whose file the OS has since cleared, which would show
//     a broken tile and fail on send;
//   • a stored draft outliving the conversation it belonged to;
//   • one chat's attachments appearing in another.

export type Staged = { uri: string; name: string; mime: string };

/** Storage key. Per room, or one chat's photos appear in another. */
export function draftKey(roomId: number | string): string {
  return `pending-media-${roomId}`;
}

/**
 * Old enough that the files are probably gone.
 *
 * Camera captures live in the cache directory, which Android empties whenever
 * it feels short of space. A month-old draft is far more likely to be a list
 * of dead paths than a message somebody still means to send.
 */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type Draft = { at: number; items: Staged[] };

/** What gets written. Returns null when there is nothing worth writing. */
export function serialize(items: Staged[], now: number): string | null {
  const keep = (items || []).filter(isUsable);
  if (!keep.length) return null;
  return JSON.stringify({ at: now, items: keep });
}

function isUsable(m: any): m is Staged {
  return !!m && typeof m.uri === 'string' && m.uri.length > 0;
}

/**
 * Read a draft back, defensively.
 *
 * Anything unrecognisable is treated as no draft at all: this runs while a
 * chat is opening, and a throw here would take the whole screen with it for
 * the sake of a stale attachment.
 */
export function parse(raw: string | null, now: number, maxAge = MAX_AGE_MS): Staged[] {
  if (!raw) return [];
  let d: any;
  try { d = JSON.parse(raw); } catch { return []; }
  // The first version of this stored a bare array. Read it rather than
  // throwing away somebody's staged photos on the upgrade.
  const items = Array.isArray(d) ? d : d?.items;
  if (!Array.isArray(items)) return [];
  const at = Array.isArray(d) ? now : Number(d?.at) || 0;
  if (at && now - at > maxAge) return [];
  return items.filter(isUsable).map((m: any) => ({
    uri: String(m.uri),
    name: String(m.name || m.uri.split('/').pop() || 'file'),
    mime: String(m.mime || 'application/octet-stream'),
  }));
}

/**
 * Drop the ones whose files have gone.
 *
 * `exists` is asked once per item rather than trusted from the draft: the
 * cache directory is not ours, and a tile pointing at a file that is no longer
 * there looks broken and fails on send with nothing to explain it.
 */
export function keepExisting(items: Staged[], exists: (uri: string) => boolean): Staged[] {
  return (items || []).filter(m => {
    // A remote or content URI is not ours to check; assume it is fine rather
    // than silently dropping it.
    if (!/^file:\/\//.test(m.uri)) return true;
    return exists(m.uri);
  });
}

/** Did the restore lose anything, and is that worth saying out loud? */
export function lostMessage(before: number, after: number): string {
  const gone = Math.max(0, before - after);
  if (!gone) return '';
  return gone === 1
    ? 'One staged photo was cleared by the system and could not be restored.'
    : `${gone} staged photos were cleared by the system and could not be restored.`;
}
