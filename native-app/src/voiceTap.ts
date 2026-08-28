// ── What a tap on a voice message does ───────────────────────────────────────
//
// Asked for as: tapping everywhere on the voice message itself should play or
// pause it, and outside of the message should still pop up the menu.
//
// Before this, only the small round ▶ was live. The rest of the bubble — the
// waveform, the duration, the space around them — was a dead zone: a tap there
// was swallowed by the bubble and did nothing at all, so playing a voice
// message meant hitting a 36-pixel target, and missing it felt like the app
// had ignored you. Every other messenger plays from anywhere on the row.
//
// One region keeps its own meaning, and it is the reason this is a rule rather
// than an `onPress` on the container:
//
//   the waveform is a TIMELINE while the message is the one playing. Tapping
//   at two-thirds along means "go there", and turning that into pause/play
//   would take away the only way to skip back over a word you missed.
//
//   Before it is playing, the waveform is a picture. There is no position to
//   seek to and no sound to seek in, so a tap there means what a tap anywhere
//   else on the bubble means: start it.
//
// Select mode outranks everything: when the chat is picking messages, a tap
// picks this message. Playing a voice message while trying to forward six of
// them is how you end up listening to somebody's voice by accident.

export type VoiceRegion =
  /** The round play/pause button. */
  | 'button'
  /** The bars. */
  | 'waveform'
  /** The ×1 / ×1.5 / ×2 button. */
  | 'speed'
  /** Anywhere else inside the bubble: the duration, the padding, the gaps. */
  | 'elsewhere';

export type VoiceTapAction = 'toggle' | 'seek' | 'speed' | 'select';

export function tapAction(o: {
  region: VoiceRegion;
  /** Is this the message the audio player currently has loaded? */
  isCurrent: boolean;
  selectMode?: boolean;
}): VoiceTapAction {
  if (o.selectMode) return 'select';
  if (o.region === 'speed') return 'speed';
  // A timeline only while there is something on it.
  if (o.region === 'waveform' && o.isCurrent) return 'seek';
  return 'toggle';
}

/**
 * Does a tap here still need the menu to be reachable?
 *
 * Yes, everywhere — which is the whole reason the bubble keeps its long-press.
 * A voice message you can play but cannot reply to, forward or delete is worse
 * than one you have to aim at.
 */
export function longPressOpensMenu(_region: VoiceRegion): boolean {
  return true;
}

/**
 * Where along the message a seek lands, as a fraction.
 *
 * Clamped, because a drag that leaves the waveform on either side must stop at
 * the ends rather than wrapping or throwing the position away.
 */
export function seekFraction(x: number, width: number): number {
  if (!width || !isFinite(x) || !isFinite(width)) return 0;
  return Math.min(1, Math.max(0, x / width));
}
