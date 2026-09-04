// ── Not being able to read a message YET is not the same as never ────────────
//
// Reported with a photograph: a whole DM reading "🔒 Encrypted message (cannot
// decrypt on this device)", every bubble, both sides — and the note that
// entering a chat sometimes takes a couple of seconds to decrypt and then
// stays like that.
//
// Two mistakes, one on top of the other.
//
// THE WORDING WAS A LIE IN PROGRESS. The peer's public key is fetched over the
// network when the chat opens. Until it lands there is no key, and every
// message was drawn with the sentence used for a message that can NEVER be
// read on this device. On a connection where that request takes two seconds,
// the chat spends two seconds telling the user their conversation is lost.
//
// AND IT WAS PERMANENT. The key arriving is not a re-render on either client:
// on the app it lands in a ref, and on the web the text has already been
// written into the DOM. So whenever the messages were drawn first — which is
// exactly what happens when the key request is slow, the one case that matters
// — the failure stayed on screen until the chat was closed and opened again.
//
// So: a message that cannot be read yet says so in those words, the key is
// retried rather than attempted once, and the arrival of a key repaints what
// was drawn without it.
//
// Mirrored by public/js/e2eState.js, compared function by function in
// test/e2eState.test.js.

export type Phase = 'waiting' | 'ready' | 'unavailable';

/**
 * How long to wait before asking for the peer's key again.
 *
 * One attempt was all there was, and a request made in the second before the
 * network came up simply lost the whole conversation until the screen was
 * reopened. Quick first, because the commonest failure is that early.
 */
const RETRY_LADDER = [400, 1200, 3000, 6000];

/** How many attempts in total. Beyond this the chat says it cannot read them. */
export const KEY_ATTEMPTS = RETRY_LADDER.length + 1;

export function keyRetryDelay(attempt: number): number {
  const i = Math.min(Math.max(Math.floor(attempt), 0), RETRY_LADDER.length - 1);
  return RETRY_LADDER[i];
}

export function keepTryingKey(attempt: number): boolean {
  return attempt < KEY_ATTEMPTS;
}

/**
 * What state this chat's encryption is in.
 *
 * `ready` is about the DEVICE's own identity — whether this browser or phone
 * has an unlocked private key at all. Without one there is nothing to wait
 * for and the user is asked to unlock, which is a different conversation from
 * this one.
 */
export function phaseFor(o: {
  hasKey: boolean; ready: boolean; attempts: number;
}): Phase {
  if (o.hasKey) return 'ready';
  if (!o.ready) return 'unavailable';
  return keepTryingKey(o.attempts) ? 'waiting' : 'unavailable';
}

/** Is this chat still expected to become readable on its own? */
export function stillTrying(phase: Phase): boolean {
  return phase === 'waiting';
}

/**
 * What to put in a bubble that has not been decrypted.
 *
 * The distinction is the whole point: one of these is a progress report and
 * the other is bad news, and using the bad news for both is what put "cannot
 * decrypt on this device" across an entire working conversation.
 */
export function undecryptedBody(phase: Phase): string {
  return phase === 'waiting'
    ? '🔒 Decrypting…'
    : '🔒 Encrypted message (cannot decrypt on this device)';
}

/** The short form, for a reply quote or a chat-list preview. */
export function undecryptedQuote(phase: Phase): string {
  return phase === 'waiting' ? '🔒 Decrypting…' : '🔒 Encrypted';
}

/**
 * Does what is already on screen have to be drawn again?
 *
 * Only when a key ARRIVED. Losing one cannot make anything readable, and
 * repainting on every check would redraw the conversation on a timer.
 */
export function repaintNeeded(prev: { hasKey: boolean }, next: { hasKey: boolean }): boolean {
  return !prev?.hasKey && !!next?.hasKey;
}
