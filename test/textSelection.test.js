// Tests for native-text-selection tracking (native-app/src/textSelection.ts).
//
// The bug this exists to prevent: after double-tapping to select a word,
// tapping anywhere else popped the message menu instead of clearing the
// selection. A tap outside a selection must dismiss it and do nothing more.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'seltest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'textSelection.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping text-selection tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const S = require(path.join(OUT, 'textSelection.js'));

const DOUBLE_TAP = 300;   // mirrors DOUBLE_TAP_MS, asserted below
const tests = [];
const test = (n, f) => tests.push({ n, f });

// A tiny driver mirroring how the screen threads the reducer's output back in.
function run(events) {
  let state = S.initialSelection;
  let last = null;
  const actions = [];
  const cleared = [];
  for (const ev of events) {
    const r = S.reduceSelection(state, last, ev);
    state = r.state; last = r.last;
    actions.push(r.action);
    cleared.push(r.clearId);
  }
  return { state, actions, cleared };
}

test('an ordinary tap opens the message menu', () => {
  const { actions, state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
  ]);
  assert.deepStrictEqual(actions, [null, 'menu']);
  assert.strictEqual(state.selecting, null);
});

test('a double tap starts a selection', () => {
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1000 + S.DOUBLE_TAP_MS - 50 },
  ]);
  assert.strictEqual(state.selecting, 1);
});

test('THE BUG: a tap after a double tap dismisses, and does not open the menu', () => {
  const { actions, state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // double tap → selecting
    { type: 'tap' },                     // tap somewhere outside
  ]);
  assert.strictEqual(actions[3], 'dismiss', 'the tap outside the selection opened the menu');
  assert.strictEqual(state.selecting, null, 'the selection was not cleared');
});

test('the very next tap after dismissing works normally again', () => {
  const { actions } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },
    { type: 'tap' },                     // dismiss
    { type: 'down', id: 2, at: 5000 },
    { type: 'tap' },                     // menu again
  ]);
  assert.deepStrictEqual(actions.slice(3), ['dismiss', null, 'menu']);
});

test('two slow taps are two taps, not a double tap', () => {
  const { state, actions } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1000 + S.DOUBLE_TAP_MS + 1 },
    { type: 'tap' },
  ]);
  assert.strictEqual(state.selecting, null);
  assert.deepStrictEqual(actions, [null, 'menu', null, 'menu']);
});

test('taps on two DIFFERENT messages are never a double tap', () => {
  // Otherwise tapping quickly down a list would arm a phantom selection and
  // swallow the next tap.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 2, at: 1100 },
  ]);
  assert.strictEqual(state.selecting, null);
});

test('a held touch starts a selection', () => {
  // The long-press case: the touch went down and no tap ever followed.
  const { state } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
  ]);
  assert.strictEqual(state.selecting, 7);
});

test('a stale hold for a touch we are no longer waiting on is ignored', () => {
  // A late timer from an earlier message must not arm a selection on it.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },                  // resolved: nothing pending
    { type: 'held', id: 1 },
  ]);
  assert.strictEqual(state.selecting, null);
});

test('a hold for a different message than the pending one is ignored', () => {
  const { state } = run([
    { type: 'down', id: 2, at: 1000 },
    { type: 'held', id: 1 },
  ]);
  assert.strictEqual(state.selecting, null);
});

test('a tap after a long-press selection also dismisses', () => {
  const { actions } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
    { type: 'tap' },
  ]);
  assert.strictEqual(actions[2], 'dismiss');
});

test('clear drops the selection without asking for any action', () => {
  const { state, actions } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
    { type: 'clear' },
  ]);
  assert.strictEqual(state.selecting, null);
  assert.strictEqual(actions[2], null);
  assert.strictEqual(state.pendingId, null);
});

// ── Selecting a word on a SECOND message ─────────────────────────────────────
//
// Reported as: double-tap works on the first message, then stops working on
// every message after it, until you tap outside several times. The cause is
// that the OS spends the first tap dismissing the selection that is still up
// on the previous message, so the double-tap is read as dismiss + single tap.

