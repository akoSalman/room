// ── The slice of a chat that is currently loaded ─────────────────────────────
//
// A chat is normally shown from its newest message backwards, and the only
// direction that can run out is older. Jumping to a message from months ago
// breaks that assumption: the loaded messages are now a window in the MIDDLE of
// the history, with more in both directions.
//
// The old code merged the jump's window into whatever was already on screen and
// sorted by id. That produces a list with a hole in it — a message from March
// sitting directly above one from August, with nothing to say that thousands
// are missing between them. Scrolling down from the message you jumped to
// silently skipped the entire history after it, which is what "it loads
// everything at once" looks like from the outside.
//
// So the window is contiguous by construction, and it knows whether there is
// more in each direction. Reaching either end loads one page that way.

export type Msg = { id: number | string; [k: string]: any };

// Generic over the caller's message type: this module only ever looks at `id`,
// and widening everything to a bare { id } at the boundary would strip the type
// off every message in the app.
export type Window<T extends Msg = Msg> = {
  /** Oldest first, contiguous — no holes. */
  messages: T[];
  hasOlder: boolean;
  /** True only after a jump, when the window stops short of the newest. */
  hasNewer: boolean;
};

export const emptyWindow: Window = { messages: [], hasOlder: false, hasNewer: false };

const num = (id: number | string) => Number(id);

/** The newest page of a chat: nothing after it, by definition. */
export function atBottom<T extends Msg>(messages: T[], pageSize: number): Window<T> {
  return { messages, hasOlder: messages.length >= pageSize, hasNewer: false };
}

/**
 * The window around a jumped-to message.
 *
 * It REPLACES whatever was loaded rather than merging with it. Merging is what
 * created the hole: the two blocks are not adjacent, and once they are in one
 * array sorted by id nothing can tell where the join was.
 */
export function aroundMessage<T extends Msg>(
  messages: T[], hasOlder: boolean, hasNewer: boolean,
): Window<T> {
  return { messages, hasOlder, hasNewer };
}

/** One page further back. A short page means we have reached the beginning. */
export function prependOlder<T extends Msg>(win: Window<T>, older: T[], pageSize: number): Window<T> {
  if (!older.length) return { ...win, hasOlder: false };
  const known = new Set(win.messages.map(m => String(m.id)));
  const add = older.filter(m => !known.has(String(m.id)));
  return {
    messages: [...add, ...win.messages],
    hasOlder: older.length >= pageSize,
    hasNewer: win.hasNewer,
  };
}

/** One page forward, towards the present. */
export function appendNewer<T extends Msg>(win: Window<T>, newer: T[], pageSize: number): Window<T> {
  if (!newer.length) return { ...win, hasNewer: false };
  const known = new Set(win.messages.map(m => String(m.id)));
  const add = newer.filter(m => !known.has(String(m.id)));
  return {
    messages: [...win.messages, ...add],
    hasOlder: win.hasOlder,
    // A short page means there was nothing more to fetch, so the window now
    // reaches the present and live messages can be appended again.
    hasNewer: newer.length >= pageSize,
  };
}

/**
 * Should a message that just arrived be added to the list?
 *
 * Only when the window actually reaches the present. While the user is reading
 * a jumped-to message from March, a message arriving now belongs thousands of
 * messages later — appending it would draw it directly beneath March as though
 * it were the next thing said. It is not dropped from the chat, only from this
 * window; going back to the bottom fetches it with everything else.
 */
export function acceptsLive(win: Window<any>): boolean {
  return !win.hasNewer;
}

/** Where the id of the newest loaded message is, for asking what comes after. */
export function newestId(win: Window<any>): number | string | null {
  return win.messages.length ? win.messages[win.messages.length - 1].id : null;
}

/** And the oldest, for asking what comes before. */
export function oldestId(win: Window<any>): number | string | null {
  return win.messages.length ? win.messages[0].id : null;
}

/**
 * Is this message inside the loaded window?
 *
 * Asked before jumping: a target already on screen needs no request at all.
 */
export function contains(win: Window<any>, id: number | string): boolean {
  return win.messages.some(m => String(m.id) === String(id));
}

/**
 * Trim a window that has grown long, keeping the end the user is reading.
 *
 * Walking forward through months of history one page at a time would otherwise
 * accumulate every page in memory, and these are phones with not much of it.
 * Dropping from the far end is safe because the flag says it can be re-fetched.
 */
export function trim<T extends Msg>(win: Window<T>, keep: number, from: 'older' | 'newer'): Window<T> {
  if (win.messages.length <= keep) return win;
  if (from === 'older') {
    return {
      messages: win.messages.slice(win.messages.length - keep),
      hasOlder: true,
      hasNewer: win.hasNewer,
    };
  }
  return {
    messages: win.messages.slice(0, keep),
    hasOlder: win.hasOlder,
    hasNewer: true,
  };
}

/** Newest first, which is the order an inverted list wants. */
export function inverted<T extends Msg>(win: Window<T>): T[] {
  return [...win.messages].reverse();
}

/** Sort helper shared by callers merging server payloads. */
export function byId(a: Msg, b: Msg): number {
  return num(a.id) - num(b.id);
}

// ── Following the conversation ───────────────────────────────────────────────
//
// Reported as: on a new message arriving, the auto scroll down is not
// happening.
//
// It was not, and the cause was a fix for a different problem. The list is
// INVERTED, so a new message is inserted at index 0 — the start of the
// content — and `maintainVisibleContentPosition` exists precisely to stop the
// content already on screen from moving when that happens. Anchoring
// unconditionally therefore did exactly what it says: it held the view still
// and left the new message sitting just off the bottom edge.
//
// Both behaviours are wanted, in different places, and which one applies is
// decided by whether the list is showing the present or is parked in the
// middle of the history after a jump.

/**
 * Should the list pin its visible content when rows are inserted?
 *
 * Only when parked mid-history. There, rows are inserted at the top of the
 * content as newer pages load, and without an anchor the view slides by
 * however wrong the list's estimate of the new rows was — the "history loading
 * hops" report.
 *
 * At the present there is nothing above to insert: a new message is the
 * newest thing there is, and the right response to it is to move, not to hold
 * still. Anchoring here is what stopped the chat following the conversation.
 */
export function anchorsContent(o: { hasNewer: boolean }): boolean {
  return !!o.hasNewer;
}

/**
 * Should the view follow a message that just arrived?
 *
 * Only if the reader is already at the newest end. Someone reading back
 * through yesterday does not want to be yanked to the bottom because a
 * message came in — that is what the unseen badge is for.
 *
 * A message the user sent THEMSELVES is different: pressing send is a request
 * to be at the bottom, and every chat app in the world obliges.
 */
export function followsNewMessage(o: {
  atEnd: boolean; fromMe: boolean; windowAcceptsLive: boolean;
}): boolean {
  if (!o.windowAcceptsLive) return false;   // parked mid-history; it is not even shown
  return o.fromMe || o.atEnd;
}
