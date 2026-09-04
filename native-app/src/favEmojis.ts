// The user's favourite / most-used emoji set, shared by the composer's quick
// bar and the message-menu reaction row. Persisted per device, with a tiny
// subscription so every mounted consumer updates the moment the list is edited.
import { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { bump, orderFor, countsAsUse, Counts } from './emojiOrder';

// Asked for: 😘 and 🍑 among the most used. Added at the front of the two
// halves they belong to — the quick bar is read left to right, and an addition
// tacked on the end is one nobody reaches.
export const DEFAULT_FAV_EMOJIS = [
  '😂', '❤️', '😘', '👍', '🙏', '😍', '🔥', '🍑', '🎉', '😢', '😮', '👌',
];
export const MAX_FAV_EMOJIS = 16;

// A broad palette to pick from when editing the list.
export const EMOJI_PALETTE = [
  '😂', '🤣', '😊', '😍', '🥰', '😎', '🤔', '😐', '😴', '🤗',
  '😢', '😭', '😡', '🤯', '🥳', '😮', '😱', '🙄', '😇', '🤩',
  '😘', '😗', '😚', '🤭', '😉', '🥺', '🤤', '😈', '🍑', '🍆',
  '👍', '👎', '👌', '🙏', '👏', '🙌', '💪', '🤝', '✌️', '🫶',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💯', '✨',
  '🔥', '🎉', '🎊', '🎁', '⭐', '🌟', '⚡', '🌈', '🌸', '🍀',
  '✅', '❌', '❗', '❓', '⏰', '📌', '💡', '🚀', '☕', '🍕',
];

const KEY = 'favEmojis';
let current: string[] = DEFAULT_FAV_EMOJIS;
let loaded = false;
const subs = new Set<(v: string[]) => void>();

function publish() { subs.forEach(fn => fn(current)); }

export function getFavEmojis(): string[] { return current; }

export async function loadFavEmojis(): Promise<string[]> {
  if (loaded) return current;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length) {
      current = parsed.filter((e: any) => typeof e === 'string' && e).slice(0, MAX_FAV_EMOJIS);
      publish();
    }
  } catch {}
  return current;
}

export async function setFavEmojis(list: string[]) {
  // Never let the list go empty — an empty quick bar looks like a bug.
  const next = list.filter(Boolean).slice(0, MAX_FAV_EMOJIS);
  current = next.length ? next : DEFAULT_FAV_EMOJIS;
  publish();
  try { await AsyncStorage.setItem(KEY, JSON.stringify(current)); } catch {}
}

// ── Most-used ordering ───────────────────────────────────────────────────────
// The SET is the user's own list above; this only decides the ORDER within it.
// Counting is immediate, reordering is not — see emojiOrder.ts for why.
const COUNTS_KEY = 'emojiCounts';
let counts: Counts = {};
let countsLoaded = false;

export async function loadEmojiCounts(): Promise<Counts> {
  if (countsLoaded) return counts;
  countsLoaded = true;
  try {
    const raw = await AsyncStorage.getItem(COUNTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') counts = parsed as Counts;
  } catch {}
  return counts;
}

export function getEmojiCounts(): Counts { return counts; }

/** Record that the user PICKED this emoji. Safe to call from a press handler. */
export function noteEmojiUse(emoji: string, source: 'bar' | 'reaction' | 'typed') {
  if (!countsAsUse(source)) return;
  counts = bump(counts, emoji);
  AsyncStorage.setItem(COUNTS_KEY, JSON.stringify(counts)).catch(() => {});
}

/**
 * The favourites, most-used first.
 *
 * `openKey` is what pins the order: it is recomputed only when that value
 * changes — i.e. when the bar or sheet OPENS — so the row never rearranges
 * itself under a finger that is already moving towards a button.
 */
export function useOrderedFavEmojis(openKey?: unknown): string[] {
  const list = useFavEmojis();
  const [, setReady] = useState(countsLoaded);
  useEffect(() => { loadEmojiCounts().then(() => setReady(true)).catch(() => {}); }, []);
  return useMemo(() => orderFor(list, counts), [list, openKey]);
}

export function useFavEmojis(): string[] {
  const [v, setV] = useState<string[]>(current);
  useEffect(() => {
    subs.add(setV);
    loadFavEmojis().then(setV).catch(() => {});
    return () => { subs.delete(setV); };
  }, []);
  return v;
}
