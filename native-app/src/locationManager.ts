// ── Live location sharing ────────────────────────────────────────────────────
//
// One share at a time, owned at module scope so it survives leaving the chat:
// stopping the stream because the user scrolled away would defeat the point.
//
// The watcher is stopped by whichever comes first — the user pressing Stop, the
// expiry passing, or the server rejecting an update because the share already
// ended. The server enforces the expiry too, so a client that somehow keeps
// watching cannot keep broadcasting.
import * as Location from 'expo-location';
import { getSocket } from './api';
import { showLiveLocation, hideLiveLocation } from './incomingCall';
import { sendDue, shareOver, HEARTBEAT_MS } from './liveShare';

type Active = {
  messageId: number | string;
  roomId: number | string;
  /**
   * The chat this share lives in, kept whole rather than as an id.
   *
   * Asked for: tapping the live-location bar should go to the message it is
   * about, from ANY chat. From another chat that means opening a different
   * conversation, and opening one needs the room itself — an id alone would
   * have to be looked up, and the bar would do nothing until it came back.
   */
  room: any;
  until: number;
  sub: Location.LocationSubscription | null;
  /** The heartbeat that repeats an unchanged position. */
  beat: any;
  timer: any;
};

let active: Active | null = null;
/** When the last position actually went out, and what it was. */
let lastSentAt: number | null = null;
let lastPos: Location.LocationObject | null = null;
const listeners = new Set<() => void>();

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function emit() { listeners.forEach(f => f()); }

export function activeShare() {
  return active
    ? { messageId: active.messageId, roomId: active.roomId, room: active.room, until: active.until }
    : null;
}

/** Foreground permission, asked only when it isn't already granted. */
export async function ensurePermission(): Promise<boolean> {
  const existing = await Location.getForegroundPermissionsAsync();
  if (existing.granted) return true;
  const asked = await Location.requestForegroundPermissionsAsync();
  return asked.granted;
}

/**
 * One fix, as good as the phone can make it.
 *
 * Accuracy.High, not Balanced. Balanced asks Android for roughly a hundred
 * metres and is the right trade for the live tracker below, which takes a
 * reading every few seconds for hours. This is a SINGLE reading for a message
 * saying where someone is, and a hundred metres is the difference between a
 * street and a neighbourhood — which is exactly the complaint. The extra
 * battery for one fix is not worth defending.
 */
export async function currentPosition(): Promise<{ lat: number; lng: number; accuracy: number | null } | null> {
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null };
  } catch {
    // A last known fix is far better than nothing when the sky is blocked.
    try {
      const last = await Location.getLastKnownPositionAsync();
      if (last) return { lat: last.coords.latitude, lng: last.coords.longitude, accuracy: last.coords.accuracy ?? null };
    } catch {}
    return null;
  }
}

