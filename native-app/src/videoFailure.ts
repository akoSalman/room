// ── Why a video would not play ──────────────────────────────────────────────
//
// Reported twice, from both ends: a video received a moment ago will not play
// after downloading, and a video just sent will not play after uploading.
//
// The server was measured and cleared. Every video on it is structurally
// complete — the boxes tile each file exactly — and every chunk offset in
// every track points inside the media, which is the other way a sound-looking
// MP4 can be unplayable. The files are good. And the sender's own copy is a
// byte-for-byte copy of what was uploaded, so both ends are looking at the
// same good bytes.
//
// Which leaves the player, and the player was throwing the answer away:
//
//     onError={() => setFailed(true)}
//
// ExoPlayer says WHY — a decoder that would not initialise, a source it could
// not read, a format it does not support — and all of it went in the bin,
// leaving "Couldn't play this video" and no way to tell those apart. That is
// the whole reason this has taken two rounds of guessing.
//
// So the reason is kept and shown. It has to be cleaned first, which is what
// this file is for.

/**
 * The reason, fit to put on a screen.
 *
 * NOTHING THAT IDENTIFIES ANYTHING. ExoPlayer's message routinely contains the
 * URI it was reading, and a media URL here carries a signature and the
 * viewer's id in its query — so pasting the raw message onto the screen would
 * put a working credential in front of the camera every time somebody
 * photographs the error for me. Anything URL- or path-shaped is removed before
 * the text is used, not when it is displayed, so there is one place to get it
 * right.
 */
export function playbackReason(err: unknown): string {
  const raw = textOf(err);
  if (!raw) return '';
  const clean = raw
    // Whole URLs, with or without a query.
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S*/g, '…')
    // Bare absolute paths, which is what a local file error carries.
    .replace(/(?:^|\s)\/\S+/g, ' …')
    // A run long enough to be a signature or an id, wherever it sits.
    .replace(/[A-Fa-f0-9]{16,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
  // Long enough to name the fault, short enough to read on a phone and to be
  // legible in a photograph of one.
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}

/** Whatever shape the error arrived in, as text. */
function textOf(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    // React Native rejections are plain Errors whose `name` is just "Error",
    // so the message is the only part worth reading.
    for (const k of ['message', 'error', 'reason', 'description']) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  }
  return String(err);
}

/**
 * What the reason means, in one line, when it is one of the few that have a
 * plain explanation.
 *
 * Deliberately short of a diagnosis: a wrong explanation is worse than none,
 * and these are the only families where the mapping is not a guess.
 */
export function failureHint(reason: string): string {
  const r = (reason || '').toLowerCase();
  if (!r) return '';
  if (/decoder|mediacodec|codec/.test(r)) return 'This phone could not decode it.';
  if (/source|unable to connect|timed? ?out|network|http|404|403/.test(r)) {
    return 'The file could not be read.';
  }
  if (/unsupported|malformed|container|parser|unexpected end/.test(r)) {
    return 'The file is not in a format it can read.';
  }
  return '';
}
