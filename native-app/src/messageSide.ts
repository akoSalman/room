// ── Which side of the chat a message goes on ─────────────────────────────────
//
// Reported with a screenshot: messages sent with no internet, which failed,
// come back on the LEFT — the other person's side — after closing the chat and
// opening it again, with "Failed — tap to retry" under them.
//
// The side was decided by one string comparison: `msg.username === me`. That
// is right for anything the server sent back, and fragile for the rows this
// app makes itself.
//
// A message being sent is created locally, stamped with whatever the screen
// currently believes the user is called, and persisted so a failed send can be
// retried after a restart. Two things then go wrong together:
//
//   • `me` is state, and a retry dispatched from a timer runs with whatever
//     value that closure captured — an empty string, if the retry was
//     scheduled before the username had been read back;
//   • the row is then persisted with `username: ''`, so it is wrong for good.
//     Fixing the stamping alone would leave every message already sitting in
//     somebody's outbox on the wrong side forever.
//
// So a message this device made is marked as OURS when it is made, and that
// mark travels with it into storage. A string is evidence; the mark is a fact.

export type SideInput = {
  /** Stamped by us on anything this device composed. */
  _mine?: boolean;
  /** Present on anything the server sent back. */
  username?: string | null;
  /** A local row waiting to be sent, or one that failed. */
  _uploading?: boolean;
  _uploadFailed?: boolean;
  /** Local rows carry a string id; the server's are numbers. */
  id?: number | string;
};

/**
 * Is this message ours?
 *
 * In order of how much the evidence is worth:
 *
 *   1. the mark we put on it ourselves;
 *   2. an in-flight or failed row with a local (string) id — only our own
 *      sends are ever in that state, which is what rescues the rows already
 *      persisted with an empty username;
 *   3. the username, for everything that came from the server.
 */
export function isMine(msg: SideInput | null | undefined, me: string): boolean {
  if (!msg) return false;
  if (msg._mine) return true;
  // A local row: the id is the client id we generated, not a server row id.
  if ((msg._uploading || msg._uploadFailed) && typeof msg.id === 'string') return true;
  // An empty username on OUR side would match an empty `me` and put somebody
  // else's message on the right — so both have to be real to count.
  if (!me || !msg.username) return false;
  return msg.username === me;
}

/** Stamp a row this device composed, so its side never depends on a guess. */
export function markMine<T extends object>(msg: T): T & { _mine: true } {
  return { ...msg, _mine: true };
}
