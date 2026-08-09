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

// Order matters: URLs first, then phone-shaped runs, then any bare number.
const URL = 'https?:\\/\\/[^\\s]+|(?:[a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(?:\\/[^\\s]*)?';
const PHONE = `\\+?[${D}](?:[${SEP}]?[${D}]){7,17}`;
const NUMBER = `[${D}]+(?:[.,\u066B\u066C][${D}]+)*`;   // 1,234.56 / ۱۲۳٫۴۵

export const TOKEN_RE = new RegExp(`(${URL}|${PHONE}|${NUMBER})`, 'g');

export type TokenKind = 'url' | 'phone' | 'number' | 'text';

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

export function isUrl(t: string): boolean {
  return /^https?:\/\//i.test(t) || /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/.test(t);
}

// A phone number: enough digits to dial, not too many to be one, and not a
// decimal amount. Card numbers (16 digits) are deliberately NOT phones.
export function isPhone(t: string): boolean {
  if (isUrl(t)) return false;
  const digits = countDigits(t);
  if (digits < 8 || digits > 15) return false;
  if (/[.,\u066B]\d{1,2}$/.test(t)) return false; // looks like an amount
  return true;
}

export function classify(token: string): TokenKind {
  if (!token) return 'text';
  if (isUrl(token)) return 'url';
  if (isPhone(token)) return 'phone';
  if (countDigits(token) > 0) return 'number';
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
    const kind = classify(trimmed);
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