test('THE BUG: touching another message clears the selection still up on the first', () => {
  const { cleared, actions } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // double tap → message 1 is selected
    { type: 'down', id: 2, at: 5000 },   // now reach for message 2
  ]);
  assert.strictEqual(cleared[3], 1,
    'message 1 kept its selection, so the OS will spend the next tap dismissing it');
  // Not reported as 'dismiss': the clear happens on the way DOWN and the touch
  // carries on to become whatever it was going to be. Calling it a dismiss
  // would mean "that gesture is spent", and it is not — this very touch may be
  // the first half of a double-tap on message 2.
  assert.strictEqual(actions[3], null);
});

test('and a double tap on that second message then selects it first time', () => {
  const { state, cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // message 1 selected
    { type: 'down', id: 2, at: 5000 },   // first tap of the double on message 2
    { type: 'down', id: 2, at: 5150 },   // second tap
  ]);
  assert.strictEqual(state.selecting, 2, 'the second message never got selected');
  // And the clear happened once, on the way in — not again on the second tap.
  assert.deepStrictEqual(cleared, [null, null, null, 1, null]);
});

test('touching the SAME selected message again does not clear it', () => {
  // Adjusting your own selection with the handles must not wipe it.
  const { cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // selected
    { type: 'down', id: 1, at: 9000 },   // touch it again, slowly
  ]);
  assert.strictEqual(cleared[3], null);
});

test('THE BUG: touching a message clears the LAST ONE TOUCHED, believed selected or not', () => {
  // This used to clear only a selection the reducer believed in, and that
  // belief is an inference from two weak signals — a touch going down, and a
  // tap failing to arrive. It is wrong in both directions.
  //
  // Wrong the dangerous way: a real OS selection exists that we never noticed
  // (a tap on the text reaches the <Text>, not any press handler, so nothing
  // ever confirms it). The next double-tap on another message is then spent by
  // the OS dismissing that selection, and nothing gets selected — which is
  // exactly the reported "single tap another message first, then it works".
  //
  // Clearing by touch has no such holes. Remounting a Text with nothing
  // selected in it renders identically and shows nothing.
  const { cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'down', id: 2, at: 5000 },
  ]);
  assert.deepStrictEqual(cleared, [null, 1],
    'touching message 2 did not clear whatever message 1 might have been showing');
});

test('touching the SAME message again clears nothing', () => {
  // The second tap of a double-tap must not wipe the selection the first tap
  // is in the middle of starting.
  const { cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'down', id: 1, at: 1150 },
  ]);
  assert.deepStrictEqual(cleared, [null, null]);
});

test('THE SCROLL CASE: a scroll does not make the reducer forget what was touched', () => {
  // Reported as: on the first screen of a chat double-tap is fine, but after
  // scrolling it stops working until you tap some other message first.
  //
  // A scroll clears our state, but it cannot clear what the OS has drawn. The
  // message under the finger when the drag began is still the one that might
  // be holding a selection, so it has to survive the clear and be wiped on the
  // next touch elsewhere.
  const { cleared } = run([
    { type: 'down', id: 7, at: 1000 },   // finger lands on a message
    { type: 'clear' },                   // ...and the list starts scrolling
    { type: 'down', id: 9, at: 4000 },   // now double-tap something else
  ]);
  assert.strictEqual(cleared[2], 7,
    'after a scroll, the message the drag started on was never cleared');
});

test('and the double-tap that follows a scroll still registers', () => {
  const { state } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'clear' },
    { type: 'down', id: 9, at: 4000 },
    { type: 'down', id: 9, at: 4150 },
  ]);
  assert.strictEqual(state.selecting, 9);
});

test('after the stale selection is cleared, the next tap opens the menu', () => {
  // If `selecting` were left pointing at the old message, this tap would be
  // eaten as another dismiss and the menu would never open.
  const { actions } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // message 1 selected
    { type: 'down', id: 2, at: 5000 },   // clears message 1
    { type: 'tap' },
  ]);
  assert.strictEqual(actions[4], 'menu');
});

test('a tap outside reports WHICH message to wipe', () => {
  const { cleared } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
    { type: 'tap' },
  ]);
  assert.strictEqual(cleared[2], 7);
});

test('clear reports the message to wipe as well', () => {
  const { cleared } = run([
    { type: 'down', id: 7, at: 1000 },
    { type: 'held', id: 7 },
    { type: 'clear' },
  ]);
  assert.strictEqual(cleared[2], 7);
});

