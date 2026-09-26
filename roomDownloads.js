// ── Whether media in a room may be saved to a device ───────────────────────
//
// Asked for: the room's admin decides, from the room info page, whether media
// in a private room can be downloaded — and when it is allowed, Download
// appears both in a message's menu and in the opened image's menu.
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────
//
// It is a house rule, and it is worth being plain about that rather than
// letting anybody believe otherwise.
//
// To show somebody a photo you must send them the photo. Once their phone has
// the bytes — and it must have them, or there is nothing on screen — a
// screenshot, a second device pointed at the screen, or a request made outside
// the app all remain possible, and no setting here can change that. Turning
// this off removes the button, which stops the casual case: the tap that
// puts a picture in somebody's camera roll without a thought.
//
// So it is a sign on a door, not a lock. A room whose members must not be able
// to keep what they are shown cannot be built out of a chat app, and telling
// an admin otherwise would be the more damaging bug of the two.
//
// The setting therefore has one honest job: make the app stop OFFERING it.
//
// There is deliberately no server-side enforcement, because there is no such
// thing to build here: a photo is fetched from the same signed URL whether it
// is being displayed or saved, so a server that refused the save would refuse
// the view with it. Anything claiming to block one and not the other would be
// a lie told in code. The server owns the SETTING — only the owner may change
// it, and every member is told when it changes — and the clients honour it.

/** Rooms are open unless somebody says otherwise. */
const DEFAULT_ALLOWED = true;

/**
 * May media in this room be downloaded?
 *
 * A missing column reads as ALLOWED, which is what every room created before
 * this existed was doing. The alternative — treating "unknown" as forbidden —
 * would silently take the download button away from every chat on the server
 * the moment this shipped.
 */
function downloadsAllowed(room) {
  if (!room) return DEFAULT_ALLOWED;
  const v = room.downloads_allowed;
  if (v === null || v === undefined || v === '') return DEFAULT_ALLOWED;
  // SQLite hands back 0 and 1, JSON hands back true and false, and an old
  // client may send the string. All three mean the same two things.
  if (v === '0' || v === 0 || v === false) return false;
  return true;
}

/**
 * Who may change it.
 *
 * The room's owner, and nobody else. This is unlike the disappearing and
 * one-time settings next door, which either side may change on purpose: those
 * protect the person RECEIVING the messages, so giving both sides the switch
 * is right. This one restricts what members may do with somebody else's
 * pictures, which is the owner's call about their own room.
 *
 * A DM has no owner in that sense — there are two people and neither is in
 * charge — so it is not offered there at all.
 */
function canChangeDownloads(o) {
  const room = o && o.room;
  if (!room) return false;
  if (room.is_dm) return false;
  const userId = numberOrNull(o && o.userId);
  const owner = numberOrNull(room.created_by);
  if (userId === null || owner === null) return false;
  return userId === owner;
}

/**
 * Should the app show a Download option for this message?
 *
 * `mine` is deliberately NOT an exception. Somebody who sent a photo already
 * has it; offering them a download in a room where nobody else gets one would
 * only make the rule look arbitrary from the other side.
 *
 * One-time media is never downloadable, whatever the room says — that is the
 * message's own promise and it outranks a room setting.
 */
function showDownload(o) {
  const s = o || {};
  if (s.oneTime) return false;
  if (!s.hasFile) return false;
  return downloadsAllowed(s.room);
}

/** What to tell somebody who asks for a download in a room that forbids it. */
function refusedText() {
  return 'Saving media is turned off in this room.';
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  DEFAULT_ALLOWED,
  downloadsAllowed,
  canChangeDownloads,
  showDownload,
  refusedText,
};
