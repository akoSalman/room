// ── Where an upload's progress lives ─────────────────────────────────────────
//
// Outside React, with one subscription per message.
//
// It used to be a `uploadProgress` object in ChatScreen's state, listed in the
// message list's `extraData`. Every progress report — and there are hundreds
// during a video transcode, one per decoded frame — re-rendered every mounted
// row in the chat. That is not just wasted work: it competes with the encoder
// for the same CPU, on the same phone, which is a real part of why "processing
// videos takes too long".
//
// Here a report reaches exactly the bubble it belongs to. The rest of the chat
// does not hear about it.
import {
  Phase, Sample, Stage, overallPercent, pushSample, rateFrom,
} from './uploadSession';

/** Everything one uploading bubble needs to draw itself. */
export type UploadView = {
  phase: Phase;
  /** 0..100 across both stages. */
  percent: number;
  sent: number;
  total: number;
  bytesPerSec: number;
  /** Whether this send has a transcode in front of it, for the shared bar. */
  hasProcessing: boolean;
};

/** What the buttons on the bubble call. */
export type UploadControls = {
  pause?: () => void;
  resume?: () => void;
  cancel?: () => void;
};

type Listener = (v: UploadView | null) => void;

const views = new Map<string, UploadView>();
const controls = new Map<string, UploadControls>();
const samples = new Map<string, Sample[]>();
const listeners = new Map<string, Set<Listener>>();

function emit(id: string) {
  const set = listeners.get(id);
  if (!set) return;
  const v = views.get(id) || null;
  set.forEach(fn => { try { fn(v); } catch {} });
}

export function get(id: string): UploadView | null {
  return views.get(id) || null;
}

export function subscribe(id: string, fn: Listener): () => void {
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(id);
  };
}

/** Begin tracking a send. `hasProcessing` fixes how the bar is shared. */
export function begin(id: string, hasProcessing: boolean) {
  views.set(id, {
    phase: hasProcessing ? 'processing' : 'uploading',
    percent: 0, sent: 0, total: 0, bytesPerSec: 0, hasProcessing,
  });
  samples.delete(id);
  emit(id);
}

/** Progress within the current stage, 0..1. */
export function report(
  id: string, stage: Stage, fraction: number, sent = 0, total = 0,
  // Injectable so the speed calculation can be tested; nothing passes it.
  now: number = Date.now(),
) {
  const cur = views.get(id);
  if (!cur) return;
  // A paused or cancelled send must not be dragged back to "uploading" by a
  // report from a request that was already in the air when the button was
  // pressed. The button is the user's decision; a late packet is not.
  if (cur.phase === 'paused' || cur.phase === 'cancelled' || cur.phase === 'done') return;

  let bytesPerSec = cur.bytesPerSec;
  if (stage === 'uploading' && sent > 0) {
    const next = pushSample(samples.get(id) || [], now, sent);
    samples.set(id, next);
    bytesPerSec = rateFrom(next);
  }
  views.set(id, {
    ...cur,
    phase: stage === 'processing' ? 'processing' : 'uploading',
    percent: overallPercent({ stage, fraction, hasProcessing: cur.hasProcessing }),
    sent: sent || cur.sent,
    total: total || cur.total,
    bytesPerSec,
  });
  emit(id);
}

export function setPhase(id: string, phase: Phase) {
  const cur = views.get(id);
  if (!cur) return;
  views.set(id, { ...cur, phase, ...(phase === 'paused' ? { bytesPerSec: 0 } : {}) });
  // A pause makes the speed meaningless; keeping the last one on screen would
  // claim an upload is moving while it sits still.
  if (phase === 'paused') samples.delete(id);
  emit(id);
}

export function attach(id: string, c: UploadControls) {
  controls.set(id, { ...controls.get(id), ...c });
}

export function pause(id: string) {
  controls.get(id)?.pause?.();
  setPhase(id, 'paused');
}

export function resume(id: string) {
  setPhase(id, 'uploading');
  controls.get(id)?.resume?.();
}

export function cancel(id: string) {
  controls.get(id)?.cancel?.();
  setPhase(id, 'cancelled');
}

/** Done with, one way or another. */
export function finish(id: string) {
  views.delete(id);
  controls.delete(id);
  samples.delete(id);
  emit(id);
  listeners.delete(id);
}

/** Only for tests. */
export function _reset() {
  views.clear(); controls.clear(); samples.clear(); listeners.clear();
}