/** Begin streaming positions into an existing live-location message. */
export async function startSharing(
  messageId: number | string, roomId: number | string, until: number, chatName?: string,
  room?: any,
) {
  await stopSharing({ silent: true });

  // ── The socket is fetched PER SEND, never captured ───────────────────────
  //
  // This is what was broken. It read
  //
  //     const sock = await getSocket();
  //     … watchPositionAsync(…, pos => sock.emit('location_update', …))
  //
  // — one socket, taken when the share started and used by a callback that
  // runs for hours. Sockets do not last hours on these connections. Every
  // send after a reconnect went into an orphaned object, which accepts an
  // emit and delivers nothing, so the pin froze where the share began while
  // the phone looked perfectly healthy: network up, permission granted,
  // watcher running, notification showing. Reported as exactly that.
  //
  // api.ts already says so, above onSocket: "Handing a socket out once and
  // hoping nothing replaces it is the bug." That note was written after the
  // same mistake made the app deaf to every message. This file was making it
  // too, out of sight in a closure.
  //
  // getSocket() returns the live one, so asking each time costs a promise and
  // cannot go stale.
  const push = async (pos: Location.LocationObject) => {
    if (!active || active.messageId !== messageId) return;
    const sock = await getSocket().catch(() => null);
    if (!sock) return;
    // Re-checked after the await: the share can end while it is pending.
    if (!active || active.messageId !== messageId) return;
    // Kept whatever happens next, so the heartbeat has something to repeat.
    lastPos = pos;
    // ── Not while the socket is down ────────────────────────────────────────
    //
    // Reported: "when connection is lost, after that update does not work."
    //
    // An emit on a disconnected socket is accepted and queued, and
    // ensureSocketAlive() — the probe that recovers a zombie connection after
    // a SIM call or a network switch — does `s.disconnect(); s.connect();`,
    // and disconnect() throws the queue away. So a position handed over
    // during an outage could be silently dropped by the very thing that
    // repairs the connection.
    //
    // Nothing is queued now. The heartbeat below retries, so an outage costs
    // one beat rather than the rest of the share.
    if (sock.connected === false) return;
    sock.emit('location_update', {
      messageId,
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? null,
    }, (res: any) => {
      // The server says it is over — believe it, and stop the watcher.
      if (res?.ended) { stopSharing({ silent: true }); return; }
      // ── Sent means ACKNOWLEDGED, not handed over ──────────────────────────
      //
      // This used to be set before the emit, which counted a send that
      // nothing ever received: during an outage the clock was pushed forward
      // by sends that went nowhere, and the heartbeat sat quiet believing it
      // was up to date. A reply is the only proof the server heard it.
      //
      // Any reply, not only a successful one — the question this answers is
      // "did the round trip work", and an error that comes back answers it
      // just as well. `ended` is handled above and is the one reply that
      // means stop rather than carry on.
      lastSentAt = Date.now();
    });
  };

  const sub = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.Balanced,
      // Throttled on both axes: a fix every few seconds, and only once the
      // person has actually moved. Streaming every GPS sample would drain the
      // battery and flood the room for no visible benefit.
      timeInterval: 5000,
      distanceInterval: 15,
    },
    (pos) => {
      if (!active || active.messageId !== messageId) return;
      if (shareOver(Date.now(), active.until)) { stopSharing(); return; }
      push(pos);
    },
  );

  // ── And a heartbeat, because not moving looks like not working ───────────
  //
  // The watcher is silent while the phone is still, so "updated 56 min ago"
  // could mean the person has not moved in an hour or that nothing has
  // reached the server in an hour. Those need telling apart by whoever is
  // waiting for them. Repeating the last position on a slow timer makes the
  // time on the card mean "we heard from them this recently", and makes a
  // dropped update repair itself at the next beat instead of lasting until
  // the next real movement.
  const beat = setInterval(() => {
    if (!active || active.messageId !== messageId) return;
    if (shareOver(Date.now(), active.until)) { stopSharing(); return; }
    if (!sendDue(Date.now(), lastSentAt)) return;
    const p = lastPos;
    if (p) { push(p); return; }
    // Nothing sent yet — the watcher has not produced a fix. A cached one is
    // free and better than staying silent.
    Location.getLastKnownPositionAsync()
      .then(last => { if (last) push(last); })
      .catch(() => {});
  }, Math.max(5_000, Math.floor(HEARTBEAT_MS / 4)));

  active = {
    messageId,
    roomId,
    room: room || null,
    until,
    sub,
    beat,
    timer: setTimeout(() => stopSharing(), Math.max(0, until - Date.now())),
  };
  // Visible in the notification shade for as long as it runs, with Stop on it,
  // so leaving the app cannot hide the fact that you are still broadcasting.
  showLiveLocation(chatName || 'Chat', until).catch(() => {});
  emit();
}

/**
 * The message IS the share — deleting it must end the broadcast.
 *
 * Otherwise the message vanished from the chat while the phone kept sending
 * positions, with the banner above the composer and the shade notification
 * still up and no message left to stop them from.
 */
export async function stopForMessage(messageId: number | string) {
  if (active && String(active.messageId) === String(messageId)) await stopSharing();
}

export async function stopSharing(opts: { silent?: boolean } = {}) {
  const cur = active;
  active = null;
  // Reset here rather than in startSharing, because startSharing's first act
  // is to call this — so one place covers both, and a new share can never
  // inherit the previous one's heartbeat clock and think it is up to date.
  lastSentAt = null;
  lastPos = null;
  if (!cur) { if (!opts.silent) emit(); return; }
  clearTimeout(cur.timer);
  clearInterval(cur.beat);
  try { cur.sub?.remove(); } catch {}
  hideLiveLocation().catch(() => {});
  if (!opts.silent) {
    const sock = await getSocket().catch(() => null);
    sock?.emit('location_stop', { messageId: cur.messageId });
  }
  emit();
}
