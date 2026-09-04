// ── Putting the emojis you actually use first ────────────────────────────────
//
// Asked for as: the arrangement of the emoji bar should change automatically,
// based on the most used ones.
//
// The bar is a fixed list in a fixed order, and the order was chosen once by
// guessing. Everybody's is different, and the two or three anybody really uses
// end up wherever they happened to be put — which for a bar that scrolls means
// off the edge of the screen.
//
// THE PART THAT IS EASY TO GET WRONG is not the counting. It is WHEN the order
// is allowed to change. A bar that re-sorts the instant you tap something is
// hostile: your finger is already moving towards where the next one was, and
// it has just been replaced by something else. So the counting happens
// immediately and the ORDER is recomputed only when the bar is opened — see
// orderFor's callers. Between one opening and the next, the bar is fixed.
//
// Mirrored by public/js/emojiOrder.js, compared function by function in
// test/emojiOrder.test.js.

export type Counts = Record<string, number>;

/**
 * Past this, every count is halved.
 *
 * Which is what makes this "most used LATELY" rather than "most used ever". An
 * emoji used forty times last year should not outrank one used ten times this
 * week, and without ageing the bar would freeze into whatever the first month
 * of use looked like.
 */
export const AGE_AT = 60;

/** How many counts are worth keeping. The bar is at most sixteen. */
export const MAX_TRACKED = 40;

/** One more use of `emoji`. Returns a NEW object; the old one is untouched. */
export function bump(counts: Counts | null | undefined, emoji: string): Counts {
  const key = String(emoji || '');
  if (!key) return { ...(counts || {}) };
  const next: Counts = { ...(counts || {}) };
  next[key] = (Number(next[key]) || 0) + 1;
  if (next[key] < AGE_AT) return trim(next);
  // Halved together, so their ORDER survives the ageing — this is a change of
  // scale, not of ranking.
  for (const k of Object.keys(next)) next[k] = Math.floor(next[k] / 2);
  return trim(next);
}

/** Forget the long tail, so this cannot grow without bound. */
export function trim(counts: Counts, max = MAX_TRACKED): Counts {
  const keys = Object.keys(counts);
  if (keys.length <= max) return counts;
  const kept = keys
    .sort((a, b) => (counts[b] - counts[a]) || (a < b ? -1 : 1))
    .slice(0, max);
  const out: Counts = {};
  for (const k of kept) out[k] = counts[k];
  return out;
}

/**
 * The bar, most-used first.
 *
 * The SET does not change — this is a reordering of the emojis the user has,
 * never an addition or a removal. Somebody who edited their list to hold
 * exactly the twelve they want still has exactly those twelve.
 *
 * Ties keep their original order, which is what stops the bar shuffling for no
 * reason: two emojis used the same number of times stay as they were, and an
 * emoji nobody has used yet never moves at all.
 */
export function orderFor(list: string[], counts: Counts | null | undefined): string[] {
  const c = counts || {};
  return (list || []).slice().map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const d = (Number(c[b.e]) || 0) - (Number(c[a.e]) || 0);
      return d !== 0 ? d : a.i - b.i;
    })
    .map(x => x.e);
}

/**
 * Is this worth counting?
 *
 * Only what the user PICKED. A message that happens to contain an emoji is not
 * a vote for it — that would let one long message about a party promote 🎉
 * over the things they reach for every day.
 */
export function countsAsUse(source: 'bar' | 'reaction' | 'typed'): boolean {
  return source === 'bar' || source === 'reaction';
}
