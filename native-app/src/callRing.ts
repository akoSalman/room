// ── Ringing from the socket, not from Google ─────────────────────────────────
//
// Reported as: I am calling this phone with a good connection and it does not
// ring until I open the app.
//
// That is exactly what the code guaranteed, and the measurement says so:
//
//     NAJVA configured in the service environment: NO   <- FCM is the only route
//     tokens by provider:  fcm|6
//     users who have sent a message in the last 7 days: 15
//     …of those, how many have NO push token:            9
//
// ringIncoming() — the looping, full-screen, Accept/Decline ring — had exactly
// ONE caller in the whole app: the FCM background task in callPush.ts. So the
// phone rang if and only if a Google push arrived. Nine of fifteen active
// users have no token for that to be delivered to, and these networks throttle
// what is left.
//
// Meanwhile the offer is ALREADY ARRIVING on the socket. The server emits
// call_offer to the callee before it even thinks about a push, the keep-alive
// foreground service holds that socket open with the app closed — every device
// in the report says keepalive=running — and callManager listens for it. What
// callManager does with it is startTone('callee'), an in-app expo-av tone, and
// a React screen. With the app closed there is no screen to show and no audio
// session to play into, so the offer landed and nothing happened. Open the app
// and the server re-delivers the pending offer, which is why it rings THEN and
// looks like a push problem.
//
// keepAlive.ts's own first line is "Keeping the socket alive, so notifications
// do not need Google". Messages have been using that route for weeks, through
// socketNotifier.ts. Calls were never wired to it. This is that wiring's
// decision half, kept pure and apart from it, because the rules below are the
// part that can be got wrong silently and an `if` inside a socket handler
// cannot be tested without two phones and a second person to dial.

/**
 * How long one claim to be "the call that is ringing" lasts.
 *
 * It is the notification's own `timeoutAfter` — incomingCall.ts imports this
 * constant rather than repeating the number, so the ring and the claim on it
 * cannot drift apart. Past channel and tag bugs in this app were all two
 * copies of one value disagreeing.
 */
export const RING_CLAIM_MS = 45000;

export type RingDecision = { ring: boolean; reason: string };

/**
 * Should this socket event start the phone ringing?
 *
 * Pure. Every input that varies — who is already ringing, when, what the app
 * is doing — is passed in rather than read, so each rule can be driven
 * directly.
 */
export function ringDecision(o: {
  event?: string | null;
  fromUserId?: number | string | null;
  /** Non-null for a room call, which must not ring. */
  roomId?: number | string | null;
  appState?: string | null;
  /** Who this device is already ringing for, if anyone. */
  ringingFrom?: number | string | null;
  ringingSince?: number | null;
  now?: number;
}): RingDecision {
  if (!o) return { ring: false, reason: 'no-event' };
  // onAny delivers every event on the socket, so this is the filter.
  if (o.event !== 'call_offer') return { ring: false, reason: 'not-an-offer' };
  // ── A room call does not ring ───────────────────────────────────────────
  //
  // The server already draws this line itself — `if (!roomId)` guards both
  // the pending-call record and the push — and callManager ignores a room
  // offer unless this device is already in that room's voice call. Joining a
  // room call is something you choose, not something that rings at you, and
  // ringing here would make every room member's phone go off whenever any two
  // of them talked.
  if (o.roomId != null && String(o.roomId) !== '') {
    return { ring: false, reason: 'room-call' };
  }
  // ── A usable sender id, not merely a present one ────────────────────────
  //
  // Checked as a NUMBER, because String(0) is '0' and that is truthy: a
  // truthiness test on the string form rings for sender 0 and then hands 0 to
  // a notification whose Accept and Decline both begin `if (!fromUserId)
  // return`. The ring would be real and neither button would do anything.
  //
  // Ids are integers from the database, so anything that is not a positive
  // one is not a sender — it arrives as a number on the socket and as a
  // string from the notification payload, and both go through Number here.
  const id = Number(o.fromUserId);
  if (!Number.isFinite(id) || id <= 0) return { ring: false, reason: 'no-sender' };
  const from = String(o.fromUserId);
  // ── Not while the app is in front of the person ─────────────────────────
  //
  // Then callManager's own incoming-call screen and its tone are already
  // doing this, and a full-screen notification over the top would be a second
  // ring over the first. This is the same rule, for the same reason, as
  // socketNotifier's 'app-active'.
  if (o.appState === 'active') return { ring: false, reason: 'app-active' };
  // ── One ring per caller ─────────────────────────────────────────────────
  //
  // The offer can arrive more than once for one call: the server re-delivers
  // the pending offer on every reconnect, and a flapping socket reconnects
  // often — one device in the report drops and returns every 26 to 161
  // seconds. Each delivery would re-post the notification, and re-posting a
  // loopSound notification restarts the ring from the beginning, so a call
  // nobody answered would ring in bursts forever.
  //
  // Only the SAME caller is held off. A different one replaces it, which is
  // what the single notification id does anyway and what the server's push
  // tag has always done: "One tag, so a second offer replaces the first
  // rather than stacking."
  const ringing = o.ringingFrom == null ? '' : String(o.ringingFrom);
  if (ringing && ringing === from) {
    const since = typeof o.ringingSince === 'number' && Number.isFinite(o.ringingSince)
      ? o.ringingSince : 0;
    const now = typeof o.now === 'number' && Number.isFinite(o.now) ? o.now : 0;
    // An expired claim must not block the next real call from the same
    // person, which a plain "same caller" test would do for the life of the
    // process.
    if (since > 0 && now - since < RING_CLAIM_MS) {
      return { ring: false, reason: 'already-ringing' };
    }
  }
  return { ring: true, reason: 'ok' };
}

// ── The claim itself ────────────────────────────────────────────────────────

let ringingFrom: string | null = null;
let ringingSince = 0;

/**
 * Decide, and take the claim if the answer is yes.
 *
 * Both routes to a ring go through here — this one and callPush's FCM task —
 * so whichever arrives first rings and the other is told 'already-ringing'
 * instead of restarting the tone. The same arrangement as notifyOnce.ts, for
 * the same reason: two routes, one notification, and the loser must be the
 * one that does nothing.
 */
export function claimRing(o: {
  event?: string | null;
  fromUserId?: number | string | null;
  roomId?: number | string | null;
  appState?: string | null;
}, now: number = Date.now()): RingDecision {
  const d = ringDecision({ ...o, ringingFrom, ringingSince, now });
  if (d.ring) {
    ringingFrom = String(o.fromUserId);
    ringingSince = now;
  }
  return d;
}

/**
 * Give up the claim: answered, declined, cancelled or timed out.
 *
 * Called from stopRinging(), which is the one place every one of those ends
 * up, so a new call from the same person rings immediately afterwards instead
 * of waiting out the claim.
 */
export function releaseRing(): void {
  ringingFrom = null;
  ringingSince = 0;
}

/** For the test, so it reads the real state rather than a copy of it. */
export function _state(): { ringingFrom: string | null; ringingSince: number } {
  return { ringingFrom, ringingSince };
}
