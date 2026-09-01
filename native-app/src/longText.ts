// ── Long messages, folded ────────────────────────────────────────────────────
//
// Asked for as: long text messages should be expandable and foldable.
//
// A pasted article, a forwarded poem, a chain message — one of them fills the
// whole screen and pushes every other message out of the chat. Scrolling past
// it to reach what came next means flicking through somebody else's essay, and
// on a phone that is most of a screenful per flick.
//
// So a message past a certain size is shown with its first part and a "Show
// more", and can be folded again afterwards. Two decisions worth stating:
//
//   • it folds on LINES as well as characters. A message of forty short lines
//     is as tall as one long paragraph, and height is the thing that hurts.
//   • the fold happens at a line or word boundary, never mid-word. A cut that
//     lands in the middle of a word reads as corruption rather than as a fold.
//
// The full text is always what gets copied, forwarded, searched and edited —
// folding is a way of DRAWING a message, not a change to it.

/** Past this many characters, a message is folded. */
export const FOLD_CHARS = 600;
/** …or past this many lines, whichever comes first. */
export const FOLD_LINES = 12;
/** What a folded message shows: enough to know whether to open it. */
export const PREVIEW_CHARS = 420;
export const PREVIEW_LINES = 8;

export function lineCount(text: string | null | undefined): number {
  return String(text ?? '').split('\n').length;
}

/**
 * Is this message long enough to be worth folding?
 *
 * The threshold is deliberately well above the preview size: folding a message
 * to save two lines is churn, and a "Show more" that reveals a sentence is
 * worse than the sentence.
 */
export function isLong(text: string | null | undefined): boolean {
  const t = String(text ?? '');
  return t.length > FOLD_CHARS || lineCount(t) > FOLD_LINES;
}

/**
 * The part shown while folded.
 *
 * Cut at a newline if there is one nearby, otherwise at a space; only if
 * neither exists in the last stretch is a word broken — which happens for a
 * long unbroken string, where there is nothing better to do.
 */
export function preview(text: string | null | undefined): string {
  const t = String(text ?? '');
  if (!isLong(t)) return t;

  // Lines first: this is what stops a message of many short lines from being
  // "previewed" as the whole thing.
  const byLines = t.split('\n').slice(0, PREVIEW_LINES).join('\n');
  const cutByChars = byLines.length > PREVIEW_CHARS;
  let cut = cutByChars ? byLines.slice(0, PREVIEW_CHARS) : byLines;

  // Only when the cut was made mid-line. Cutting at the line limit has already
  // landed on a boundary, and looking for another one there just throws away a
  // whole line of the preview.
  if (cutByChars) {
    const nl = cut.lastIndexOf('\n');
    const sp = cut.lastIndexOf(' ');
    // Only a boundary in the last quarter counts: one near the start would
    // throw away most of the preview to avoid breaking a single word.
    const floor = cut.length * 0.75;
    if (nl > floor) cut = cut.slice(0, nl);
    else if (sp > floor) cut = cut.slice(0, sp);
  }
  return cut.replace(/\s+$/, '');
}

/** What the button under a folded message says. */
export function toggleLabel(expanded: boolean): string {
  return expanded ? 'Show less' : 'Show more';
}

/**
 * What to draw right now.
 *
 * One function so the two clients cannot disagree about when the button
 * appears — a message folded on one and whole on the other would look like two
 * different messages.
 */
export function shownText(text: string | null | undefined, expanded: boolean): string {
  const t = String(text ?? '');
  return expanded || !isLong(t) ? t : preview(t) + '…';
}

/** Does this message get a Show more / Show less button at all? */
export function showsToggle(text: string | null | undefined): boolean {
  return isLong(text);
}
