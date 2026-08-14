// ── Download helpers ─────────────────────────────────────────────────────────
//
// Pure functions only, so the parts that are easy to get quietly wrong — the
// cache key and the byte formatting — can be unit tested.

/** Human-readable byte count: "812 KB", "12.4 MB". */
export function fmtBytes(b: number): string {
  if (!isFinite(b) || b <= 0) return '0 B';
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * A stable local filename for a remote media URL.
 *
 * Media URLs are HMAC-signed and expire, so the same file is served under a
 * DIFFERENT query string every time it is refreshed. Keying the cache on the
 * whole URL would therefore re-download a video the user already has, every
 * time its signature was renewed — so the query is dropped and only the path
 * identifies the file.
 */
export function localNameFor(url: string, prefix = 'dl-'): string {
  const noQuery = String(url || '').split('?')[0].split('#')[0];
  const base = noQuery.split('/').filter(Boolean).pop() || 'file';
  // Everything a filesystem might object to becomes an underscore. The name is
  // decoded first so an %-escaped upload keeps one stable spelling.
  let decoded = base;
  try { decoded = decodeURIComponent(base); } catch {}
  const safe = decoded.replace(/[^\w.\-]/g, '_').slice(-120);
  return `${prefix}${safe || 'file'}`;
}

/** 0–100, clamped, and 0 when the total size is not known yet. */
export function progressPercent(written: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (written / total) * 100));
}
