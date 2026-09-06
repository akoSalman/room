// The floating button at the bottom of a chat (native-app/src/scrollFab.ts).
//
// Reported as: tapping the new-message badge scrolls down, but the badge and
// the button are still there afterwards.
//
// The count and the button were cleared only by the scroll handler, and that
// handler is throttled to one event per 100ms. A programmatic scroll finishes
// between two ticks, so the last position ever reported is part-way there —
// the button stays up over a chat that is already at the bottom, with a count
// of messages the user is now looking at.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollfab-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'scrollFab.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping scroll-fab tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const F = require(path.join(OUT, 'scrollFab.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const mode = (o) => F.fabMode({ atEndOfWindow: false, hasNewer: false, unseen: 0, ...o });

test('scrolled up in a normal chat, the button offers the bottom', () => {
  assert.strictEqual(mode({ atEndOfWindow: false }), 'bottom');
});

test('at the bottom of a normal chat, there is nothing to offer', () => {
  assert.strictEqual(mode({ atEndOfWindow: true }), 'hidden');
});

test('THE BUG: tapping the go-to-bottom button clears the unseen count', () => {
  // Without this the count waits for a scroll event that may never arrive with
  // the final position, and sits over messages the user is already reading.
  assert.strictEqual(F.clearsUnseenOnTap('bottom'), true);
  assert.strictEqual(F.clearsUnseenOnTap('hidden'), false);
});

test('the end of the WINDOW is not the present when more follows it', () => {
  // After a jump the loaded window sits in the middle of the chat, so the end
  // of the list still has history beyond it.
  assert.strictEqual(F.atPresent({ atEndOfWindow: true, hasNewer: true }), false);
  assert.strictEqual(F.atPresent({ atEndOfWindow: true, hasNewer: false }), true);
  assert.strictEqual(F.atPresent({ atEndOfWindow: false, hasNewer: false }), false);
});

test('at the end of a jumped-to window, the button still offers the present', () => {
  // Otherwise the way back to the newest messages disappears exactly where the
  // user most needs it.
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: true }), 'bottom');
});

// ── One button, one job ─────────────────────────────────────────────────────
//
// Reported as: after "show in chat" there is no need for a button that returns
// to where you were — the one that goes to the newest messages is enough; and
// the same while searching.
//
// The button used to turn into a back button after any jump and walk the trail
// in reverse. Stepping through ten search results left ten jumps on that trail,
// so leaving the search meant ten taps backwards through results already looked
// at — and the whole time the count of new messages was hidden, because the
// button was busy being something else.

test('THE CHANGE: a jump does not turn the button into a back button', () => {
  // There is no longer any mode but "go to the newest".
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: true }), 'bottom');
  assert.strictEqual(mode({ atEndOfWindow: false, hasNewer: false }), 'bottom');
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: false }), 'hidden');
});

test('every visible state of the button clears the count when tapped', () => {
  // It only ever goes to the newest messages now, so arriving there always
  // means the new messages have been reached.
  assert.strictEqual(F.clearsUnseenOnTap(mode({ atEndOfWindow: false })), true);
  assert.strictEqual(F.clearsUnseenOnTap(mode({ atEndOfWindow: true, hasNewer: true })), true);
});

// ── The count ───────────────────────────────────────────────────────────────
//
// Reported as: when new messages arrive while scrolled up, the button with the
// count does not act correctly.

test('THE BUG: something unseen always leaves somewhere to go', () => {
  // onScroll is throttled, so the last position it reported is not always
  // where the list actually came to rest. If that reading says "at the bottom"
  // while messages have arrived unseen, the button hides itself and takes the
  // count with it — a badge that vanishes over messages nobody has read.
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: false, unseen: 3 }), 'bottom');
});

test('nothing unseen and nothing beyond the end means no button', () => {
  assert.strictEqual(mode({ atEndOfWindow: true, hasNewer: false, unseen: 0 }), 'hidden');
});

test('a missing count is not a count', () => {
  // The caller may simply not pass it; that must not read as "something is
  // waiting" and pin the button open forever.
  assert.strictEqual(F.fabMode({ atEndOfWindow: true, hasNewer: false }), 'hidden');
});

// ── Clear of what is under it ───────────────────────────────────────────────
//
// Reported as: while "… is typing" is showing, the go-to-newest button does
// not work.
//
// The typing line is drawn AFTER the button and adds its own row at the bottom
// of the screen, so it lands on top of a button pinned a fixed distance from
// that edge — and on the app a tap then goes to the text rather than to the
// control under it. The reply and edit banners had been given a lift for
// exactly this reason years earlier; the typing and recording lines never
// were.
//
// (On the WEB the button was still clickable — it wins on z-index — but it sat
// over the line, which is its own reason to move. Both were checked in a real
// browser rather than argued about.)

global.window = global;
const W = require(path.join(__dirname, '..', 'public', 'js', 'scrollFab.js'));

test('THE BUG: the button moves up for the typing line, not just for banners', () => {
  const plain = F.fabBottom({});
  assert.ok(F.fabBottom({ activity: true }) > plain,
    'a typing line does not move the button, so the line lands on top of it');
  assert.ok(F.fabBottom({ banner: true }) > plain, 'the banners stopped lifting it');
  // Both at once is both lifts: a reply banner AND somebody typing is a real
  // state, and lifting for only one of them puts the button back on the other.
  assert.strictEqual(F.fabBottom({ banner: true, activity: true }),
    plain + F.FAB_BANNER_LIFT + F.FAB_ACTIVITY_LIFT);
  assert.strictEqual(F.fabBottom({}), F.FAB_BASE);
  assert.strictEqual(F.fabBottom(null), F.FAB_BASE);
});

