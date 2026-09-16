// ── A half-written message is still a message ────────────────────────────────
//
// Asked for as: keep the draft when typing anything into the composer, or
// adding media, and exiting the chat.
//
// The media half already worked — see pendingMedia.ts, which was written for
// exactly the same complaint about staged photos. The TEXT half did not, and
// for a reason that is invisible from the outside: the composer keeps its text
// in its own local state, deliberately, so that a keystroke re-renders one
// small component instead of the whole message list. That is what makes typing
// feel instant in a chat with two thousand messages in it. It also means the
// text lives in a component that is unmounted the moment you go back to the
// chat list — React drops the state, and with it whatever was typed.
//
// So the two halves of a half-written message were treated differently: the
// photos survived leaving the chat and the sentence did not. This restores the
// symmetry without giving the text back to the parent screen's state, which
// would undo the reason it lives in the composer in the first place.
//
// What can go wrong lives here, away from React and away from storage:
//   • a draft outliving the conversation by months;
//   • a restore overwriting something already in the composer — text shared in
//     from another app, or a reply the user has started typing;
//   • one chat's draft appearing in another.
//
// Mirrored by public/js/textDraft.js, compared function by function in
// test/textDraft.test.js.

/** Storage key. Per room, or one chat's draft appears in another. */
export function draftKey(roomId: number | string): string {
  return `text-draft-${roomId}`;
}

/**
 * Old enough that it is no longer a message anybody means to send.
 *
 * Shorter than the staged-media month: a photo draft is a file somebody
 * deliberately picked, while a stray half-sentence from a fortnight ago
 * appearing in the composer is confusing rather than helpful.
 */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How long after the last keystroke the draft is written.
 *
 * Writing on every keystroke would put a storage round-trip in the typing
 * path, which is the exact cost the composer's local state was arranged to
 * avoid. Long enough to coalesce a burst of typing, short enough that it has
 * always run by the time somebody can reach the back button.
 */
export const SAVE_DEBOUNCE_MS = 400;

export type Draft = { at: number; text: string };

/**
 * Is there anything here worth keeping?
 *
 * Whitespace is not a draft. Without this, tapping into the composer and
 * tapping out again would leave a stored " " that comes back as a composer
 * which looks empty but has a live Send button.
 */
export function worthKeeping(text: string | null | undefined): boolean {
  return String(text ?? '').trim().length > 0;
}

/** What gets written. Returns null when there is nothing worth writing. */
export function serialize(text: string | null | undefined, now: number): string | null {
  if (!worthKeeping(text)) return null;
  // The text is stored EXACTLY as typed, not trimmed. Someone who has typed
  // "see you at " and gone to look up the time should get their trailing space
  // back with the rest of the sentence.
  return JSON.stringify({ at: now, text: String(text) });
}

/**
 * Read a draft back, defensively.
 *
 * Anything unrecognisable is treated as no draft at all: this runs while a chat
 * is opening, and a throw here would take the whole screen down for the sake of
 * a stale sentence.
 */
export function parse(raw: string | null | undefined, now: number, maxAge = MAX_AGE_MS): string {
  if (!raw) return '';
  let d: any;
  try { d = JSON.parse(raw); } catch {
    // The very first version of this wrote the bare string. Read it rather
    // than throwing away somebody's draft on the upgrade.
    return typeof raw === 'string' && raw[0] !== '{' && raw[0] !== '[' ? raw : '';
  }
  if (typeof d === 'string') return d;
  if (!d || typeof d.text !== 'string') return '';
  const at = Number(d.at) || 0;
  if (at && now - at > maxAge) return '';
  return d.text;
}

/**
 * What the composer should end up containing.
 *
 * `current` wins whenever it has anything in it. By the time the stored draft
 * has been read back from disk the composer may already hold text that did not
 * come from the user typing — a sentence shared in from another app, a forward,
 * an edit being prefilled — and overwriting any of those with a week-old draft
 * loses something the user did on purpose, seconds ago.
 */
export function restoredText(saved: string, current: string | null | undefined): string {
  const now = String(current ?? '');
  if (now.length) return now;
  return String(saved ?? '');
}

/**
 * Has the draft actually changed since it was last written?
 *
 * The composer reports every keystroke, and several of those carry the same
 * text: selecting a mention, the caret moving, a re-render replaying the value.
 * Comparing before writing keeps the debounce from queueing writes that change
 * nothing.
 */
export function changed(text: string | null | undefined, lastWritten: string | null | undefined): boolean {
  return String(text ?? '') !== String(lastWritten ?? '');
}
