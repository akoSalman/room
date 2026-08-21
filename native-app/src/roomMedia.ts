// ── The shared-media gallery: everything about it that is not pixels ─────────
//
// Reported as: "gallery does not work good at all — it lags all the time, does
// extra scroll, and loads every time opening it."
//
// All three had the same root: the gallery had no memory and no shape.
//
//  • LOADS EVERY TIME. Every open fetched the entire media list of the room —
//    a scan of thousands of messages, up to two thousand photo entries — and
//    nothing could be drawn until it landed. Nothing was kept, so closing and
//    reopening paid the whole cost again. Here the room's media is remembered
//    between opens, so reopening draws instantly and any refresh happens
//    behind what is already on screen.
//
//  • EXTRA SCROLL. The grid restored its position from an effect that re-ran
//    on tab changes and dimension changes as well as on opening, so it would
//    yank the list out from under a finger that was already scrolling.
//    `restoreToken` gives a restore exactly one identity — this open, this
//    photo — and it happens once for it and never again.
//
//  • LAGS. A single list of every photo in the room. Photos now arrive a page
//    at a time and the grid is built from ROWS, so each row has an exact known
//    height and nothing has to be measured or guessed while scrolling.
//
// The rules live here, away from the component, because they are the part that
// can be wrong in ways a screenshot will not show.

export type MediaItem = {
  url: string;
  msgId?: number | string;
  name?: string;
  kind?: string;
  /** False when this viewer may not keep a copy (disappearing, or not theirs). */
  cacheable?: boolean;
};

export type MediaTab = 'images' | 'files' | 'music' | 'links';

/** What the gallery knows about one room. */
export type MediaState = {
  images: MediaItem[];
  files: MediaItem[];
  music: MediaItem[];
  links: MediaItem[];
  /** Message id to ask for the next photo page before; null when unknown. */
  imagesCursor: number | null;
  imagesHasMore: boolean;
  /** When the first page was last fetched, for staleness. */
  fetchedAt: number;
};

/** One response from the server. Fields it did not send stay undefined. */
export type MediaPage = {
  images?: any;
  files?: any;
  music?: any;
  links?: any;
  imagesCursor?: number | null;
  imagesHasMore?: boolean;
};

/** The server used to send bare url strings; accept both shapes. */
export function normalise(list: any): MediaItem[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((x: any) => (typeof x === 'string' ? { url: x } : x))
    .filter((x: any) => x && typeof x.url === 'string' && x.url);
}

export function emptyState(now = 0): MediaState {
  return { images: [], files: [], music: [], links: [], imagesCursor: null, imagesHasMore: false, fetchedAt: now };
}

/** A first page becomes the whole of what we know. */
export function fromFirstPage(raw: MediaPage, now = 0): MediaState {
  const images = normalise(raw?.images);
  return {
    images,
    files: normalise(raw?.files),
    music: normalise(raw?.music),
    links: normalise(raw?.links),
    imagesCursor: raw?.imagesCursor ?? null,
    // An older server sends no paging fields at all and the whole list in one
    // go; treating that as "there is more" would leave the grid asking for a
    // page that never comes.
    imagesHasMore: raw?.imagesHasMore === true,
    fetchedAt: now,
  };
}

/**
 * Another page of photos onto the end.
 *
 * Duplicates are dropped rather than appended: a page boundary that moves —
 * because something was deleted between two requests — would otherwise show
 * the same photo twice and give two rows the same key.
 */
export function appendImages(state: MediaState, page: MediaPage): MediaState {
  const extra = normalise(page?.images);
  const seen = new Set(state.images.map(i => i.url));
  const fresh = extra.filter(i => !seen.has(i.url));
  return {
    ...state,
    images: fresh.length ? state.images.concat(fresh) : state.images,
    imagesCursor: page?.imagesCursor ?? state.imagesCursor,
    imagesHasMore: page?.imagesHasMore === true,
  };
}

/**
 * A re-fetched FIRST page merged into what is already loaded.
 *
 * The point is to pick up photos sent since the gallery was last opened
 * without throwing away the pages the user has already scrolled through — and
 * without moving the ground under them. New photos are newer than everything
 * held, so they go on the front and the rest keeps its place.
 *
 * If the new page and the old head have nothing in common the history has
 * moved too far to stitch (a long absence, or a bulk delete) and the state is
 * replaced outright — better a clean reload than a list with a hole in it.
 */
export function mergeRefresh(state: MediaState, raw: MediaPage, now = 0): MediaState {
  const page = fromFirstPage(raw, now);
  const held = new Set(state.images.map(i => i.url));
  const overlap = page.images.some(i => held.has(i.url));
  if (!state.images.length || (!overlap && page.images.length)) {
    return page;
  }
  const added = page.images.filter(i => !held.has(i.url));
  return {
    ...state,
    images: added.length ? added.concat(state.images) : state.images,
    files: page.files,
    music: page.music,
    links: page.links,
    fetchedAt: now,
    // Cursor and hasMore describe the END of the loaded run, which the refresh
    // did not touch — taking them from a first page would rewind the paging to
    // photos already on screen.
  };
}

/** How long a remembered gallery is used without asking the server again. */
export const MEDIA_TTL_MS = 60_000;

export function isStale(state: MediaState | null, now: number, ttl = MEDIA_TTL_MS): boolean {
  if (!state) return true;
  return now - state.fetchedAt >= ttl;
}

// ── What the room remembers between opens ────────────────────────────────────
//
// Module level, not component state: the whole point is to outlive the
// component, so that closing the gallery and opening it again is free.

