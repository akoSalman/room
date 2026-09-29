// ── Opening the chat a notification was about ────────────────────────────────
//
// Reported as: sometimes, tapping a new-message notification opens the app but
// leaves it on the chat list instead of the chat.
//
// "Sometimes" is the word that matters. Tapping a notification did not open a
// chat; it started a chain that had to survive four things going right, and
// each of them fails often enough to be seen every few days:
//
//   1. THE RACE. On a cold start two independent async jobs finish in whatever
//      order the phone decides: reading the saved token, which sets the screen
//      to the room list, and reading the notification that launched the app,
//      which sets it to the chat. When the notification won, the token read
//      landed a moment later and put the room list back on top of it. Nothing
//      was broken and nothing was logged — the chat simply never appeared.
//
//   2. THE NETWORK. The notification carries a room id and nothing else, so
//      the app fetched /rooms and /dm-rooms to find out what that room was
//      called. A push arrives precisely when the phone has just woken up, on
//      the connection these users have; if either request failed, the code
//      found no room in an empty list and stopped, silently.
//
//   3. THE STRICT MATCH. The lists were searched with `===` on the id. The
//      push sends the id as a string; anything that arrives as a string on the
//      other side never matches.
//
//   4. THE SILENCE. Every one of the above ends the same way — the room list,
//      no message, nothing to retry. To the user that is the app ignoring the
//      notification they just tapped.
//
// So the intent to open a chat is now a thing that persists until it is
// satisfied, resolved against the offline cache before the network is even
// consulted, and never quietly dropped.

export type RoomRef = {
  id: number;
  name: string;
  /** Always 0 or 1: the server has sent this as a boolean and as a number. */
  is_dm: number;
  other_username?: string | null;
};

export type PushData = {
  roomId?: string | number;
  msgId?: string | number;
  type?: string;
  /** Set on a comment: the message whose thread it belongs to. */
  parentId?: string | number;
  comment?: string | number | boolean;
  /** Newer servers send enough to open the chat without asking anything. */
  roomName?: string;
  isDm?: string | number | boolean;
  peer?: string;
};

/** The room id a notification is about, or null. */
export function roomIdFromPush(data: PushData | null | undefined): number | null {
  if (!data || data.type === 'call') return null;
  const n = parseInt(String(data.roomId ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The chat a notification names, when it named it fully.
 *
 * A push that carries the room's name and kind can be opened with no network
 * at all — which is the whole point, because a push arrives exactly when the
 * connection is least dependable.
 */
export function roomFromPush(data: PushData | null | undefined): RoomRef | null {
  const id = roomIdFromPush(data);
  if (!id || !data?.roomName) return null;
  const isDm = data.isDm === true || data.isDm === 1 || data.isDm === '1';
  return {
    id,
    name: String(data.roomName),
    is_dm: isDm ? 1 : 0,
    other_username: data.peer ? String(data.peer) : null,
  };
}

/**
 * Find a room in the lists the app already has.
 *
 * Ids are compared as strings on purpose: the push sends one, the server's
 * JSON sends the other, and a strict comparison between them is a match that
 * silently never happens.
 */
export function resolveRoom(
  lists: { rooms?: any[] | null; dms?: any[] | null } | null | undefined,
  roomId: number | string | null | undefined,
): RoomRef | null {
  const want = String(roomId ?? '');
  if (!want) return null;
  const all = [
    ...(Array.isArray(lists?.dms) ? lists!.dms! : []),
    ...(Array.isArray(lists?.rooms) ? lists!.rooms! : []),
  ];
  const r = all.find((x: any) => x && String(x.id) === want);
  if (!r) return null;
  return {
    id: parseInt(String(r.id), 10),
    name: String(r.name ?? ''),
    is_dm: r.is_dm ? 1 : 0,
    other_username: r.other_username ?? null,
  };
}

/**
 * The thread a notification is about, when it is about one.
 *
 * Reported as: tapping a new-comment notification opens the chat, where there
 * is nothing to see — a comment never appears in the conversation, by design.
 * It has to open the THREAD, at the comment.
 *
 * Both ids are required. A comment push without its parent cannot open
 * anything better than the chat, and guessing would put the user in some other
 * message's thread.
 */
export function commentTargetFromPush(
  data: PushData | null | undefined,
): { parentId: number; commentId: number | null } | null {
  if (!data) return null;
  const parent = parseInt(String(data.parentId ?? ''), 10);
  if (!Number.isFinite(parent) || parent <= 0) return null;
  const comment = parseInt(String(data.msgId ?? ''), 10);
  return {
    parentId: parent,
    commentId: Number.isFinite(comment) && comment > 0 ? comment : null,
  };
}

/**
 * Which screen the startup token read should leave showing.
 *
 * This is the race, settled by asking rather than assuming. The rule is one
 * line and it is the whole fix: a chat that is already open was opened by
 * something the user did — a tapped notification — and the room list is only
 * ever a default. A default must not overwrite a decision.
 */
export function screenFor(o: {
  hasToken: boolean;
  /** What is on screen at the moment this answer is applied. */
  current?: 'auth' | 'rooms' | 'chat';
}): 'auth' | 'rooms' | 'chat' {
  if (!o.hasToken) return 'auth';
  if (o.current === 'chat') return 'chat';
  return 'rooms';
}

/**
 * How long to wait before asking the server again.
 *
 * The first retry is quick because the commonest failure is a request made in
 * the second before the network came up; after that it backs off, and it stops
 * rather than retrying forever in somebody's pocket.
 */
export const RESOLVE_ATTEMPTS = 4;

export function retryDelay(attempt: number): number {
  const ladder = [400, 1500, 4000];
  return ladder[Math.min(Math.max(attempt, 0), ladder.length - 1)];
}

export function shouldKeepTrying(attempt: number): boolean {
  return attempt < RESOLVE_ATTEMPTS;
}

/**
 * Has this intent gone stale?
 *
 * A notification tapped ten minutes ago, whose room could never be resolved,
 * must not suddenly open a chat over whatever the user is doing now.
 */
export const INTENT_TTL_MS = 60_000;

export function intentStillWanted(o: {
  at: number; now: number; ttlMs?: number;
}): boolean {
  const ttl = o.ttlMs ?? INTENT_TTL_MS;
  const age = o.now - o.at;
  return age >= 0 && age <= ttl;
}

// ── A tap the app was not running to hear ──────────────────────────────────
//
// Reported as: with a chat open, close the app, get a notification from a
// DIFFERENT chat, tap it — and the app opens the old chat.
//
// Two notifications can be drawn for one message: the server's push, and the
// one the app draws itself from its socket (see notifyOnce.ts). Tapping the
// PUSH works, because expo hands its data to a response listener. Tapping the
// app's own did nothing at all: it carried no data to say which chat it was
// about, and notifee's press was never handled for a message — so the app
// simply launched and restored whatever chat was last open.
//
// That was always broken; it became the common case when the two routes
// started agreeing on who draws, because the socket usually wins the race.
//
// These handlers run at module scope, long before the screen that can act on
// them exists — on a cold start there may be no React tree at all yet. So the
// tap is PARKED here and collected when there is something to collect it.
let parked: PushData | null = null;

/** Remember a tapped notification until the app is ready to act on it. */
export function parkPush(data: PushData | null | undefined) {
  // Only if it actually names a chat: parking something unusable would
  // displace a real tap that arrived beside it.
  if (roomIdFromPush(data)) parked = data as PushData;
}

/** Take the parked tap, if there is one. Reading it clears it. */
export function takeParkedPush(): PushData | null {
  const p = parked;
  parked = null;
  return p;
}
