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
  /**
   * The app drew a notification itself, off its own socket — AND THE POST WAS
   * ACCEPTED. Recorded after the call resolves, never before it.
   *
   * It used to be recorded on the line after the call, with the call's own
   * rejection thrown away by a bare .catch(() => {}). A screenshot then read
   * "shown by the app itself: 38, last 2s ago" while the phone had shown
   * nothing at all, because all 38 had been refused. The counter was
   * measuring attempts and claiming to measure notifications.
   */
  lastSocketRaisedAt: number | null;
  socketRaisedCount: number;
  /** …and the ones that were refused, with the reason. */
  lastSocketFailedAt: number | null;
  socketFailedCount: number;
  lastSocketError: string | null;
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
  lastSocketFailedAt: null,
  socketFailedCount: 0,
  lastSocketError: null,
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
  event: {
    kind: 'received' | 'socket-raised' | 'socket-failed' | 'handler' | 'token-accepted';
    at: number; showed?: boolean; error?: string;
  },
): Diag {
  const d: Diag = { ...EMPTY, ...(prev || {}) };
  const at = Number(event?.at) || 0;
  if (!at) return d;
  switch (event.kind) {
    case 'received':
      return { ...d, lastReceivedAt: at, receivedCount: (Number(d.receivedCount) || 0) + 1 };
    case 'socket-raised':
      return { ...d, lastSocketRaisedAt: at, socketRaisedCount: (Number(d.socketRaisedCount) || 0) + 1 };
    case 'socket-failed':
      return {
        ...d,
        lastSocketFailedAt: at,
        socketFailedCount: (Number(d.socketFailedCount) || 0) + 1,
        // Truncated because this is read off a screenshot, and because a
        // native stack in a chat message helps nobody.
        lastSocketError: String(event.error || 'unknown').slice(0, 120),
      };
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
  // BEFORE anything about Firebase. The app's own socket is the fast path and
  // covers almost every message; if its posts are being REFUSED then nothing
  // appears no matter what Google does, and the reason is right here in the
  // app. This went unseen for three builds because the rejection was thrown
  // away by a bare .catch(() => {}) and the counter was bumped anyway.
  const failed = Number(d?.socketFailedCount) || 0;
  const failedAt = Number(d?.lastSocketFailedAt) || 0;
  const raisedAt = Number(d?.lastSocketRaisedAt) || 0;
  if (failed > 0 && failedAt >= raisedAt) {
    return `The app is being refused when it tries to show a notification: ${d?.lastSocketError || 'unknown'}`;
  }
  const received = Number(d?.receivedCount) || 0;
  if (received === 0) {
    return 'No push message has ever reached this app. The server is sending them, so they are being lost on the way — this is delivery, not the app.';
  }
  // The handler's verdict only describes the LAST ARRIVAL if it happened
  // after it. Reported from a real screenshot: two pushes 23 seconds ago, a
  // handler decision twelve minutes older, and this line blaming the app for
  // hiding something it was never asked about. A diagnostic that accuses the
  // wrong component is worse than one that says nothing.
  const recv = Number(d?.lastReceivedAt) || 0;
  const handled = Number(d?.lastHandlerAt) || 0;
  if (d?.lastHandlerShowed === false && handled >= recv) {
    return 'Push messages are arriving but the app decided not to show the last one.';
  }
  if (handled < recv) {
    // They arrived without the handler being consulted, which is what happens
    // when Android draws them itself — so they were shown, and the stale
    // handler decision below is about something else entirely.
    return 'Push messages are arriving and being shown by Android directly.';
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
  kind: 'received' | 'socket-raised' | 'socket-failed' | 'handler' | 'token-accepted',
  showed?: boolean,
  error?: string,
): void {
  (async () => {
    try {
      const prev = await read();
      const next = apply(prev, { kind, at: Date.now(), showed, error });
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
  })();
}
