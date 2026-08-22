// ── Sending a file: the part that can be wrong ───────────────────────────────
//
// Reported as: "when uploading files, sometimes it takes too long — the upload
// progress should be there with pause and cancel buttons."
//
// A bar creeping along with no numbers, no way to stop it and no way to put it
// off until later is the worst version of a slow upload: the user cannot tell
// whether it is moving, cannot get on with anything else, and cannot give up
// without force-quitting.
//
// Pause is the part that decides the design. expo-file-system's UploadTask can
// be CANCELLED but not paused — pausing a whole-file POST would mean throwing
// away everything sent so far, which on a 60 MB video over a bad connection is
// not a pause, it is a defeat. So the file goes up in chunks against a server
// session that remembers how many bytes it already holds. Pausing stops after
// the current chunk; resuming asks the server where it got to and carries on.
// The same machinery survives a dropped connection, an app restart, and a
// train going into a tunnel.
//
// The arithmetic and the state rules live here, away from the network and the
// pixels, because they are what silently corrupts a file if they are wrong.

/**
 * Bytes per chunk.
 *
 * A compromise. Bigger chunks mean fewer round trips, which matters on a slow
 * link; smaller chunks mean pause takes effect sooner and less is re-sent when
 * one fails. At 512 KB a pause lands within a chunk even on a poor connection,
 * and a re-sent chunk costs half a megabyte at worst.
 */
export const CHUNK_BYTES = 512 * 1024;

/** Matches the server's own limit; checked here so the failure is immediate. */
export const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

/** Slow work that happens before a byte is sent. */
export type Stage = 'processing' | 'uploading';

export type Phase =
  | 'processing'   // re-encoding a video, compressing a photo
  | 'uploading'
  | 'paused'
  | 'failed'
  | 'done'
  | 'cancelled';

// ── One bar for two stages ───────────────────────────────────────────────────

/** The share of the bar given to re-encoding when there is any. */
export const PROCESSING_SHARE = 0.4;

