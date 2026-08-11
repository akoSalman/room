import AsyncStorage from '@react-native-async-storage/async-storage';
import { io, Socket } from 'socket.io-client';

export const BASE_URL = 'https://chat.akosalman.com';
// Stamped per-brand by CI (build-native-apk.yml) from native-app/brands/<brand>.json
export const RELEASE_TAG = 'latest-apk';
export const RELEASE_FILE = 'ChatRoom-latest.apk';

export async function getToken() {
  return AsyncStorage.getItem('token');
}
export async function getUsername() {
  return AsyncStorage.getItem('username');
}

export async function setAuth(token: string, username: string, avatar?: string | null) {
  await AsyncStorage.setItem('token', token);
  await AsyncStorage.setItem('username', username);
  if (avatar !== undefined) {
    if (avatar) await AsyncStorage.setItem('avatar', avatar);
    else await AsyncStorage.removeItem('avatar');
  }
}

export async function getAvatar() {
  return AsyncStorage.getItem('avatar');
}

export async function getUserId(): Promise<number | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.id ?? null;
  } catch { return null; }
}

// ── Session expiry ───────────────────────────────────────────────────────────
// When the server's signing secret is rotated (or a token otherwise stops being
// valid) every request starts coming back 401 and the socket refuses to
// connect. Previously nothing noticed: the UI just rendered empty/broken
// screens and the user had to work out for themselves that they should sign out
// again. The app now detects that state once and signs the user out cleanly.
type ExpiredHandler = () => void;
let onSessionExpired: ExpiredHandler | null = null;
let expiredFired = false;

export function setSessionExpiredHandler(fn: ExpiredHandler | null) {
  onSessionExpired = fn;
}
// Re-arm after a fresh sign-in, so a later expiry is detected again.
export function resetSessionExpiry() { expiredFired = false; }

function sessionExpired() {
  if (expiredFired) return;      // one notification per session, not one per request
  expiredFired = true;
  onSessionExpired?.();
}

export async function apiFetch(path: string, method = 'GET', body?: object) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // 401 means the token is no longer accepted — sign out rather than leaving
  // the user staring at a screen that silently fails.
  if (res.status === 401 && token) sessionExpired();
  return res.json();
}

let socket: Socket | null = null;

export async function getSocket(): Promise<Socket> {
  if (socket?.connected) return socket;
  const token = await getToken();
  // Default transports: start on HTTP long-polling, upgrade to WebSocket when
  // the proxy supports it. Forcing websocket-only made the app silently dead
  // (no sends, no realtime) behind proxies without WebSocket upgrade support.
  socket = io(BASE_URL, {
    auth: { token },
    // Come back fast after network changes (SIM calls, Wi-Fi/data switches)
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 8000,
  });
  // The server rejects the handshake with "Unauthorized" for a stale token.
  // Endless silent reconnect attempts look like "the app is just broken", so
  // treat it as an expired session.
  socket.on('connect_error', (err: any) => {
    if (String(err?.message || '').toLowerCase().includes('unauthorized')) sessionExpired();
  });
  return socket;
}

// After a SIM call or network switch the socket can be a zombie: it still
// says connected but the server timed it out, and noticing that organically
// takes tens of seconds. Probe with an acked ping and force a reconnect if
// the ack doesn't arrive quickly.
export function ensureSocketAlive() {
  const s: any = socket;
  if (!s) return;
  if (!s.connected) { s.connect(); return; }
  try {
    s.timeout(3000).emit('ping_check', (err: any, res: any) => {
      if (err || !res?.ok) {
        try { s.disconnect(); } catch {}
        s.connect();
      }
    });
  } catch {}
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
