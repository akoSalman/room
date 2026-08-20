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
    ? `${name} will be able to message you again.`
    : `${name} will not be able to send you messages.`;
}

/** Blocking is irreversible-feeling enough to ask about; unblocking is not. */
export function blockConfirm(blocked: boolean, name: string): { title: string; body: string } | null {
  if (blocked) return null;
  return { title: `Block ${name}?`, body: `${name} will not be able to send you messages.` };
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
