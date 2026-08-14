// ── Playlist ordering ────────────────────────────────────────────────────────
//
// Pure functions, no player and no React, so shuffling can be unit tested. A
// shuffle that quietly drops or duplicates a track is very hard to notice by
// ear and very annoying to live with, so it is checked rather than eyeballed.

export type Repeat = 'off' | 'all' | 'one';

/** The next repeat mode in the cycle a user expects from one button. */
export function nextRepeat(mode: Repeat): Repeat {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
}

/**
 * Unbiased Fisher-Yates. `rng` returns 0..1 and is injectable so tests can be
 * deterministic — Math.random() by default.
 */
export function shuffled<T>(items: T[], rng: () => number = Math.random): T[] {
  const a = items.slice();          // never reorder the caller's array
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The play order for a queue, and where the currently playing track sits in it.
 *
 * Whatever is playing must keep playing across a shuffle toggle — re-ordering
 * the list is not a reason to interrupt the music — so the current track is
 * pinned:
 *   - shuffling puts it FIRST and shuffles everything else after it;
 *   - unshuffling restores the original order and reports its index there.
 */
export function orderFor<T extends { id: number | string }>(
  base: T[],
  currentId: number | string | null,
  shuffle: boolean,
  rng: () => number = Math.random,
): { order: T[]; index: number } {
  if (!base.length) return { order: [], index: -1 };

  if (!shuffle) {
    const index = base.findIndex(t => String(t.id) === String(currentId));
    return { order: base.slice(), index: index < 0 ? 0 : index };
  }

  const current = base.find(t => String(t.id) === String(currentId));
  const rest = base.filter(t => String(t.id) !== String(currentId));
  const mixed = shuffled(rest, rng);
  return current
    ? { order: [current, ...mixed], index: 0 }
    : { order: mixed, index: 0 };
}
