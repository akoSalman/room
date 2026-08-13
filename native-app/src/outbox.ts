// ── Outbox: pending sends that outlive the chat screen ───────────────────────
//
// Uploads run as plain JS promises, so they keep going after ChatScreen
// unmounts (leaving the chat) — but everything that *reacted* to them lived in
// that component. Leaving mid-upload therefore meant:
//   • the server's echo arrived with no listener, so the crash-safety copy in
//     AsyncStorage was never cleared, and
//   • re-entering the chat restored that copy AND auto-retried it, while the
//     original upload was still in flight — producing two real uploads and the
//     duplicated image in the chat.
//
// This module owns that state at module scope instead: which client ids are
// currently uploading, and an app-wide socket listener that clears the stored
// copy the moment the server acknowledges a send, no matter what screen (if
// any) is mounted.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSocket } from './api';

const failedKeyFor = (roomId: number | string) => `failed-msgs-${roomId}`;
const discardKeyFor = (roomId: number | string) => `discarded-msgs-${roomId}`;

// How many times a stalled send is resumed automatically when the chat is
// opened. Without a cap, a send that can never succeed (the local file is
// gone, the room rejects it) retried on EVERY open, re-persisted itself on
// every failure, and looped forever.
export const MAX_AUTO_RETRIES = 3;

// Each retry dispatches a brand-new clientId, so the identity the user sees
// would change on every attempt. `originId` is the stable identity across
// retries: it is what the attempt counter counts, and what a delete
// tombstones. Set immediately before a retry dispatch; the next markStart()
// claims it.
let pendingOrigin: { originId: string; attempts: number } | null = null;
const origins = new Map<string, { originId: string; attempts: number }>();

export function setNextOrigin(originId: string, attempts: number) {
  pendingOrigin = { originId: String(originId), attempts };
}
export function originOf(clientId: string | number) {
  return origins.get(String(clientId)) || { originId: String(clientId), attempts: 0 };
}

// clientId -> roomId, for every send whose upload/emit is still running.
const inFlight = new Map<string, number | string>();

// Client ids the server has confirmed. remember() refuses to persist these.
//
// Without it there is a race that duplicates messages: remember() and forget()
// each do a read-modify-write on AsyncStorage, so when a send is acked almost
// immediately (send, then straight out of the chat) forget() can read, remove
// and write BEFORE remember()'s own write lands — and remember() then puts the
// entry back. Nothing ever cleared it again, so re-entering the chat resumed a
// message that had already been delivered, and it sent twice.
const delivered = new Set<string>();

// Every storage mutation for a room runs in a chain, so two read-modify-write
// cycles can never interleave in the first place.
const chains = new Map<string, Promise<void>>();
function serialize(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

export function markStart(clientId: string, roomId: number | string) {
  inFlight.set(String(clientId), roomId);
  if (pendingOrigin) { origins.set(String(clientId), pendingOrigin); pendingOrigin = null; }
}
export function markDone(clientId: string) {
  inFlight.delete(String(clientId));
  origins.delete(String(clientId));
  delivered.add(String(clientId));
  // Bounded: this only needs to outlive an in-flight remember().
  if (delivered.size > 200) delivered.delete(delivered.values().next().value as string);
}
export function isInFlight(clientId: string | number): boolean {
  return inFlight.has(String(clientId));
}
export function inFlightCount(): number {
  return inFlight.size;
}

// Drop a persisted pending copy — the send is confirmed or abandoned.
export async function forget(roomId: number | string, clientId: string | number) {
  const key = failedKeyFor(roomId);
  delivered.add(String(clientId));
  return serialize(key, async () => {
    try {
      const arr = JSON.parse((await AsyncStorage.getItem(key)) || '[]')
        .filter((x: any) => String(x.id) !== String(clientId));
      await AsyncStorage.setItem(key, JSON.stringify(arr));
    } catch {}
  });
}

// Tombstone a send the user deleted. A retry already in flight will fail
// later and try to persist itself again — under a NEW clientId, which is why
// deleting the visible copy never stopped it coming back. The tombstone is
// keyed on the stable originId, so any descendant of a deleted send is
// refused by remember() no matter what id it now carries.
export async function discard(roomId: number | string, msg: any) {
  const originId = String(msg?._originId || msg?.id);
  try {
    const key = discardKeyFor(roomId);
    const arr = JSON.parse((await AsyncStorage.getItem(key)) || '[]')
      .filter((x: string) => x !== originId);
    arr.push(originId);
    await AsyncStorage.setItem(key, JSON.stringify(arr.slice(-50)));
  } catch {}
  await forget(roomId, msg?.id);
  if (msg?._originId) await forget(roomId, msg._originId);
}

async function isDiscarded(roomId: number | string, originId: string) {
  try {
    const arr = JSON.parse((await AsyncStorage.getItem(discardKeyFor(roomId))) || '[]');
    return Array.isArray(arr) && arr.includes(String(originId));
  } catch { return false; }
}

// Persist a pending send so it survives the process being killed.
export async function remember(roomId: number | string, msg: any) {
  const key = failedKeyFor(roomId);
  const { originId, attempts } = originOf(msg.id);
  // Deleted by the user — it must never reappear, however it got here.
  if (await isDiscarded(roomId, originId)) return;
  return serialize(key, async () => {
    // Re-checked INSIDE the chain: the ack may have arrived while this call
    // was waiting its turn, and persisting now would resurrect a delivered
    // message for the next visit to resend.
    if (delivered.has(String(msg.id)) || delivered.has(String(originId))) return;
    try {
      const arr = JSON.parse((await AsyncStorage.getItem(key)) || '[]')
        // Replace any earlier generation of this same send, not just this id.
        .filter((x: any) => String(x.id) !== String(msg.id)
          && String(x._originId || x.id) !== String(originId));
      arr.push({ ...msg, _originId: originId, _attempts: attempts, _uploading: false, _uploadFailed: true });
      await AsyncStorage.setItem(key, JSON.stringify(arr.slice(-20)));
    } catch {}
  });
}

// App-wide: whenever the server echoes a message back carrying the client_id we
// sent it with, that send is durably stored server-side — clear our copy even
// if the user has long since left that chat.
let bound = false;
export async function init() {
  if (bound) return;
  bound = true;
  try {
    const sock = await getSocket();
    sock.on('message_received', (msg: any) => {
      if (!msg?.client_id) return;
      markDone(String(msg.client_id));
      forget(msg.room_id, msg.client_id);
    });
  } catch {
    bound = false; // allow a retry once the socket is available
  }
}
