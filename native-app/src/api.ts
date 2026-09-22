import AsyncStorage from '@react-native-async-storage/async-storage';
import { io, Socket } from 'socket.io-client';
import * as connection from './connection';

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

// Reachability lives in connection.ts so the socket and requests feed the same
// answer; re-exported here because callers already import from api.
export function isOnline() { return connection.isOnline(); }
export function onNetworkChange(fn: (up: boolean) => void) {
  return connection.subscribe(s => fn(s === 'online'));
}
const setOnline = (up: boolean) => connection.report(up);

/**
 * A failed request RESOLVES with an error rather than throwing.
 *
 * fetch() rejects when there is no connection, and every caller that awaited
 * several of these together (`Promise.all`) then threw straight past its own
 * `setLoading(false)`. The result was the worst possible offline behaviour: a
 * spinner that never stops, on a screen whose contents were on the device all
 * along. An error value flows through the `if (res.error)` path every caller
 * already has.
 */
export async function apiFetch(path: string, method = 'GET', body?: object) {
  const token = await getToken();
  try {
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
    setOnline(true);
    try {
      return await res.json();
    } catch {
      // Reached the server but got something that is not JSON — a proxy's
      // error page, or a truncated response.
      return { error: `Bad response (${res.status})`, offline: false };
    }
  } catch {
    setOnline(false);
    return { error: 'No connection', offline: true };
  }
}

let socket: Socket | null = null;
/**
 * The in-flight creation, so concurrent callers share one socket.
 *
 * ── SEVEN SOCKETS FOR ONE PHONE ────────────────────────────────────────────
 *
 * Measured on the server, which had never logged this until it was looked for:
 *
 *     08:35:44  connect    user=11          (seven times, same second)
 *     08:35:51  disconnect user=11 held=7s  (seven times, same second)
 *
 * Two compounding faults in the eight lines below, both now fixed.
 *
 * FIRST, the guard asked `socket?.connected` rather than whether a socket
 * EXISTED. A socket that is merely reconnecting — which is most of the time on
 * these connections — failed that test, so a brand new one was built and the
 * old one was abandoned. Abandoned is not closed: socket.io goes on
 * reconnecting it forever, so every drop left another immortal socket behind.
 *
 * SECOND, `await getToken()` sits between the check and the assignment. Every
 * caller that arrived during that await passed the guard and created its own.
 * The ordinary async-singleton race, and the app calls getSocket() from
 * several places at once on resume.
 *
 * Together they turn one bad minute of network into a handful of permanent
 * sockets, each reconnecting on its own schedule, each raising its own
 * presence on the server.
 */
let creating: Promise<Socket> | null = null;

export async function getSocket(): Promise<Socket> {
  // EXISTS, not "is connected". socket.io reconnects an existing socket by
  // itself; replacing it during a reconnect is what orphaned the old one.
  if (socket) return socket;
  // A creation already under way is awaited rather than raced.
  if (creating) return creating;
  creating = createSocket().finally(() => { creating = null; });
  return creating;
}

/**
 * Everyone who wants to be told when a NEW socket exists.
 *
 * ── WHY THIS HAD TO EXIST ──────────────────────────────────────────────────
 *
 * A phone reported, on v323:
 *
 *     Socket to the server: connected
 *     Messages reaching the app: 0 · last never
 *
 * The socket was up and not one message had ever reached the notification
 * listener. Not refused — never delivered. The listener was attached ONCE,
 * from a React effect, to whatever socket existed at that moment; every
 * socket built afterwards had no listener on it, while getSocket() and the
 * diagnostics line both reported the NEW one as connected. The app looked
 * perfectly healthy and was deaf.
 *
 * Handing a socket out once and hoping nothing replaces it is the bug.
 * Subscribers are told about every socket, including the one that already
 * exists when they subscribe, so there is no window in which a listener can
 * be attached to the wrong one — and no ordering to get right at startup.
 */
const socketSubscribers = new Set<(s: Socket) => void>();

/**
 * Be told about the socket: now if there is one, and again whenever a new one
 * replaces it.
 *
 * Returns an unsubscribe, though callers that want notifications for the life
 * of the process should simply never call it.
 */
export function onSocket(cb: (s: Socket) => void): () => void {
  socketSubscribers.add(cb);
  if (socket) { try { cb(socket); } catch {} }
  return () => { socketSubscribers.delete(cb); };
}

async function createSocket(): Promise<Socket> {
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
    // Could not reach the server. This is the signal that lets the app notice
    // a connection dropping while the user is sitting there reading, with no
    // request of our own to piggyback on.
    else connection.report(false);
  });
  socket.on('connect', () => connection.report(true));
  socket.on('disconnect', (reason: string) => {
    // 'io client disconnect' is us leaving on purpose (sign-out), not a fault.
    if (reason !== 'io client disconnect') connection.report(false);
  });
  // Tell everyone who is listening for the socket, BEFORE returning it, so a
  // caller that awaits getSocket() cannot race the subscribers.
  for (const cb of socketSubscribers) { try { cb(socket); } catch {} }
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
  creating = null;
}
