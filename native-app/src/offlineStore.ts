// ── Showing the app before the network answers ───────────────────────────────
//
// Opening the app used to mean waiting on the server for anything at all: the
// room list and every chat's history came from a request, and if that request
// was slow — or the connection was down, or the server unreachable, which for
// these users is a normal Tuesday — the screen sat on a spinner with nothing
// on it. The messages were already on the device a moment ago; there was no
// reason to have nothing to show.
//
// So the last-seen room list and the recent history of each chat are kept on
// the device and rendered IMMEDIATELY, before any request is made. The network
// result replaces them when (and if) it arrives.
//
// What is deliberately NOT kept:
//
//  • Disappearing and one-time messages. A message that destroys itself must
//    not be written somewhere that outlives it — the same rule the media cache
//    follows.
//  • Messages still being sent, or that failed to send. Those are the outbox's
//    business and it persists them itself; a second copy here would show them
//    twice.
import AsyncStorage from '@react-native-async-storage/async-storage';

/** How much of a chat is worth keeping: a screen or three, not a year. */
export const MAX_MESSAGES = 60;
/** Chats to keep history for. Beyond this, the least recently opened go. */
export const MAX_ROOMS = 40;

const ROOMS_KEY = 'offline:rooms';
const MSGS_PREFIX = 'offline:msgs:';
const INDEX_KEY = 'offline:index';

export type CachedRooms = { rooms: any[]; dms: any[]; savedAt: number };

/**
 * Strip a message list down to what may be stored, newest kept.
 *
 * Pure, and tested, because everything that matters about this cache is what
 * it refuses to hold.
 */
export function forStorage(messages: any[], max = MAX_MESSAGES): any[] {
  const safe = (messages || []).filter(m => {
    if (!m) return false;
    // Self-destructing content is never written down.
    if (m.disappear_seconds) return false;
    if (m.one_time_seconds) return false;
    // Optimistic rows: not real history, and owned by the outbox.
    if (m._uploading || m._uploadFailed) return false;
    if (typeof m.id !== 'number') return false;
    return true;
  });
  // The tail is the newest — that is the part someone opening a chat sees.
  return safe.slice(-max);
}

/** Rooms to keep history for, most recently opened first. */
export function trimIndex(index: { roomId: string; at: number }[], max = MAX_ROOMS) {
  const seen = new Set<string>();
  const newestFirst = [...index].sort((a, b) => b.at - a.at);
  const kept: { roomId: string; at: number }[] = [];
  const dropped: string[] = [];
  for (const e of newestFirst) {
    if (seen.has(e.roomId)) continue;      // one entry per room
    seen.add(e.roomId);
    if (kept.length < max) kept.push(e);
    else dropped.push(e.roomId);
  }
  return { kept, dropped };
}

// ── Room list ────────────────────────────────────────────────────────────────

export async function saveRooms(rooms: any[], dms: any[]) {
  try {
    await AsyncStorage.setItem(ROOMS_KEY, JSON.stringify({ rooms, dms, savedAt: Date.now() }));
  } catch {}
}

export async function loadRooms(): Promise<CachedRooms | null> {
  try {
    const raw = await AsyncStorage.getItem(ROOMS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.rooms) || !Array.isArray(parsed.dms)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Per-chat history ─────────────────────────────────────────────────────────

async function readIndex(): Promise<{ roomId: string; at: number }[]> {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveMessages(roomId: number | string, messages: any[]) {
  const keep = forStorage(messages);
  const id = String(roomId);
  try {
    if (!keep.length) {
      // Nothing storable (an empty chat, or one that is entirely
      // disappearing) — drop any stale copy rather than leaving it behind.
      await AsyncStorage.removeItem(MSGS_PREFIX + id);
    } else {
      await AsyncStorage.setItem(MSGS_PREFIX + id, JSON.stringify(keep));
    }
    const { kept, dropped } = trimIndex([...(await readIndex()), { roomId: id, at: Date.now() }]);
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(kept));
    await Promise.all(dropped.map(r => AsyncStorage.removeItem(MSGS_PREFIX + r).catch(() => {})));
  } catch {}
}

export async function loadMessages(roomId: number | string): Promise<any[] | null> {
  try {
    const raw = await AsyncStorage.getItem(MSGS_PREFIX + String(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/** Signing out must not leave the last account's chats readable. */
export async function clearAll() {
  try {
    const index = await readIndex();
    await AsyncStorage.multiRemove([
      ROOMS_KEY, INDEX_KEY, ...index.map(e => MSGS_PREFIX + e.roomId),
    ]);
  } catch {}
}
