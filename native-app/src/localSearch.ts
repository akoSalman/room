// ── Searching end-to-end encrypted messages, on the device ───────────────────
//
// The server cannot search these, and that is the whole point of them: it holds
// ciphertext and no key. So it was excluding them and reporting how many it had
// skipped — honest, but the user still could not find their own messages.
//
// What Telegram does, since the question comes up: Telegram's ordinary cloud
// chats are NOT end-to-end encrypted. They are encrypted in transit and on
// disk, but Telegram holds the keys, which is exactly why it can offer instant
// server-side search across your whole history from any device. Its Secret
// Chats, which ARE end-to-end encrypted, live on one device, are absent from
// global search, and are searched locally by the app that holds the key.
// Signal, being end-to-end throughout, searches everything locally.
//
// There is no third option. Either the server can read the text — and can
// therefore index it — or the device does the work. This app keeps the
// encryption and does the work here: the server hands over the ciphertext it
// already stores, the device decrypts it in memory and matches locally, and no
// plaintext and no query ever leaves the phone.
//
// The matching itself is the substance of this file, and it is mostly about
// Persian. Written Persian has several ways to spell the same word, and a
// search that ignores them finds nothing while looking like it works.

export type Hit = {
  id: number | string;
  content: string;
  created_at?: string;
  user_id?: number;
  username?: string;
  avatar?: string | null;
};

/**
 * One spelling for text that has several.
 *
 * Persian and Arabic share an alphabet but not its conventions, and a phone
 * keyboard may produce either:
 *
 *   • ي (Arabic yeh) and ی (Farsi yeh) look identical in most fonts
 *   • ك (Arabic kaf) and ک (Farsi keheh) likewise
 *   • ه‌ي vs ۀ, أ إ آ ٱ vs ا — the same word, different code points
 *   • the zero-width non-joiner inside می‌روم is invisible and often absent
 *   • ٠١٢ (Arabic-Indic), ۰۱۲ (extended) and 012 are the same numbers
 *   • harakat (َ ِ ُ ّ ْ) are optional and rarely typed
 *
 * Someone searching for "میروم" must find "می‌روم", and someone who typed a
 * word with an Arabic yeh must find their own message back.
 */
export function normalise(s: string): string {
  return String(s || '')
    .toLowerCase()
    // Yeh, kaf, heh and the alef family.
    .replace(/[يىۍ]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ۀ]/g, 'ه')
    .replace(/[ة]/g, 'ه')
    // Optional vowel marks and the tatweel used to stretch a word.
    .replace(/[ً-ْٰـ]/g, '')
    // Zero-width joiners and non-joiners: invisible, and usually not typed.
    .replace(/[​-‏⁠﻿]/g, '')
    // Arabic-Indic and extended Arabic-Indic digits to ASCII.
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    // Runs of whitespace are one space.
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does this text contain the query, ignoring how either is spelled? */
export function matches(text: string, query: string): boolean {
  const q = normalise(query);
  if (!q) return false;
  return normalise(text).includes(q);
}

/**
 * Search already-decrypted messages, newest first.
 *
 * `limit` matches the server's, so a local search and a remote one cannot
 * return wildly different amounts of history.
 */
export function searchLocal(messages: Hit[], query: string, limit = 500): Hit[] {
  const q = normalise(query);
  if (q.length < 2) return [];
  const out: Hit[] = [];
  // Backwards: the newest match is the one most likely to be wanted, and this
  // way the limit keeps the newest rather than the oldest.
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (m && typeof m.content === 'string' && matches(m.content, q)) out.push(m);
  }
  return out;
}

/**
 * One list of results from the server's and the device's.
 *
 * Both can legitimately return the same message: a chat may hold plain and
 * encrypted messages side by side, from before encryption was switched on.
 * Ids are compared as strings because a message that has not been acknowledged
 * yet carries a temporary one.
 */
export function mergeResults(server: Hit[], local: Hit[]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const m of [...server, ...local]) {
    if (!m) continue;
    const key = String(m.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  // Newest first, by id — the same order the server returns.
  return out.sort((a, b) => Number(b.id) - Number(a.id));
}
