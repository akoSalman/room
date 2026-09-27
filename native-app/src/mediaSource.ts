// ── Asking for our own media, as ourselves ─────────────────────────────────
//
// The server no longer serves a file to whoever holds the link. A media
// request has to say who is making it, and the answer is checked against the
// rooms that person can see. For anything the app fetches itself that is easy
// — apiFetch already sends the token. For a picture it is not, because the
// thing that fetches a picture is <Image>, and it sends what its `source` says
// and nothing else.
//
// So every place that displays one of our files goes through here.
//
// ── The rule that matters is the NARROW one ─────────────────────────────────
//
// The obvious implementation attaches the token to every `source` and is a
// worse bug than the one it fixes. These same components also load a map tile,
// a link preview's cover, and a YouTube player — and handing a session token
// to youtube.com, to whatever host a stranger's link points at, or to an OSM
// mirror, is a credential leak to a third party in exchange for nothing.
//
// The token goes to our own origin, and only to the two paths that actually
// check it. /tiles and /link-image are deliberately unauthenticated — they
// serve bytes that are already ours, re-encoded — so they do not get it either.

/** The paths that authenticate the requester. Nothing else needs the token. */
const GUARDED = ['/uploads/', '/thumb/'];

export type ImageSource = { uri: string; headers?: Record<string, string> };

// ── The origin and the token, held here ─────────────────────────────────────
//
// Deliberately NOT read from api.ts. Everything that displays or downloads a
// file would then import api.ts, which pulls in AsyncStorage and socket.io —
// modules that do not load off a device — and mediaCache and storage became
// untestable the moment they did. This module depends on nothing, and api.ts
// pushes the two values into it.
let baseUrl = '';
let token: string | null = null;

/** Called once at startup with the server's origin. */
export function configureMedia(o: { baseUrl?: string; token?: string | null }) {
  if (typeof o?.baseUrl === 'string') baseUrl = o.baseUrl;
  if (o && 'token' in o) token = o.token ?? null;
}

/** Called whenever the session changes: sign-in, sign-out, a refreshed token. */
export function setMediaToken(t: string | null) {
  token = t;
}

/**
 * Is this one of our own guarded media urls?
 *
 * `base` is a parameter rather than the module's own value so the rule can be
 * tested on its own — it is the whole safety argument, and a rule nobody can
 * test in isolation is a rule that quietly widens.
 */
export function needsToken(uri: unknown, base: unknown): boolean {
  if (typeof uri !== 'string' || !uri) return false;
  if (typeof base !== 'string' || !base) return false;
  const root = base.replace(/\/+$/, '');
  if (!uri.startsWith(root + '/')) return false;
  // Compared on the PATH, so a query or fragment cannot be used to make some
  // other path look like a guarded one.
  const path = uri.slice(root.length).split('?')[0].split('#')[0];
  return GUARDED.some(p => path.startsWith(p));
}

/**
 * The `source` for an <Image>, a <Video>, or anything else taking one.
 *
 * Returns a plain `{ uri }` for everything that is not ours, which is what
 * every one of these call sites passed before — so a component handed a local
 * file:// path, a data: uri or a foreign host behaves exactly as it did.
 */
export function mediaSource(uri: string): ImageSource {
  if (!token || !needsToken(uri, baseUrl)) return { uri };
  return { uri, headers: { Authorization: `Bearer ${token}` } };
}

/**
 * Just the headers, for the places that fetch bytes rather than render them:
 * saving a photo, caching one to disk, downloading a video.
 *
 * Same narrow rule — an empty object for anything that is not one of our
 * guarded paths, so the APK download, a map tile and a foreign host are all
 * unchanged.
 */
export function mediaHeaders(uri: string): Record<string, string> {
  if (!token || !needsToken(uri, baseUrl)) return {};
  return { Authorization: `Bearer ${token}` };
}
