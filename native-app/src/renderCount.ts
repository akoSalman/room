// ── How much the chat screen is actually redrawing ─────────────────────────
//
// Reported: after using a few animated reactions in a chat, every action in
// the app becomes slow — and going back to the chat list and in again fixes
// it. That last fact is the useful one: it means the cost lives in the chat
// screen's own state and dies when the screen is thrown away.
//
// Four rounds of reading the source have not found it. Every candidate — the
// socket listeners, the burst animation and its timers, the emoji counters,
// the reaction chips — is either bounded or cleaned up, and reading harder
// has stopped being the cheapest way to find out.
//
// So this counts the two things that would distinguish the remaining
// explanations, and they are very different:
//
//   • the screen redraws far more often than the number of things that
//     happened — something is re-rendering in a loop;
//   • the screen redraws a normal number of times but each one redraws every
//     row — the list is being told its rows changed when they did not.
//
// The ratio of the two numbers says which, and neither can be guessed from
// the source. They ride out on the device_health event the app already sends
// on every foreground/background transition, so they land in the server log
// without anybody having to photograph a screen.
//
// Deliberately two integers. No message content, no room, no username: this
// goes into a log that is read into a repository that has been public.

let screens = 0;
let rows = 0;

/** The chat screen rendered. Called from the render body, so it must be free. */
export function noteScreen(): void { screens++; }

/** One row of the message list rendered. */
export function noteRow(): void { rows++; }

/**
 * The counters so far.
 *
 * Not reset by reading. Both numbers are cumulative for the life of the
 * process, because the question is how they GROW — a single reading says
 * nothing, and resetting on read would mean two readings could never be
 * compared.
 */
export function snapshot(): { screens: number; rows: number } {
  return { screens, rows };
}

/** Back to zero. For the tests, and for a fresh sign-in. */
export function reset(): void { screens = 0; rows = 0; }