const cache = new Map<string, MediaState>();
/** Rooms whose media changed since they were cached. */
const dirty = new Set<string>();

export function getCached(roomId: string | number): MediaState | null {
  return cache.get(String(roomId)) || null;
}

export function putCached(roomId: string | number, state: MediaState): void {
  cache.set(String(roomId), state);
  dirty.delete(String(roomId));
}

/**
 * Something new arrived in this room.
 *
 * The cache is MARKED, not thrown away: the next open still draws instantly
 * from what is held, and the refresh that follows brings in what is new. A
 * blank gallery while a request is in flight is the thing being fixed.
 */
export function markDirty(roomId: string | number): void {
  if (cache.has(String(roomId))) dirty.add(String(roomId));
}

export function isDirty(roomId: string | number): boolean {
  return dirty.has(String(roomId));
}

export function forgetCached(roomId?: string | number): void {
  if (roomId === undefined) { cache.clear(); dirty.clear(); return; }
  cache.delete(String(roomId));
  dirty.delete(String(roomId));
}

/** Does a new message change what the gallery would show? */
export function affectsMedia(msg: any): boolean {
  if (!msg) return false;
  const t = msg.type;
  if (t === 'image' || t === 'gallery' || t === 'video' || t === 'file' || t === 'music') return true;
  // Links come from text, but only text that actually has one in it —
  // otherwise every chatty room would throw its gallery away all day.
  return t === 'text' && typeof msg.content === 'string' && /https?:\/\/|\w+\.\w{2,}/.test(msg.content);
}

/** Should the gallery go to the server when it opens? */
export function shouldRefresh(state: MediaState | null, dirtyNow: boolean, now: number, ttl = MEDIA_TTL_MS): boolean {
  if (!state) return true;
  return dirtyNow || isStale(state, now, ttl);
}

// ── The grid ─────────────────────────────────────────────────────────────────

/**
 * Photos grouped into rows.
 *
 * The grid is a list of ROWS, not of photos. A row has one known height, so
 * the list can be told exactly where every row starts instead of measuring as
 * it goes — which is what made a long gallery stutter, and what made scrolling
 * to a remembered photo land in the wrong place.
 */
export function toRows<T>(items: T[], cols: number): T[][] {
  if (cols < 1) return items.length ? [items.slice()] : [];
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return rows;
}

export function rowOf(index: number, cols: number): number {
  if (cols < 1) return 0;
  return Math.floor(Math.max(0, index) / cols);
}

/** Width of one square cell, and the row height that goes with it. */
export function cellSize(screenWidth: number, cols: number, gap: number): number {
  return Math.floor((screenWidth - gap * (cols - 1)) / cols);
}

/**
 * Should another page be asked for?
 *
 * Guarded on `loading` as well as `hasMore`: the list fires its end-reached
 * callback more than once for one arrival at the end, and without the guard
 * that is several identical requests for the same page.
 */
export function shouldLoadMore(o: { hasMore: boolean; loading: boolean; itemCount: number }): boolean {
  return o.hasMore && !o.loading && o.itemCount > 0;
}

// ── Keeping your place ───────────────────────────────────────────────────────

/**
 * The one identity a scroll-restore is allowed to happen for, or null for no
 * restore at all.
 *
 * `openId` counts opens of the gallery. Including it means reopening restores
 * again; leaving it out meant a second open sat wherever the list happened to
 * be. Excluding everything else — the tab, the screen width, the number of
 * photos loaded — means none of those can trigger a scroll, and THAT is the
 * "extra scroll": a restore effect that re-ran on a re-render and threw the
 * list back while the user was reading it.
 */
export function restoreToken(o: {
  visible: boolean; openId: number; tab: MediaTab | string; focusIndex: number;
}): string | null {
  if (!o.visible) return null;
  if (o.tab !== 'images') return null;
  if (!(o.focusIndex > 0)) return null;   // the top needs no restoring
  return `${o.openId}:${o.focusIndex}`;
}

/** Restore only for a token that has not already been honoured. */
export function shouldRestore(token: string | null, done: string | null): boolean {
  return token !== null && token !== done;
}

/**
 * Where the grid should sit when it comes back from the fullscreen viewer.
 *
 * Reported as: closing a photo scrolls the grid down until that photo is on
 * the top row. It was restoring by ROW INDEX, and scrolling to an index puts
 * that row at the top of the screen — so a photo you opened from the middle
 * of the screen came back at the top, dragging everything with it.
 *
 * A gallery should not move at all when you close a picture you can already
 * see. So: keep the offset the grid had, and only scroll when the photo is
 * genuinely off screen — which happens when the viewer was swiped through to
 * a different one. Then it is centred, because a photo arriving at the very
 * edge of the screen is barely better than not scrolling.
 */
export function restoreOffset(o: {
  savedOffset: number;
  focusRow: number;
  rowHeight: number;
  viewportHeight: number;
  maxOffset?: number;
}): number {
  const saved = Math.max(0, o.savedOffset || 0);
  if (!(o.rowHeight > 0) || !(o.viewportHeight > 0)) return saved;
  const top = Math.max(0, o.focusRow) * o.rowHeight;
  const bottom = top + o.rowHeight;
  // Wholly visible where we already are: leave it exactly alone.
  if (top >= saved && bottom <= saved + o.viewportHeight) return saved;
  const centred = top - (o.viewportHeight - o.rowHeight) / 2;
  const cap = o.maxOffset === undefined ? Infinity : Math.max(0, o.maxOffset);
  return Math.max(0, Math.min(centred, cap));
}
