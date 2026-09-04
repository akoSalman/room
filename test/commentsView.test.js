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
// THE DESIGN WAS THEN REJECTED, and rightly. The first version was a green
// circle straddling the message's corner — that is how a LAUNCHER badges an
// app icon, and it shouts because it is competing with a screenful of other
// icons. Sitting on somebody's words, in a colour this app uses nowhere else,
// it just fought the text.
//
// Telegram's shape is quieter and says more: a full-width strip along the
// bottom of the message, inside its outline, separated by a hairline, in the
// app's own accent — "3 Comments ›". It reads as part of the message, it names
// what it opens instead of leaving a number to be decoded, and the whole strip
// is the tap target rather than a 20-pixel dot.
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

// ── The comments bar ───────────────────────────────────────────────────────

test('THE BAR names what it opens rather than leaving a number to decode', () => {
  assert.strictEqual(W.commentsBarLabel(1), '1 Comment', 'reads as "1 Comments"');
  assert.strictEqual(W.commentsBarLabel(5), '5 Comments');
  assert.strictEqual(W.commentsBarLabel(0), '0 Comments');
  assert.strictEqual(W.commentsBarLabel(null), '0 Comments');
});

test('the launcher-badge geometry is gone, not left behind as dead code', () => {
  // It was the wrong reference for this and nothing should be able to reach
  // for it again by accident.
  assert.strictEqual(W.badgeWidth, undefined, 'the old badge sizing is still exported');
  assert.strictEqual(W.badgeOffset, undefined);
  assert.strictEqual(W.BADGE_SIZE, undefined);
});

// ── The parent, reduced to a line ──────────────────────────────────────────
//
// Asked for as: the thread has no room for new messages once the keyboard is
// up. Make it a full screen, with only a SHORT preview of the message it is
// about — a couple of words, or a small thumbnail for a picture — as a link
// back to the original, stuck to the top bar.

test('THE HEADING: a long message becomes a few words', () => {
  const p = W.parentPreview({ type: 'text', content: 'hello there my friend this is quite a long message indeed' });
  assert.ok(p.text.length <= W.PREVIEW_CHARS + 1, `${p.text.length} characters is not a heading`);
  assert.ok(p.text.endsWith('…'), p.text);
  assert.strictEqual(p.thumb, false, 'a text message asked for a thumbnail');
});

test('and a short one is left exactly as it is', () => {
  assert.deepStrictEqual(W.parentPreview({ type: 'text', content: 'see this' }),
    { text: 'see this', thumb: false });
});

test('it cuts on a word rather than mid-syllable', () => {
  assert.strictEqual(W.trimTo('alpha beta gamma delta', 12), 'alpha beta…');
  // …unless the last word is so long that cutting on it would throw most of
  // the line away.
  assert.strictEqual(W.trimTo('a supercalifragilistic', 12), 'a supercalif…');
  assert.strictEqual(W.trimTo('short', 12), 'short');
});

test('a picture asks for a thumbnail, and its caption is the words', () => {
  // "Photo" says nothing the thumbnail beside it does not.
  assert.deepStrictEqual(W.parentPreview({ type: 'image', content: 'look at this' }),
    { text: 'look at this', thumb: true });
  assert.deepStrictEqual(W.parentPreview({ type: 'image' }), { text: 'Photo', thumb: true });
  assert.strictEqual(W.parentPreview({ type: 'gallery' }).thumb, true);
  assert.strictEqual(W.parentPreview({ type: 'video' }).thumb, true);
});

test('a message with no words is named by what it is', () => {
  assert.strictEqual(W.parentPreview({ type: 'audio' }).text, 'Voice message');
  assert.strictEqual(W.parentPreview({ type: 'location' }).text, 'Location');
  // A file's NAME is the useful part.
  assert.strictEqual(W.parentPreview({ type: 'file', file_name: 'report.pdf' }).text, 'report.pdf');
  assert.strictEqual(W.parentPreview({ type: 'file' }).text, 'File');
  assert.strictEqual(W.parentPreview(null).text, 'Message');
  assert.strictEqual(W.parentPreview({ type: 'text', content: '   ' }).text, 'Message');
});

