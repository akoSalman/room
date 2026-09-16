// ── Two different things both called "delete" ────────────────────────────────
//
// Asked for as: add delete to the other side's message, but the delete is just
// for me.
//
// Until now Delete meant one thing — `delete_message`, which removes the
// message from the conversation for everybody in it — and it was offered only
// on your own messages, because it is the only kind of delete that makes sense
// there. There was no way at all to get rid of something somebody else sent:
// an unwanted photo, a message read and finished with, a chat you want to tidy.
//
// So there are now two deletes, and the whole point of this file is that they
// must never be confused for one another:
//
//   • YOUR message  → "Delete", which is `delete_message`: gone for everyone.
//   • THEIR message → "Delete for me", which is `hide_message`: gone from your
//     copy of the chat, on every device you sign in on, and untouched for them.
//
// Getting that backwards is not a cosmetic bug. Sending `delete_message` for
// somebody else's message would be one person silently deleting another
// person's words out of the conversation — so the rule is written down here,
// once, and tested, rather than being an `if` in the middle of a menu.
//
// Mirrored by public/js/messageDelete.js, compared function by function in
// test/messageDelete.test.js.

/** Which of the two deletes applies. */
export type DeleteKind = 'everyone' | 'me';

/**
 * Which delete this message gets.
 *
 * Authorship decides it, and nothing else. There is deliberately no option to
 * pick: offering "delete for everyone" on a message you did not write would
 * promise something the server will refuse, and offering "delete for me" on
 * your own would be two near-identical items in a four-item menu.
 */
export function deleteKind(o: { mine: boolean }): DeleteKind {
  return o && o.mine ? 'everyone' : 'me';
}

/**
 * The socket event each kind sends.
 *
 * Named here so neither client can reach for the other one. `delete_message`
 * on somebody else's message is the failure this whole file exists to stop.
 */
export function deleteEvent(kind: DeleteKind): string {
  return kind === 'everyone' ? 'delete_message' : 'hide_message';
}

/** What the menu item says, so the difference is visible before it is tapped. */
export function deleteLabel(kind: DeleteKind): string {
  return kind === 'everyone' ? 'Delete' : 'Delete for me';
}

/**
 * The confirmation, which has to say WHO the message disappears for.
 *
 * "Delete message?" over a message somebody else sent reads like it deletes it
 * from the conversation. It does not, and someone who believes it does will
 * think they have unsent another person's message.
 */
export function deleteConfirm(kind: DeleteKind, count = 1): { title: string; body: string } {
  const n = Math.max(1, Number(count) || 1);
  const what = n === 1 ? 'message' : `${n} messages`;
  if (kind === 'everyone') {
    return {
      title: `Delete ${what}?`,
      body: n === 1
        ? 'This removes it for everyone in the chat.'
        : 'This removes them for everyone in the chat.',
    };
  }
  return {
    title: `Delete ${what} for me?`,
    body: n === 1
      ? 'It disappears from your chat only. The sender still has it.'
      : 'They disappear from your chat only. The senders still have them.',
  };
}

export type Split = {
  /** Ids to remove from the conversation: yours. */
  forEveryone: Array<number | string>;
  /** Ids to hide from your own copy: everyone else's. */
  forMe: Array<number | string>;
};

/**
 * Sort a multi-selection into the two deletes.
 *
 * A selection is very often mixed — you pick a run of messages covering both
 * sides of a conversation — and the old code sent `delete_message` for all of
 * them. The server refused the ones that were not yours, so the selection
 * half-vanished with nothing said about the rest.
 *
 * Order is preserved within each list so the confirmation and the optimistic
 * removal iterate in the order the user sees.
 */
export function splitForDeletion(
  ids: Array<number | string>,
  isMine: (id: number | string) => boolean,
): Split {
  const out: Split = { forEveryone: [], forMe: [] };
  (ids || []).forEach(id => {
    if (deleteKind({ mine: !!isMine(id) }) === 'everyone') out.forEveryone.push(id);
    else out.forMe.push(id);
  });
  return out;
}

/**
 * One sentence for a mixed selection.
 *
 * Two confirmations in a row for one action is worse than one that explains
 * itself, so a mixed delete asks once and says what will happen to each half.
 */
export function splitConfirm(split: Split): { title: string; body: string } {
  const mine = split.forEveryone.length;
  const theirs = split.forMe.length;
  if (!mine) return deleteConfirm('me', theirs);
  if (!theirs) return deleteConfirm('everyone', mine);
  const total = mine + theirs;
  return {
    title: `Delete ${total} messages?`,
    body: `${mine} of yours will be removed for everyone. `
      + `${theirs} from other people will disappear from your chat only.`,
  };
}
