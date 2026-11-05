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
/**
 * The same host and credentials on a different port.
 *
 * ── WHY THERE IS A SECOND PORT AT ALL ──────────────────────────────────────
 *
 * Measured, not guessed: nothing from the phones that cannot call reaches
 * 3478. Our own STUN on it returns no reflexive candidate, TURN on it returns
 * no relay candidate on either end of any call, and coturn's log is not
 * written to at all while those calls happen — the requests are not refused,
 * they never arrive. Meanwhile a CI runner allocates through that exact port
 * successfully, so the server is fine; and the app is talking to the same host
 * on 443 the whole time, which is how the calls are signalled.
 *
 * So there is now a second coturn on UDP 443, and this is how a phone is told
 * about it.
 *
 * UDP ONLY. TCP 443 on that host is Apache's. Advertising
 * `?transport=tcp` for this port would hand clients a TURN url pointing at a
 * web server, where they would wait and fail for a reason nothing could
 * explain. The main port keeps its TCP fallback; this one must not have one.
 */
function altFor(url, port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  if (typeof url !== 'string') return null;
  const m = /^(turns?):([^?]+?)(?::(\d+))?(?:\?.*)?$/i.exec(url.trim());
  if (!m) return null;
  const host = m[2].trim();
  if (!host) return null;
  return { turn: `${m[1].toLowerCase()}:${host}:${n}`, stun: `stun:${host}:${n}` };
}

function iceServersFor(env, fallbacks) {
  const out = [];
  const url = env && typeof env.TURN_URL === 'string' ? env.TURN_URL.trim() : '';
  const user = env && typeof env.TURN_USERNAME === 'string' ? env.TURN_USERNAME.trim() : '';
  const pass = env && typeof env.TURN_PASSWORD === 'string' ? env.TURN_PASSWORD.trim() : '';
  const alt = altFor(url, env && env.TURN_ALT_PORT);
  // The reachable port first, where there is one: it is the only one these
  // phones have been shown to get through to.
  if (alt) out.push({ urls: [alt.stun] });
  const ownStun = stunFor(url);
  if (ownStun) out.push({ urls: [ownStun] });
  const extra = Array.isArray(fallbacks) ? fallbacks.filter(u => typeof u === 'string' && u) : [];
  if (extra.length) out.push({ urls: extra });
  // The relay needs all three: a url with no credentials yields no relay
  // candidate at all, since TURN answers an unauthenticated allocate with 401.
  if (url && user && pass) {
    if (alt) out.push({ urls: [alt.turn], username: user, credential: pass });
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

module.exports = { stunFor, altFor, iceServersFor };
