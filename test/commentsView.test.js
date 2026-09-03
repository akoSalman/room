// The comments screen: the badge, and the three ways the thread was not the
// chat.
//
// Reported together:
//
//   1. The badge should be a circle — like a launcher's notification badge —
//      green, on the message's bottom-left corner, half on it and half off.
//   2. Comments have no margin on a phone, and the list follows neither the
//      keyboard opening nor a comment being sent.
//   3. Swiping right should close the thread.
//   4. The jump-to-bottom button does nothing there.
//
// All four have the same cause: the thread was built as a place to READ
// comments and the chat's own behaviours were never given to it. The badge was
// a line of text in the footer beside the clock; the list had 4px of padding
// and no scroll logic at all; the chat's jump button is bound to #messages and
// the chat's keyboard handler looked only at #messages.
//
// A badge is meant to be seen before it is read, and that only works if it
// breaks the outline of the thing it belongs to — hence a circle straddling
// the corner rather than a number tucked inside.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'commentsView.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'cview-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'commentsView.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'commentsView.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The badge ───────────────────────────────────────────────────────────────

test('THE BADGE straddles the corner rather than sitting inside it', () => {
  // Half on, half off: that is what makes it look attached to the message
  // instead of printed on it.
  assert.strictEqual(W.badgeOffset(20), 10);
  assert.strictEqual(W.badgeOffset(), W.BADGE_SIZE / 2);
});

test('one or two digits are a circle; "99+" is a pill of the same height', () => {
  // Forcing a circle around three characters either clips them or leaves a
  // disc the size of a thumbnail — and a changing height would break the
  // rhythm of a column of messages.
  assert.strictEqual(W.badgeWidth('1'), W.BADGE_SIZE);
  assert.strictEqual(W.badgeWidth('12'), W.BADGE_SIZE);
  assert.ok(W.badgeWidth('99+') > W.BADGE_SIZE, 'a three-character badge is squeezed into a circle');
  assert.strictEqual(W.badgeWidth(''), W.BADGE_SIZE);
  assert.strictEqual(W.badgeWidth(null), W.BADGE_SIZE);
});

// ── Following the thread ────────────────────────────────────────────────────

test('THE BUG: a comment I sent is always shown to me', () => {
  // Sending one and being left looking at older comments is the report.
  assert.strictEqual(W.shouldStickToBottom({ reason: 'mine', nearBottom: false }), true);
  assert.strictEqual(W.shouldStickToBottom({ reason: 'opened', nearBottom: false }), true,
    'opening a thread does not show its newest comment');
});

test('…but somebody else\'s does not drag me out of what I am reading', () => {
  assert.strictEqual(W.shouldStickToBottom({ reason: 'theirs', nearBottom: false }), false);
  assert.strictEqual(W.shouldStickToBottom({ reason: 'theirs', nearBottom: true }), true);
});

test('and the keyboard follows the same rule', () => {
  // It halves the screen; whatever was in front of you should stay there.
  assert.strictEqual(W.shouldStickToBottom({ reason: 'keyboard', nearBottom: true }), true);
  assert.strictEqual(W.shouldStickToBottom({ reason: 'keyboard', nearBottom: false }), false);
});

test('"near the bottom" is generous, and unmeasured counts as bottom', () => {
  assert.strictEqual(W.isNearBottom({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 }), true);
  assert.strictEqual(W.isNearBottom({ scrollHeight: 2000, scrollTop: 100, clientHeight: 400 }), false);
  // Before the first layout there are no numbers, and treating that as "not at
  // the bottom" would stop a freshly opened thread from scrolling at all.
  assert.strictEqual(W.isNearBottom({}), true);
});

test('THE JUMP BUTTON appears only when it would do something', () => {
  assert.strictEqual(W.showsJumpButton({ scrollHeight: 3000, scrollTop: 0, clientHeight: 600 }), true);
  assert.strictEqual(W.showsJumpButton({ scrollHeight: 3000, scrollTop: 2500, clientHeight: 600 }), false,
    'the button is offered to somebody already at the bottom');
  // A thread of two comments has nothing to jump to.
  assert.strictEqual(W.showsJumpButton({ scrollHeight: 620, scrollTop: 0, clientHeight: 600 }), false);
});

// ── Swiping the thread away ─────────────────────────────────────────────────

test('THE SWIPE: a rightward drag closes the thread', () => {
  assert.strictEqual(W.closesOnSwipe({ dx: 120, dy: 10 }), true);
  assert.strictEqual(W.closesOnSwipe({ dx: 20, dy: 0 }), false, 'a twitch closed the screen');
  assert.strictEqual(W.closesOnSwipe({ dx: -120, dy: 0 }), false, 'a leftward drag closed it');
});

