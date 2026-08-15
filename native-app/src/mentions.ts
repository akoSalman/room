// Working out whether the person is part-way through typing an @name, and
// splicing the chosen name back in.
//
// Kept out of the composer so it can be tested without a renderer: the fiddly
// part is not the dropdown, it is deciding when "@" is the start of a mention
// and when it is just a character in the middle of a word (an email address,
// a price, "a@b"). Getting that wrong pops a suggestion list over the keyboard
// while someone is typing something else entirely.

/** Same character set the server and the tokenizer accept in a username. */
const NAME_CHARS = /^[a-zA-Z0-9._]*$/;

export type MentionQuery = { start: number; query: string };

/**
 * If the caret sits inside an @name that is still being typed, return where
 * that name begins and what has been typed so far (without the @).
 * Returns null when there is nothing to suggest for.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;

  // An @ must start a word. Anything word-like immediately before it means
  // this is an email address or similar, not a mention.
  const before = at > 0 ? upto[at - 1] : '';
  if (before && !/\s/.test(before)) return null;

  const query = upto.slice(at + 1);
  // A space (or any other character a username cannot contain) ends the
  // mention — past that point the person has moved on.
  if (!NAME_CHARS.test(query)) return null;
  if (query.length > 20) return null;

  return { start: at, query };
}

/**
 * Replace the partially typed name with the chosen one, leaving a trailing
 * space so the next word can just be typed. Returns the new text and where
 * the caret should end up.
 */
export function applyMention(
  text: string, start: number, caret: number, username: string,
): { text: string; caret: number } {
  const head = text.slice(0, start);
  const tail = text.slice(caret);
  // Only add the space if there isn't already one — completing a name in the
  // middle of a sentence should not leave a double space behind.
  const inserted = `@${username}` + (/^\s/.test(tail) ? '' : ' ');
  return {
    text: head + inserted + tail,
    caret: head.length + inserted.length,
  };
}

/**
 * The names to offer, by prefix first and then by any other match, so typing
 * "@al" puts "ali" above "kamal".
 */
export function filterUsernames(usernames: string[], query: string, limit = 6): string[] {
  const q = query.toLowerCase();
  if (!q) return usernames.slice(0, limit);
  const prefix: string[] = [];
  const rest: string[] = [];
  for (const u of usernames) {
    const l = u.toLowerCase();
    if (l.startsWith(q)) prefix.push(u);
    else if (l.includes(q)) rest.push(u);
  }
  return [...prefix, ...rest].slice(0, limit);
}
