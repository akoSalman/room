// Splitting message text into copyable/actionable tokens.
//
// Kept as pure logic (no React) so it can be unit tested — the digit handling
// in particular is easy to get subtly wrong.
//
// Digits come in three flavours users actually type here:
//   ASCII        0-9
//   Persian      ۰-۹  U+06F0–U+06F9
//   Arabic-Indic ٠-٩  U+0660–U+0669
// All three must be recognised, and normalised to ASCII before being handed to
// tel: links (a dialler cannot parse ۰۹۱۲…).

export const PERSIAN_ZERO = 0x06f0;
export const ARABIC_ZERO = 0x0660;

const D = '0-9\u06F0-\u06F9\u0660-\u0669';           // any digit
const SEP = ' \\-()\u200f\u200e.'; // separators allowed inside a phone number

// Order matters: URLs first, then reference codes, then phone-shaped runs,
// then any bare number.
const URL = 'https?:\\/\\/[^\\s]+|(?:[a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(?:\\/[^\\s]*)?';
// IBANs, tracking numbers and the like: a short letter prefix glued to a long
// digit run. Without this, "IR100560611828005461905601" lost its "IR" and the
// digits were split in two (see the trailing guard below).
const CODE = `[A-Za-z]{1,4}[${D}]{8,}(?![${D}])`;
// The trailing (?![D]) is what stops a phone match from eating the FIRST 18
// digits of a longer run: a 24-digit account number used to match PHONE for
// its first 18 digits, leaving the remaining 6 as a separate token — so
// tapping one half copied 18 digits and the other half copied 6. With the
// guard, no repetition count can satisfy PHONE inside a longer run, and the
// whole run falls through to NUMBER as a single token.
const PHONE = `\\+?[${D}](?:[${SEP}]?[${D}]){7,17}(?![${D}])`;
const NUMBER = `[${D}]+(?:[.,\u066B\u066C][${D}]+)*`;   // 1,234.56 / ۱۲۳٫۴۵

// @mention. The same shape the server accepts as a username, so what looks
// like a mention in the chat is exactly what the server would resolve. It must
// come FIRST in the alternation: '@user2' would otherwise have its digits
// split off as a NUMBER.
const MENTION = `@[a-zA-Z0-9._]{3,20}`;

export const TOKEN_RE = new RegExp(`(${MENTION}|${URL}|${CODE}|${PHONE}|${NUMBER})`, 'g');

export type TokenKind = 'url' | 'phone' | 'number' | 'mention' | 'text';

// Convert Persian/Arabic-Indic digits to ASCII.
export function toAsciiDigits(s: string): string {
  return String(s).replace(/[\u06F0-\u06F9\u0660-\u0669]/g, ch => {
    const c = ch.charCodeAt(0);
    const base = c >= PERSIAN_ZERO ? PERSIAN_ZERO : ARABIC_ZERO;
    return String(c - base);
  });
}

export function countDigits(s: string): number {
  return (String(s).match(new RegExp(`[${D}]`, 'g')) || []).length;
}

/**
 * How many digits a bare number needs before it is worth offering to copy.
 *
 * Asked for as: only numbers with four or more digits should be copyable.
 *
 * Every digit run used to become a tappable chip, so "ساعت ۲ میریم" — "we're
 * leaving at 2" — drew a copy chip around the 2. A number that short is being
 * used as a word, and turning it into a control both litters the sentence and
 * puts a tap target in the middle of text somebody is trying to read.
 *
 * Four is where the useful ones start: a year, a room number, a verification
 * code, an amount. Below that it is prose.
 */
export const MIN_COPY_DIGITS = 4;

export function isUrl(t: string): boolean {
  return /^https?:\/\//i.test(t) || /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/.test(t);
}

// A phone number: enough digits to dial, not too many to be one, and not a
// decimal amount. Card numbers (16 digits) are deliberately NOT phones.
export function isPhone(t: string): boolean {
  if (isUrl(t)) return false;
  if (/[A-Za-z]/.test(t)) return false;   // reference codes are not phone numbers
  const digits = countDigits(t);
  if (digits < 8 || digits > 15) return false;
  if (/[.,\u066B]\d{1,2}$/.test(t)) return false; // looks like an amount
  return true;
}

export function classify(token: string): TokenKind {
  if (!token) return 'text';
  if (token[0] === '@') return 'mention';
  if (isUrl(token)) return 'url';
  if (isPhone(token)) return 'phone';
  // Long enough to be worth copying, rather than a number used as a word.
  if (countDigits(token) >= MIN_COPY_DIGITS) return 'number';
  return 'text';
}

export type Token = { text: string; kind: TokenKind };

// Split a message into alternating plain-text and actionable tokens.
export function tokenize(content: string): Token[] {
  const src = String(content ?? '');
  const out: Token[] = [];
  let last = 0;
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), kind: 'text' });
    const raw = m[0];
    // Trailing separators (". " at the end of a sentence) belong to the text.
    const trimmed = raw.replace(/[\s.,\-()]+$/, '');
    let kind = classify(trimmed);
    // An '@' glued to the end of a word is an email address, not a mention:
    // "me@example.com" would otherwise render "@example.com" as a tappable
    // mention of a user who does not exist. A mention starts a word.
    if (kind === 'mention') {
      const before = m.index > 0 ? src[m.index - 1] : '';
      if (before && /[\w.@-]/.test(before)) kind = 'text';
    }
    if (!trimmed || kind === 'text') {
      out.push({ text: raw, kind: 'text' });
    } else {
      out.push({ text: trimmed, kind });
      if (raw.length > trimmed.length) out.push({ text: raw.slice(trimmed.length), kind: 'text' });
    }
    last = m.index + raw.length;
  }
  if (last < src.length) out.push({ text: src.slice(last), kind: 'text' });
  return out;
}

// The string to hand to a tel: URI.
export function telHref(phone: string): string {
  const ascii = toAsciiDigits(phone);
  const plus = ascii.trim().startsWith('+') ? '+' : '';
  return 'tel:' + plus + ascii.replace(/[^\d]/g, '');
}
