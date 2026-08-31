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
      await Audio.setAudioModeAsync(RECORD_MODE);
      const rec = new Audio.Recording();
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
  const rec = warm;
  warm = null;
  warmAt = null;
  if (!rec) return;
  try { await rec.stopAndUnloadAsync(); } catch {}
  try { await Audio.setAudioModeAsync(PLAYBACK_MODE); } catch {}
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
  const now = Date.now();
  let rec: Audio.Recording | null = null;
  if (warm && warmStillGood({ preparedAt: warmAt, now })) {
    rec = warm;
    warm = null;
    warmAt = null;
  } else {
    // A stale warm-up is thrown away rather than started: it has been holding
    // the microphone for long enough that the session may have moved on.
    await cool();
    await Audio.setAudioModeAsync(RECORD_MODE);
    rec = new Audio.Recording();
    await rec.prepareToRecordAsync(OPTIONS);
  }
  await rec.startAsync();
  // Not assumed: on a device that refused the microphone, startAsync can
  // resolve on a recorder that never begins. The caller keeps showing
  // "starting" until this says otherwise.
  return { recording: rec };
}

/** Hand the audio session back to playback. */
export async function releaseSession(): Promise<void> {
  try { await Audio.setAudioModeAsync(PLAYBACK_MODE); } catch {}
}