// ── Swiping to reply with a finger that started on the text ──────────────────
//
// Reported as: swiping right to reply sometimes selects the text instead.
//
// The swipe only claims the gesture after ten pixels of sideways movement, and
// the OS starts its long-press timer the moment the finger lands. Rest briefly
// before pulling, or pull slowly, and the timer wins: a word is selected, the
// handles and the copy bar appear, and they are still there once the reply box
// has opened. Nothing can un-fire that timer, so the selection is wiped.

test('THE BUG: a swipe wipes the selection the OS started under the finger', () => {
  const { cleared, state } = run([
    { type: 'down', id: 4, at: 1000 },   // finger lands on the text
    { type: 'swipe', id: 4 },            // and pulls sideways
  ]);
  assert.strictEqual(cleared[1], 4,
    'the word the OS selected mid-swipe was left highlighted');
  assert.strictEqual(state.selecting, null);
  assert.strictEqual(state.pendingId, null, 'the touch is still pending after becoming a swipe');
});

test('a swipe also wipes a selection left on another message', () => {
  const { cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'tap' },
    { type: 'down', id: 1, at: 1150 },   // message 1 selected
    { type: 'swipe', id: 9 },            // swipe a different message
  ]);
  assert.strictEqual(cleared[3], 1);
});

test('a swipe with nothing to wipe does not remount anything', () => {
  // Remounting on every swipe would flicker the text of every message anyone
  // ever replies to.
  const { cleared } = run([
    { type: 'swipe', id: 4 },
  ]);
  assert.strictEqual(cleared[0], null);
});

test('a swipe on a message OTHER than the pending touch wipes nothing', () => {
  const { cleared } = run([
    { type: 'down', id: 4, at: 1000 },
    { type: 'swipe', id: 5 },
  ]);
  assert.strictEqual(cleared[1], null);
});

test('the touch that became a swipe cannot go on to be a tap', () => {
  // The gesture ends when the finger lifts. Without forgetting it, that lift
  // arrives as a tap and opens the message menu on top of the reply box.
  const { actions } = run([
    { type: 'down', id: 4, at: 1000 },
    { type: 'swipe', id: 4 },
    { type: 'tap' },
  ]);
  assert.strictEqual(actions[2], 'menu',
    'a tap after a swipe should be an ordinary tap, not a dismiss');
});

test('a swipe cannot leave a stale double-tap primed', () => {
  // `last` is forgotten, so the next touch on this message is a first tap
  // rather than the second half of a double tap that never happened.
  const { state } = run([
    { type: 'down', id: 4, at: 1000 },
    { type: 'swipe', id: 4 },
    { type: 'down', id: 4, at: 1100 },   // would be "double" if last survived
  ]);
  assert.strictEqual(state.selecting, null,
    'the swipe left a half-finished double tap behind, so the next touch selected a word');
});

test('a late hold timer after a swipe is ignored', () => {
  // The long-press timer is still running when the swipe takes over; it must
  // not arm a selection behind the reply box.
  const { state } = run([
    { type: 'down', id: 4, at: 1000 },
    { type: 'swipe', id: 4 },
    { type: 'held', id: 4 },
  ]);
  assert.strictEqual(state.selecting, null);
});

// ── Measuring the double-tap the way Android does ───────────────────────────
//
// Reported as: on entering a room, the first couple of double-taps do nothing;
// tapping outside a message and then on it makes the next one work.
//
// The window was measured from the previous tap's touch-DOWN, which includes
// however long the finger rested on it. Android measures from the previous
// tap's RELEASE (ViewConfiguration.getDoubleTapTimeout, also 300ms). So an
// ordinary double-tap — a 120ms dwell then a 220ms gap — is 340ms down-to-down
// and 220ms release-to-down: the OS accepted it and selected a word, while
// this reducer decided it was two separate taps. 300ms later the second of
// those "taps" opened the message menu on top of the selection.

