// ── "Dr.Soran is recording…", from somebody who is not even online ─────────
//
// Photographed: a chat showing "is recording…" for a person who had gone.
// Reported as happening for typing too, and for the rest of them.
//
// Every one of these indicators was a LATCH. A name went into a list on
// `user_recording` and came out again on `user_stopped_recording`, and that
// was the entire mechanism:
//
//     setRecordingUsers(prev => [...prev, u]);        // start
//     setRecordingUsers(prev => prev.filter(...));    // stop
//
// So the display was correct only if the stop event always arrived. It does
// not. The sender's app is killed, their socket drops, their phone loses
// signal mid-recording, the process is swiped away — and in every one of those
// cases the last thing anybody heard was "started", which then stands on
// screen for ever. Recording was the worst of the set because it announced
// itself ONCE at the beginning: a two-minute voice note sent one event and
// then nothing until it finished.
//
// The fix is to stop treating these as state and treat them as what they
// actually are: a claim that was true a moment ago. Each one is remembered
// with the time it last arrived, the sender re-sends while it is still true,
// and anything not heard from recently is simply dropped. A lost stop event
// then costs a few seconds of a stale indicator instead of a permanent one,
// and no amount of dying on the sender's side can leave a mark on somebody
// else's screen.

/**
 * How often a sender repeats itself while the thing is still happening.
 *
 * Typing already did this by accident — it re-announces on every keystroke —
 * which is why typing recovered on its own more often than recording did.
 */
export const HEARTBEAT_MS = 3000;

/**
 * How long a claim is believed without being repeated.
 *
 * Comfortably more than two heartbeats, so a single dropped packet or a
 * moment of jitter does not make the indicator flicker, and short enough that
 * a dead sender's mark is gone before anybody wonders about it.
 */
export const EXPIRY_MS = 8000;

/** username -> when we last heard this was true. */
export type Claims = Record<string, number>;

/** Record that somebody is doing the thing, as of now. */
export function note(claims: Claims | null | undefined, name: string, now: number): Claims {
  const out: Claims = { ...(claims || {}) };
  const who = String(name || '').trim();
  if (!who) return out;
  const t = Number(now);
  out[who] = Number.isFinite(t) ? t : 0;
  return out;
}

/** Record that they have stopped — the explicit case, when it does arrive. */
export function drop(claims: Claims | null | undefined, name: string): Claims {
  const out: Claims = { ...(claims || {}) };
  delete out[String(name || '').trim()];
  return out;
}

/**
 * Who is still doing it.
 *
 * A claim with no usable timestamp is dropped rather than kept: `Number(null)`
 * is 0, and a 0 here means "last heard from in 1970", which is the safe
 * direction — an indicator that vanishes early is a great deal better than one
 * that never goes.
 */
export function active(claims: Claims | null | undefined, now: number, expiryMs = EXPIRY_MS): string[] {
  const c = claims || {};
  const t = Number(now);
  if (!Number.isFinite(t)) return [];
  const out: string[] = [];
  for (const name of Object.keys(c)) {
    const at = Number(c[name]);
    if (!Number.isFinite(at) || at <= 0) continue;
    if (t - at < expiryMs) out.push(name);
  }
  return out;
}

/**
 * Is anything still live? Used to decide whether the expiry timer needs to
 * keep running, so an idle chat is not waking up every second for nothing.
 */
export function anyActive(claims: Claims | null | undefined, now: number, expiryMs = EXPIRY_MS): boolean {
  return active(claims, now, expiryMs).length > 0;
}
