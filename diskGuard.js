// ── Refusing an upload before it fills the disk ─────────────────────────────
//
// Asked: what is the best approach to file upload when the server's disk is
// limited. Measured first, because the answer depended on numbers nobody had
// looked at:
//
//     /dev/vda1   97G total   43G used   54G free
//     uploads/                2.7G in 3615 files
//     systemd journal         3.9G          <- more than every file ever sent
//     growth                  about 780 MB a month
//
// So the disk is not close to full and will not be for years. This is not
// here to reclaim space; it is here for the day something unexpected fills
// the volume, because of what happens TODAY when a write runs out of room.
//
// What happens today: multer deletes the half-written file (checked, in
// remove-uploaded-files.js — the bytes are not left behind), and then hands
// the error to Express. server.js registers no error handler at all, so
// Express's default one replies with an HTML page. The app's apiFetch expects
// JSON, so the phone shows an unparseable-response error and the person is
// told nothing. For a resumable upload it is worse: the client's reaction to
// an error it cannot read is to retry, and it will retry a disk that is still
// full, for as long as the person leaves it open.
//
// A pre-flight check turns that into one clear sentence, before any bytes are
// written. It costs one statfs per upload.
//
// ── IT FAILS OPEN, DELIBERATELY ─────────────────────────────────────────────
//
// If free space cannot be measured — an old Node without statfs, a platform
// that reports nothing — the upload is ALLOWED. The alternative is a guard
// that cannot read the disk and therefore blocks every upload on the service,
// which would be a far worse outage than the one it is guarding against. The
// thing it protects against is rare; being unable to send a photo is not.

const fs = require('fs');

const GIB = 1024 * 1024 * 1024;

/**
 * How much room to keep free regardless.
 *
 * The database, the journal and the OS all need somewhere to write, and a
 * SQLite database on a full disk is a worse day than a refused photo. One
 * gibibyte on a 97 GiB volume is about 1%.
 */
const DEFAULT_RESERVE_BYTES = 1 * GIB;

/**
 * Should a file of this size be accepted?
 *
 * Pure: every input is passed in, so each rule can be driven directly. The
 * io half is freeBytesFor() below.
 *
 * @param {object} o
 * @param {number} o.freeBytes      bytes free on the volume, or null if unknown
 * @param {number} o.incomingBytes  size of the file about to be written
 * @param {number} [o.reserveBytes] floor to keep free (default 1 GiB)
 */
function spaceVerdict(o) {
  const f = o || {};
  // ── Unmeasured means yes ────────────────────────────────────────────────
  //
  // See the note at the top. A guard that cannot see the disk must not become
  // a guard that refuses everything.
  //
  // Checked by TYPE before any conversion, and that is the whole point:
  // Number(null) is 0, and 0 is a perfectly finite non-negative number. The
  // first version of this ran freeBytes through Number() first, so
  // freeBytesFor() returning null — its way of saying "this platform cannot
  // tell me" — arrived here as "zero bytes free" and refused every upload on
  // the server. Precisely the failure this file argues against, written into
  // the line meant to prevent it.
  const free = f.freeBytes;
  if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) {
    return { ok: true, reason: 'unmeasured' };
  }
  const incoming = Number.isFinite(Number(f.incomingBytes)) && Number(f.incomingBytes) > 0
    ? Math.ceil(Number(f.incomingBytes)) : 0;
  const reserveRaw = Number(f.reserveBytes);
  const reserve = Number.isFinite(reserveRaw) && reserveRaw >= 0
    ? reserveRaw : DEFAULT_RESERVE_BYTES;

  // The file has to fit AND leave the floor intact. Written as one comparison
  // rather than two so a file larger than the whole disk and a disk with no
  // room left give the same answer by the same rule.
  if (free - incoming < reserve) {
    return {
      ok: false,
      reason: 'low-space',
      freeBytes: free,
      neededBytes: incoming + reserve,
    };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * Bytes free on the volume holding `dir`, or null when that cannot be read.
 *
 * statfs arrived in Node 18.15. Older runtimes return null here and
 * spaceVerdict then allows the upload, which is the intended degradation and
 * not an oversight.
 */
function freeBytesFor(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(dir);
    // bavail, not bfree: bfree counts blocks reserved for root, which this
    // process cannot use. Reporting those as free is how a guard lets the
    // disk fill the last few percent and then fails anyway.
    const free = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch {
    return null;
  }
}

/** The sentence the person sees. No paths, no byte counts they cannot act on. */
function lowSpaceMessage() {
  return 'The server is out of storage space. Your file was not sent — '
    + 'please tell the administrator.';
}

module.exports = {
  spaceVerdict,
  freeBytesFor,
  lowSpaceMessage,
  DEFAULT_RESERVE_BYTES,
};