test('THE BUG: an ordinary double-tap is one, even with a dwell on the first tap', () => {
  // 120ms of dwell, then a 220ms gap. Android says double-tap. So must we.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'release', id: 1, at: 1120 },
    { type: 'down', id: 1, at: 1340 },
  ]);
  assert.strictEqual(state.selecting, 1,
    'a double-tap the OS would accept was read as two separate taps — the menu '
    + 'then opens over the selection the OS just made');
});

test('a slow, deliberate press-and-tap is still not a double-tap', () => {
  // Half a second after letting go is somebody tapping twice, not double-tapping.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'release', id: 1, at: 1120 },
    { type: 'down', id: 1, at: 1120 + S.DOUBLE_TAP_MS + 50 },
  ]);
  assert.strictEqual(state.selecting, null);
});

test('a release from another message does not disturb this one\'s window', () => {
  // A stray release — a swipe that ended over a neighbouring bubble, a row
  // recycled mid-gesture — must leave the tracked message alone. Handled
  // carelessly it OVERWRITES which message is being tracked, and the
  // double-tap in progress is then attributed to the wrong one and lost.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'release', id: 2, at: 1100 },   // not the message being tracked
    { type: 'down', id: 1, at: 1200 },      // still a double-tap on 1
  ]);
  assert.strictEqual(state.selecting, 1,
    "a release from another message stole the double-tap in progress");
});

test('and it does not extend the window for a message already moved on from', () => {
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'release', id: 2, at: 5000 },
    { type: 'down', id: 1, at: 5100 },
  ]);
  assert.strictEqual(state.selecting, null,
    "somebody else's release kept message 1's double-tap window open");
});

test('a release before anything was touched is harmless', () => {
  const { state, actions } = run([{ type: 'release', id: 1, at: 1000 }]);
  assert.strictEqual(state.selecting, null);
  assert.strictEqual(actions[0], null);
});

test('the release of a LONG press still opens the window for what follows', () => {
  // A press that became a selection is still the start of the next window —
  // double-tapping straight after adjusting a selection has to work.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'held', id: 1 },
    { type: 'release', id: 1, at: 1500 },
    { type: 'down', id: 1, at: 1700 },
  ]);
  assert.strictEqual(state.selecting, 1);
});

// ── Scrolling, which is where this kept breaking ────────────────────────────
//
// Reported for the sixth time as: "double tap select still does not work when
// I scroll up." Two separate causes, both of them the same mistake — believing
// the OS had selected something when it had not, after which every tap on that
// message was eaten as a "dismiss" of a selection that was never there.

test('THE BUG: a finger that lands on a still-gliding list is not half a double-tap', () => {
  // Android spends that touch stopping the fling. The child never sees a tap
  // and no word is selected — so if we count it, the pair that follows looks
  // to us like a completed double-tap and to the OS like nothing at all.
  const { state } = run([
    { type: 'down', id: 1, at: 1000, settling: true },   // stops the fling
    { type: 'release', id: 1, at: 1060 },
    { type: 'down', id: 1, at: 1150 },                   // the user's first real tap
  ]);
  assert.strictEqual(state.selecting, null,
    'a fling-stopping touch was counted as the first tap of a double-tap');
});

test('…and the two taps AFTER it still select normally', () => {
  const { state } = run([
    { type: 'down', id: 1, at: 1000, settling: true },
    { type: 'release', id: 1, at: 1060 },
    { type: 'down', id: 1, at: 1150 },
    { type: 'release', id: 1, at: 1210 },
    { type: 'down', id: 1, at: 1330 },
  ]);
  assert.strictEqual(state.selecting, 1, 'double-tap stopped working after a flick');
});

test('a fling-stopping touch cannot COMPLETE a double-tap either', () => {
  // Tap a word, then flick the list; the finger that catches the fling lands
  // on the same message inside the window. The OS spends it stopping the
  // scroll and selects nothing, so it must not look like a second tap to us.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'release', id: 1, at: 1060 },
    { type: 'down', id: 1, at: 1150, settling: true },
  ]);
  assert.strictEqual(state.selecting, null,
    'a touch spent stopping a fling was read as the second tap of a double-tap');
});

test('a still list is the ordinary case and is untouched by any of this', () => {
  const { state } = run([
    { type: 'down', id: 1, at: 1000, settling: false },
    { type: 'release', id: 1, at: 1060 },
    { type: 'down', id: 1, at: 1150 },
  ]);
  assert.strictEqual(state.selecting, 1);
});

