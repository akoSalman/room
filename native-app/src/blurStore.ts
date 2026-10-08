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

export async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      revealed = parsed.filter(k => typeof k === 'string' && k).slice(-MAX_REMEMBERED);
      have = new Set(revealed);
      emit();
    }
  } catch {}
}

function persist() {
  AsyncStorage.setItem(KEY, JSON.stringify(revealed)).catch(() => {});
}

/** This picture has been looked at: stop asking about it. */
export function reveal(key: string | null | undefined) {
  if (!key || have.has(key)) return;
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
  if (!key || !have.has(key)) return;
  have.delete(key);
  revealed = revealed.filter(k => k !== key);
  persist();
  emit();
}

/** Only for tests. */
export function _reset() {
  revealed = []; have = new Set(); loaded = false; listeners.clear();
}
