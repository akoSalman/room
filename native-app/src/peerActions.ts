// ── What you can do about another person, and what it means ─────────────────
//
// Mute, block and clear all read as "make this go away", and they mean three
// very different things. Getting the wording or the availability wrong here is
// how somebody destroys a conversation they meant to hide, or thinks they have
// stopped someone contacting them when they have only silenced the buzz.
//
// The rules live here rather than inside a sheet component because they are
// exactly the part where a mistake is quiet and expensive.

export type ClearScope = 'me' | 'both';

export type PeerView = {
  username: string;
  avatar?: string | null;
  muted: boolean;
  /** When the mute ends, in ms. null = forever. */
  mutedUntil?: number | null;
  blocked: boolean;
  isSelf?: boolean;
};

/**
 * Which clear options may be offered.
 *
 * "For both" deletes the other person's copy too, so it is only ever offered
 * in a DIRECT chat. In a group it would be one member destroying everybody
 * else's record of a conversation they were all part of — and unlike a DM,
 * where the two people involved can simply talk again, there is no one there
 * whose agreement it represents.
 */
export function clearScopes(isDm: boolean): ClearScope[] {
  return isDm ? ['me', 'both'] : ['me'];
}

export function canClearForBoth(isDm: boolean): boolean {
  return clearScopes(isDm).includes('both');
}

/** The button. Short, and says which of the two it is. */
export function clearLabel(scope: ClearScope): string {
  return scope === 'both' ? 'Clear for both of us' : 'Clear just for me';
}

/**
 * The line under the button, and the reason each exists.
 *
 * Both say what happens to the OTHER person's copy, because that is the whole
 * difference between them and the only thing a person can get wrong here.
 */
export function clearHint(scope: ClearScope, name: string): string {
  return scope === 'both'
    ? `Deletes these messages for you and for ${name}. This cannot be undone.`
    : `Removes them from your device only. ${name} keeps their copy.`;
}

/** The confirmation. Irreversible things get asked about; reversible ones do not. */
export function clearConfirm(scope: ClearScope, name: string): { title: string; body: string } | null {
  if (scope === 'both') {
    return {
      title: 'Clear for both?',
      body: `These messages will be deleted for you and for ${name}, permanently.`,
    };
  }
  // Clearing your own copy takes nothing from anyone else and the chat returns
  // the moment either of you says something, so a confirmation here would be a
  // dialog that only ever gets in the way.
  return null;
}

// ── Mute and block ──────────────────────────────────────────────────────────

export function muteLabel(muted: boolean): string {
  return muted ? 'Unmute notifications' : 'Mute notifications';
}

/**
 * How long a mute lasts, offered as a choice.
 *
 * Two options and no more. A list of durations is a menu somebody has to read
 * while already irritated by a chat that will not shut up; "for a while" and
 * "for good" is the whole of what anybody wants at that moment.
 */
export type MuteFor = '2h' | 'forever';

/** The choices, in the order they are offered. */
export const MUTE_CHOICES: MuteFor[] = ['2h', 'forever'];

export function muteChoiceLabel(choice: MuteFor): string {
  return choice === '2h' ? 'For 2 hours' : 'Until I turn it back on';
}

/**
 * What a mute in force says about itself.
 *
 * `until` is a millisecond timestamp from the server, or null for forever.
 * Formatted HERE, on the phone, which is the only party that knows the user's
 * timezone — a server rendering "until 14:30" would be guessing at it.
 */
export function mutedUntilLabel(until: number | null | undefined, now = Date.now()): string {
  const t = Number(until);
  if (!Number.isFinite(t) || t <= 0) return 'Muted';
  if (t <= now) return 'Muted';       // expired but not yet swept; see mutes.js
  const mins = Math.ceil((t - now) / 60000);
  if (mins < 60) return `Muted for ${mins} more minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  return `Muted for ${hours} more hour${hours === 1 ? '' : 's'}`;
}

export function muteHint(muted: boolean, name: string): string {
  return muted
    ? `You will be notified about ${name} again.`
    // Spelled out because "mute" is widely assumed to hide the messages too,
    // and someone who wanted that wanted block.
    : `Messages from ${name} still arrive — your phone just will not ring.`;
}

export function blockLabel(blocked: boolean): string {
  return blocked ? 'Unblock' : 'Block';
}

export function blockHint(blocked: boolean, name: string): string {
  return blocked
    ? `${name}'s messages will reach you again.`
    // Deliberately says what the BLOCKER gets, not what the other person is
    // stopped from doing — because they are not stopped. Their app still lets
    // them type and send; the messages simply never arrive here, and they are
    // never told why. Promising "they cannot send you messages" would be a
    // promise about somebody else's screen that this app does not keep.
    : `You will stop receiving ${name}'s messages, and they will not see when you are online.`;
}

/** Blocking is irreversible-feeling enough to ask about; unblocking is not. */
export function blockConfirm(blocked: boolean, name: string): { title: string; body: string } | null {
  if (blocked) return null;
  return {
    title: `Block ${name}?`,
    body: `Their messages will stop reaching you, and they will not see when you are online. `
      + `They are not told that they have been blocked.`,
  };
}

/**
 * How a message of mine that was never delivered should be drawn.
 *
 * Faded, dashed, and with no delivery tick. The point is that it FEELS wrong
 * without saying anything: a ✓ would be an outright lie about a message the
 * server deliberately withheld, and a banner reading "you have been blocked"
 * would turn one person's quiet decision into a confrontation with them.
 */
export function vanishedStyle(blockedDelivery: boolean | number | undefined): {
  faded: boolean; dashed: boolean; showTicks: boolean;
} {
  const gone = !!blockedDelivery;
  return { faded: gone, dashed: gone, showTicks: !gone };
}

/**
 * Which actions belong on this person's sheet.
 *
 * None of them make sense pointed at yourself, and offering "block" on your
 * own profile is the kind of thing that gets tapped once out of curiosity.
 */
export function actionsFor(peer: PeerView, isDm: boolean): Array<'mute' | 'block' | 'clear'> {
  if (peer.isSelf) return [];
  // Clearing needs a conversation to clear. Blocking and muting do not.
  return isDm ? ['mute', 'block', 'clear'] : ['mute', 'block'];
}

/** The single letter/emoji shown for a person when they have set no avatar. */
export function avatarFor(peer: { avatar?: string | null; username: string }): string {
  return peer.avatar || peer.username.slice(0, 2).toUpperCase();
}
