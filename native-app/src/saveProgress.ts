// ── Saving something to the device, and saying so while it happens ──────────
//
// Reported as: tapping Download does nothing for a couple of seconds, and then
// "file saved to device" appears. For anything bigger than a photo that is
// long enough to assume the tap missed — so people tap again, and a 40 MB
// video downloads twice.
//
// Two things were missing: any sign that it had started, and any sign of how
// far along it was. Both are here, outside React, for the same reason upload
// progress is: a download reports many times a second, and routing that
// through the screen's state would re-render every row in the chat — every
// photo, video and map — for each tick.
//
// The percentages and wording live here too, where they can be tested. A
// progress indicator that is wrong is worse than none: it is a promise about
// how long this will take.

export type SaveState = {
  /** Which item of how many — galleries save several files in one go. */
  index: number;
  total: number;
  /** Bytes of the CURRENT file. 0 when the server did not say. */
  written: number;
  bytes: number;
  /** Set once it is over, so the overlay can say what happened. */
  done?: 'saved' | 'failed' | 'cancelled';
  /**
   * The user has asked for this to stop.
   *
   * A flag rather than a straight abort: the download itself lives in the
   * screen, which checks this between files and hands it to the task in
   * flight. Asked for as a cross on the progress — a forty-megabyte video
   * started by a mistaken tap otherwise has to be waited out.
   */
  cancelling?: boolean;
};

type Listener = (s: SaveState | null) => void;

let current: SaveState | null = null;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach(fn => { try { fn(current); } catch {} });
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function get(): SaveState | null {
  return current;
}

/** Starting: shown immediately, so the tap is visibly acknowledged. */
export function begin(total = 1) {
  current = { index: 0, total, written: 0, bytes: 0 };
  emit();
}

export function advance(index: number) {
  if (!current) return;
  current = { ...current, index, written: 0, bytes: 0 };
  emit();
}

export function report(written: number, bytes: number) {
  if (!current || current.done) return;
  current = { ...current, written, bytes };
  emit();
}

/**
 * Over. The result stays on screen briefly rather than vanishing at the
 * instant it finishes — an indicator that disappears the moment the work ends
 * leaves the user unsure whether it worked.
 */
export function finish(result: 'saved' | 'failed' | 'cancelled') {
  if (!current) return;
  current = { ...current, done: result };
  emit();
}

export function clear() {
  current = null;
  emit();
}

/** The user pressed the cross. Whoever is downloading checks this. */
export function requestCancel() {
  if (!current || current.done) return;
  current = { ...current, cancelling: true };
  emit();
}

/** Has it been asked to stop? Read by the download loop between files. */
export function isCancelling(): boolean {
  return !!(current && current.cancelling);
}

/** Is there anything to cancel — i.e. should the cross be offered at all? */
export function canCancel(s: SaveState | null): boolean {
  return !!s && !s.done && !s.cancelling;
}

/** Only for tests. */
export function _reset() { current = null; listeners.clear(); }

// ── What the overlay shows ──────────────────────────────────────────────────

/**
 * 0..100 across the WHOLE job, not just the file in flight.
 *
 * A gallery of ten photos that showed each file's own percentage would run
 * 0–100 ten times over, which reads as ten separate downloads rather than one
 * that is a tenth done.
 */
export function overallPercent(s: SaveState | null): number {
  if (!s) return 0;
  const total = Math.max(1, s.total);
  const withinFile = s.bytes > 0 ? Math.min(1, Math.max(0, s.written / s.bytes)) : 0;
  return Math.round(((s.index + withinFile) / total) * 100);
}

/**
 * Whether the bar can be trusted to move.
 *
 * A server that sends no Content-Length gives no total, and a bar frozen at 0
 * looks like a download that has stalled. A spinner is honest about not
 * knowing.
 */
export function isDeterminate(s: SaveState | null): boolean {
  return !!s && (s.bytes > 0 || s.total > 1);
}

export function saveLabel(s: SaveState | null): string {
  if (!s) return '';
  if (s.done === 'saved') return s.total > 1 ? `${s.total} files saved` : 'Saved to your device';
  if (s.done === 'failed') return 'Could not save';
  // Said in the past tense, and NOT as a failure: stopping something on
  // purpose is not the same as it going wrong, and the ⚠ that "Could not
  // save" carries would read as an error the user did not cause.
  if (s.done === 'cancelled') return 'Download stopped';
  if (s.cancelling) return 'Stopping…';
  if (s.total > 1) return `Saving ${Math.min(s.index + 1, s.total)} of ${s.total}…`;
  return 'Saving…';
}
