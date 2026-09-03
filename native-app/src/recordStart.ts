// ── The first second of a voice message ──────────────────────────────────────
//
// Reported as: sometimes, on tapping record, the first second or two is empty
// and not recorded.
//
// It is not that the audio is dropped. It is that the app said "recording"
// before it was, and people quite reasonably started talking:
//
//   tap → the recording bar appears, red dot pulsing, timer at 0:00
//        → ask the OS for the microphone permission state
//        → put the audio session into record mode
//        → build an encoder and open the microphone (prepareToRecordAsync)
//        → start                                        ← capture begins HERE
//
// Everything between the first line and the last is asynchronous, and on a
// mid-range Android phone with something else holding audio focus it is
// comfortably one to two seconds. The bar was on screen for all of it. An
// earlier fix moved the TIMER to start after the recorder does, which made the
// duration honest but left the same silent gap at the front, because the thing
// people react to is the bar appearing, not the digits changing.
//
// Two halves, and both are needed:
//
//   • BE HONEST. Until the recorder is actually capturing, the bar says so —
//     no pulsing dot, no timer, a plain "Starting…". Nobody has ever begun
//     talking to a screen that says it is not ready yet.
//   • BE FAST. The slow parts are the permission check, the audio-session
//     switch and the encoder, and none of them depend on the user having
//     decided to speak yet. They can all be done while the finger is still on
//     the microphone button, so that by the time the bar appears the recorder
//     is already open and the honest state lasts no time at all.
//
// The timing rules live here so that both can be tested without a microphone.

export type RecordPhase =
  /** Nothing yet. */
  | 'idle'
  /** Permission, audio session and encoder are being got ready. */
  | 'starting'
  /** The microphone is open and audio is being written. */
  | 'recording'
  | 'paused'
  /** Stopped, with something to listen back to. */
  | 'preview';

/**
 * What the bar should be showing.
 *
 * Driven by what the recorder REPORTS, never by what was asked of it: the
 * whole bug was a UI that described an intention as a fact.
 */
export function phaseFor(o: {
  started: boolean;      // startAsync() has resolved
  isRecording: boolean;  // the recorder says it is capturing
  paused: boolean;
  stopped: boolean;
}): RecordPhase {
  if (o.stopped) return 'preview';
  if (o.paused) return 'paused';
  if (o.started && o.isRecording) return 'recording';
  return 'starting';
}

/** May the user be told, by a pulsing dot and a running clock, that they are being heard? */
export function showsLiveUi(phase: RecordPhase): boolean {
  return phase === 'recording' || phase === 'paused';
}

/**
 * Is there any point sending what has been captured?
 *
 * A recording stopped while it was still starting has no audio in it at all —
 * sending it produces the empty voice message this report is about, only
 * shorter.
 */
export function canStop(phase: RecordPhase): boolean {
  return phase === 'recording' || phase === 'paused';
}

/**
 * The elapsed time to display.
 *
 * Taken from the recorder's own duration rather than counted with a timer.
 * A once-per-second interval drifts, keeps counting through a pause it was not
 * told about, and — the reason it matters here — starts from whenever the
 * JavaScript got round to it rather than from the first captured sample. The
 * number under the waveform should be the length of the audio, exactly.
 */
export function elapsedSeconds(durationMillis: number | null | undefined): number {
  const ms = Number(durationMillis);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 1000);
}

// ── When it will not start ───────────────────────────────────────────────────

export type StartFailure = 'permission' | 'busy' | 'unknown';

/**
 * Why did recording not start?
 *
 * Reported as: "a lot of times, while microphone permission is granted, I
 * still get the recording error, and I have to close and reopen the app."
 *
 * The dialog said "Please check microphone permissions in Settings" for EVERY
 * failure, so somebody who had already granted the microphone was sent to look
 * at a setting that was already correct — and the real cause, a recorder left
 * prepared by a previous attempt, was never mentioned.
 */
export function classifyStartFailure(o: {
  granted: boolean; message?: string | null;
}): StartFailure {
  if (!o.granted) return 'permission';
  const m = String(o.message || '').toLowerCase();
  // expo-av's own words when its single recording slot is already taken, and
  // Android's when something else holds the microphone.
  if (/only one recording|already prepared|prepare|in use|busy|unavailable/.test(m)) return 'busy';
  return 'unknown';
}

export function startFailureText(kind: StartFailure): string {
  switch (kind) {
    case 'permission':
      return 'ChatRoom needs permission to use the microphone. Open Settings → Apps → '
        + 'ChatRoom → Permissions and allow Microphone.';
    case 'busy':
      return 'The microphone is busy — a call, or another app, is still using it. '
        + 'Tap the microphone again in a moment.';
    default:
      return 'The recording could not be started. Tap the microphone to try again.';
  }
}

/** Is trying again immediately worth offering? */
export function offersRetry(kind: StartFailure): boolean {
  return kind !== 'permission';
}

// ── Warming up ───────────────────────────────────────────────────────────────

/**
 * How long a prepared recorder may sit unused.
 *
 * It holds the microphone open, which shows as the recording indicator on
 * newer Androids and stops other apps using it — so a warm-up nobody followed
 * through on has to be given back, and quickly enough that a user who thought
 * better of it is not left with a live microphone.
 */
export const WARM_TTL_MS = 8000;

export function warmStillGood(o: {
  preparedAt: number | null | undefined;
  now: number;
  ttlMs?: number;
}): boolean {
  if (!o.preparedAt) return false;
  const age = o.now - o.preparedAt;
  return age >= 0 && age <= (o.ttlMs ?? WARM_TTL_MS);
}

/**
 * Is warming up on a touch worth doing at all?
 *
 * Only when the microphone is what that touch is going to open. Preparing an
 * encoder because somebody brushed the send button would take the microphone
 * from a call or a playing voice message for no reason.
 */
export function shouldWarm(o: {
  target: 'mic' | 'send' | 'other';
  alreadyWarm: boolean;
  recording: boolean;
}): boolean {
  return o.target === 'mic' && !o.alreadyWarm && !o.recording;
}
