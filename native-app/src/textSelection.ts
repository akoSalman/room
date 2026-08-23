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

/**
 * The double-tap window — measured from the previous tap's RELEASE, not from
 * its touch-down.
 *
 * This is how Android measures it (ViewConfiguration.getDoubleTapTimeout, also
 * 300ms), and measuring it the other way is why double-tap "does not work for
 * the first couple of tries". Down-to-down includes however long the finger
 * rested on the first tap, so an ordinary double-tap — 120ms of dwell, then a
 * 220ms gap — is 340ms down-to-down and only 220ms release-to-down. The OS
 * accepted it and selected the word; we rejected it, decided the touch was an
 * ordinary tap, and 300ms later opened the message menu on top of the
 * selection the OS had just made.
 */
export const DOUBLE_TAP_MS = 300;
export const LONG_PRESS_MS = 450;

export type MsgId = number | string;

export type SelectionState = {
  /** The message believed to be showing a native selection right now. */
  selecting: MsgId | null;
  /** A touch that went down and has not yet resolved into a tap. */
  pendingId: MsgId | null;
  /**
   * The last message a finger landed on, whatever came of it.
   *
   * Not the same as `selecting`, and that difference is the whole point.
   * `selecting` is a GUESS about the OS, assembled from the two signals we get
   * — a touch going down, and a tap failing to arrive — and a guess made from
   * incomplete evidence is sometimes wrong. When it is wrong in the direction
   * of "there is no selection" while the OS actually has one, the user's next
   * double-tap is spent by the OS dismissing that selection, and nothing gets
   * selected. That is the "tap another message first, then it works" bug.
   *
   * So the clearing no longer waits to be sure. Any message that has been
   * touched might be holding a selection, and remounting a Text with no
   * selection in it costs nothing and shows nothing.
   */
  touchedId: MsgId | null;
};

export type SelectionEvent =
  | {
      type: 'down'; id: MsgId; at: number;
      /**
       * The list was still gliding when this finger landed.
       *
       * Android spends that touch stopping the fling: the child never sees a
       * tap and the OS starts no selection from it. Counting it as half of a
       * double-tap is what left us believing a word was selected when nothing
       * was — and the belief then ate the next tap as a "dismiss". This is the
       * "double-tap does not work after scrolling up" report.
       */
      settling?: boolean;
    }
  /** The pending touch never became a tap: the finger was held. */
  | { type: 'held'; id: MsgId }
  /**
   * The finger came off. Recorded so the NEXT touch measures its gap from
   * here — see DOUBLE_TAP_MS for why measuring from the touch-down instead
   * made ordinary double-taps fail.
   */
  | { type: 'release'; id: MsgId; at: number }
  | { type: 'tap' }
  /**
   * The tracked finger travelled far enough to be a drag.
   *
   * Nothing else told the reducer this. A slow scroll that started on a
   * message left the touch "pending", and 450ms later the hold timer declared
   * a selection the OS had never made — after which every tap on that message
   * was eaten as a dismiss. A scroll of half a second is an ordinary scroll,
   * so this happened constantly.
   */
  | { type: 'moved'; id: MsgId }
  /** A swipe-to-reply took the gesture over on this message. */
  | { type: 'swipe'; id: MsgId }
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

