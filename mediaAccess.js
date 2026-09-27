// ── Who may fetch a photo, a video, a voice note or a file ─────────────────
//
// Asked for as: nobody should see files or images they do not have access to,
// on the server or in any client.
//
// What was there before, stated by its own comment in server.js:
//
//     "Access is therefore decided when the message is DELIVERED — which
//      already only happens for rooms the user can see — and the link stops
//      working soon after, rather than never."
//
// That is an honest description of a BEARER TOKEN. A signed url proves only
// that somebody, once, was allowed to be given it. It does not say who is
// asking now. So:
//
//   • forward the url to anyone, in any app, and they get the file — no
//     account needed at all;
//   • leave a private room and every url you kept still works;
//   • "delete for everyone" removes the row, not the bytes;
//   • and because send_message accepted any `filePath` string, a fresh
//     signature could be minted for ANY filename on the server just by
//     posting a message that pointed at it.
//
// This module holds the rules that replace it. Two changes carry the weight:
//
//   1. A SIGNATURE NAMES ITS VIEWER. The url carries `u=<id>` and the hmac
//      covers it, so a url issued to one person is not a url for anybody
//      else. That is what makes a per-request access check possible at all.
//
//   2. ACCESS IS CHECKED WHEN THE BYTES ARE ASKED FOR, not when the message
//      was delivered. Losing access to a room now loses access to its media,
//      which is what everybody assumes already happens.
//
// The functions here are the decisions. The lookups they depend on — which
// rooms a file appears in, whether this viewer may see that room — belong to
// the server, because they are queries; each one is passed in as a fact.

/**
 * A filename that is safe to touch on disk, or null.
 *
 * This is the smallest and most important function in the file. `file_path`
 * arrived from the client and was stored after nothing but a query-string
 * strip, and `destroyMessage` then did:
 *
 *     if (p.startsWith('/uploads/')) fs.unlink(path.join(__dirname, p))
 *
 * `path.join` normalises `..` away, so '/uploads/../../../etc/crontab' passes
 * that test and resolves outside the directory entirely. Any account could
 * delete any file the service could write, including the database.
 *
 * The rule is deliberately about SHAPE rather than about a naming scheme:
 * every file already on disk has to keep working, and a regex describing how
 * names happen to be generated today would quietly strand the ones generated
 * differently yesterday.
 */
function safeUploadName(v) {
  if (typeof v !== 'string' || !v) return null;
  const name = v.split('?')[0].split('#')[0];
  if (!name || name.length > 255) return null;
  // No separators of either kind, no NUL, no control characters. A name
  // containing one of these is not a name.
  if (/[\/\\\u0000-\u001f\u007f]/.test(name)) return null;
  // '.' and '..' are directories, and a leading dot is one of ours — the
  // thumbnail, partial-upload and tile caches all live in dot-directories
  // inside uploads/ and are nobody's media.
  if (name.startsWith('.')) return null;
  return name;
}

/** '/uploads/x.jpg?e=1&s=2' -> 'x.jpg'. Anything else -> null. */
function nameFromPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/uploads/')) return null;
  return safeUploadName(p.slice('/uploads/'.length));
}

/**
 * Every upload a stored `file_path` refers to.
 *
 * A gallery message keeps a JSON array of paths in the one column, so this is
 * not simply "the one path" — and a caller that forgets the array case checks
 * the access of a photo nobody asked about while serving the one they did.
 */
