// What the connection banner should show, as a pure function of the connection
// state and how long it has held it.
//
// Kept apart from the component because the interesting part is timing, not
// markup: "offline" has to stay up for as long as it is true, while "back
// online" is news — it must appear when the connection returns and then get
// out of the way, and it must NOT appear when the app simply starts up
// connected, which is not news at all.

export type BannerState = 'hidden' | 'offline' | 'restored';

/** How long "Back online" stays up before it stops being worth screen space. */
export const RESTORED_MS = 2500;

export function bannerFor(
  connection: 'online' | 'offline',
  /** Milliseconds since the connection state last CHANGED. */
  heldFor: number,
  /** False until the app has actually been offline at least once. */
  wasOffline: boolean,
): BannerState {
  if (connection === 'offline') return 'offline';
  // Online, but only worth announcing if it is a recovery rather than the
  // ordinary state of things.
  if (!wasOffline) return 'hidden';
  return heldFor < RESTORED_MS ? 'restored' : 'hidden';
}
