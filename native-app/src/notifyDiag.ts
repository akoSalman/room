// ── What actually happened to notifications, on this phone ──────────────────
//
// Notifications have been diagnosed six times from reading the source, and
// every diagnosis has been wrong. The reason is not carelessness; it is that
// the facts that decide the answer are all on a handset nobody debugging can
// see:
//
//   • did Android ever grant permission, and is it still granted?
//   • is the channel the server names actually enabled, and at what
//     importance? A channel a user (or an OEM) has turned down shows nothing,
//     and no code change reaches it.
//   • does an FCM message EVER arrive at this app? That single fact splits the
//     problem in half: if messages arrive and nothing is drawn, it is the app;
//     if they never arrive, it is delivery, and nothing in this repository
//     can fix it.
//   • is the token this device holds the one the server is pushing to?
//
// So this records them as they happen, in storage, and a screen reads them
// back. A screenshot then answers in one round-trip what six rounds of
// reasoning could not.
//
// Deliberately tiny: counters and timestamps, no message content, nothing that
// would be embarrassing in a screenshot shared in a chat.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'notify-diag-v1';

export type Diag = {
  /** An FCM/expo notification reached this app's JavaScript. */
  lastReceivedAt: number | null;
  receivedCount: number;
  /** The app drew a notification itself, off its own socket. */
  lastSocketRaisedAt: number | null;
  socketRaisedCount: number;
  /** The notification handler was asked whether to show one, and its answer. */
  lastHandlerAt: number | null;
  lastHandlerShowed: boolean | null;
  /** The server accepted this device's push token. */
  lastTokenAcceptedAt: number | null;
};

const EMPTY: Diag = {
  lastReceivedAt: null,
  receivedCount: 0,
  lastSocketRaisedAt: null,
  socketRaisedCount: 0,
  lastHandlerAt: null,
  lastHandlerShowed: null,
  lastTokenAcceptedAt: null,
};

/** The blank slate, as a value — never the shared object, or callers mutate it. */
export function empty(): Diag {
  return { ...EMPTY };
}

/**
 * Fold one event into the record.
 *
 * Pure, so the rules can be tested without a device: the whole point of this
 * file is to be trustworthy about what happened, and a counter that is wrong
 * is worse than no counter at all.
 */
export function apply(
  prev: Diag | null | undefined,
  event: { kind: 'received' | 'socket-raised' | 'handler' | 'token-accepted'; at: number; showed?: boolean },
): Diag {
  const d: Diag = { ...EMPTY, ...(prev || {}) };
  const at = Number(event?.at) || 0;
  if (!at) return d;
  switch (event.kind) {
    case 'received':
      return { ...d, lastReceivedAt: at, receivedCount: (Number(d.receivedCount) || 0) + 1 };
    case 'socket-raised':
      return { ...d, lastSocketRaisedAt: at, socketRaisedCount: (Number(d.socketRaisedCount) || 0) + 1 };
    case 'handler':
      return { ...d, lastHandlerAt: at, lastHandlerShowed: !!event.showed };
    case 'token-accepted':
      return { ...d, lastTokenAcceptedAt: at };
    default:
      return d;
  }
}

/**
 * How long ago, in words a non-technical reader can act on.
 *
 * "never" is the most important answer this can give: for lastReceivedAt it
 * means no FCM message has EVER reached this app, which decides the whole
 * question and cannot be read off a number of milliseconds.
 */
export function ago(at: number | null | undefined, now: number = Date.now()): string {
  const t = Number(at) || 0;
  if (!t) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * The one line that says where the problem is.
 *
 * Written as a sentence rather than a status code, because the person reading
 * it is holding a phone and needs to know what to do, and because the whole
 * value of this screen is turning "it doesn't work" into something specific.
 */
export function verdict(d: Diag | null | undefined, o: {
  permissionGranted: boolean; channelEnabled: boolean; tokenRegistered: boolean;
}): string {
  if (!o || !o.permissionGranted) {
    return 'Android is blocking notifications for this app. Turn them on in Settings → Apps → Notifications.';
  }
  if (!o.channelEnabled) {
    return 'The "Messages" channel is switched off or silenced. Turn it on in the app\'s notification settings.';
  }
  if (!o.tokenRegistered) {
    return 'This device has not registered for push. Reopen the app while online.';
  }
  const received = Number(d?.receivedCount) || 0;
  if (received === 0) {
    return 'No push message has ever reached this app. The server is sending them, so they are being lost on the way — this is delivery, not the app.';
  }
  if (d?.lastHandlerShowed === false) {
    return 'Push messages are arriving but the app decided not to show the last one.';
  }
  return 'Push messages are arriving and being shown.';
}

// ── Storage ────────────────────────────────────────────────────────────────

export async function read(): Promise<Diag> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return empty();
    return { ...EMPTY, ...(JSON.parse(raw) || {}) };
  } catch {
    return empty();
  }
}

/**
 * Record an event.
 *
 * Never throws and never blocks the caller: this is instrumentation, and
 * instrumentation that can break the thing it measures is worse than none.
 */
export function record(
  kind: 'received' | 'socket-raised' | 'handler' | 'token-accepted',
  showed?: boolean,
): void {
  (async () => {
    try {
      const prev = await read();
      const next = apply(prev, { kind, at: Date.now(), showed });
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
  })();
}
