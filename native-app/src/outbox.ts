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

// clientId -> roomId, for every send whose upload/emit is still running.
const inFlight = new Map<string, number | string>();

export function markStart(clientId: string, roomId: number | string) {
  inFlight.set(String(clientId), roomId);
}
export function markDone(clientId: string) {
  inFlight.delete(String(clientId));
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
  try {
    const arr = JSON.parse((await AsyncStorage.getItem(key)) || '[]')
      .filter((x: any) => String(x.id) !== String(clientId));
    await AsyncStorage.setItem(key, JSON.stringify(arr));
  } catch {}
}

// Persist a pending send so it survives the process being killed.
export async function remember(roomId: number | string, msg: any) {
  const key = failedKeyFor(roomId);
  try {
    const arr = JSON.parse((await AsyncStorage.getItem(key)) || '[]')
      .filter((x: any) => String(x.id) !== String(msg.id));
    arr.push({ ...msg, _uploading: false, _uploadFailed: true });
    await AsyncStorage.setItem(key, JSON.stringify(arr.slice(-20)));
  } catch {}
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
