// ── The links tab, in a chat the server cannot read ──────────────────────────
//
// Reported as: the profile's media menu does not list links.
//
// It lists them fine in an ordinary room. In a DM it never could, and the
// reason is the encryption working exactly as intended: the server builds that
// tab by scanning message text, and an end-to-end encrypted message is
// ciphertext to it. The collector even says so —
//
//     } else if (m.type === 'text' && m.content && !m.content.startsWith('e2e:')) {
//
// — so every encrypted message is skipped, and in a DM that is all of them.
// The tab was not broken; it was empty, permanently, and said "No links yet"
// as though that were a fact about the conversation.
//
// The device has the key. This is the same division of labour already used for
// searching an encrypted chat: the server hands over the ciphertext it cannot
// read, the device decrypts it in memory and does the work. No plaintext and
// no link ever goes back.
//
// Mirrored by public/js/mediaLinks.js, compared function by function in
// test/mediaLinks.test.js.

export type LinkItem = { url: string; msgId?: number | string };

/**
 * The same expression the server uses on the messages it CAN read.
 *
 * Deliberately identical: a link found in a room and the same link found in a
 * DM must produce the same row. A test reads the server's source and fails if
 * these two ever drift apart.
 */
export const LINK_RE = /(https?:\/\/[^\s]+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?)/g;

/** Every link in one message's text. */
export function extractLinks(text: string): string[] {
  const s = String(text || '');
  if (!s) return [];
  return s.match(new RegExp(LINK_RE.source, 'g')) || [];
}

/**
 * The links in a run of decrypted messages, newest first.
 *
 * Deduplicated by URL, keeping the FIRST sighting in the order given. Since
 * the caller passes messages newest-first, that is the most recent time the
 * link was sent — which is the one somebody scrolling this tab is looking for,
 * and the one whose "Show in chat" lands somewhere they remember.
 */
export function linksFrom(
  messages: { id?: number | string; content?: string | null }[],
  max = 200,
): LinkItem[] {
  const seen = new Set<string>();
  const out: LinkItem[] = [];
  for (const m of messages || []) {
    for (const url of extractLinks(m && m.content ? m.content : '')) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, msgId: m.id });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * The server's links and the device's, as one list.
 *
 * A chat can hold both: messages sent before encryption was set up are
 * readable by the server, and everything after it is not. Neither list is a
 * superset of the other, so both are kept.
 *
 * Ordered by message id descending, because that is the order the rest of this
 * tab is in and the two lists arrive independently sorted. Anything without an
 * id sorts last rather than being dropped — a link is still worth showing when
 * we cannot say which message it came from.
 */
export function mergeLinks(server: LinkItem[], local: LinkItem[], max = 200): LinkItem[] {
  const byUrl = new Map<string, LinkItem>();
  for (const item of [...(server || []), ...(local || [])]) {
    if (!item || !item.url) continue;
    const had = byUrl.get(item.url);
    // The same link from both sides: keep whichever knows its message, and of
    // two that do, the newer one.
    if (!had || (had.msgId == null && item.msgId != null)
      || (had.msgId != null && item.msgId != null && Number(item.msgId) > Number(had.msgId))) {
      byUrl.set(item.url, item);
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => (a.msgId == null ? -1 : Number(a.msgId)) < (b.msgId == null ? -1 : Number(b.msgId)) ? 1 : -1)
    .slice(0, max);
}
