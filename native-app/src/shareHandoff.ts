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
