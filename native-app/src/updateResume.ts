// ── Keeping an update download across a change of network ────────────────────
//
// Reported as: while the update is downloading, changing the internet
// connection stops it, and the user has to start again from scratch.
//
// The download already used expo-file-system's DownloadResumable and already
// wrote a snapshot when it failed — so on the face of it it should have
// resumed. It did not, for a reason worth writing down:
//
//   `savable()` only carries `resumeData` if the task was PAUSED. A task that
//   died of a network error has none, and a DownloadResumable rebuilt without
//   resumeData quietly starts again at byte zero. The snapshot looked like
//   insurance and was a receipt for nothing.
//
// So the fix is to pause DELIBERATELY the moment the connection goes, while
// the task is still alive and can hand back a real offset — and to resume by
// itself when the network comes back, because a forty-megabyte download over a
// connection like these users have is not something to ask somebody to
// shepherd.
//
// The rules live here, away from the filesystem and the notification shade.

export type DownloadPhase = 'idle' | 'downloading' | 'paused' | 'failed' | 'done';

/**
 * What the network changing means for a download.
 *
 * Losing the connection pauses rather than fails: nothing is wrong with the
 * bytes already on disk, and calling it a failure invites the user to start
 * over, which is the very thing being complained about.
 */
export function phaseOnNetworkChange(phase: DownloadPhase, online: boolean): DownloadPhase {
  if (!online) return phase === 'downloading' ? 'paused' : phase;
  // Coming back: only something we paused OURSELVES resumes on its own. A
  // failure has a cause we do not know, and retrying it on every flicker of
  // signal would be a loop nobody asked for.
  return phase === 'paused' ? 'downloading' : phase;
}

/** Should the download pick itself back up right now? */
export function shouldAutoResume(o: {
  phase: DownloadPhase; online: boolean; hasSnapshot: boolean;
}): boolean {
  return o.phase === 'paused' && o.online && o.hasSnapshot;
}

export type Snapshot = {
  url?: string;
  fileUri?: string;
  options?: any;
  resumeData?: string | null;
};

/** Is this snapshot about the file we are being asked for? */
export function snapshotMatches(snap: Snapshot | null | undefined, url: string): boolean {
  return !!(snap && snap.url && url && snap.url === url && snap.fileUri);
}

/**
 * Will resuming this snapshot actually continue, or silently start again?
 *
 * The difference matters to what the user is told. Promising "it will carry
 * on" and then spending their data from zero is worse than saying nothing.
 */
export function canContinue(snap: Snapshot | null | undefined): boolean {
  return !!(snap && typeof snap.resumeData === 'string' && snap.resumeData.length > 0);
}

/**
 * How far along, as a fraction, or null when nobody can say.
 *
 * Reported as: the update shows no progress at all and then, after a while,
 * the install dialog appears.
 *
 * A download only knows a PERCENTAGE if something told it how big the file is,
 * and `totalBytesExpectedToWrite` is -1 whenever the response arrives without
 * a length — which is every chunked or re-encoded response, and every proxy
 * that decides to stream. The bar was then driven by a number that never
 * changed, so a forty-megabyte download looked like nothing happening.
 *
 * The manifest already says how big the build is, so that is used when the
 * response will not say. And when NEITHER knows, this returns null rather than
 * a made-up 0 — the caller shows the bytes so far instead, which is still a
 * sign of life.
 */
export function fractionOf(o: {
  written: number; expected?: number | null; declared?: number | null;
}): number | null {
  const written = Number(o.written);
  if (!Number.isFinite(written) || written < 0) return null;
  const total = [o.expected, o.declared]
    .map(v => Number(v))
    .find(v => Number.isFinite(v) && v > 0);
  if (!total) return null;
  return Math.max(0, Math.min(1, written / total));
}

/** Bytes as something a person can read. */
export function humanBytes(n: number): string {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '0 MB';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the button and the line under it should say. */
export function statusLine(o: {
  phase: DownloadPhase; percent: number; online: boolean; canContinue: boolean;
  /** Bytes on disk, used when no percentage can be known. */
  written?: number;
  /** False when the percentage is a guess at nothing. */
  knowsTotal?: boolean;
}): string {
  const unknown = o.knowsTotal === false;
  switch (o.phase) {
    case 'downloading':
      // Never "0%" forever: with no size to measure against, what IS known is
      // how much has arrived, and that moves.
      return unknown
        ? `Downloading update… ${humanBytes(o.written || 0)}`
        : `Downloading update… ${Math.round(o.percent)}%`;
    case 'paused':
      if (unknown) {
        return o.online
          ? `Paused at ${humanBytes(o.written || 0)} — continuing…`
          : o.canContinue
            ? `Waiting for a connection — will continue from ${humanBytes(o.written || 0)}`
            : 'Waiting for a connection — will start again when it returns';
      }
      return o.online
        ? `Paused at ${Math.round(o.percent)}% — continuing…`
        : o.canContinue
          // The honest promise, and the reason the pause exists at all.
          ? `Waiting for a connection — will continue from ${Math.round(o.percent)}%`
          : 'Waiting for a connection — will start again when it returns';
    case 'failed':
      return 'Download failed — tap to try again';
    case 'done':
      return 'Downloaded';
    default:
      return '';
  }
}

/** Is there anything for the user to do about it? */
export function needsTap(phase: DownloadPhase): boolean {
  // A pause resolves itself when the network returns; a failure does not.
  return phase === 'failed';
}