function uploadNamesIn(filePath) {
  if (typeof filePath !== 'string' || !filePath) return [];
  let raw = [filePath];
  if (filePath.startsWith('[')) {
    try {
      const arr = JSON.parse(filePath);
      raw = Array.isArray(arr) ? arr : [];
    } catch { raw = []; }
  }
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    const n = nameFromPath(typeof p === 'string' ? p : '');
    if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

/**
 * May this viewer be handed a signature for this file at all?
 *
 * Used where a message is CREATED. `owns` is whether this account uploaded
 * the file; `referencedIn` is the set of rooms where a message already points
 * at it, and `canSee` answers for one room.
 *
 * Owning it is the ordinary case. The second clause is for forwarding and for
 * re-sending something out of a chat you can read, and it is written as "a
 * room you can see" rather than "any room" for the obvious reason.
 */
function mayAttach(o) {
  if (!o) return false;
  if (o.owns) return true;
  const rooms = Array.isArray(o.referencedIn) ? o.referencedIn : [];
  if (!rooms.length) return false;
  const canSee = typeof o.canSee === 'function' ? o.canSee : () => false;
  return rooms.some(r => canSee(r));
}

/**
 * How long a signed url stays valid, and the window it is rounded into.
 *
 * Both left at a day, and the reasoning is worth writing down because the
 * obvious move when tightening access is to shorten them.
 *
 * The expiry is no longer what protects the file — the viewer binding and the
 * per-request access check are. Shortening it therefore buys very little: a
 * leaked url is already useless to anybody but the person it names. What it
 * COSTS is large, because a url is only cacheable while it stays the same. An
 * hour-long bucket means every phone re-downloads every photo in every chat it
 * opens, once an hour, on a connection paid for by the megabyte.
 *
 * So the window stays wide and the identity does the work.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 24 * 60 * 60 * 1000;

/**
 * The expiry to stamp on a url.
 *
 * Rounded UP to a whole bucket so the url for a given file is STABLE within
 * that window instead of different on every request. That is not cosmetic:
 * `now + ttl` produces a new url each time a chat is opened, and every cache
 * that keys on the url — the phone's, the browser's, our own — then misses
 * every single time and re-downloads the same photo. On a connection paid for
 * by the megabyte that is the difference between usable and not.
 *
 * It was a day before, with a seven-day ttl behind it, because the url was the
 * whole of the protection and had to survive being looked at later. Now that
 * the viewer is named and checked on every request, the window only has to be
 * long enough to load a chat — so it is hours, not a week.
 */
function expiryFor(now, ttl = TTL_MS, bucket = BUCKET_MS) {
  const t = Number(now);
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.ceil((t + ttl) / bucket) * bucket;
}

/**
 * What to do with a request for some bytes.
 *
 * Every input is a fact somebody else established; this only says what they
 * add up to, so that the order of the checks is in one place and cannot drift
 * between /uploads and /thumb.
 *
 * `viewerId` is null when the url carries no `u` — a link made before urls
 * named their viewer. Those cannot be authorised, because there is nobody to
 * authorise, so they are refused unless the operator has explicitly turned the
 * old behaviour back on during a rollout.
 */
function decide(o) {
  const f = o || {};
  if (!f.name) return 'bad-request';
  if (f.viewerId == null) return f.allowLegacy ? 'legacy' : 'unidentified';
  if (!f.sigValid) return 'bad-signature';
  // Number(null) is 0, and 0 is finite — so a missing expiry read as a
  // timestamp from 1970 and came back 'expired' rather than 'malformed'. Both
  // refuse, so nothing was unsafe, but a url with no expiry at all is not an
  // old url and saying so is how it stays distinguishable in a log.
  const exp = numberOrNull(f.exp);
  const now = numberOrNull(f.now);
  if (exp === null || now === null) return 'bad-signature';
  if (now > exp) return 'expired';
  // Last, and only once the url has been shown to be ours and current: the
  // question this whole module exists for.
  if (!f.hasAccess) return 'no-access';
  return 'ok';
}

/** A real number, or null — never 0 standing in for "absent". */
function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The HTTP status for a decision. 'ok' and 'legacy' are the two that serve. */
function statusFor(decision) {
  if (decision === 'ok' || decision === 'legacy') return 200;
  if (decision === 'bad-request') return 400;
  // Everything else is 403, deliberately — including 'no-access'.
  //
  // A 404 for a file that exists but is not yours would be kinder to a
  // confused client and would also answer, truthfully, "this file exists".
  // Since the names are the only thing standing between a stranger and a
  // guess, they get the same answer either way.
  return 403;
}

module.exports = {
  TTL_MS, BUCKET_MS,
  safeUploadName, nameFromPath, uploadNamesIn,
  mayAttach, expiryFor, decide, statusFor,
};
