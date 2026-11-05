// ── What to tell a phone about finding itself ────────────────────────────────
//
// Reported, measured, and the same on every end of every failed call:
//
//     host=1 srflx=0 relay=0 ans=1 turn=1
//
// srflx=0 means STUN told the phone nothing about how the world sees it, so
// its entire offer was one candidate: its own address on its own network. ICE
// cannot succeed from that against anybody who is not on the same network.
//
// The STUN server was stun.l.google.com. Google is blocked or throttled from
// these networks — this app already knows that and proxies its map tiles
// through its own server for exactly that reason (see geo.ts, "foreign map
// services are blocked or throttled for users in Iran, so drawing straight
// from OSM left the map an empty grey grid"). Nobody had applied the same
// reasoning to ICE, and it is the same reasoning.
//
// coturn answers STUN as well as TURN on the same port, and these servers are
// already running it. So the phone can be told to ask the host it is already
// talking to.
//
// Google is kept, AFTER ours. It costs a phone that can reach neither nothing
// extra, and it is a real fallback on a network where ours is the blocked one
// — which is not a guess worth making in either direction.

/**
 * The STUN url for a TURN url, or null if there isn't one.
 *
 * TURN and STUN share a port, so this is the same host and port with the
 * scheme changed. Any `?transport=` is dropped: it describes how to reach a
 * relay, means nothing to a STUN binding request, and a url carrying it is
 * rejected by some implementations rather than ignored.
 */
function stunFor(turnUrl) {
  if (typeof turnUrl !== 'string') return null;
  const trimmed = turnUrl.trim();
  // The SCHEME, not the presence of the word: "stun:turn.example.org" is not
  // a TURN url, and treating it as one would advertise a relay that is not
  // there.
  const m = /^turns?:(.+)$/i.exec(trimmed);
  if (!m) return null;
  const rest = m[1].split('?')[0].trim();
  if (!rest) return null;
  return `stun:${rest}`;
}

/**
 * The whole iceServers list, in the order a phone should try it.
 *
 * Ours first, because it is the one that can be reached from the networks
 * this is for. The public fallbacks stay at the end.
 */
function iceServersFor(env, fallbacks) {
  const out = [];
  const url = env && typeof env.TURN_URL === 'string' ? env.TURN_URL.trim() : '';
  const user = env && typeof env.TURN_USERNAME === 'string' ? env.TURN_USERNAME.trim() : '';
  const pass = env && typeof env.TURN_PASSWORD === 'string' ? env.TURN_PASSWORD.trim() : '';
  const ownStun = stunFor(url);
  if (ownStun) out.push({ urls: [ownStun] });
  const extra = Array.isArray(fallbacks) ? fallbacks.filter(u => typeof u === 'string' && u) : [];
  if (extra.length) out.push({ urls: extra });
  // The relay needs all three: a url with no credentials yields no relay
  // candidate at all, since TURN answers an unauthenticated allocate with 401.
  if (url && user && pass) {
    out.push({
      // UDP first; the TCP fallback rescues networks that block or throttle
      // UDP, which is a common cause of a call that never connects.
      urls: [url, `${url}?transport=tcp`],
      username: user,
      credential: pass,
    });
  }
  return out;
}

module.exports = { stunFor, iceServersFor };
