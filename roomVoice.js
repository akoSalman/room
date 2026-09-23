// ── A voice chat nobody is told about ───────────────────────────────────────
//
// Reported as: "voice call in rooms doesn't work at all".
//
// The WebRTC signalling is fine. Offers, answers and ICE all relay correctly,
// and the mesh logic — existing members offer to each newcomer — is right.
// None of it ever runs, because nothing tells the other members that a voice
// chat has started.
//
// In the app, `voice_count` is handled in exactly one place, and it is gated:
//
//     s.on('voice_count', ({ roomId, count }) => {
//       if (this.mode === 'room-voice' && …) { this.status = …; }
//     });
//
// You only see the count if you are ALREADY IN the call. Nothing renders it on
// the room's call button, and there is no ring, no banner and no notification.
// So somebody taps the button, joins, and sits alone in "waiting for others…"
// while every other member's phone stays silent and unchanged. Nobody joins,
// so no offer is ever made, so nothing connects. "Doesn't work at all" is an
// accurate description of what they can observe.
//
// The server made it worse by addressing the count to the chat's socket room:
//
//     io.to(key).emit('voice_count', …)
//
// which reaches only the people who happen to have that chat OPEN. Everyone
// else — which is everyone, most of the time — was never in the conversation.
//
// So this module answers the two questions the server needs: who has to hear
// about this, and is this the moment a call BEGAN, which is the only moment
// worth interrupting somebody for.

/**
 * Everyone who should be told the voice chat's state changed.
 *
 * Every member of the room, not the sockets in it. Addressed by user id so it
 * reaches a phone whose owner is reading something else — which is the whole
 * point, because a person with the chat already open is the one person who
 * least needs telling.
 *
 * The joiner is included: their own client uses the count for its status line,
 * and leaving them out would mean two sources of truth for one number.
 */
function notifyTargets(o) {
  const memberIds = (o && o.memberIds) || [];
  if (!Array.isArray(memberIds)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of memberIds) {
    const id = numberOrNull(raw);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Did this join START the call, as opposed to joining one already happening?
 *
 * The difference decides whether anybody's phone makes a noise. A call
 * beginning is news; the third person arriving at one is not, and pushing for
 * it would teach people to ignore the notification that matters.
 *
 * `countBefore` is the size of the membership BEFORE this joiner was added.
 */
function isCallStarting(o) {
  // numberOrNull, NOT Number(): Number(null) is 0, and 0 is finite, so a
  // missing count would read as "the call is starting" and push the whole
  // room. The same trap this file's own test was written to catch, walked
  // straight into one function below the comment warning about it.
  const before = numberOrNull(o && o.countBefore);
  if (before === null) return false;
  return before === 0;
}

/**
 * Who to push to when a call starts: every member except the person who
 * started it.
 *
 * Pushing the starter would ring the phone of somebody already holding it with
 * the call open on it.
 */
function pushTargets(o) {
  const starter = numberOrNull(o && o.starterId);
  return notifyTargets(o).filter(id => id !== starter);
}

/**
 * What the notification says.
 *
 * Named rather than assembled at the call site so the two brands and the tests
 * cannot drift, and so this reads as one decision: who started it, and where.
 */
function startedPush(o) {
  const who = String((o && o.username) || '').trim();
  const room = String((o && o.roomName) || '').trim();
  return {
    title: room || 'Voice chat',
    body: who ? `${who} started a voice chat` : 'A voice chat has started',
  };
}

/**
 * Number(null) is 0, and 0 is finite — so a null member id would pass a plain
 * isFinite check and become "member 0", a user who does not exist and whose
 * notifications go nowhere.
 */
function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { notifyTargets, isCallStarting, pushTargets, startedPush };
