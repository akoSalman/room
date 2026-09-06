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
  timer: any;
};

let active: Active | null = null;
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

  const sock = await getSocket().catch(() => null);
  if (!sock) return;

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
      if (Date.now() > active.until) { stopSharing(); return; }
      sock.emit('location_update', {
        messageId,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy ?? null,
      }, (res: any) => {
        // The server says it is over — believe it, and stop the watcher.
        if (res?.ended) stopSharing({ silent: true });
      });
    },
  );

  active = {
    messageId,
    roomId,
    room: room || null,
    until,
    sub,
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
  if (!cur) { if (!opts.silent) emit(); return; }
  clearTimeout(cur.timer);
  try { cur.sub?.remove(); } catch {}
  hideLiveLocation().catch(() => {});
  if (!opts.silent) {
    const sock = await getSocket().catch(() => null);
    sock?.emit('location_stop', { messageId: cur.messageId });
  }
  emit();
}
