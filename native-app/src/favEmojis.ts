// The user's favourite / most-used emoji set, shared by the composer's quick
// bar and the message-menu reaction row. Persisted per device, with a tiny
// subscription so every mounted consumer updates the moment the list is edited.
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const DEFAULT_FAV_EMOJIS = ['😂', '❤️', '👍', '🙏', '😍', '🔥', '🎉', '😢', '😮', '👌'];
export const MAX_FAV_EMOJIS = 16;

// A broad palette to pick from when editing the list.
export const EMOJI_PALETTE = [
  '😂', '🤣', '😊', '😍', '🥰', '😎', '🤔', '😐', '😴', '🤗',
  '😢', '😭', '😡', '🤯', '🥳', '😮', '😱', '🙄', '😇', '🤩',
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

export function useFavEmojis(): string[] {
  const [v, setV] = useState<string[]>(current);
  useEffect(() => {
    subs.add(setV);
    loadFavEmojis().then(setV).catch(() => {});
    return () => { subs.delete(setV); };
  }, []);
  return v;
}