export const initialSelection: SelectionState = { selecting: null, pendingId: null, touchedId: null };

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
      // A touch spent stopping a fling is not a tap, so it can neither
      // complete a double-tap nor begin one; the clock starts from the next
      // finger that lands on a list which is standing still.
      const isDouble = !ev.settling && !!last && last.id === ev.id
        && ev.at - last.at < DOUBLE_TAP_MS;

      // Whatever the PREVIOUS message may be showing has to go, right now, on
      // the way down — and without first checking whether we think it is
      // showing anything.
      //
      // The OS will not start a new selection while an old one is up: it
      // spends the first tap dismissing the old selection instead. So a
      // double-tap on message B is read as "dismiss A" plus one ordinary tap,
      // nothing is selected, and it takes further taps to get anywhere. That
      // is the reported bug, and it kept coming back because the clearing was
      // conditional on `selecting`, which is only ever an inference.
      //
      // The inference has holes. A tap that lands on the text itself never
      // reaches a press handler, so nothing cancels the hold timer and nothing
      // confirms the tap — we can end up believing there is a selection when
      // there is not, and believing there is none when there is. Scrolling
      // makes it worse: a drag that starts on a message looks exactly like a
      // touch that went down and never became a tap.
      //
      // Clearing by TOUCH rather than by belief has no holes in it. The cost
      // is remounting one <Text> that may have had nothing selected, which
      // renders identically and is invisible.
      const stale = state.touchedId !== null && state.touchedId !== ev.id
        ? state.touchedId : null;

      return {
        state: isDouble
          ? { selecting: ev.id, pendingId: null, touchedId: ev.id }
          // Once the previous message is cleared nothing is selected any more,
          // so `selecting` must drop — keeping the old id would leave the next
          // tap thinking it still had a selection to dismiss.
          : { selecting: stale ? null : state.selecting, pendingId: ev.id, touchedId: ev.id },
        last: ev.settling ? null : { id: ev.id, at: ev.at },
        // Never 'dismiss'. This clear is speculative — the previous message
        // may well have had nothing selected — so it must not be reported as
        // a gesture that got consumed dismissing something. 'dismiss' means
        // "that touch was spent", and this one was not.
        action: null,
        clearId: stale,
      };
    }
    case 'release': {
      // Only the touch we are actually tracking. A release belonging to some
      // earlier message must not reset the clock for this one.
      if (!last || last.id !== ev.id) return { state, last, action: null, clearId: null };
      return { state, last: { id: ev.id, at: ev.at }, action: null, clearId: null };
    }
    case 'moved': {
      // Only the touch being tracked. A stray move from an old finger must not
      // cancel a fresh one.
      if (state.pendingId !== ev.id && (!last || last.id !== ev.id)) {
        return { state, last, action: null, clearId: null };
      }
      return {
        // No longer pending: a finger that is travelling is not being held,
        // whatever the timer is about to say.
        state: { ...state, pendingId: null },
        // And not the first half of a double-tap either — the OS did not read
        // a drag as a tap, so neither may we.
        last: null,
        action: null,
        clearId: null,
      };
    }
    case 'held': {
      // Only the touch we are actually waiting on can turn into a hold.
      if (state.pendingId !== ev.id) return { state, last, action: null, clearId: null };
      return {
        state: { selecting: ev.id, pendingId: null, touchedId: ev.id },
        last, action: null, clearId: null,
      };
    }
    case 'tap': {
      // While a selection is up, a tap outside it clears the selection and
      // does nothing else. The menu is NOT opened — otherwise dismissing a
      // selection and opening a menu are the same gesture.
      if (state.selecting !== null) {
        return {
          state: { selecting: null, pendingId: null, touchedId: state.touchedId },
          last, action: 'dismiss', clearId: state.selecting,
        };
      }
      return { state: { ...state, pendingId: null }, last, action: 'menu', clearId: null };
    }
    case 'swipe': {
      // Swiping to reply with a finger that started on the text.
      //
      // The swipe only claims the gesture after ten pixels of sideways
      // movement, and the OS starts its long-press timer the instant the finger
      // lands. Rest for a moment before pulling, or pull slowly, and the timer
      // wins the race: a word is selected, the handles and the copy bar appear,
      // and they are still there after the reply box has opened.
      //
      // Nothing can un-fire that timer, so the selection is wiped instead. The
      // message is named so the component can remount its text, which is the
      // only way to drop a native selection.
      //
      // Only when a selection could actually exist: one we already know about,
      // or a touch on THIS message that has not resolved yet, which is exactly
      // the case where the OS may have just started one. Remounting on every
      // swipe would flicker the text of every message anyone ever replies to.
      const wipe = state.selecting !== null ? state.selecting
        : state.pendingId === ev.id ? ev.id
        : null;
      return {
        state: { selecting: null, pendingId: null, touchedId: ev.id },
        // The touch is spent: it became a swipe, so it must not go on to be
        // read as a tap or a hold when it ends.
        last: null,
        action: null,
        clearId: wipe,
      };
    }
    case 'clear':
      // Dropping the selection means dropping what is drawn too, so hand back
      // whatever was selected. Without this the state said "nothing selected"
      // while the highlight stayed on screen.
      //
      // `touchedId` deliberately SURVIVES a clear. A scroll clears the state
      // but cannot clear what the OS has drawn, so the message under the
      // finger when the scroll began is still the one that might be holding a
      // selection — and forgetting it here is precisely what left a selection
      // on screen that the next double-tap then had to be spent dismissing.
      return {
        state: { selecting: null, pendingId: null, touchedId: state.touchedId },
        last, action: null, clearId: state.selecting,
      };
  }
}
