// ── Getting the microphone open before anybody speaks ────────────────────────
//
// The expo-av half of the fix described in recordStart.ts. Kept out of the
// component because the whole point is that it starts BEFORE the component
// exists: the finger going down on the microphone button warms the recorder,
// and the bar that appears a moment later collects one that is already open.
//
// Everything here is safe to call twice, and nothing here throws at the
// caller: a warm-up that fails simply leaves the ordinary path to do the work
// and report the problem.
import { Audio } from 'expo-av';
import { warmStillGood } from './recordStart';

const OPTIONS = { ...Audio.RecordingOptionsPresets.HIGH_QUALITY, isMeteringEnabled: true };

const RECORD_MODE = {
  allowsRecordingIOS: true,
  playsInSilentModeIOS: true,
  staysActiveInBackground: false,
};

export const PLAYBACK_MODE = {
  allowsRecordingIOS: false,
  playsInSilentModeIOS: true,
  staysActiveInBackground: false,
};

let warm: Audio.Recording | null = null;
let warmAt: number | null = null;
let warming: Promise<void> | null = null;
/**
 * Whatever recorder exists right now, warmed up or running.
 *
 * Reported as: "a lot of times, while microphone permission is granted, I
 * still get the recording error, and I have to close and reopen the app."
 *
 * That is expo-av's singleton talking. Only ONE Audio.Recording may be
 * prepared at a time, and the flag saying one exists lives in the module — so
 * a recorder that is prepared and then LOST (its start threw, the screen was
 * left mid-preparation, a warm-up whose owner went away) leaves the library
 * refusing every recording afterwards with an error that names no cause.
 * Killing the app is what clears it, which is exactly what people were doing.
 *
 * So nothing is ever created without being remembered here, and every start
 * begins by releasing whatever is held. A leak now costs one recording rather
 * than every recording until the app is restarted.
 */
let held: Audio.Recording | null = null;

/** Unload whatever recorder exists, whatever state it is in. */
async function releaseHeld(): Promise<void> {
  const rec = held;
  held = null;
  warm = null;
  warmAt = null;
  if (!rec) return;
  try { await rec.stopAndUnloadAsync(); } catch {}
}

/** Do we already hold the microphone permission? Cached, because asking costs a round trip. */
export async function hasPermission(): Promise<boolean> {
  try {
    const { status } = await Audio.getPermissionsAsync();
    return status === 'granted';
  } catch { return false; }
}

/**
 * Open the microphone now, so that starting is instant later.
 *
 * Called from the press-in on the mic button. It does the three slow things —
 * the permission read, the audio-session switch and building the encoder —
 * while the user is still deciding to lift their finger.
 *
 * Deliberately does nothing at all without permission already granted: a
 * permission DIALOG on a press-in, before the user has even completed the tap,
 * would be its own bug.
 */
export async function warmUp(): Promise<void> {
  if (warm || warming) return warming ?? undefined;
  warming = (async () => {
    try {
      if (!(await hasPermission())) return;
      // Anything left over from a previous attempt goes first: preparing a
      // second recorder while one is held is the error people were restarting
      // the app to clear.
      await releaseHeld();
      await Audio.setAudioModeAsync(RECORD_MODE);
      const rec = new Audio.Recording();
      held = rec;                       // remembered BEFORE it can throw
      await rec.prepareToRecordAsync(OPTIONS);
      warm = rec;
      warmAt = Date.now();
    } catch {
      warm = null;
      warmAt = null;
    } finally {
      warming = null;
    }
  })();
  return warming;
}

/** Is a prepared recorder standing by? */
export function isWarm(now = Date.now()): boolean {
  return !!warm && warmStillGood({ preparedAt: warmAt, now });
}

/**
 * Give back a microphone nobody used.
 *
 * A prepared recorder holds the mic open — which shows as the recording
 * indicator on newer Androids and locks other apps out — so a warm-up that was
 * not followed through has to be released.
 */
export async function cool(): Promise<void> {
  const had = !!warm;
  await releaseHeld();
  if (had) { try { await Audio.setAudioModeAsync(PLAYBACK_MODE); } catch {} }
}

export type Started = { recording: Audio.Recording };

/**
 * Start capturing, using the warmed-up recorder when there is one.
 *
 * Resolves only once the recorder has actually started — the caller shows a
 * "starting" state until then, because a bar that says "recording" before this
 * resolves is exactly the reported bug.
 */
export async function begin(): Promise<Started> {
  // FIRST: let any warm-up in flight finish.
  //
  // Reported as "Could not start recording — the microphone is busy", every
  // time, with nothing else using the microphone. The app was fighting itself.
  //
  // warmUp() is fired by the finger LANDING on the microphone button and takes
  // a moment; begin() runs when the finger lifts. If the warm-up has not
  // finished by then, `warm` is still null, so the branch below used to run —
  // releasing the half-prepared recorder out from under the warm-up and
  // preparing a SECOND one. expo-av allows exactly one prepared recorder at a
  // time, so the second throws, and on a slow phone the two are always close
  // enough together for that to happen on every attempt.
  //
  // Waiting costs nothing: the warm-up is the very work begin() would
  // otherwise do, so this is the fast path, not a delay.
  if (warming) { try { await warming; } catch {} }

  const now = Date.now();
  let rec: Audio.Recording | null = null;
  try {
    if (warm && warmStillGood({ preparedAt: warmAt, now })) {
      rec = warm;
      warm = null;                      // no longer "warm", but still `held`
      warmAt = null;
    } else {
      // A stale warm-up is thrown away rather than started: it has been holding
      // the microphone for long enough that the session may have moved on. This
      // also releases a recorder left behind by a previous FAILED attempt.
      await releaseHeld();
      await Audio.setAudioModeAsync(RECORD_MODE);
      rec = new Audio.Recording();
      held = rec;                       // remembered BEFORE it can throw
      await rec.prepareToRecordAsync(OPTIONS);
    }
    await rec.startAsync();
  } catch (e) {
    // EVERY failure gives the slot back, not just a failed start.
    //
    // prepareToRecordAsync used to throw from outside this try, so a recorder
    // that failed to prepare stayed held, expo-av went on believing one was
    // prepared, and every later attempt failed the same way until the app was
    // killed. That is the "it is always there" in the report — one unlucky
    // moment broke recording for the rest of the session.
    await releaseHeld();
    // And hand the audio session back, so the next attempt starts from the
    // same state a fresh launch would.
    try { await Audio.setAudioModeAsync(PLAYBACK_MODE); } catch {}
    throw e;
  }
  // Not assumed: on a device that refused the microphone, startAsync can
  // resolve on a recorder that never begins. The caller keeps showing
  // "starting" until this says otherwise.
  return { recording: rec };
}

/**
 * Done with this recording, however it ended.
 *
 * Called by the bar on stop AND on cancel, so the slot is given back on every
 * path out — including the ones where the file is thrown away.
 */
export async function finish(): Promise<void> {
  await releaseHeld();
  await releaseSession();
}

/** Is a recorder currently held (prepared or running)? */
export function isHeld(): boolean { return !!held; }

/** Hand the audio session back to playback. */
export async function releaseSession(): Promise<void> {
  try { await Audio.setAudioModeAsync(PLAYBACK_MODE); } catch {}
}
