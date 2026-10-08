// ── Which pictures have already been cleared ───────────────────────────────
//
// The decisions are in imageBlur.ts and tested there. This is the part that
// touches storage and tells the screen when something changed.
//
// Kept on the device rather than in memory, because "that exact image does not
// ask again" has to survive closing the app. Keyed by the upload's filename
// (see viewerList.photoKey), so a re-signed url — and the same photo forwarded
// into another chat — is the same picture.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'revealedImages-v1';

/**
 * How many are remembered.
 *
 * Somebody who has used the app for a year has cleared a lot of pictures, and
 * this is read on every render of every photo. The oldest are forgotten first,
 * which means a picture from last March asks once more — the right thing to
 * forget, and the mild cost of not keeping a list that grows for ever.
 */
export const MAX_REMEMBERED = 4000;

// Insertion-ordered, so dropping the oldest is dropping from the front.
let revealed: string[] = [];
let have = new Set<string>();
// Pictures explicitly COVERED, which is a different thing from "not yet
// revealed". Your own photos are clear until you say otherwise, so without
// somewhere to record that you said otherwise, the button on them does
// nothing.
let hidden = new Set<string>();
let loaded = false;
const listeners = new Set<() => void>();

function emit() { listeners.forEach(f => f()); }

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Has this picture been cleared before? Answers false until loaded. */
export function isRevealed(key: string | null | undefined): boolean {
  if (!key) return false;
  return have.has(key);
}

/** Has this picture been deliberately covered? */
export function isHidden(key: string | null | undefined): boolean {
  if (!key) return false;
  return hidden.has(key);
}

export async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    // An array is the older shape, from before covering your own was
    // possible. Read it as the revealed list so nobody's answers are lost.
    if (Array.isArray(parsed)) {
      revealed = parsed.filter(k => typeof k === 'string' && k).slice(-MAX_REMEMBERED);
      have = new Set(revealed);
      emit();
    } else if (parsed && typeof parsed === 'object') {
      const r = Array.isArray(parsed.revealed) ? parsed.revealed : [];
      const h = Array.isArray(parsed.hidden) ? parsed.hidden : [];
      revealed = r.filter((k: any) => typeof k === 'string' && k).slice(-MAX_REMEMBERED);
      have = new Set(revealed);
      hidden = new Set(h.filter((k: any) => typeof k === 'string' && k).slice(-MAX_REMEMBERED));
      emit();
    }
  } catch {}
}

function persist() {
  AsyncStorage.setItem(KEY, JSON.stringify({
    revealed, hidden: [...hidden],
  })).catch(() => {});
}

/** This picture has been looked at: stop asking about it. */
export function reveal(key: string | null | undefined) {
  if (!key) return;
  // Clearing it undoes an explicit cover, whoever sent it.
  const wasHidden = hidden.delete(key);
  if (have.has(key)) { if (wasHidden) { persist(); emit(); } return; }
  revealed.push(key);
  have.add(key);
  if (revealed.length > MAX_REMEMBERED) {
    const dropped = revealed.splice(0, revealed.length - MAX_REMEMBERED);
    dropped.forEach(k => have.delete(k));
  }
  persist();
  emit();
}

/** Cover it again. The button, and the whole reason this is reversible. */
export function hide(key: string | null | undefined) {
  if (!key) return;
  // Recorded as covered, not merely removed from the cleared list. Your own
  // photos were never in that list, so removing from it did nothing at all —
  // which is exactly how the button came to have no effect on them.
  have.delete(key);
  revealed = revealed.filter(k => k !== key);
  hidden.add(key);
  if (hidden.size > MAX_REMEMBERED) {
    const first = hidden.values().next();
    if (!first.done) hidden.delete(first.value);
  }
  persist();
  emit();
}

/** Only for tests. */
export function _reset() {
  revealed = []; have = new Set(); hidden = new Set(); loaded = false; listeners.clear();
}
