// ── Where map tiles come from ───────────────────────────────────────────────
//
// Reported three times, each time as "the location picker does not work on
// zoom and pinch and move". Three readings of the gesture code found nothing
// wrong with it, because nothing is wrong with it.
//
// The map is drawn from tiles this server fetches and passes on, because
// OpenStreetMap is unreachable for the people who use this app. The server
// fetched from exactly one place, and when that one place could not be reached
// it answered 502 and the app drew nothing — a plain grey rectangle. Tiles
// already on disk still served, so the view the picker OPENS on appeared
// normally, and then every pan and every zoom moved into tiles that had to be
// fetched and were not there.
//
// So the gestures worked, the map state changed, and not one pixel moved. From
// the outside that is identical to a map that ignores your fingers, which is
// exactly how it was reported, and it is why looking at the gesture code again
// was never going to find it.
//
// Two things follow. A single upstream is a single point of failure for the
// whole feature, so there is now a list. And a failure that draws nothing and
// says nothing is how this hid for three rounds, so failures are now counted
// and said out loud.

/** Hosts tried in order, until one answers. */
const DEFAULT_UPSTREAMS = [
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  // Same tiles, different operators. A network that blocks or throttles one
  // of these usually does not block all of them, and the cost of trying
  // another is one request on the server, never on the phone.
  'https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
  'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
];

/**
 * The list to try, from the environment or the default.
 *
 * TILE_UPSTREAM stays a single URL for compatibility with servers already
 * configured that way; TILE_UPSTREAMS takes several, separated by commas or
 * whitespace. Either one REPLACES the defaults rather than adding to them: an
 * operator who has named a reachable mirror does not want this quietly falling
 * back to a host their network drops.
 */
function upstreamsFrom(env) {
  const e = env || {};
  const many = String(e.TILE_UPSTREAMS || '').trim();
  if (many) {
    const list = many.split(/[,\s]+/).filter(Boolean).filter(isTemplate);
    if (list.length) return list;
  }
  const one = String(e.TILE_UPSTREAM || '').trim();
  if (one && isTemplate(one)) return [one];
  return DEFAULT_UPSTREAMS.slice();
}

/**
 * Is this a usable tile template?
 *
 * It must name all three coordinates, or every tile request would return the
 * same picture — a map of one place that never changes, which is worse than
 * no map because it looks like it is working.
 */
function isTemplate(url) {
  const u = String(url || '');
  if (!/^https?:\/\//.test(u)) return false;
  return u.includes('{z}') && u.includes('{x}') && u.includes('{y}');
}

/** The URL for one tile from one template. */
function tileUrlFrom(template, z, x, y) {
  return String(template)
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * Is this request for a tile that can exist?
 *
 * Bounded deliberately: this endpoint must never become an open proxy that
 * fetches an arbitrary URL on request.
 */
function tileInRange(z, x, y, maxZoom) {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < 0 || z > maxZoom) return false;
  const n = Math.pow(2, z);
  return x >= 0 && x < n && y >= 0 && y < n;
}

module.exports = {
  DEFAULT_UPSTREAMS, upstreamsFrom, isTemplate, tileUrlFrom, tileInRange,
};
