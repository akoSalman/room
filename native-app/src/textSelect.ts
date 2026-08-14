// ── Finding the word under a tap ─────────────────────────────────────────────
//
// React Native gives no hit-testing from a touch to a character. What it does
// give is <Text onTextLayout>, which reports every rendered LINE with its
// position, size and text. That makes the line exact; within the line the
// character is estimated from how far across the tap landed.
//
// The estimate can be a character or two out with a proportional font, which is
// why the result is then snapped outwards to whole word boundaries — being
// slightly off inside a word still selects the right word.

export type TextLine = { text: string; x: number; y: number; width: number; height: number };

/** Characters that end a word. Deliberately not letters, digits or marks. */
const BOUNDARY = /[\s.,;:!?()[\]{}"'«»…\-–—/\\|]/;

/**
 * The character offset in the whole string that a tap at (x, y) landed on.
 *
 * Returns -1 when there are no lines to work with, so the caller can fall back
 * to selecting everything rather than guessing.
 */
export function charIndexAt(lines: TextLine[], x: number, y: number): number {
  if (!lines || !lines.length) return -1;

  // Which line: exact, since every line reports its own box.
  let li = lines.findIndex(l => y >= l.y && y < l.y + l.height);
  if (li < 0) li = y < lines[0].y ? 0 : lines.length - 1;

  // Where each line starts in the full string. The reported line texts
  // concatenate back to the original, so lengths accumulate.
  let start = 0;
  for (let i = 0; i < li; i++) start += lines[i].text.length;

  const line = lines[li];
  const len = line.text.length;
  if (!len) return start;
  if (!line.width || line.width <= 0) return start;

  const frac = (x - line.x) / line.width;
  const within = Math.round(frac * len);
  return start + Math.max(0, Math.min(len, within));
}

/**
 * The word surrounding a character offset, as a selection range.
 *
 * A tap on whitespace or punctuation takes the word before it — landing in the
 * gap after a word almost always means that word was the target.
 */
export function wordRangeAt(text: string, index: number): { start: number; end: number } {
  const s = String(text ?? '');
  if (!s.length) return { start: 0, end: 0 };
  // Out of range, or unknown (-1): select everything rather than guess.
  if (index < 0 || index > s.length) return { start: 0, end: s.length };

  let i = Math.min(index, s.length - 1);
  // On a boundary: step back onto the previous word if there is one.
  if (BOUNDARY.test(s[i])) {
    let back = i - 1;
    while (back >= 0 && BOUNDARY.test(s[back])) back--;
    if (back < 0) return { start: 0, end: s.length };   // nothing but separators
    i = back;
  }

  let start = i;
  while (start > 0 && !BOUNDARY.test(s[start - 1])) start--;
  let end = i + 1;
  while (end < s.length && !BOUNDARY.test(s[end])) end++;
  return { start, end };
}