function clamp01(n: number): number {
  if (!isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Where the single progress bar should be, 0..100.
 *
 * Transcoding and uploading are two different waits and the user only sees one
 * bar, so they share it. When there is no transcoding — a photo, a document,
 * a video sent as-is — the upload gets the whole bar rather than starting at
 * 40%, which would have looked like a bar that begins already part-done.
 */
export function overallPercent(o: {
  stage: Stage; fraction: number; hasProcessing: boolean;
}): number {
  const f = clamp01(o.fraction);
  if (!o.hasProcessing) return Math.round(f * 100);
  return o.stage === 'processing'
    ? Math.round(f * PROCESSING_SHARE * 100)
    : Math.round((PROCESSING_SHARE + f * (1 - PROCESSING_SHARE)) * 100);
}

// ── Chunking ─────────────────────────────────────────────────────────────────

/** The next slice to send, or null when the whole file is up. */
export function chunkRange(
  offset: number, total: number, chunk = CHUNK_BYTES,
): { start: number; end: number } | null {
  if (!(total > 0) || !(chunk > 0)) return null;
  const start = Math.max(0, Math.min(offset, total));
  if (start >= total) return null;
  return { start, end: Math.min(start + chunk, total) };
}

export function chunkCount(total: number, chunk = CHUNK_BYTES): number {
  if (!(total > 0) || !(chunk > 0)) return 0;
  return Math.ceil(total / chunk);
}

/**
 * Where to carry on from when resuming.
 *
 * The SERVER's count wins, always. The phone's idea of how much it sent counts
 * bytes handed to the network stack, not bytes that arrived — after a
 * connection drops mid-chunk those are different numbers, and trusting the
 * phone would append the tail of a chunk the server never received, leaving a
 * hole in the middle of the file. A file with a hole in it uploads
 * "successfully" and is broken, which is far worse than sending half a
 * megabyte twice.
 */
export function resumeOffset(serverOffset: number, total: number): number {
  if (!isFinite(serverOffset) || serverOffset < 0) return 0;
  if (!(total > 0)) return 0;
  return Math.min(Math.floor(serverOffset), total);
}

/** Is the session finished, as far as the byte count goes? */
export function isComplete(offset: number, total: number): boolean {
  return total > 0 && offset >= total;
}

// ── Retrying ─────────────────────────────────────────────────────────────────

export const MAX_ATTEMPTS = 5;

/**
 * Is this failure worth another go?
 *
 * A network error has no status and is exactly the case retrying is for. A
 * 4xx means the server understood and refused — sending the same chunk again
 * will be refused again — except for "too many requests" and "timeout", which
 * are invitations to come back.
 */
export function shouldRetry(attempt: number, status?: number): boolean {
  if (attempt >= MAX_ATTEMPTS) return false;
  if (status === undefined || status === 0) return true;   // network failure
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * How long to wait before attempt n, in milliseconds.
 *
 * Exponential, with jitter. The jitter is not decoration: without it every
 * phone that lost the same connection comes back at the same instant, and the
 * server that was struggling gets the whole crowd at once.
 */
export function retryDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(1000 * Math.pow(2, Math.max(0, attempt)), 30_000);
  return Math.round(base * (0.5 + rand() * 0.5));
}

// ── What the buttons may do ──────────────────────────────────────────────────
//
// Offering a control that does nothing is worse than not offering it, so each
// one is a rule rather than a guess in the middle of a component.

/**
 * Pause applies to uploading only.
 *
 * A transcode cannot be paused — the native encoder offers cancel and nothing
 * else — so showing a pause button during it would be a lie. Cancel is offered
 * throughout, because "this is taking too long" is the whole complaint and
 * there must always be a way out.
 */
export function canPause(phase: Phase): boolean {
  return phase === 'uploading';
}

export function canResume(phase: Phase): boolean {
  return phase === 'paused' || phase === 'failed';
}

export function canCancel(phase: Phase): boolean {
  return phase === 'processing' || phase === 'uploading'
    || phase === 'paused' || phase === 'failed';
}

/** Is anything still going to happen on its own? */
export function isActive(phase: Phase): boolean {
  return phase === 'processing' || phase === 'uploading';
}

// ── Telling the user how it is going ─────────────────────────────────────────

export function formatBytes(n: number): string {
  if (!isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export type Sample = { at: number; sent: number };

/** How far back the speed is measured over. */
export const RATE_WINDOW_MS = 5000;

/**
 * Record where we are, and forget what is too old to be about right now.
 *
 * The window is trimmed to the samples inside it PLUS the one just before,
 * so that a rate can still be worked out when progress has been slow enough
 * that only one report landed in the last few seconds. Dropping that one would
 * make a crawling upload report a speed of zero, which reads as stalled.
 */
export function pushSample(
  samples: Sample[], at: number, sent: number, windowMs = RATE_WINDOW_MS,
): Sample[] {
  const next = samples.concat({ at, sent });
  const cutoff = at - windowMs;
  const firstInside = next.findIndex(s => s.at >= cutoff);
  if (firstInside <= 0) return next;
  return next.slice(firstInside - 1);
}

/**
 * Bytes per second over the recent past.
 *
 * Measured from a moving window rather than from the start, because "it has
 * averaged 200 KB/s since you pressed send" is not what someone whose signal
 * just died wants to be told.
 */
export function rateFrom(samples: { at: number; sent: number }[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const seconds = (last.at - first.at) / 1000;
  const bytes = last.sent - first.sent;
  if (seconds <= 0 || bytes <= 0) return 0;
  return bytes / seconds;
}

/** Seconds left at the current rate, or null when there is nothing to go on. */
export function etaSeconds(sent: number, total: number, bytesPerSec: number): number | null {
  if (!(bytesPerSec > 0) || !(total > 0)) return null;
  const left = total - sent;
  if (left <= 0) return 0;
  return left / bytesPerSec;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds)) return '';
  if (seconds < 1) return 'almost done';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.ceil(seconds % 60)}s left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

/**
 * Can the bar be trusted to move?
 *
 * Until the first byte is reported there is nothing to draw a bar from, and a
 * bar sitting at 0% is a claim — that the upload has started and got nowhere.
 * A spinner claims only that something is happening, which is all that is
 * known. The distinction matters most for the smallest files, where the whole
 * upload is one chunk and there is exactly one report at each end of it.
 */
export function uploadDeterminate(o: {
  phase: Phase; sent: number; total: number;
}): boolean {
  if (o.phase === 'processing') return true;   // transcoding reports properly
  return o.total > 0 && o.sent > 0;
}

/**
 * The line under the progress bar.
 *
 * A percentage on its own does not answer "is this stuck?". The bytes and the
 * speed do, and a stalled upload is then obvious rather than mysterious.
 */
export function statusLine(o: {
  phase: Phase; sent: number; total: number; bytesPerSec: number;
}): string {
  if (o.phase === 'processing') return 'Preparing video…';
  if (o.phase === 'paused') return `Paused · ${formatBytes(o.sent)} of ${formatBytes(o.total)}`;
  if (o.phase === 'failed') return 'Upload failed — tap to retry';
  if (o.phase === 'cancelled') return 'Cancelled';
  if (o.phase === 'done') return '';
  const size = `${formatBytes(o.sent)} / ${formatBytes(o.total)}`;
  // No rate yet — the first chunk has not landed, and a made-up speed would be
  // worse than none.
  if (!(o.bytesPerSec > 0)) return size;
  const eta = formatEta(etaSeconds(o.sent, o.total, o.bytesPerSec));
  return `${size} · ${formatBytes(o.bytesPerSec)}/s${eta ? ` · ${eta}` : ''}`;
}