test('the web and the app agree about all of it', () => {
  let checked = 0;
  for (const banner of [true, false]) {
    for (const activity of [true, false]) {
      assert.strictEqual(W.fabBottom({ banner, activity }), F.fabBottom({ banner, activity }));
      checked++;
    }
  }
  for (const o of [{ atEndOfWindow: true, hasNewer: false, unseen: 0 },
                   { atEndOfWindow: true, hasNewer: true, unseen: 0 },
                   { atEndOfWindow: false, hasNewer: false, unseen: 0 },
                   { atEndOfWindow: true, hasNewer: false, unseen: 3 }]) {
    assert.strictEqual(W.fabMode(o), F.fabMode(o), `modes diverge for ${JSON.stringify(o)}`);
    assert.strictEqual(W.atPresent(o), F.atPresent(o));
    checked++;
  }
  assert.strictEqual(W.FAB_GAP, F.FAB_GAP);
  assert.strictEqual(W.clearsUnseenOnTap('bottom'), F.clearsUnseenOnTap('bottom'));
  assert.strictEqual(checked, 8, 'the drift check did not actually run');
});

test('the app lifts the button and the mention button with the same rule', () => {
  const chat = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const lifts = (chat.match(/fabBottom\(\{/g) || []).length;
  assert.ok(lifts >= 2, `only ${lifts} control asks where it should sit`);
  // EVERY caller, counted — not "the string appears somewhere". One control
  // left behind is one control still sitting on the typing line, and the other
  // callers would hide it from a looser check.
  const busy = (chat.match(/activity: someoneIsBusy/g) || []).length;
  assert.strictEqual(busy, lifts,
    `${lifts} controls are placed by the rule but only ${busy} of them move for the typing line`);
  // The same condition decides whether the line is drawn AND whether the
  // button moves, so the two cannot disagree.
  assert.ok(/const someoneIsBusy = recordingUsers\.filter/.test(chat)
    && /typing\.filter\(u => u !== me\)\.length > 0/.test(chat),
    'the lift is decided by a different test from the one that draws the line');
  assert.ok(!/scrollFabRaised/.test(chat), 'the old fixed raise is still in use somewhere');
});

test('the web measures where the conversation actually ends', () => {
  // px counted by hand cannot survive an emoji bar, a two-line composer and a
  // typing line arriving together — and the browser already knows where the
  // list stops.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function liftScrollFab('), app.indexOf('// ─── Lightbox'));
  assert.ok(fn.length > 0, 'liftScrollFab is gone — this check would be vacuous');
  assert.ok(/getBoundingClientRect\(\)/.test(fn), 'the web counts pixels by hand again');
  assert.ok(/ScrollFab\.FAB_GAP/.test(fn), 'the clearance is written out rather than shared');
  assert.ok(/if \(!listRect\.height\) return;/.test(fn),
    'the button is placed from a hidden list, which measures as nothing');
  // …and it runs when the line appears and when it goes.
  const bar = app.slice(app.indexOf('function renderTypingBar('), app.indexOf('// ─── Sidebar'));
  assert.strictEqual((bar.match(/liftScrollFab\(\)/g) || []).length, 2,
    'the button is not repositioned when the typing line appears, or when it goes');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/src="\/js\/scrollFab\.js"/.test(html),
    'scrollFab.js is never loaded, so ScrollFab is undefined and every scroll throws');
});

// ── The live-location bar ───────────────────────────────────────────────────
//
// Reported with a screenshot: the go-to-newest button sitting exactly on top
// of the live bar's Stop. Worse than the typing line it was lifted over
// before, because the control being covered is the one that ends a broadcast
// of where you are — the tap that looks like Stop scrolls the chat instead,
// and the sharing carries on.

test('THE BUG: the button clears the live-location bar', () => {
  const plain = F.fabBottom({});
  const lifted = F.fabBottom({ liveBar: true });
  assert.ok(lifted > plain, 'the button still sits on the bar');
  assert.ok(lifted - plain >= 34,
    `lifted by only ${lifted - plain}px — the bar is a row of text with padding`);
});

test('the lifts stack, because the things they clear do', () => {
  const both = F.fabBottom({ liveBar: true, activity: true, banner: true });
  assert.strictEqual(both,
    F.FAB_BASE + F.FAB_BANNER_LIFT + F.FAB_ACTIVITY_LIFT + F.FAB_LIVE_LIFT);
});

test('nothing is lifted when the bar is not there', () => {
  assert.strictEqual(F.fabBottom({ liveBar: false }), F.FAB_BASE);
});

test('the app and the web lift by the same amount', () => {
  let checked = 0;
  for (const banner of [true, false]) {
    for (const activity of [true, false]) {
      for (const liveBar of [true, false]) {
        assert.strictEqual(W.fabBottom({ banner, activity, liveBar }),
          F.fabBottom({ banner, activity, liveBar }),
          `fabBottom diverges for ${banner}/${activity}/${liveBar}`);
        checked++;
      }
    }
  }
  assert.strictEqual(W.FAB_LIVE_LIFT, F.FAB_LIVE_LIFT);
  assert.strictEqual(checked, 8, 'the drift check did not actually run');
});

test('every floating control in the app is lifted, not just one of them', () => {
  const ROOT = path.join(__dirname, '..');
  const chat = fs.readFileSync(
    path.join(ROOT, 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  const calls = (chat.match(/fabBottom\(\{/g) || []).length;
  const lifted = (chat.match(/liveBar: !!liveShare/g) || []).length;
  assert.ok(calls > 0, 'fabBottom is no longer used');
  assert.strictEqual(lifted, calls,
    `${calls} floating controls, ${lifted} of them clear of the live bar`);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  \u2713 ${n}`); passed++; }
  catch (e) { console.error(`  \u2717 ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
