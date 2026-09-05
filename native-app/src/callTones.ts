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
