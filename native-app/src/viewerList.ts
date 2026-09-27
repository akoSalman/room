// ── Which photos the fullscreen viewer can reach ───────────────────────────
//
// Reported as: opening an image in a chat, the counter says "3 / 12" when the
// chat holds hundreds, and swiping stops at the edge of that twelve.
//
// Both symptoms are one cause. The viewer's list came from `chatImageUrls()`,
// which walks `messagesRef.current` — the messages currently loaded in the
// chat window. That is a page, not a conversation. Scroll up to load more and
// the same photo suddenly has a different number under it, which is the tell.
//
// So the list has to come from the server, which is the only thing that knows
// how many photos the chat has. This module is the part that is easy to get
// wrong: putting that list together with the one already on screen.
//
// ── Why the urls cannot simply be compared ──────────────────────────────────
//
// Every media url is signed: `/uploads/x.jpg?e=<expiry>&s=<hmac>`. The expiry
// is bucketed to the day, so two urls for the SAME photo are byte-identical
// within a bucket and different across one. Comparing urls therefore works
// almost always and fails at midnight — the worst kind of bug, and one this
// codebase has already been bitten by once: the media gallery's urls "often
// weren't found in the chat's list, so the viewer opened at index 0".
//
// The identity of a photo is its upload FILENAME. Uploads are uniquely named,
// the name is in every url for that file, and no signature touches it.
//
// ── Why the local url wins ──────────────────────────────────────────────────
//
// When both lists hold the same photo, the merged list keeps the url the chat
// was already using. The two are equally valid, but the image cache is keyed
// by url — so preferring the server's would re-download a photo that is on
// screen at that moment, over a metered connection, to show the identical
// bytes. Same picture, same position, but paid for twice.

/**
 * The stable identity of a photo: the filename the upload was stored under.
 *
 * Null when there isn't one, and callers must treat null as "matches
 * nothing" rather than as a key — otherwise every unidentifiable url
 * collides with every other one and the merge dedupes real photos away.
 */
export function photoKey(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  // Query and fragment first: the signature lives in the query, and a '/'
  // inside it would otherwise be mistaken for a path separator.
  const bare = url.split('#')[0].split('?')[0];
  const name = bare.slice(bare.lastIndexOf('/') + 1);
  if (!name) return null;
  // Percent-encoding is decoded so that '%20' and ' ' are one photo, not two.
  try { return decodeURIComponent(name); } catch { return name; }
}

/**
 * The full list to browse, and where the photo being looked at now sits in it.
 *
 * `local` is what the chat window knows, oldest first. `full` is the room's
 * whole list from the server, oldest first, or null when it could not be had —
 * an older server, or no connection. `current` is the url on screen, and the
 * one thing this must never lose: whatever else happens, it stays in the list
 * and the returned index points at it.
 *
 * With no `full`, the answer is exactly today's behaviour. That is deliberate:
 * this has to degrade to "the feature is absent", never to "the wrong photo".
 */
export function mergeViewerList(o: {
  local?: string[] | null;
  full?: string[] | null;
  current?: string | null;
}): { images: string[]; index: number } {
  const local = Array.isArray(o && o.local) ? o!.local!.filter(u => typeof u === 'string' && u) : [];
  const full = Array.isArray(o && o.full) ? o!.full!.filter(u => typeof u === 'string' && u) : null;
  const current = o && typeof o.current === 'string' && o.current ? o.current : null;

  if (!full || !full.length) return place(local, current);

  // The url the chat is already showing for each photo, so the merged list can
  // prefer it and leave the image cache alone.
  const byKey = new Map<string, string>();
  for (const u of local) {
    const k = photoKey(u);
    if (k && !byKey.has(k)) byKey.set(k, u);
  }

  const images: string[] = [];
  const taken = new Set<string>();
  for (const u of full) {
    const k = photoKey(u);
    // A url with no readable name is still a photo; it just cannot be matched
    // or deduped, so it is passed through as itself.
    if (!k) { images.push(u); continue; }
    if (taken.has(k)) continue;
    taken.add(k);
    images.push(byKey.get(k) || u);
  }

  // Photos the server does not know about yet, in the order the chat has them.
  // In practice this is one just-sent photo — the upload has finished on this
  // device and the list was fetched before it did. They are the newest, and
  // the list runs oldest first, so the end is where they belong.
  for (const u of local) {
    const k = photoKey(u);
    if (k && taken.has(k)) continue;
    if (k) taken.add(k);
    images.push(u);
  }

  return place(images, current);
}

/**
 * The index of `current`, inserting it if the list somehow lost it.
 *
 * Matched by key rather than by url for the reason in the header — and falling
 * back to 0 rather than -1, because an index of -1 hands the gallery a photo
 * that does not exist.
 */
function place(images: string[], current: string | null): { images: string[]; index: number } {
  if (!current) return { images, index: 0 };
  const want = photoKey(current);
  let idx = -1;
  if (want) {
    for (let i = 0; i < images.length; i++) {
      if (photoKey(images[i]) === want) { idx = i; break; }
    }
  } else {
    idx = images.indexOf(current);
  }
  if (idx >= 0) return { images, index: idx };
  return { images: [current, ...images], index: 0 };
}
