// ── What the player's state means for the UI ─────────────────────────────────
//
// Turning a react-native-track-player state into the three things the app
// actually shows: is it playing, is it still starting up, and has the session
// ended. It lives here, away from the manager, because the rules are timing
// rules — the kind that are impossible to check on a device and easy to get
// wrong twice, which is what happened.
//
// The two bugs this encodes the fix for, both of which left a voice message
// audibly playing while its bubble showed ▶:
//
//  1. Starting a track calls TrackPlayer.reset(), and the service reports that
//     as Stopped/None. Taking that at face value meant our OWN reset looked
//     exactly like the user pressing Stop in the notification shade, so the
//     manager forgot which message was playing a moment before it started
//     playing it. Whether the event landed before or after start-up finished
//     is not deterministic — hence a bug that only happened sometimes.
//
//  2. Immediately after calling play(), the player usually reports Ready or
//     Buffering rather than Playing. Writing that straight into `playing`
//     turned the icon back to ▶, and since the real Playing event had often
//     already been delivered and applied, nothing ever arrived to correct it.
//
// Both are the same mistake: treating a state seen DURING start-up as the
// settled truth. So start-up is passed in explicitly, and while it is running
// the transient states mean "still starting", never "stopped" or "paused".

export type TrackState =
  | 'none' | 'ready' | 'playing' | 'paused' | 'stopped'
  | 'buffering' | 'loading' | 'connecting' | 'ended' | 'error';

export type PlaybackFlags = {
  playing: boolean;
  loading: boolean;
  /** The session is genuinely over: forget which message was playing. */
  clearCurrent: boolean;
};

/** States that mean "on its way to playing", not "not playing". */
const STARTING: TrackState[] = ['loading', 'buffering', 'connecting'];

/**
 * @param state        what the player reports
 * @param starting     true while we are inside our own start-up sequence
 *                     (between reset() and play() having taken effect)
 */
export function playbackFlags(state: TrackState, starting: boolean): PlaybackFlags {
  if (state === 'error') {
    return { playing: false, loading: false, clearCurrent: false };
  }

  // During start-up, everything short of a definite stop is start-up noise.
  // In particular `none` and `stopped` here are OUR reset, not the user's.
  if (starting && state !== 'playing' && state !== 'paused' && state !== 'ended') {
    return { playing: false, loading: true, clearCurrent: false };
  }

  return {
    playing: state === 'playing',
    loading: STARTING.includes(state),
    // Only a stop we did not cause ends the session.
    clearCurrent: !starting && (state === 'none' || state === 'stopped'),
  };
}
