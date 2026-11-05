// ── Why a call did not connect ───────────────────────────────────────────────
//
// Reported as: on one device the call never connects, it used to work.
//
// The app said "Connection failed" and knew nothing more, which is the same
// position the video player was in before it started printing its reason —
// three rounds of guessing went into that one and the answer took minutes
// once the phone said what had actually happened.
//
// For a call the facts that separate the causes are all about ICE, and they
// are cheap to collect:
//
//   • how many candidates of each TYPE were gathered. `host` is this phone's
//     own address, `srflx` is what a STUN server said the outside world sees,
//     `relay` is a TURN server standing by to forward. Which of those exist
//     decides what is possible;
//   • whether the other side ever answered at all;
//   • whether a relay was even offered in the configuration.
//
// Those four facts tell "the other phone never picked up" from "this network
// needs a relay and there isn't one" from "there is a relay and it could not
// be reached" — and those have completely different fixes, one of which is
// not a code change at all.
//
// ── NOTHING FROM THE CANDIDATE ITSELF ───────────────────────────────────────
//
// An ICE candidate string carries IP ADDRESSES: the phone's address on its
// local network and, for srflx, its public one. These reports arrive as
// photographs of the screen, and this text is written to go on that screen,
// so nothing is taken from a candidate but its type — a word from a fixed
// list. candidateKind returns one of five constants or null and can return
// nothing else, which is the whole of the scrubbing and is tested as such.

export type IceKind = 'host' | 'srflx' | 'prflx' | 'relay';

/**
 * The TYPE of an ICE candidate, and nothing else about it.
 *
 * Accepts the string form or the object react-native-webrtc hands over. Any
 * shape that is not one of the four known types gives null rather than a
 * guess, because an unknown word here would be printed on a screen.
 */
export function candidateKind(candidate: unknown): IceKind | null {
  let text = '';
  if (typeof candidate === 'string') text = candidate;
  else if (candidate && typeof candidate === 'object') {
    const c = candidate as Record<string, unknown>;
    // Some implementations expose `type` directly; most only have the SDP.
    if (typeof c.type === 'string') text = `typ ${c.type}`;
    else if (typeof c.candidate === 'string') text = c.candidate;
  }
  if (!text) return null;
  const m = /\btyp\s+(host|srflx|prflx|relay)\b/.exec(text);
  return m ? (m[1] as IceKind) : null;
}

export type CallFacts = {
  /** Counts by candidate type, gathered locally. */
  host: number;
  srflx: number;
  relay: number;
  /** Did the other side's answer arrive? */
  answered: boolean;
  /** Did the ICE configuration contain a TURN server at all? */
  relayOffered: boolean;
};

const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/**
 * One sentence saying what went wrong, for the person looking at the phone.
 *
 * Ordered by what can be concluded, not by what is most likely: a call with
 * no answer tells you nothing about the network, so that is decided first.
 */
export function callFailureReason(facts: Partial<CallFacts> | null | undefined): string {
  const f = facts || {};
  const host = num(f.host), srflx = num(f.srflx), relay = num(f.relay);
  const answered = f.answered === true;
  const relayOffered = f.relayOffered === true;

  if (!answered) return 'The other phone never answered the call.';

  if (relay > 0) {
    // A relay was reachable and it still failed. Not the usual network
    // problem, and saying "needs a relay" here would send someone to fix
    // something that is already working.
    return 'Connected to the relay, but no route to the other phone.';
  }
  if (relayOffered) {
    return 'The relay server could not be reached from this network.';
  }
  if (srflx > 0) {
    // We know our public address, so STUN worked; what is missing is
    // somewhere to forward through when both sides are behind carrier NAT.
    return 'No direct route, and no relay server is set up for this network.';
  }
  if (host > 0) {
    // Only our own address. Either STUN is blocked — which it is, on these
    // networks, when it points at a foreign host — or nothing answered it.
    return 'This phone could not discover its own address, and has no relay.';
  }
  return 'No network candidates at all — the call had nothing to connect with.';
}

/**
 * The same facts as a short code, for the log and the second line on screen.
 *
 * Compact on purpose: it has to survive being read off a photograph of a
 * phone held at arm's length. Counts and one word, no addresses.
 */
export function callFacts(facts: Partial<CallFacts> | null | undefined): string {
  const f = facts || {};
  return `h${num(f.host)} s${num(f.srflx)} r${num(f.relay)}`
    + ` ans=${f.answered === true ? 1 : 0} turn=${f.relayOffered === true ? 1 : 0}`;
}

/**
 * Does this ICE configuration offer somewhere it is actually possible to
 * relay through?
 *
 * A url is not enough. TURN with lt-cred-mech answers an unauthenticated
 * allocate with 401, so a `turn:` entry carrying no username or credential
 * produces no relay candidate and looks exactly like a blocked network from
 * the outside. This was reporting turn=1 for that case, which would have been
 * read — by me, out loud — as "a relay was offered and could not be reached".
 *
 * So both halves are required: somewhere to go, and something to say on
 * arrival.
 */
export function offersRelay(iceServers: unknown): boolean {
  if (!Array.isArray(iceServers)) return false;
  for (const entry of iceServers) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const urls = e.urls;
    const list = Array.isArray(urls) ? urls : [urls];
    const hasTurn = list.some(u => typeof u === 'string' && /^turns?:/i.test(u.trim()));
    if (!hasTurn) continue;
    const user = typeof e.username === 'string' ? e.username.trim() : '';
    const cred = typeof e.credential === 'string' ? e.credential.trim() : '';
    if (user && cred) return true;
  }
  return false;
}
