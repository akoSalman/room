// ── Persian sentences with English words in them ─────────────────────────────
//
// Reported with two screenshots side by side: the same paragraph, correct in
// the app it was copied from and scrambled here — "(DWT) باربری" landing in the
// middle of a different clause, a full stop at the wrong end of a line, a
// number separated from the unit it belongs to.
//
// Nothing reordered the words. Unicode's bidirectional algorithm did what it
// is supposed to do, against the wrong BASE DIRECTION.
//
// Every paragraph of mixed text has a base direction, and it decides where the
// neutral characters go — spaces, digits, brackets, punctuation, the lot. A
// Persian sentence laid out in an LTR paragraph keeps its Persian words in the
// right order (they are a strong RTL run) but hangs everything neutral off the
// wrong end: the parenthesis that opened before an English acronym closes
// after the words that follow it, and a sentence's final full stop appears on
// its left. The words are all there and the sentence is unreadable.
//
// The web never set a direction at all, so every message inherited the
// document's — LTR. That is the whole bug: these users write Persian with
// English technical terms in it, which is precisely the case that needs a base
// direction of its own.
//
// The rule below picks one PER MESSAGE. It is a count rather than the "first
// strong character" that dir="auto" uses, because a Persian message that opens
// with a product name — "Suezmax یه نفتکش…" — is still a Persian message, and
// first-strong would lay the whole thing out backwards.
//
// Mirrored by public/js/bidi.js, compared function by function in
// test/bidi.test.js.

export type Direction = 'rtl' | 'ltr';

/** Hebrew, Arabic, Syriac, Thaana, Arabic Supplement/Extended, and the presentation forms. */
const RTL_CHARS = /[֐-׿؀-ۿ܀-ݏހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/g;
/** Latin, Greek and Cyrillic: the strong LTR letters these users actually mix in. */
const LTR_CHARS = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;

/**
 * How much of the strong text has to be RTL before the paragraph is RTL.
 *
 * A third. Well below half on purpose: a line like "قیمت این tanker حدود 40
 * million dollar است" is a Persian sentence with English in it, not an English
 * sentence — and laying it out LTR is what scrambles it.
 */
export const RTL_SHARE = 0.3;

/** Which way round this text should be laid out. */
export function baseDirection(text: string | null | undefined): Direction {
  const s = String(text || '');
  const rtl = (s.match(RTL_CHARS) || []).length;
  const ltr = (s.match(LTR_CHARS) || []).length;
  if (!rtl) return 'ltr';
  return rtl >= (rtl + ltr) * RTL_SHARE ? 'rtl' : 'ltr';
}

/** Where the text sits in its bubble, given that direction. */
export function alignFor(dir: Direction): 'right' | 'left' {
  return dir === 'rtl' ? 'right' : 'left';
}

/** Both, for a piece of text: what the caller almost always wants. */
export function textDirection(text: string | null | undefined): {
  dir: Direction; align: 'right' | 'left';
} {
  const dir = baseDirection(text);
  return { dir, align: alignFor(dir) };
}

const FSI = '⁨';   // FIRST STRONG ISOLATE
const PDI = '⁩';   // POP DIRECTIONAL ISOLATE

/**
 * Fence a fragment off from the sentence around it.
 *
 * For text DROPPED INTO another line — a name in a header, a message preview
 * in a chat list, a quoted reply above a bubble. Without a fence, a Persian
 * preview inside an English row pulls the row's own punctuation around with
 * it: "Ali: سلام" renders the colon on the wrong side, every time.
 *
 * An isolate is the right tool rather than an embedding: it hides the
 * fragment's direction from the outside, which is exactly the promise a
 * preview needs to make.
 */
export function isolate(text: string | null | undefined): string {
  const s = String(text ?? '');
  if (!s) return s;
  return FSI + s + PDI;
}
