// ── Handing a shared file over to a chat ────────────────────────────────────
//
// Reported with a photograph: sharing something into the app sticks on
// "Preparing shared content…" for ever. The spinner in that photograph is
// sitting over a conversation, which is the whole clue — the hand-off had
// already reached the chat and then stopped.
//
// The cause was one dependency array. ChatScreen staged the shared files in an
// effect with `[]`, so it ran once when the screen mounted and never again;
// and ChatScreen is NOT keyed by room, so switching to the share's target
// chat while already in a chat reuses the same component instead of mounting a
// new one. The effect had already run, with nothing to do, before the share
// existed. Nothing staged the files, nothing called onShareConsumed, and the
// overlay is tied to that call.
//
// The severity was a second bug on top: the overlay is a Modal with no cancel
// and no onRequestClose, so hardware back did nothing and the app could not be
// used again until it was force-stopped. A hand-off that fails should cost the
// file, not the app.
//
// Both rules live here, away from the component, because "is the overlay up"
// is now a question with four inputs and one wrong answer freezes everything.

/** How long a hand-off may sit unconsumed before it is abandoned. */
export const HANDOFF_GRACE_MS = 10_000;

/**
 * A stable identity for one incoming share.
 *
 * Reported as: sharing something opens the chat list twice.
 *
 * The picker was guarded by a boolean — "a picker has been built" — which both
 * ways out of the share reset to false on their way past, along with the room
 * list that served as the second guard. That is safe only if the intent is
 * gone by the next render, and it is not: resetShareIntent calls a React state
 * setter, and it calls it only when the shareIntent captured in its closure
 * still looks present. So the effect could run again with the intent still
 * reported, both guards freshly cleared, and build a second picker on top of
 * the first.
 *
 * A boolean cannot say WHICH share was dealt with, which is the thing that
 * actually needs remembering — and it has to keep saying it for as long as the
 * intent lingers, while still letting a genuinely new share through. Hence a
 * key: same share, no second picker; different share, a picker.
 *
 * Built from what the sender gave us, not from object identity: the hook
 * rebuilds its value on every refresh, so identity changes while the share
 * does not.
 */
export function shareKey(si: unknown): string {
  const s = (si || {}) as Record<string, any>;
  const files = Array.isArray(s.files) ? s.files : [];
  const parts = files.map((f: any) => {
    const o = (f || {}) as Record<string, any>;
    // The path is what identifies a shared file; the rest is description.
    return String(o.path || o.contentUri || '');
  });
  for (const k of ['text', 'webUrl']) {
    const v = s[k];
    if (typeof v === 'string' && v) parts.push(`${k}:${v}`);
  }
  // Never empty while a share is present: the key is compared against a ref
  // that starts empty, and "" on both sides would read as "already handled"
  // for a share nobody has touched.
  return parts.length ? parts.join('\u0000') : 'share';
}

/**
 * Should the "preparing" overlay be on screen?
 *
 * Two stages, deliberately one overlay: the intent arriving and the room list
 * loading, and then the chat staging what arrived. Before they were joined
 * there was a gap in the middle where the user watched an empty composer with
 * no idea anything was still happening.
 */
export function overlayVisible(o: {
  hasShareIntent?: boolean;
  /** The loaded room list, or null while it is still loading. */
  shareRooms?: unknown[] | null;
  screen?: string;
  pendingShare?: unknown;
}): boolean {
  const loading = !!o.hasShareIntent && !o.shareRooms && o.screen !== 'auth';
  return loading || !!o.pendingShare;
}

/**
 * Has a hand-off been waiting long enough to give up on?
 *
 * A backstop, NOT the fix — the fix is that the chat consumes the share when
 * it arrives rather than only when it mounts. This exists because the failure
 * it guards against is total: an overlay that never clears cannot be
 * dismissed, and the app is finished until it is force-stopped. Cheap
 * insurance against the next variant of a bug that has already happened once.
 */
export function handoffExpired(o: { since?: number | null; now: number; graceMs?: number }): boolean {
  if (typeof o.since !== 'number' || !o.since) return false;
  const grace = typeof o.graceMs === 'number' ? o.graceMs : HANDOFF_GRACE_MS;
  const waited = o.now - o.since;
  // A stamp in the future — a clock that moved while a share was pending —
  // must not expire anything.
  //
  // This line cannot change the answer and no mutation can tell it from its
  // absence: a negative wait is already below any positive grace, so the
  // comparison below returns false on its own. It is kept because it states
  // the intent, which the comparison only implies, and because it would start
  // mattering the moment somebody passed a negative graceMs.
  if (waited < 0) return false;
  return waited >= grace;
}
