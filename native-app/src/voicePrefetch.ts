// ── Having the voice message before it is tapped ───────────────────────────
//
// Asked for: fetch voice messages when a chat opens or one arrives, and keep
// them so they are never fetched twice.
//
// The keeping half already worked — mediaCache writes every played voice note
// to permanent storage and plays it from there afterwards. What did not work
// was the FIRST play: resolve() deliberately returns the remote url and
// downloads in the background, so the first tap streams, and on these networks
// that is the pause people notice.
//
// So the first play is moved earlier, to a moment nobody is waiting: the chat
// opening, or the message arriving while it is open.
//
// What this must NOT do is turn "open a chat" into a large download. A year of
// voice notes is a lot of megabytes on a connection paid for by the megabyte,
// and nobody asked for the ones from last March. Hence a cap, newest first.

/** A message, as much of one as this needs to see. */
export type Voiceish = {
  id?: unknown;
  type?: unknown;
  file_path?: unknown;
  _uploading?: unknown;
};

/**
 * How many to pull down when a chat opens.
 *
 * Voice notes are small — a few seconds of speech is tens of kilobytes — so a
 * handful is cheap and covers what anybody is about to listen to. The number
 * is small deliberately: the cost of being wrong is somebody's data, and the
 * benefit of being right is a second saved on a tap.
 */
export const MAX_ON_OPEN = 8;

/**
 * Which voice messages are worth fetching, newest first.
 *
 * `canKeep` is the SAME rule the player uses to decide whether it may write a
 * file down at all. A disappearing message, or anything in a private room that
 * is not your own, must never be written to permanent storage — pre-fetching
 * one would be a way of keeping content the sender said could not be kept,
 * which is worse than a slow tap.
 *
 * `isLocal` keeps already-downloaded ones out, so re-opening a chat is free
 * rather than being a list of requests that all turn out to be unnecessary.
 */
export function pickVoice(o: {
  messages?: Voiceish[] | null;
  canKeep?: (m: Voiceish) => boolean;
  isLocal?: (m: Voiceish) => boolean;
  max?: number;
}): Voiceish[] {
  const e = o || {};
  const list = Array.isArray(e.messages) ? e.messages : [];
  const canKeep = typeof e.canKeep === 'function' ? e.canKeep : () => true;
  const isLocal = typeof e.isLocal === 'function' ? e.isLocal : () => false;
  const max = Number.isFinite(Number(e.max)) ? Number(e.max) : MAX_ON_OPEN;

  // No explicit guard for a cap of zero: the loop's own `out.length < max`
  // already yields nothing for zero or less. One was here and no mutation
  // could tell it from its absence, which is the definition of a line that is
  // not doing anything.
  const out: Voiceish[] = [];
  // Backwards: the newest are the ones somebody is about to play, and the cap
  // should spend itself on those rather than on the oldest in the window.
  for (let i = list.length - 1; i >= 0 && out.length < max; i--) {
    const m = list[i];
    if (!m || m.type !== 'audio') continue;
    // Still going up from this device: there is nothing on the server yet.
    if (m._uploading) continue;
    if (typeof m.file_path !== 'string' || !m.file_path) continue;
    if (!canKeep(m)) continue;
    if (isLocal(m)) continue;
    out.push(m);
  }
  return out;
}

/**
 * Is one newly arrived message worth fetching on its own?
 *
 * The same rules, for the message-arrived case. Separate from pickVoice
 * because there is no cap to apply to a single message and no list to walk —
 * and because getting this wrong silently downloads every arriving message.
 */
export function wantsPrefetch(o: {
  message?: Voiceish | null;
  canKeep?: (m: Voiceish) => boolean;
}): boolean {
  const e = o || {};
  const m = e.message;
  if (!m || m.type !== 'audio' || m._uploading) return false;
  if (typeof m.file_path !== 'string' || !m.file_path) return false;
  const canKeep = typeof e.canKeep === 'function' ? e.canKeep : () => true;
  return canKeep(m);
}