test('…and scrolling the comments does not throw the screen away', () => {
  // The thing that makes this liveable: a drag down the list is often a little
  // sideways too, and losing the thread every time would be worse than not
  // having the gesture.
  assert.strictEqual(W.closesOnSwipe({ dx: 80, dy: 200 }), false);
  assert.strictEqual(W.closesOnSwipe({ dx: 80, dy: 60 }), true, 'a clearly sideways drag was ignored');
});

test('the app and the web behave identically', () => {
  if (!A) return;
  let checked = 0;
  for (const label of ['1', '9', '12', '99', '99+', '', null]) {
    assert.strictEqual(W.badgeWidth(label), A.badgeWidth(label), `badgeWidth ${label}`);
    checked++;
  }
  const boxes = [
    { scrollHeight: 1000, scrollTop: 900, clientHeight: 100 },
    { scrollHeight: 3000, scrollTop: 0, clientHeight: 600 },
    { scrollHeight: 620, scrollTop: 0, clientHeight: 600 },
    {},
  ];
  for (const b of boxes) {
    assert.strictEqual(W.isNearBottom(b), A.isNearBottom(b), JSON.stringify(b));
    assert.strictEqual(W.showsJumpButton(b), A.showsJumpButton(b), JSON.stringify(b));
    checked++;
  }
  for (const d of [{ dx: 120, dy: 10 }, { dx: 20, dy: 0 }, { dx: -120, dy: 0 },
    { dx: 80, dy: 200 }, { dx: 80, dy: 60 }]) {
    assert.strictEqual(W.closesOnSwipe(d), A.closesOnSwipe(d), JSON.stringify(d));
    checked++;
  }
  for (const r of ['mine', 'theirs', 'keyboard', 'opened']) {
    for (const nb of [true, false]) {
      assert.strictEqual(W.shouldStickToBottom({ reason: r, nearBottom: nb }),
        A.shouldStickToBottom({ reason: r, nearBottom: nb }), `${r}/${nb}`);
      checked++;
    }
  }
  assert.strictEqual(checked, 24, 'the drift check did not actually run');
  assert.strictEqual(W.BADGE_SIZE, A.BADGE_SIZE);
  assert.strictEqual(W.NEAR_BOTTOM_PX, A.NEAR_BOTTOM_PX);
  assert.strictEqual(W.SWIPE_CLOSE_PX, A.SWIPE_CLOSE_PX);
  assert.strictEqual(W.badgeOffset(), A.badgeOffset());
});

// ── The web ─────────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE BADGE IS A GREEN CIRCLE ON THE BUBBLE, not text in the footer', () => {
  const rule = /\.comment-badge \{([^}]*)\}/.exec(css);
  assert.ok(rule, '.comment-badge has no rule — this check would be vacuous');
  assert.ok(/position:\s*absolute/.test(rule[1]), 'the badge is still in the footer flow');
  assert.ok(/left:\s*-10px/.test(rule[1]) && /bottom:\s*-10px/.test(rule[1]),
    'the badge does not straddle the bottom-left corner');
  assert.ok(/background:\s*#22c55e/.test(rule[1]), 'the badge is not green');
  assert.ok(/border-radius:\s*10px/.test(rule[1]), 'the badge is not round');
  assert.ok(/border:\s*2px solid/.test(rule[1]),
    'no ring in the page background, so the circle reads as part of the bubble');
  // The old footer placement is gone.
  assert.ok(!/order:\s*-1/.test(rule[1]), 'the badge is still ordered into the footer');
});

test('and it hangs off the bubble, which is what it is positioned against', () => {
  const fn = app.slice(app.indexOf('  // ── The comments badge ──'), app.indexOf('  if (!msg._uploading) {'));
  assert.ok(fn.length > 0, 'the badge is not built — this check would be vacuous');
  assert.ok(/bubble\.appendChild\(badge\)/.test(fn),
    'the badge is appended to the row, so its corner is the row\'s, not the message\'s');
  assert.ok(/CommentsView\.badgeWidth\(badge\.textContent\)/.test(fn), 'a "99+" badge is squeezed');
  assert.ok(!/💬/.test(fn), 'the badge still carries the old speech-bubble glyph');
  assert.ok(html.includes('/js/commentsView.js'), 'the rules are never loaded by the page');
});

test('THE MARGINS: the thread gets the same room the conversation does', () => {
  const rule = /\.comments-list \{([^}]*)\}/.exec(css);
  assert.ok(rule, '.comments-list has no rule — this check would be vacuous');
  const chat = /#messages \{([^}]*)\}/.exec(css);
  assert.ok(chat, '#messages has no rule');
  const pad = /padding:\s*([^;]+);/.exec(rule[1]);
  const chatPad = /padding:\s*([^;]+);/.exec(chat[1]);
  assert.ok(pad && chatPad, 'one of the two lists has no padding at all');
  assert.strictEqual(pad[1].trim(), chatPad[1].trim(),
    'the thread is still more cramped than the chat it is part of');
  assert.ok(/gap:\s*6px/.test(rule[1]), 'the comments have no space between them');
});

