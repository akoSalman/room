// ── Choosing where the pin goes ──────────────────────────────────────────────
//
// Reported as: the location the app picks is sometimes not accurate, so let the
// user choose on a map before sending.
//
// A phone's fix is a guess with an error bar. Indoors, in a dense city, or on a
// device that has fallen back to cell towers, that error is measured in
// hundreds of metres — and "here is where I am" is not a message anyone wants
// to send approximately. So the pin is now placed on a map the user can move,
// starting from the fix so that the common case (the fix is fine) is one extra
// tap and nothing more.
//
// The rules live here because two of them are easy to get quietly wrong, and
// both would put a false claim in a message someone relies on.
import { LatLng, distanceMeters, formatCoords, formatDistance } from './geo';

export type Fix = { lat: number; lng: number; accuracy?: number | null } | null;

/** Zoom close enough to place a pin on the right side of a street. */
export const PICK_ZOOM = 17;
/** Zoom for "we have no idea where you are" — a whole region. */
export const UNKNOWN_ZOOM = 5;

/**
 * A pin within this of the fix counts as NOT moved.
 *
 * The map cannot be held perfectly still and the centre is a float, so an
 * untouched map still drifts by a metre or two. Anything inside ordinary GPS
 * noise is the fix, not a decision.
 */
export const PIN_MOVED_M = 15;

/**
 * Where the map opens.
 *
 * On the fix when there is one. Failing that, on anything already pinned in
 * this chat — the last place someone shared is far closer to useful than the
 * middle of the ocean — and failing that, nowhere in particular, zoomed out
 * far enough that panning to your city is possible.
 */
export function openingView(fix: Fix, nearby: LatLng[] = []): { center: LatLng; zoom: number } {
  if (fix) return { center: { lat: fix.lat, lng: fix.lng }, zoom: PICK_ZOOM };
  if (nearby.length) return { center: { ...nearby[0] }, zoom: 13 };
  return { center: { lat: 0, lng: 0 }, zoom: UNKNOWN_ZOOM };
}

/** Has the user actually moved the pin off the fix? */
export function pinMoved(fix: Fix, chosen: LatLng, tolerance = PIN_MOVED_M): boolean {
  if (!fix) return true;   // nothing to have moved away FROM
  return distanceMeters({ lat: fix.lat, lng: fix.lng }, chosen) > tolerance;
}

/**
 * The payload for the message.
 *
 * Two rules that matter more than they look:
 *
 * 1. ACCURACY IS DROPPED once the pin has been moved. `accuracy` describes the
 *    error bar on a measurement; carrying it over to a point someone placed by
 *    hand attaches a measured uncertainty to a number that was not measured. If
 *    anything it is backwards — a hand-placed pin is usually the more accurate
 *    of the two, which is the whole reason for this feature.
 *
 * 2. A LIVE SHARE ALWAYS USES THE FIX. Live sharing means "follow me", and the
 *    tracker overwrites the coordinates within seconds of the first update.
 *    Letting someone hand-place the start of one would show a position that was
 *    never true and then silently correct itself, which is worse than not
 *    offering it.
 */
export function locationPayload(o: {
  chosen: LatLng;
  fix: Fix;
  /** Epoch ms a live share ends, or null for a one-off pin. */
  liveUntil?: number | null;
  now: number;
}): {
  lat: number; lng: number; accuracy: number | null;
  liveUntil: number | null; updatedAt: number;
} {
  const live = o.liveUntil && o.liveUntil > o.now ? o.liveUntil : null;
  const at = live && o.fix ? { lat: o.fix.lat, lng: o.fix.lng } : o.chosen;
  const moved = pinMoved(o.fix, at);
  return {
    lat: at.lat,
    lng: at.lng,
    accuracy: moved ? null : (o.fix?.accuracy ?? null),
    liveUntil: live,
    updatedAt: o.now,
  };
}

/** Can a live share be started at all? */
export function canShareLive(fix: Fix): boolean {
  return !!fix;
}

/**
 * The line under the map.
 *
 * Says which of the two things is about to be sent, and — once the pin has
 * been moved — how far it is from where the phone thinks you are. That
 * distance is the honest answer to "have I dragged this to the right place or
 * to another district", and it is the only feedback available without street
 * names.
 */
export function chosenLabel(fix: Fix, chosen: LatLng): string {
  if (!fix) return `Chosen point · ${formatCoords(chosen)}`;
  if (!pinMoved(fix, chosen)) {
    const acc = fix.accuracy && fix.accuracy > 0
      ? ` · accurate to about ${formatDistance(fix.accuracy)}` : '';
    return `Your current position${acc}`;
  }
  const away = distanceMeters({ lat: fix.lat, lng: fix.lng }, chosen);
  return `Chosen point · ${formatDistance(away)} from your position`;
}

// ── When this position was last heard ──────────────────────────────────────
//
// Asked for: show the last time a live location was updated.
//
// The card already said how long the share has left to run — "for 12 min" —
// which is a promise about the future. It said nothing about the past, and the
// past is the question somebody actually has: is this where they are NOW, or
// where they were before the phone lost signal twenty minutes ago? A live pin
// that has silently stopped moving looks exactly like one that is moving, and
// that is the one thing this card must not be ambiguous about.
//
// The payload has carried `updatedAt` all along, refreshed by the server on
// every move, so nothing had to be added to have the answer.

/** Under a minute is "just now": a clock would be noise at that scale. */
export const JUST_NOW_MS = 60_000;

/**
 * "updated just now", "updated 4 min ago", "updated 2 h ago".
 *
 * Deliberately relative rather than a clock time. A clock time has to be read
 * and subtracted from the current one before it answers anything, and the
 * question is always "how stale is this".
 */
export function formatUpdated(updatedAt: unknown, now: unknown = Date.now()): string {
  const at = Number(updatedAt);
  const t = Number(now);
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(t)) return '';
  // A timestamp from the future is two clocks disagreeing, not a position
  // from tomorrow, and it falls out as "just now" on its own: a negative age
  // is below the just-now threshold. Clamping it to zero as well was tried and
  // no test could tell the difference, which is the definition of a line that
  // only looks like care.
  const ago = t - at;
  if (ago < JUST_NOW_MS) return 'updated just now';
  const mins = Math.floor(ago / 60_000);
  if (mins < 60) return `updated ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `updated ${days} d ago`;
}
