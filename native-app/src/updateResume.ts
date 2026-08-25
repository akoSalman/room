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

/** What the button and the line under it should say. */
export function statusLine(o: {
  phase: DownloadPhase; percent: number; online: boolean; canContinue: boolean;
}): string {
  switch (o.phase) {
    case 'downloading':
      return `Downloading update… ${Math.round(o.percent)}%`;
    case 'paused':
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