test('THE AUTOSCROLL: sending, arriving, opening and the keyboard', () => {
  assert.ok(/function stickComments\(reason\)/.test(app), 'nothing decides whether to follow');
  assert.ok(/stickComments\('mine'\)/.test(app), 'my own comment does not bring the view to it');
  assert.ok(/stickComments\('theirs'\)/.test(app), 'an arriving comment is never followed');
  assert.ok(/CommentsView\.shouldStickToBottom\(\{ reason, nearBottom \}\)/.test(app),
    'the web decides for itself rather than from the rule');
  // The keyboard handler looked only at #messages, so a thread stayed behind it.
  const kb = app.slice(app.indexOf('function keepBottomInView()'), app.indexOf('function keepBottomInView()') + 700);
  assert.ok(/commentParent \? 'comments-list' : 'messages'/.test(kb),
    'the keyboard scrolls the conversation even when a thread is open');
});

test('THE JUMP BUTTON exists here and is bound to this list', () => {
  assert.ok(/id="comments-fab"/.test(html), 'there is no jump button in the thread');
  assert.ok(/onclick="commentsToBottom\(\)"/.test(html), 'the button does nothing');
  assert.ok(/function syncCommentsFab\(\)/.test(app), 'its visibility is never worked out');
  assert.ok(/CommentsView\.showsJumpButton\(\{/.test(app), 'it is shown by hand rather than by the rule');
  assert.ok(/list\.addEventListener\('scroll', syncCommentsFab/.test(app),
    'scrolling the thread never updates the button');
});

test('THE SWIPE closes the thread, and only a real one does', () => {
  const fn = app.slice(app.indexOf('function setupCommentsGestures()'), app.indexOf('async function openComments('));
  assert.ok(fn.length > 0, 'there are no gestures on the thread');
  assert.ok(/CommentsView\.closesOnSwipe\(\{ dx: t\.clientX - from\.x, dy: t\.clientY - from\.y \}\)/.test(fn),
    'the swipe is judged by hand rather than by the rule');
  assert.ok(/if \(closed\) closeComments\(\)/.test(fn), 'a swipe does not close anything');
  assert.ok(/if \(!from \|\| !commentParent\) return;/.test(fn),
    'a swipe in the conversation closes a thread that is not open');
  assert.ok(app.includes('setupCommentsGestures();'), 'the gestures are never installed');
});

// ── The app ─────────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('the app badge is the same circle, OUTSIDE the bubble', () => {
  // The bubble is `overflow: hidden`, so a child hanging over its edge would
  // simply be cut off — the badge has to be its sibling.
  const style = chat.slice(chat.indexOf('  commentBadge: {'), chat.indexOf('  commentBadgeText:'));
  assert.ok(/position: 'absolute'/.test(style), 'the badge is still in the footer flow');
  assert.ok(/left: -BADGE_OFFSET, bottom: -BADGE_OFFSET/.test(style), 'it does not straddle the corner');
  assert.ok(/backgroundColor: '#22c55e'/.test(style), 'the badge is not green');
  assert.ok(/borderRadius: BADGE_SIZE \/ 2/.test(style), 'the badge is not round');
  assert.ok(/borderWidth: 2/.test(style), 'no ring, so it reads as part of the bubble');
  assert.ok(chat.indexOf('</Bubble>') < chat.indexOf('style={[s.commentBadge'),
    'the badge is inside the bubble, which clips it');
});

test('the app thread scrolls, jumps and swipes like the web', () => {
  assert.ok(/contentContainerStyle=\{s\.commentsListContent\}/.test(chat), 'the comments have no margins');
  assert.ok(/shouldStickToBottom\(\{ reason: 'mine'/.test(chat), 'my own comment is not scrolled to');
  assert.ok(/onScroll=\{onCommentsScroll\}/.test(chat), 'the thread never reports its position');
  assert.ok(/showsJumpButton\(box\)/.test(chat), 'the jump button is decided by hand');
  assert.ok(/commentsListRef\.current\?\.scrollToEnd/.test(chat), 'nothing can reach the end');
  assert.ok(/onMoveShouldSetPanResponder: \(_e, g\) => closesOnSwipe\(/.test(chat),
    'the swipe is judged by hand, or claims every drag');
  assert.ok(/\{\.\.\.commentsSwipe\.panHandlers\}/.test(chat), 'the gesture is never attached');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
