// ── Which phone makes which noise ────────────────────────────────────────────
//
// Reported as: the call ringtone should be on the receiver's device, not the
// caller's.
//
// Both ends were playing ring.wav. That file is a RINGTONE — loud, bright, and
// written to be heard from across a room through a pocket — which is exactly
// right for the phone being called and exactly wrong for the phone doing the
// calling, where it is held to an ear and drowns out the moment the other
// person picks up.
//
// The two sounds are different things:
//
//   • the CALLEE hears a ringtone: it has to compete with a room, a pocket and
//     somebody's attention being elsewhere;
//   • the CALLER hears a ringback — the quiet purring tone a telephone network
//     plays down the line to say "it is ringing at the other end". Nobody is
//     supposed to notice a ringback, only its absence when the call connects.
//
// Mirrored by public/js/callTones.js, compared function by function in
// test/callTones.test.js.

export type Tone = 'ringtone' | 'ringback' | null;

/**
 * What this device should play, given which end of the call it is.
 *
 * `connected` silences both: a tone that survives the answer is the complaint
 * behind half the call bugs in this file's history.
 */
export function toneFor(o: {
  role: 'caller' | 'callee';
  connected?: boolean;
}): Tone {
  if (!o || o.connected) return null;
  if (o.role === 'callee') return 'ringtone';
  if (o.role === 'caller') return 'ringback';
  return null;
}

/** The file each tone lives in, so neither client can reach for the wrong one. */
export function toneFile(tone: Tone): string {
  if (tone === 'ringtone') return 'ring.wav';
  if (tone === 'ringback') return 'ringback.wav';
  return '';
}

/**
 * How loud, out of 1.
 *
 * The ringback is quiet on purpose: it plays at the earpiece, an inch from an
 * ear, and it is there to be heard under somebody's attention rather than for
 * it. The ringtone is louder but not full — it comes out of the loudspeaker,
 * where the tone was written to be heard across a room.
 */
export function toneVolume(tone: Tone): number {
  if (tone === 'ringtone') return 0.5;
  if (tone === 'ringback') return 0.35;
  return 0;
}

/** Both tones repeat until something stops them. */
export function toneLoops(tone: Tone): boolean {
  return tone === 'ringtone' || tone === 'ringback';
}

// ── A tone that arrives after it was cancelled ───────────────────────────────
//
// Reported as: the ringing is still sounding while the call is in progress, on
// both video and audio calls.
//
// `toneFor` has always answered "no tone once connected", so the rule was
// right and the call still rang. The fault was in the gap between deciding to
// play a sound and the sound existing.
//
// Loading a tone is asynchronous — the file has to be read and decoded — and
// the sound is created already playing. Stopping the ring in the meantime does
// what it can: it silences whatever is currently loaded. But when the load
// finishes a moment later it hands back a sound that is ALREADY MAKING A NOISE
// and stores it as the current one. Nothing stops it after that, because the
// thing that would have stopped it has already run.
//
// The window is small, and it is open at exactly the two moments that matter:
//
//   • the callee taps Accept in the second after the phone starts ringing;
//   • the caller's ringback is still loading when the other end picks up.
//
// Accepting from the notification shade loses the race every time, because the
// accept is dispatched in the same breath as the ring is started.
//
// So a tone carries the number of the ring it belongs to. Stopping the ring
// moves that number on, and a tone that finishes loading against an old number
// is thrown away instead of stored — which is the only moment anything can
// still silence it.

/**
 * Does a tone that has just finished loading still belong to the current ring?
 *
 * Called with the generation captured BEFORE the load began and the one
 * current now. Anything else means a stop happened while it was loading, and
 * the sound must be discarded rather than kept.
 */
export function toneStillWanted(startedGeneration: number, currentGeneration: number): boolean {
  return Number(startedGeneration) === Number(currentGeneration);
}
