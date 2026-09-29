// ── Where call audio comes out, and when ─────────────────────────────────────
//
// Reported as: "when calling, the first rings are not on speaker but are in a
// loud state."
//
// Exactly right, and it describes the bug precisely. The outgoing ringback was
// an expo-av sound played before any call audio session existed, so Android
// treated it as ordinary media: full loudspeaker, at media volume, held
// against an ear. The moment the callee answered, InCallManager.start() ran
// for the first time and the route dropped to the earpiece — which is why the
// ringing was loud and the conversation was not.
//
// The fix is to open the call audio session when the call STARTS rather than
// when it connects, so the ringback is routed like the call it belongs to.
// That makes routing a question with an answer for every phase, and the answer
// lives here rather than being re-decided at three call sites.

export type CallMode = 'dm-voice' | 'dm-video' | 'room-voice';
export type CallPhase = 'outgoing' | 'incoming' | 'connected';

export type Route = {
  /** Which InCallManager session to open ('audio' also covers video's audio). */
  media: 'audio' | 'video';
  /** Force the loudspeaker on. */
  speaker: boolean;
  /** expo-av's playThroughEarpieceAndroid for any tone we play ourselves. */
  earpiece: boolean;
};

/**
 * Where the audio for this call should go.
 *
 * Video is hands-free by nature and so is a room call — you are not holding a
 * group voice chat to your ear. A one-to-one voice call is the phone-call
 * case: earpiece, from the first ring to the last word.
 *
 * `incoming` is the deliberate exception. That tone is the phone ringing at
 * somebody who is not holding it, and routing it to the earpiece would mean a
 * call they simply never hear. It is the one tone that belongs on the
 * loudspeaker at ringer volume.
 */
export function routeFor(o: {
  mode: CallMode; phase: CallPhase; speakerOn?: boolean;
}): Route {
  if (o.phase === 'incoming') {
    return { media: 'audio', speaker: true, earpiece: false };
  }
  const handsFree = o.mode === 'dm-video' || o.mode === 'room-voice';
  // Once connected the user's own choice wins — they may have tapped the
  // speaker button, and nothing here may override that.
  const speaker = o.phase === 'connected' && o.speakerOn !== undefined
    ? !!o.speakerOn
    : handsFree;
  return {
    media: o.mode === 'dm-video' ? 'video' : 'audio',
    speaker,
    earpiece: !speaker,
  };
}

/**
 * Does the audio session need to be open in this phase?
 *
 * Answer: always, including while the call is still ringing out. Opening it
 * only on connect is what put the ringback on the loudspeaker.
 */
export function sessionNeeded(phase: CallPhase): boolean {
  return phase === 'outgoing' || phase === 'connected';
}

// ── What the caller is told while they wait ──────────────────────────────────
//
// Reported as: "on calling, check if the user is online or available, then
// show ringing — otherwise connecting."
//
// The screen said "Ringing…" the instant the offer was handed to the socket,
// which is a claim about the OTHER phone made without hearing from it. If the
// callee was offline it was simply untrue: nothing was ringing anywhere, and
// the caller waited 45 seconds staring at a word that meant nothing.
//
// Three things are actually known, in order:
//   1. whether the server had a live socket for them (the offer's ack),
//   2. whether their app said it started alerting (`call_ringing`),
//   3. whether they answered.
// Only the second justifies the word "Ringing".

export type OutgoingState = {
  /** A push notification was dispatched: their phone is alerting them. */
  pushed?: boolean;
  /** The server had a live socket for them and handed the offer over. */
  delivered?: boolean;
  /** Their device confirmed it is alerting. */
  ringing?: boolean;
  /** The answer SDP arrived. */
  answered?: boolean;
  /** Media is flowing. */
  connected?: boolean;
};

export function outgoingStatus(s: OutgoingState): string {
  if (s.connected) return 'Connected';
  if (s.answered) return 'Connecting…';
  if (s.ringing) return 'Ringing…';
  // A PUSH WENT OUT, so their phone is alerting them — that is ringing, and
  // saying "Connecting…" while the other person is looking at an incoming call
  // is simply wrong. Reported exactly that way: "the other user is seeing the
  // notification on their device but the call is still connecting".
  //
  // `ringing` above is better evidence — it is the callee's app saying so —
  // but it only exists when their app is awake. This covers the closed app,
  // which is the case the complaint is about.
  if (s.pushed) return 'Ringing…';
  if (s.delivered) return 'Calling…';
  // Nothing reached them by any route: no socket, no push token. THIS is what
  // "Connecting…" is for — somebody with no internet at all.
  return 'Connecting…';
}

// ── Hanging up before it was answered ──────────────────────────────────────
//
// Reported as: the caller's side ends the call, and the other phone goes on
// ringing for ever.
//
// `call_end` arrived and was handled like this:
//
//     this.dropPeer(fromUserId);
//     if (this.mode?.startsWith('dm')) this.teardown();
//
// Neither line does anything to an UNANSWERED call. There is no peer
// connection yet, so dropPeer has nothing to drop; and `mode` is only set when
// a call is ACCEPTED, so for a phone that is merely ringing it is null and the
// teardown — which is what stops the tone and cancels the notification — never
// ran. The one case where hanging up matters most was the one case nothing
// handled.

/**
 * Does this `call_end` stop what is happening on this device?
 *
 * Yes for a call in progress with that person, and yes for a call from them
 * that is still ringing here. The second is the one that was missing.
 */
export function endStopsCall(o: {
  /** Who the ending applies to, from the event. */
  fromUserId?: unknown;
  /** The call currently in progress, if any. */
  mode?: string | null;
  /** Who we are in a call with, when there is one. */
  peerId?: unknown;
  /** Who is ringing this phone right now, if anybody. */
  incomingFrom?: unknown;
}): boolean {
  if (!o) return false;
  const from = idOf(o.fromUserId);
  if (from === null) return false;
  // Still ringing, unanswered — the reported case.
  if (idOf(o.incomingFrom) === from) return true;
  // In a direct call with them. Room calls are not ended this way: a room
  // call has many peers and one leaving is not the call ending.
  if (typeof o.mode === 'string' && o.mode.startsWith('dm')) {
    const peer = idOf(o.peerId);
    return peer === null || peer === from;
  }
  return false;
}

/**
 * How long this phone rings before giving up on its own.
 *
 * A backstop, not the normal path: normally the caller gives up after 45s and
 * sends `call_end`. But if their app is killed, or their network drops, that
 * event never comes — and with nothing here to stop it the phone rang until
 * somebody noticed. Longer than the caller's 45s so the ordinary ending still
 * wins and this only fires when something has genuinely gone wrong.
 */
export const RING_TIMEOUT_MS = 60000;

function idOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
