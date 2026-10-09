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
import { bumpToTop } from './listOrder';

/** How much of a chat is worth keeping: a screen or three, not a year. */
export const MAX_MESSAGES = 60;
/** Chats to keep history for. Beyond this, the least recently opened go. */
export const MAX_ROOMS = 40;

const ROOMS_KEY = 'offline:rooms';
const MSGS_PREFIX = 'offline:msgs:';
/** The gallery's list, per room. The pictures themselves live in mediaCache. */
const MEDIA_PREFIX = 'offline:media:';
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
  // Ties broken by POSITION, and the index is kept NEWEST FIRST — so an
  // earlier position means more recent.
  //
  // Timestamps come from Date.now() and several rooms are written inside one
  // millisecond whenever a chat list refreshes. Sorting by time alone leaves
  // those in whatever order they arrived, and the rooms just written were as
  // likely to be evicted as the ones last opened a month ago.
  //
  // This only works while the two agree: what comes back from the index is
  // newest first, and a new entry is put at the FRONT by the callers below,
  // not the back. Appending it there was the actual bug — the new entry then
  // sorted LAST among equal timestamps and was the first thing evicted.
  //
  // The comparator below is written out rather than left to the sort being
  // stable, which would give the same order and does make this line
  // impossible to distinguish by test. It is here to state the invariant,
  // since the invariant is the part that was wrong.
  const newestFirst = index
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.at - a.e.at) || (a.i - b.i))
    .map(x => x.e);
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

/**
 * A conversation moved to the top of the SAVED list.
 *
 * Not the list on screen — the one on disk, which is what the chat list is
 * built from the next time it opens.
 *
 * Reported four times as the chat list moving under a finger. Each previous
 * round made the moment of the move later or rarer, and the move was never
 * the problem: the problem is that the first thing drawn is WRONG and has to
 * be corrected while somebody is reaching for it. The list is thrown away
 * while a chat is open, so it is rebuilt from this copy, and this copy was
 * last written before that chat was opened — missing everything that arrived
 * since.
 *
 * Keeping it current while the list is closed means the first paint is
 * already right and there is nothing to correct. The server's answer then
 * agrees with what is already on screen and nothing moves at all.
 */
export async function bumpRoom(roomId: unknown): Promise<void> {
  if (roomId == null) return;
  try {
    const cached = await loadRooms();
    // Nothing saved yet, on a first run. No test can tell this line from its
    // absence — bumpToTop hands back the same empty array it was given, so
    // the identity check below already declines to write — and it is kept for
    // being the obvious reading rather than for doing work.
    if (!cached) return;
    const rooms = bumpToTop(cached.rooms, roomId);
    const dms = bumpToTop(cached.dms, roomId);
    // Same arrays back: the conversation is already first, or is not in this
    // copy at all. Writing would be a disk write per message in a busy chat,
    // for no change.
    if (rooms === cached.rooms && dms === cached.dms) return;
    await saveRooms(rooms, dms);
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
    const { kept, dropped } = trimIndex([{ roomId: id, at: Date.now() }, ...(await readIndex())]);
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

// ── The gallery, on the device ──────────────────────────────────────────────
//
// Reported as: with no connection the gallery of a chat does not load. The
// pictures were always kept — mediaCache writes them to permanent storage and
// reads them back by filename — but the LIST of them lived in a Map in
// memory, so it died with the process and the gallery had nothing to show and
// no way to ask for it.
//
// Stored under the same room index as the messages, so a room evicted for
// being long unopened takes its gallery with it rather than leaving an
// orphan behind for ever.

export async function saveMedia(roomId: number | string, state: any): Promise<void> {
  const id = String(roomId);
  try {
    if (!state) {
      await AsyncStorage.removeItem(MEDIA_PREFIX + id);
      return;
    }
    await AsyncStorage.setItem(MEDIA_PREFIX + id, JSON.stringify(state));
    const { kept, dropped } = trimIndex([{ roomId: id, at: Date.now() }, ...(await readIndex())]);
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(kept));
    await Promise.all(dropped.map(r => Promise.all([
      AsyncStorage.removeItem(MSGS_PREFIX + r).catch(() => {}),
      AsyncStorage.removeItem(MEDIA_PREFIX + r).catch(() => {}),
    ])));
  } catch {}
}

export async function loadMedia(roomId: number | string): Promise<any | null> {
  try {
    const raw = await AsyncStorage.getItem(MEDIA_PREFIX + String(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Signing out must not leave the last account's chats readable. */
export async function clearAll() {
  try {
    const index = await readIndex();
    await AsyncStorage.multiRemove([
      ROOMS_KEY, INDEX_KEY,
      ...index.map(e => MSGS_PREFIX + e.roomId),
      // The gallery too, or the next account opens a chat and finds the
      // previous one's photographs listed in it.
      ...index.map(e => MEDIA_PREFIX + e.roomId),
    ]);
  } catch {}
}
