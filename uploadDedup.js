// ── One copy of the same bytes ──────────────────────────────────────────────
//
// Forwarding a photo to five chats stored five identical files. Nothing in
// either upload path looked at what the bytes were: /upload and the resumable
// finish both mint `Date.now() + '-' + random` and keep whatever arrives.
//
// On the measured server that is 3615 files and 2.7 GB, of which the biggest
// classes — 1931 voice notes, 1336 photos — are exactly the things people
// forward. Deduplication is the one saving here that costs nobody anything:
// no quality is lost, nothing is deleted, and no old message changes.
//
// ── WHY THIS IS SAFE, WHICH IS THE ONLY INTERESTING QUESTION ────────────────
//
// Pointing two messages at one file is only safe if deleting one message does
// not take the other's photo with it. That already works, and it was built
// before this: upload_refs holds (name, message_id, room_id), and
// destroyMessage deletes this message's rows FIRST and then keeps the file if
// any row still names it —
//
//     db.prepare('DELETE FROM upload_refs WHERE message_id = ?').run(msg.id);
//     const shared = db.prepare('SELECT 1 FROM upload_refs WHERE name = ?…')
//     if (shared) continue;   // forwarded elsewhere, or still in another message
//
// That is a reference count, and it is already the rule for forwarded media.
// This change makes more messages share a name; it does not change what
// sharing means. roomsHoldingUpload() also backfills the index from the
// messages table for any name it does not find, so a path that forgets to
// record a reference is slow rather than wrong.
//
// Every failure in this file keeps the newly uploaded file. A dedupe that
// cannot hash, cannot read the table, or finds a row whose file is gone
// returns the new name unchanged. Losing somebody's photo to save a megabyte
// is not a trade worth making, so the code never has the option.

const crypto = require('crypto');
const fs = require('fs');

/**
 * sha256 of a file, streamed.
 *
 * Streamed rather than readFileSync because this runs on the request path of
 * a chat server: hashing an 80 MB upload synchronously would stop every other
 * socket on the process for the duration.
 */
function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(absPath);
    rs.on('error', reject);
    rs.on('data', d => h.update(d));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Which already-stored file, if any, may stand in for the one just uploaded.
 *
 * Pure. `rows` are candidates the caller found by hash; `exists` says whether
 * a name is still on disk. Returns a name or null.
 *
 * Three conditions, and all three matter:
 *
 *   • the hash matches. The caller selects on it, but this does not take that
 *     on trust: a query changed later must not silently turn this into "any
 *     row will do";
 *
 *   • the size matches. Free, and it means a hash collision alone cannot
 *     substitute the wrong file;
 *
 *   • THE FILE IS STILL THERE. The row can outlive the bytes — a message
 *     deleted while its upload row lingers, a restore, a hand-edited
 *     directory. Returning a name whose file is gone would hand somebody a
 *     broken photo in place of the one they just sent, which is worse than
 *     storing a duplicate.
 */
function pickExisting(rows, o) {
  const f = o || {};
  if (!Array.isArray(rows)) return null;
  const hash = typeof f.hash === 'string' && f.hash ? f.hash : null;
  if (!hash) return null;
  const size = Number(f.size);
  if (!Number.isFinite(size) || size <= 0) return null;
  const exists = typeof f.exists === 'function' ? f.exists : () => false;
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !row.name) continue;
    if (row.sha256 !== hash) continue;
    if (Number(row.size) !== size) continue;
    if (!exists(row.name)) continue;
    return row.name;
  }
  return null;
}

/**
 * Is this file worth hashing at all?
 *
 * Tiny files cost more in a hash and a round trip to the table than they can
 * ever save, and the duplicates that matter here are forwarded photos, voice
 * notes and videos. Below the floor the upload is kept as-is.
 */
const MIN_DEDUP_BYTES = 16 * 1024;

function worthDeduping(size) {
  const n = Number(size);
  return Number.isFinite(n) && n >= MIN_DEDUP_BYTES;
}

module.exports = { hashFile, pickExisting, worthDeduping, MIN_DEDUP_BYTES };
