// Knowing when a native text selection is on screen, so a tap outside it can
// dismiss the selection instead of opening the message menu.
//
// The problem this solves: message text is a plain <Text selectable>, and the
// OS owns the selection. React Native gives no way to ask whether a selection
// exists, and no way to clear one — so after double-tapping a word, a tap
// anywhere else fell straight through to the row's press handler and popped
// the message menu. That is the opposite of what a tap outside a selection
// means everywhere else.
//
// Since the platform will not tell us, we infer it from the touches we can
// see, and the inference is kept here — away from the component — because the
// ordering rules are the whole substance of the fix and are worth testing.
//
// What we can observe:
//   • a touch going DOWN on a selectable message (capture phase, not claimed)
//   • a completed quick TAP, which arrives at the row's press handler
// What we cannot observe: the touch coming back up. So a long-press is
// recognised by ABSENCE — a touch went down and no tap followed it in time,
// which means the finger stayed put and the OS started selecting.

export const DOUBLE_TAP_MS = 300;
export const LONG_PRESS_MS = 450;

export type MsgId = number | string;

export type SelectionState = {
  /** The message believed to be showing a native selection right now. */
  selecting: MsgId | null;
  /** A touch that went down and has not yet resolved into a tap. */
  pendingId: MsgId | null;
};

export type SelectionEvent =
  | { type: 'down'; id: MsgId; at: number }
  /** The pending touch never became a tap: the finger was held. */
  | { type: 'held'; id: MsgId }
  | { type: 'tap' }
  | { type: 'clear' };

/** What the component should do about this event. */
export type SelectionAction = 'menu' | 'dismiss' | null;

/** The reducer's answer: new state, new `last`, what to do, and what to clear. */
export type SelectionResult = {
  state: SelectionState;
  last: LastDown;
  action: SelectionAction;
  /**
   * The message whose on-screen selection must be wiped, if any.
   *
   * Returned explicitly rather than left for the caller to remember, because
   * the message being cleared is often NOT the one the event is about — a
   * touch on message B is what clears a stale selection on message A.
   */
  clearId: MsgId | null;
};

export const initialSelection: SelectionState = { selecting: null, pendingId: null };

// Kept outside the state so a caller cannot forget to thread it through; it is
// only ever read to spot a second tap on the same message.
type LastDown = { id: MsgId; at: number } | null;

export function reduceSelection(
  state: SelectionState, last: LastDown, ev: SelectionEvent,
): SelectionResult {
  switch (ev.type) {
    case 'down': {
      // A second tap on the same message within the double-tap window is how
      // the OS starts a word selection, so we know one is coming.
      const isDouble = !!last && last.id === ev.id && ev.at - last.at < DOUBLE_TAP_MS;

      // A selection still showing on a DIFFERENT message has to go, right now,
      // on the way down.
      //
      // This is what made double-tap work on the first message and then stop
      // working on every message after it. The OS will not start a new
      // selection while an old one is up: it spends the first tap dismissing
      // the old selection instead. So the user's double-tap on message B was
      // read as "dismiss A" followed by one ordinary tap, nothing was
      // selected, and it took a further two taps to get anywhere — exactly the
      // "tap several times outside first" workaround people found.
      //
      // Clearing it here, before the OS sees the tap, means there is no old
      // selection for the first tap to be spent on.
      const stale = state.selecting !== null && state.selecting !== ev.id ? state.selecting : null;

      return {
        state: isDouble
          ? { selecting: ev.id, pendingId: null }
          // Once the stale selection is cleared nothing is selected any more,
          // so `selecting` must drop — keeping the old id would leave the next
          // tap thinking it still had a selection to dismiss.
          : { selecting: stale ? null : state.selecting, pendingId: ev.id },
        last: { id: ev.id, at: ev.at },
        action: stale ? 'dismiss' : null,
        clearId: stale,
      };
    }
    case 'held': {
      // Only the touch we are actually waiting on can turn into a hold.
      if (state.pendingId !== ev.id) return { state, last, action: null, clearId: null };
      return { state: { selecting: ev.id, pendingId: null }, last, action: null, clearId: null };
    }
    case 'tap': {
      // While a selection is up, a tap outside it clears the selection and
      // does nothing else. The menu is NOT opened — otherwise dismissing a
      // selection and opening a menu are the same gesture.
      if (state.selecting !== null) {
        return {
          state: { selecting: null, pendingId: null },
          last, action: 'dismiss', clearId: state.selecting,
        };
      }
      return { state: { ...state, pendingId: null }, last, action: 'menu', clearId: null };
    }
    case 'clear':
      // Dropping the selection means dropping what is drawn too, so hand back
      // whatever was selected. Without this the state said "nothing selected"
      // while the highlight stayed on screen.
      return {
        state: { selecting: null, pendingId: null },
        last, action: null, clearId: state.selecting,
      };
  }
}
