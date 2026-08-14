// ── Geo helpers ──────────────────────────────────────────────────────────────
//
// Pure maths, no React and no native modules, so it can be unit tested — the
// Web Mercator projection is exactly the kind of code that is easy to get
// subtly wrong and impossible to eyeball on a device.
//
// The map is drawn from raw OpenStreetMap tiles rather than react-native-maps:
// that library needs a Google Maps API key wired into the native project, which
// is a configuration burden and another thing that can only be verified by
// building. Tiles are just images, so the map works with no native dependency
// at all.

export type LatLng = { lat: number; lng: number };

export const TILE_SIZE = 256;
export const MIN_ZOOM = 3;
export const MAX_ZOOM = 18;

/** World-pixel X for a longitude at a given zoom. */
export function lngToWorldX(lng: number, zoom: number): number {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  return ((lng + 180) / 360) * scale;
}

/** World-pixel Y for a latitude at a given zoom (Web Mercator). */
export function latToWorldY(lat: number, zoom: number): number {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  // Mercator is undefined at the poles; clamp to the standard cutoff.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return y * scale;
}

export function worldXToLng(x: number, zoom: number): number {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  return (x / scale) * 360 - 180;
}

export function worldYToLat(y: number, zoom: number): number {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const n = Math.PI - 2 * Math.PI * (y / scale);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Metres between two points (haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function formatDistance(m: number): string {
  if (!isFinite(m) || m < 0) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/** Which tiles cover a viewport, and where to draw each one. */
export function tilesForViewport(
  center: LatLng, zoom: number, width: number, height: number,
): { x: number; y: number; z: number; left: number; top: number }[] {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
  const cx = lngToWorldX(center.lng, z);
  const cy = latToWorldY(center.lat, z);
  // World-pixel coordinate of the viewport's top-left corner.
  const originX = cx - width / 2;
  const originY = cy - height / 2;

  const firstTileX = Math.floor(originX / TILE_SIZE);
  const firstTileY = Math.floor(originY / TILE_SIZE);
  const lastTileX = Math.floor((originX + width) / TILE_SIZE);
  const lastTileY = Math.floor((originY + height) / TILE_SIZE);

  const n = Math.pow(2, z);
  const out: { x: number; y: number; z: number; left: number; top: number }[] = [];
  for (let ty = firstTileY; ty <= lastTileY; ty++) {
    // Above the north pole or below the south: no tile exists.
    if (ty < 0 || ty >= n) continue;
    for (let tx = firstTileX; tx <= lastTileX; tx++) {
      // Longitude wraps, so tiles repeat horizontally.
      const wrapped = ((tx % n) + n) % n;
      out.push({
        x: wrapped,
        y: ty,
        z,
        left: tx * TILE_SIZE - originX,
        top: ty * TILE_SIZE - originY,
      });
    }
  }
  return out;
}

/** Where a point sits inside the viewport, in pixels from its top-left. */
export function pointToScreen(
  point: LatLng, center: LatLng, zoom: number, width: number, height: number,
): { x: number; y: number } {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
  return {
    x: lngToWorldX(point.lng, z) - lngToWorldX(center.lng, z) + width / 2,
    y: latToWorldY(point.lat, z) - latToWorldY(center.lat, z) + height / 2,
  };
}

/** Moving the viewport by a pixel delta gives a new centre. */
export function panCenter(
  center: LatLng, zoom: number, dx: number, dy: number,
): LatLng {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
  return {
    lng: worldXToLng(lngToWorldX(center.lng, z) - dx, z),
    lat: worldYToLat(latToWorldY(center.lat, z) - dy, z),
  };
}

export function tileUrl(x: number, y: number, z: number): string {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

/** A zoom that fits every point, with a little padding. */
export function zoomToFit(points: LatLng[], width: number, height: number): number {
  if (points.length < 2) return 15;
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const xs = points.map(p => lngToWorldX(p.lng, z));
    const ys = points.map(p => latToWorldY(p.lat, z));
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    if (w < width * 0.8 && h < height * 0.8) return z;
  }
  return MIN_ZOOM;
}

export function centerOf(points: LatLng[]): LatLng {
  if (!points.length) return { lat: 0, lng: 0 };
  return {
    lat: points.reduce((a, p) => a + p.lat, 0) / points.length,
    lng: points.reduce((a, p) => a + p.lng, 0) / points.length,
  };
}

/** Coordinates as a short human string, e.g. "35.6892, 51.3890". */
export function formatCoords(p: LatLng): string {
  return `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
}

/** Opens in whatever map app the phone has. */
export function geoUri(p: LatLng, label?: string): string {
  const q = label ? `${p.lat},${p.lng}(${encodeURIComponent(label)})` : `${p.lat},${p.lng}`;
  return `geo:${p.lat},${p.lng}?q=${q}`;
}

export function webMapUrl(p: LatLng): string {
  return `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=16/${p.lat}/${p.lng}`;
}

/** Payload carried in a location message's `content`. */
export type LocationPayload = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  /** Epoch ms this live share stops. Absent or 0 = a one-off pin. */
  liveUntil?: number | null;
  /** When the coordinates were last updated. */
  updatedAt?: number | null;
};

export function parseLocation(content: string | null | undefined): LocationPayload | null {
  try {
    const p = JSON.parse(String(content || ''));
    if (typeof p?.lat !== 'number' || typeof p?.lng !== 'number') return null;
    if (!isFinite(p.lat) || !isFinite(p.lng)) return null;
    if (p.lat < -90 || p.lat > 90 || p.lng < -180 || p.lng > 180) return null;
    return p;
  } catch { return null; }
}

export function isLiveNow(p: LocationPayload | null, now = Date.now()): boolean {
  return !!(p && p.liveUntil && p.liveUntil > now);
}

export function formatRemaining(untilMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((untilMs - now) / 1000));
  if (s <= 0) return 'ended';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m left`;
  if (m) return `${m}m left`;
  return `${s}s left`;
}