test('newlines do not turn a heading into three', () => {
  assert.strictEqual(W.parentPreview({ type: 'text', content: 'one\n\ntwo   three' }).text,
    'one two three');
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

// ── The back button ─────────────────────────────────────────────────────────

test('THE BACK BUTTON: closing by hand undoes the entry it pushed', () => {
  // Otherwise the next back press pops an entry belonging to a thread that is
  // already gone, and the page goes wherever it went before.
  assert.strictEqual(W.backAction({ fromHistory: false, pushed: 1 }), 'back');
});

test('…but a close that CAME from back does not go back again', () => {
  // The entry is already spent. Going back once more leaves the site, which
  // is the exact thing being fixed.
  assert.strictEqual(W.backAction({ fromHistory: true, pushed: 1 }), 'none');
});

test('and with nothing pushed there is nothing to undo', () => {
  assert.strictEqual(W.backAction({ fromHistory: false, pushed: 0 }), 'none',
    'closing a thread stepped back through the page history');
});

test('the app and the web behave identically', () => {
  if (!A) return;
  let checked = 0;
  for (const n of [0, 1, 2, 99, 100, null]) {
    assert.strictEqual(W.commentsBarLabel(n), A.commentsBarLabel(n), `commentsBarLabel ${n}`);
    checked++;
  }
  for (const m of [
    { type: 'text', content: 'hello there my friend this is quite a long message indeed' },
    { type: 'text', content: 'see this' }, { type: 'text', content: '  ' },
    { type: 'image' }, { type: 'image', content: 'look' }, { type: 'gallery' },
    { type: 'audio' }, { type: 'file', file_name: 'report.pdf' }, { type: 'file' }, null,
  ]) {
    assert.deepStrictEqual(W.parentPreview(m), A.parentPreview(m), `parentPreview ${JSON.stringify(m)}`);
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
  for (const fh of [true, false]) {
    for (const pu of [0, 1, 2]) {
      assert.strictEqual(W.backAction({ fromHistory: fh, pushed: pu }),
        A.backAction({ fromHistory: fh, pushed: pu }), `backAction ${fh}/${pu}`);
      checked++;
    }
  }
  assert.strictEqual(checked, 39, 'the drift check did not actually run');
  assert.strictEqual(W.PREVIEW_CHARS, A.PREVIEW_CHARS);
  assert.strictEqual(W.NEAR_BOTTOM_PX, A.NEAR_BOTTOM_PX);
  assert.strictEqual(W.SWIPE_CLOSE_PX, A.SWIPE_CLOSE_PX);
});

// ── The web ─────────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE BAR is a full-width accent strip inside the message', () => {
  const rule = /\.comment-bar-btn \{([^}]*)\}/.exec(css);
  assert.ok(rule, '.comment-bar-btn has no rule — this check would be vacuous');
  assert.ok(/width:\s*100%/.test(rule[1]), 'the strip does not run the width of the message');
  assert.ok(/border-top:\s*1px solid/.test(rule[1]), 'nothing separates it from the words above');
  assert.ok(/margin:\s*8px -12px -8px/.test(rule[1]),
    'the bubble\'s padding is not undone, so the strip floats inside a margin');
  assert.ok(/color:\s*var\(--accent/.test(rule[1]), 'the strip is not in the app\'s accent colour');
  // The rejected design, gone: no green, no circle, no corner.
  assert.ok(!/#22c55e/.test(css.slice(css.indexOf('.comment-bar-btn'), css.indexOf('#comment-bar {'))),
    'the green badge colour is still in the comments styles');
  assert.ok(!/\.comment-badge/.test(css), 'the old corner badge rule is still there');
});

test('and it is built inside the bubble, saying what it opens', () => {
  const fn = app.slice(app.indexOf('  // ── The comments bar ──'), app.indexOf('  if (!msg._uploading) {'));
  assert.ok(fn.length > 0, 'the bar is not built — this check would be vacuous');
  assert.ok(/bubble\.appendChild\(bar\)/.test(fn),
    'the bar is not inside the message, so the bubble cannot clip it into shape');
  assert.ok(/CommentsView\.commentsBarLabel\(/.test(fn), 'the label is written by hand');
  assert.ok(/comment-bar-chev/.test(fn), 'there is nothing to say it leads somewhere');
  assert.ok(/classList\.toggle\('hidden', !Comments\.showsBadge\(msg\.comment_count\)\)/.test(fn),
    'every message in the room carries a "0 Comments" strip');
  assert.ok(/dataset\.msgId = msg\.id/.test(fn),
    'a comment arriving live cannot find its bar, so the count only moves on reload');
});

test('THE FULL SCREEN: the panel sits above the emoji bar, not below it', () => {
  // Reported as "on web the emoji bar is on top". Both take the space the
  // conversation had, and the panel was further down the document — so the bar
  // rendered above it and the thread began halfway down the screen.
  assert.ok(html.indexOf('id="comments-panel"') > html.indexOf('id="messages"'),
    'the thread is not where the conversation was');
  assert.ok(html.indexOf('id="comments-panel"') < html.indexOf('id="quick-emoji-bar"'),
    'the emoji bar still renders above the thread');
});

test('and the room\'s own header stands down while a thread is open', () => {
  // Two stacked headers were most of what made the screen cramped.
  assert.ok(/body\.commenting #chat-header/.test(css), 'the room header is still above the thread');
  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/\{!selectMode && !searching && !commentParent && \(/.test(chat),
    'the app still stacks the room header above the thread');
});

test('THE HEADING is one line that opens the original', () => {
  assert.ok(/id="comments-parent-link"[\s\S]{0,120}onclick="jumpToParentMessage\(\)"/.test(html),
    'the heading does not lead back to the message');
  assert.ok(/function jumpToParentMessage\(\)/.test(app), 'it leads nowhere');
  const fn = app.slice(app.indexOf('function jumpToParentMessage()'), app.indexOf('function jumpToParentMessage()') + 300);
  assert.ok(fn.indexOf('closeComments()') < fn.indexOf('jumpToMessage('),
    'the thread stays open over the message it just jumped to');
  assert.ok(/CommentsView\.parentPreview\(parent\)/.test(app), 'the heading is written by hand');
  // The whole message is no longer drawn here.
  assert.ok(!/renderMessage\(\{ item: commentParent \}\)/.test(
    fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8')),
    'the app still pins the whole message at the top of the thread');
  assert.ok(!/appendChild\(buildMessageElement\(res\.parent\)\)/.test(app),
    'the web still pins the whole message at the top of the thread');
});

test('a picture in the heading is a thumbnail, not the picture', () => {
  assert.ok(/thumbUrl\(src, 64\)/.test(app), 'the web loads the full image into a 32px box');
  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(/commentsParentThumb: \{ width: 32, height: 32/.test(chat),
    'the app has no thumbnail size');
  assert.ok(/parentPreview\(commentParent\)\.thumb/.test(chat),
    'the app draws a thumbnail for messages that have no picture');
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

test('BACK closes the thread rather than leaving the site', () => {
  // A thread is not a page, so back has nothing to pop unless one is put
  // there — without it, back leaves the site from inside a thread.
  assert.ok(/history\.pushState\(\{ comments: true \}, ''\); commentsPushed\+\+;/.test(app),
    'opening a thread pushes nothing for back to pop');
  assert.ok(/window\.addEventListener\('popstate', \(\) => \{ if \(commentParent\) closeComments\(true\); \}\)/.test(app),
    'back does not close the thread');
  const fn = app.slice(app.indexOf('function closeComments(fromHistory)'), app.indexOf('function syncCommentBar()'));
  assert.ok(fn.length > 0, 'closeComments is gone — this check would be vacuous');
  assert.ok(/CommentsView\.backAction\(\{ fromHistory: !!fromHistory, pushed: commentsPushed \}\) === 'back'/.test(fn),
    'the loop guard is decided by hand rather than by the rule');
  assert.ok(/commentsPushed--;\s*\n\s*try \{ history\.back\(\); \} catch \{\}/.test(fn),
    'the pushed entry is never undone, so the next back goes somewhere else');
});

test('and the app leaves the THREAD before it leaves the chat', () => {
  const fn = chat.slice(chat.indexOf('// Hardware back leaves the THREAD'), chat.indexOf('// Hardware back closes search'));
  assert.ok(fn.length > 0, 'hardware back is not handled for the thread');
  assert.ok(/if \(!commentParent\) return;/.test(fn), 'the handler runs when no thread is open');
  assert.ok(/closeComments\(\);\s*\n\s*return true;/.test(fn),
    'back does not close the thread, or does not stop there');
  assert.ok(/\}, \[commentParent\]\);/.test(fn), 'the handler never sees a thread being opened');
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

test('the app draws the same strip, inside the bubble', () => {
  const style = chat.slice(chat.indexOf('  commentBar: {'), chat.indexOf('  commentBarIcon:'));
  assert.ok(style.length > 0, 'the app has no comments strip');
  assert.ok(/flexDirection: 'row'/.test(style), 'the strip is not a row');
  assert.ok(/borderTopWidth: StyleSheet\.hairlineWidth/.test(style), 'nothing separates it from the words');
  assert.ok(/marginHorizontal: -10, marginBottom: -10/.test(style),
    'the bubble padding is not undone, so the strip floats inside a margin');
  assert.ok(/color: C\.accent/.test(chat.slice(chat.indexOf('  commentBarLabel:'), chat.indexOf('  commentBarLabel:') + 200)),
    'the strip is not in the app\'s accent colour');
  // Inside the Bubble now — the strip is part of the message, and the rounded
  // corners clip it.
  assert.ok(chat.indexOf('style={s.commentBar}') < chat.indexOf('</Bubble>'),
    'the strip is outside the bubble it belongs to');
  assert.ok(!/commentBadgeText/.test(chat), 'the old corner badge style is still there');
  // Scoped to the comment styles: '#22c55e' is also the live-location
  // indicator's green, which has nothing to do with this and must survive.
  const block = chat.slice(chat.indexOf('  commentBar: {'), chat.indexOf('  commentsHead: {'));
  assert.ok(!/#22c55e/.test(block), 'the rejected green is still in the comment styles');
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