test('THE OTHER CAUSE: a drag cannot become a long-press selection', () => {
  // A scroll that starts on a message left the touch "pending", and 450ms
  // later the hold timer declared a selection the OS had never made. A scroll
  // lasting half a second is an ordinary scroll, so this happened constantly —
  // and afterwards every tap on that message was swallowed.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'moved', id: 1 },
    { type: 'held', id: 1 },      // the timer, if it somehow still fires
  ]);
  assert.strictEqual(state.selecting, null,
    'a scroll was mistaken for a long press, so a selection was invented');
  assert.strictEqual(state.pendingId, null, 'the drag is still being tracked as a pending tap');
});

test('a drag does not start the double-tap clock either', () => {
  // The OS does not read a drag as a tap, so neither may we: a tap landing
  // shortly after a flick would otherwise complete a "double-tap" nobody made.
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'moved', id: 1 },
    { type: 'down', id: 1, at: 1150 },
  ]);
  assert.strictEqual(state.selecting, null, 'a drag was counted as the first tap of a double-tap');
});

test('a tap after a scroll still opens the menu rather than being eaten', () => {
  const { actions } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'moved', id: 1 },
    { type: 'clear' },                       // the scroll begins
    { type: 'down', id: 1, at: 3000 },
    { type: 'release', id: 1, at: 3060 },
    { type: 'tap' },
  ]);
  assert.strictEqual(actions[actions.length - 1], 'menu',
    'the first tap after a scroll was swallowed as a dismiss');
});

test('a move belonging to some other message leaves the tracked touch alone', () => {
  const { state } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'moved', id: 2 },
    { type: 'release', id: 1, at: 1060 },
    { type: 'down', id: 1, at: 1150 },
  ]);
  assert.strictEqual(state.selecting, 1, "another message's drag cancelled this double-tap");
});

test('a real selection is not undone by a later drag elsewhere', () => {
  const { state, cleared } = run([
    { type: 'down', id: 1, at: 1000 },
    { type: 'release', id: 1, at: 1060 },
    { type: 'down', id: 1, at: 1150 },       // selected
    { type: 'moved', id: 1 },                // dragging the selection handles
  ]);
  assert.strictEqual(state.selecting, 1, 'dragging a selection handle dropped the selection');
  assert.strictEqual(cleared[cleared.length - 1], null, 'the selected text was wiped mid-drag');
});

// ── The wiring, which the reducer alone cannot prove ────────────────────────
//
// Every one of these rules is dead unless the screen actually sends the event,
// and the last six reports of this bug were all wiring rather than logic.

test('the screen tells the reducer when a touch turns into a drag', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/selectionEvent\(\{ type: 'moved'/.test(src),
    'a scroll that starts on a message never reaches the reducer');
  const move = src.slice(src.indexOf('onTouchMove:'), src.indexOf('onTouchMove:') + 1400);
  assert.ok(move.includes("type: 'moved'"), 'the move event is sent from somewhere other than onTouchMove');
});

// ── "After scrolling up, double-tap still does not work" ────────────────────
//
// The third report of this. The previous fix — mine — is what caused it.
//
// It kept a BOOLEAN: set when a fling began, cleared on momentum-end or on the
// next drag. A touch marked as "stopped a fling" throws away the timestamp a
// double-tap is measured from, which is right when it is true and fatal when
// it is stuck.
//
// And it does get stuck. A fling up reaches the end of the list, older
// messages are fetched and PREPENDED, and the content shifting under the glide
// ends it without a momentum-end event. That is precisely the "scroll up" in
// the report. The flag stayed true and double-tap was dead in every message
// for the rest of the session.
//
// The test that used to be here asserted `listSettling.current = false` was
// present in the file. It was — on a line that never ran. It passed
// throughout, which is why this shipped three times.

