// ── "It doesn't pick, but as a file it's OK" ────────────────────────────────
//
// Reported as: picking a 150 MB video from the gallery as a VIDEO does
// nothing, while the same video attached as a FILE works.
//
// That is not a guess about the picker; it is what the picker does. In
// expo-image-picker 15's Android source, MediaHandler.handleVideo is:
//
//     val outputFile = createOutputFile(cacheDirectory, ".mp4")
//     copyFile(sourceUri, outputFile, context.contentResolver)
//     ... MediaMetadataRetriever().setDataSource(context, outputUri)
//
// Every picked video is copied, byte for byte, into the app's cache directory
// before the JavaScript side ever sees it. A 150 MB video needs 150 MB of free
// space and a full read-and-write of the file. On the phone that reported
// this, the app was holding nine gigabytes of its own rubbish — see
// src/storage.ts — so there may well not have been room for it.
//
// When that copy fails the module rejects, and launchImageLibraryAsync was
// awaited with no try/catch anywhere around it. The rejection went nowhere,
// nothing was added to the composer, and no message was shown. "It doesn't
// pick" is exactly right: the app had decided not to, and did not say so.
//
// Why the file route survives is NOT established here. It copies too, so the
// honest statement is the user's: that route worked on this file and the
// gallery one did not. It is offered on that evidence, not on a theory.
//
// So: make room before picking, say something when it fails, and offer the
// route that is known to work. The decisions are here; the picker calls are
// in ChatScreen.

/**
 * Free space below which a copy of a video is unlikely to succeed.
 *
 * Not a size check on the file: the picker throws before it says how big the
 * thing was, so at the moment this question is asked the file's size is not
 * available and never will be. What IS known is how much room the phone has,
 * and 64 MB is below the size of the video that prompted this by a factor of
 * two — so a phone under it is short of space by any reading.
 */
export const HEADROOM_BYTES = 64 * 1024 * 1024;

/**
 * Is the phone short enough of space to name that as the cause?
 *
 * Unknown means NO. Free space fails to report on plenty of devices, and
 * telling somebody their phone is full on the strength of a number that never
 * arrived would send them deleting photos over a problem they do not have.
 */
export function spaceLooksTight(freeBytes?: number | null): boolean {
  const free = Number(freeBytes);
  if (!Number.isFinite(free) || free <= 0) return false;
  return free < HEADROOM_BYTES;
}

export type PickFailure = {
  /** What to put in the alert's title. */
  title: string;
  /** What to put in its body — in the user's terms, never the library's. */
  body: string;
  /** Whether to offer the document picker, which is known to work. */
  offerFileRoute: boolean;
};

/**
 * What to tell somebody whose video did not come in.
 *
 * Never the exception's own text. "FailedToWriteFileException" names the
 * library's problem, not the user's, and these users read Persian and Kurdish
 * — an English stack trace is the same as silence, except ruder.
 */
export function failureMessage(o: {
  error?: any; outOfSpace?: boolean; isVideo?: boolean;
}): PickFailure {
  const raw = String(o?.error?.message || o?.error || '');
  const spaceProblem = !!o?.outOfSpace
    || /space|ENOSPC|write|storage/i.test(raw);

  if (spaceProblem) {
    return {
      title: 'Not enough space',
      body: 'Your phone needs room to copy this video before it can be sent. '
        + 'Free some space, then try again — or attach it with the 📎 file '
        + 'button, which is the route that worked before.',
      offerFileRoute: true,
    };
  }
  return {
    title: o?.isVideo === false ? 'Could not open that' : 'Could not open that video',
    body: 'The gallery could not hand this one over. Attaching it with the 📎 '
      + 'file button usually works, and sends the same video.',
    offerFileRoute: true,
  };
}