test('THE LATCH IS GONE: settling cannot outlive the scroll that set it', () => {
  const now = 10_000;
  assert.strictEqual(S.stillMoving({ lastScrollAt: now - 10, now }), true, 'a stab at a gliding list');
  assert.strictEqual(S.stillMoving({ lastScrollAt: now - S.SETTLE_MS - 1, now }), false,
    'a scroll long finished still counts as gliding — this is the bug');
  // The case that broke it: momentum began and NOTHING ever ended it.
  assert.strictEqual(S.stillMoving({ lastScrollAt: now - 60_000, now }), false,
    'a fling whose end event never arrived disables double-tap forever');
  assert.strictEqual(S.stillMoving({ lastScrollAt: null, now }), false);
});

test('the window is longer than the scroll throttle, or stabs slip through', () => {
  // onScroll is throttled to 100ms, so the last sighting of a moving list can
  // be 100ms old when the finger lands.
  assert.ok(S.SETTLE_MS > 100, `SETTLE_MS is ${S.SETTLE_MS}`);
  // And short enough that a deliberate tap after the list settles is a tap.
  assert.ok(S.SETTLE_MS < DOUBLE_TAP, `SETTLE_MS is ${S.SETTLE_MS}`);
});

test('a clock that misbehaves reads as stopped, not as gliding', () => {
  // Erring this way costs one missed double-tap. Erring the other way is the
  // bug being fixed.
  assert.strictEqual(S.stillMoving({ lastScrollAt: 10_050, now: 10_000 }), false);
  assert.strictEqual(S.stillMoving({ lastScrollAt: NaN, now: 10_000 }), false);
});

test('the screen keeps a timestamp, and no flag anywhere', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(!/listSettling/.test(src), 'the latching flag is still there');
  assert.ok(/const settling = stillMoving\(\{ lastScrollAt: lastScrollAt\.current, now: Date\.now\(\) \}\)/.test(src),
    'the screen decides for itself whether the list is moving');
  assert.ok(/type: 'down', id, at: textTouchAt\.current, settling/.test(src),
    'the down event does not carry whether the list was still moving');
});

test('every sign of movement refreshes it, and the exact ends clear it', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  // onScroll is the one that cannot fail to arrive while the list moves — and
  // whose SILENCE is what ends the window.
  // Anchored FORWARD from the messages list's own handler: the comments list
  // added a `scrollEventThrottle` earlier in the file, and slicing to the
  // first one produced an empty window that could assert nothing.
  const start = src.indexOf('onScroll={(e: any) => {');
  const onScroll = src.slice(start, src.indexOf('scrollEventThrottle', start));
  assert.ok(onScroll.includes('lastScrollAt.current = Date.now();'),
    'ordinary scrolling does not refresh the window, so only flings are noticed');
  assert.ok(onScroll.includes('onMessagesScroll(e)'), 'the scroll handler it replaced is no longer called');
  assert.ok(/onMomentumScrollBegin=\{\(\) => \{ lastScrollAt\.current = Date\.now\(\); \}\}/.test(src));
  assert.ok(/onScrollEndDrag=\{\(\) => \{ lastScrollAt\.current = null; \}\}/.test(src),
    'a drag ending does not end the window');
  assert.ok(/onMomentumScrollEnd=\{\(e: any\) => \{\s*lastScrollAt\.current = null;/.test(src),
    'a momentum end does not end the window');
});

test('no long-press timer runs while the list is gliding', () => {
  // That finger is stopping a fling, not resting on a word.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/if \(!settling\) \{\s*\n\s*holdTimer\.current = setTimeout/.test(src),
    'the hold timer is armed even when the touch was spent stopping a fling');
});

// ── Tapping something INSIDE a message ──────────────────────────────────────
//
// Reported as: tapping a number copies it, and immediately afterwards the
// message menu pops up.
//
// A number, a link and an @name are each a <Text onPress> inside the bubble's
// selectable text. Pressing one runs its own action — and the bubble, which
// cannot see that, went on treating the same touch as an ordinary tap and
// opened the menu 300ms later. One finger, two answers, the second one landing
// on top of the first.
//
// The reducer cannot see this either: it is a component-level fact about which
// child handled the touch. So these check the wiring, which is where the bug
// was and where it would come back.

const chat = fs.readFileSync(
  path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('THE BUG: a tap spent on a token does not also open the menu', () => {
  // The flag this used to check is gone: it only worked when the child's
  // onPress and the parent's onTouchEnd arrived in the order the code assumed,
  // and the report came back when they did not. See test/tokenTap.test.js.
  const release = chat.slice(chat.indexOf('function noteTextRelease('),
    chat.indexOf('function dismissTextSelection('));
  assert.ok(release.length > 0, 'noteTextRelease is gone — this check would be vacuous');
  assert.ok(release.includes('if (menuSpentByToken()) return;'),
    'the release still schedules a tap after a token has answered it');
});

test('and the order of the two handlers cannot matter', () => {
  // Whether the child's onPress or the parent's onTouchEnd runs first is not
  // guaranteed, and the press can arrive after the menu has already opened.
  // So: the time is recorded, the scheduled tap is cancelled, and a menu that
  // this same touch opened is taken back.
  const fn = chat.slice(chat.indexOf('function tokenPress('),
    chat.indexOf('function tokenPress(') + 900);
  assert.ok(fn.includes('tokenPressedAt.current = now'), 'the press is never recorded');
  assert.ok(fn.includes('clearTimeout(tapTimer.current)'),
    'a tap already scheduled is left to fire, so the menu still appears');
  assert.ok(fn.includes('menuWasStrayTap({'),
    'a menu that had already opened when the press landed stays on screen');
});

test('EVERY tappable thing in a message goes through it', () => {
  // A number, a link, a phone and an @name all have the same problem; the one
  // that forgets is the one that ships.
  const render = chat.slice(chat.indexOf('function renderTextWithLinks('),
    chat.indexOf('// Tapping an @name opens a direct chat'));
  assert.ok(render.length > 0, 'renderTextWithLinks is gone — this check would be vacuous');
  const presses = render.match(/onPress=\{[^}]*\}/g) || [];
  assert.ok(presses.length >= 3, `only ${presses.length} tappable tokens found — the scan is wrong`);
  const bare = presses.filter(p => !p.includes('tokenPress('));
  assert.deepStrictEqual(bare, [],
    'these tokens act without marking the touch spent, so the menu opens over them');
});

test('THE SAME BUG, other places: everything inside a text bubble spends the touch', () => {
  // Reported separately: tapping a reply to jump to the original scrolls to
  // it and then opens the menu on top. Identical fault to the number — the
  // quote answers the touch and the bubble opens the menu anyway.
  //
  // So this scans the whole region of a text bubble rather than naming the
  // three handlers that exist today: the next one added is the one that gets
  // forgotten, and the symptom (a menu over whatever you just tapped) is
  // subtle enough to ship.
  const from = chat.indexOf('{/* Reply quote */}');
  const to = chat.indexOf("msg.type === 'image'", from);
  assert.ok(from > 0 && to > from, 'the bubble body moved — this check would be vacuous');
  const region = chat.slice(from, to);
  const presses = region.match(/onPress=\{[^\n]*/g) || [];
  assert.ok(presses.length >= 3, `only ${presses.length} handlers found — the scan is wrong`);
  const bare = presses.filter(p => !p.includes('tokenPress('));
  assert.deepStrictEqual(bare, [],
    'these run inside a text bubble without spending the touch, so the menu opens over them');
});

test('the reply quote in particular still jumps', () => {
  // Spending the touch must not cost the action itself.
  assert.ok(/tokenPress\(\(\) => jumpToMessage\(msg\.reply_to_id!\)\)/.test(chat),
    'the reply quote no longer jumps to the message it quotes');
});

test('a fresh touch forgets what the last one was spent on', () => {
  // Otherwise one tap on a number silences the menu for the NEXT ordinary tap
  // as well, which is the same bug wearing the opposite coat. It is forgotten
  // on the next touch — unless a press from the previous one is still in
  // flight, which is the case the timestamp exists for.
  const touch = chat.slice(chat.indexOf('function noteTextTouch('),
    chat.indexOf('/** When the finger that landed on a text bubble went down'));
  assert.ok(/if \(!menuSpentByToken\(\)\) tokenPressedAt\.current = null;/.test(touch),
    'the spent mark survives into the next touch');
  // And it expires by itself, so nothing depends on a later touch arriving.
  const tokenTap = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'tokenTap.ts'), 'utf8');
  assert.ok(/age >= 0 && age <= grace/.test(tokenTap), 'the mark never expires on its own');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
