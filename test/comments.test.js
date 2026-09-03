// Comments on a message.
//
// Asked for as: messages can have comments, which ARE messages and have all
// the same features; a comment cannot itself have comments; comments open in
// their own screen; the count is a badge at the bottom-left of the message,
// and only when there is one; and a Comment entry lives in the message menu.
//
// The design decision the rest follows from: a comment is an ordinary message
// with a parent — the same table, the same columns, the same code paths — and
// not a new kind of thing. That is what makes "comments have all the features"
// true rather than a promise. A comment can be a photo, a voice note, a reply
// or a forward; it can be reacted to, edited, deleted, searched and jumped to,
// because every one of those already works on messages and none of them had to
// learn what a comment is.
//
// The cost of that decision is that comments are now in the middle of every
// list of messages in the server, and would appear in the chat, the search
// results, the media tabs and the unread counts unless something keeps them
// out. That "something" is one line in visibleMessagesSql, and most of the
// wiring tests below are about it.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'comments.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'comments-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'comments.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'comments.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── One level, and no more ──────────────────────────────────────────────────

test('THE RULE: a comment cannot have comments', () => {
  assert.strictEqual(W.canComment({ id: 1 }), true);
  assert.strictEqual(W.canComment({ id: 2, parent_id: 1 }), false,
    'a thread of threads, and a screen that would need a tree to read it');
  assert.strictEqual(W.MAX_DEPTH, 1);
});

test('a parent of 0 is still a parent', () => {
  // Message ids come back from SQLite as numbers, and `0` is falsy — a
  // truthiness check here would let the very first message in the database be
  // commented on as though it were a root.
  assert.strictEqual(W.isComment({ id: 5, parent_id: 0 }), true);
  assert.strictEqual(W.canComment({ id: 5, parent_id: 0 }), false);
  assert.strictEqual(W.isComment({ id: 5, parent_id: null }), false);
  assert.strictEqual(W.isComment({ id: 5 }), false);
  assert.strictEqual(W.isComment({ id: 5, parent_id: '' }), false, 'an empty string read as a parent');
});

test('a one-time message cannot be commented on', () => {
  // It is gone the moment it is read. Comments would outlive the thing they
  // are about, and the screen would be headed by a message nobody can see.
  assert.strictEqual(W.canComment({ id: 3, one_time_seconds: 10 }), false);
  assert.strictEqual(W.canComment({ id: 3, one_time_seconds: null }), true);
});

test('nor is a join/leave line somebody\'s message to comment on', () => {
  assert.strictEqual(W.canComment({ id: 4, type: 'system' }), false);
  assert.strictEqual(W.canComment({ id: 4, type: 'invite' }), false);
  assert.strictEqual(W.canComment({ id: 4, type: 'image' }), true, 'a photo cannot be commented on');
  assert.strictEqual(W.canComment({ id: 4, type: 'audio' }), true, 'a voice note cannot be commented on');
});

test('a message still being sent has nothing to hang a comment on', () => {
  assert.strictEqual(W.canComment(null), false);
  assert.strictEqual(W.canComment(undefined), false);
  assert.strictEqual(W.canComment({}), false, 'a message with no id yet was offered comments');
});

// ── The badge ───────────────────────────────────────────────────────────────

test('THE BADGE: there is one only when there are comments', () => {
  // Asked for explicitly. A "0" on every message in the room would be noise
  // over the thing people are trying to read.
  assert.strictEqual(W.showsBadge(0), false);
  assert.strictEqual(W.showsBadge(null), false);
  assert.strictEqual(W.showsBadge(undefined), false);
  assert.strictEqual(W.showsBadge(1), true);
});

test('and it stops counting rather than growing without limit', () => {
  assert.strictEqual(W.badgeLabel(1), '1');
  assert.strictEqual(W.badgeLabel(99), '99');
  assert.strictEqual(W.badgeLabel(100), '99+');
  assert.strictEqual(W.badgeLabel(4000), '99+');
});

test('nonsense from the server reads as none, never as NaN', () => {
  for (const v of [null, undefined, NaN, -3, 'abc', {}]) {
    assert.strictEqual(W.normaliseCount(v), 0, String(v));
    assert.strictEqual(W.badgeLabel(v), '0');
    assert.strictEqual(W.showsBadge(v), false);
  }
  assert.strictEqual(W.normaliseCount('7'), 7, 'a count sent as a string was thrown away');
});

test('the count moves the moment a comment lands, and never below zero', () => {
  assert.strictEqual(W.countAfter(2, 1), 3);
  assert.strictEqual(W.countAfter(0, 1), 1);
  assert.strictEqual(W.countAfter(0, -1), 0, 'a delete arriving twice made the count negative');
  assert.strictEqual(W.countAfter(null, 1), 1);
});

test('the screen is named for what it holds', () => {
  assert.strictEqual(W.commentsTitle(0), 'Comments');
  assert.strictEqual(W.commentsTitle(1), '1 comment', 'reads as "1 comments"');
  assert.strictEqual(W.commentsTitle(5), '5 comments');
});

test('the app and the web agree on every one of these', () => {
  if (!A) return;
  let checked = 0;
  const msgs = [
    { id: 1 }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 0 }, { id: 4, parent_id: null },
    { id: 5, one_time_seconds: 9 }, { id: 6, type: 'system' }, { id: 7, type: 'invite' },
    { id: 8, type: 'image' }, {}, null,
  ];
  for (const m of msgs) {
    assert.strictEqual(W.canComment(m), A.canComment(m), `canComment ${JSON.stringify(m)}`);
    assert.strictEqual(W.isComment(m), A.isComment(m), `isComment ${JSON.stringify(m)}`);
    checked++;
  }
  for (const n of [null, undefined, 0, 1, 99, 100, -1, NaN, '7']) {
    assert.strictEqual(W.showsBadge(n), A.showsBadge(n), `showsBadge ${n}`);
    assert.strictEqual(W.badgeLabel(n), A.badgeLabel(n), `badgeLabel ${n}`);
    assert.strictEqual(W.commentsTitle(n), A.commentsTitle(n), `commentsTitle ${n}`);
    assert.strictEqual(W.countAfter(n, 1), A.countAfter(n, 1));
    checked++;
  }
  assert.strictEqual(checked, 19, 'the drift check did not actually run');
  assert.strictEqual(W.MAX_DEPTH, A.MAX_DEPTH);
  assert.strictEqual(W.BADGE_CAP, A.BADGE_CAP);
  assert.strictEqual(W.EMPTY_HINT, A.EMPTY_HINT);
});

// ── The server ──────────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const dbjs = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');

test('a comment is a message with a parent, not a table of its own', () => {
  assert.ok(/ALTER TABLE messages ADD COLUMN parent_id INTEGER/.test(dbjs),
    'comments are stored somewhere other than the messages table');
  assert.ok(!/CREATE TABLE IF NOT EXISTS comments/.test(dbjs), 'there is a second kind of message now');
  assert.ok(/idx_messages_parent/.test(dbjs),
    'every message list counts comments with no index to do it on');
});

test('THE THING THAT WOULD BREAK EVERYTHING: comments stay out of the chat', () => {
  // They are messages, so without this they appear in the conversation they
  // were written about — and in the search results, the media tabs and the
  // unread counts.
  const fn = server.slice(server.indexOf('function visibleMessagesSql('), server.indexOf('function clearedUpto('));
  assert.ok(fn.length > 0, 'visibleMessagesSql is gone — this check would be vacuous');
  assert.ok(/opts\.includeComments \? '' : ` AND \$\{alias\}\.parent_id IS NULL`/.test(fn),
    'nothing keeps comments out of the ordinary message lists');
  assert.ok(/\$\{own\}/.test(fn), 'the filter is built and then not used');
});

test('and every message says how many it has', () => {
  assert.ok(/\(SELECT COUNT\(\*\) FROM messages c WHERE c\.parent_id = m\.id\) AS comment_count/.test(server),
    'there is no count for the badge to show');
  // In the lists the chat is actually drawn from, not just declared.
  const uses = server.match(/\$\{COMMENT_COUNT_SQL\}/g) || [];
  assert.ok(uses.length >= 4, `only ${uses.length} message queries carry the count`);
});

test('THE DEPTH RULE is enforced where a comment is created, not in the UI', () => {
  const fn = server.slice(server.indexOf("socket.on('send_message'"), server.indexOf('const memberIds = getRoomMemberIds(room);'));
  assert.ok(/if \(parent\.parent_id != null\)/.test(fn), 'a comment can be hung off a comment');
  assert.ok(/A comment cannot have comments/.test(fn), 'the refusal says nothing');
  // The parent must be in THIS room, or a comment could be hung off a message
  // its readers are not allowed to see.
  assert.ok(/String\(parent\.room_id\) !== String\(room\.id\)/.test(fn),
    'a comment can be attached to a message in another room');
  assert.ok(/parent \? parent\.id : null/.test(fn), 'the parent is never stored');
});

test('a comment is delivered as a comment, never as a message', () => {
  // Every client appends `message_received` to the open chat. A comment
  // arriving that way would show up in the conversation it is about, which is
  // the one thing this must not do.
  const fn = server.slice(server.indexOf("socket.on('send_message'"), server.indexOf('// Push notification for everyone but the sender'));
  assert.ok(/const deliver = parent\s*\n?\s*\? \(id\) => io\.to\('user:' \+ id\)\.emit\('comment_added'/.test(fn),
    'a comment is broadcast as an ordinary message');
  assert.ok(/count: commentCount/.test(fn), 'the badge cannot move without a reload');
  assert.ok(/comment: outMsg/.test(fn), 'an open thread does not see the comment arrive');
});

test('the thread comes back with the message it is about', () => {
  const fn = server.slice(server.indexOf("app.get('/comments/:roomId/:msgId'"), server.indexOf('// Messages AROUND one particular message.'));
  assert.ok(fn.length > 0, 'there is no way to read a thread');
  assert.ok(/includeComments: true/.test(fn), 'the comments are filtered out of their own list');
  assert.ok(/res\.json\(\{ parent: signMessage\(parent\), comments:/.test(fn),
    'the screen would open on a list with no sight of what is being commented on');
  assert.ok(/canAccessRoom\(req\.user\.id, room\)/.test(fn), 'anybody can read any thread');
  assert.ok(/if \(!parent\) return res\.status\(404\)/.test(fn),
    'a thread whose message is gone is served headless');
  assert.ok(/ORDER BY m\.id ASC/.test(fn), 'the comments come back in an unspecified order');
});

// ── The web ─────────────────────────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');

test('THE BADGE IS DRAWN, and only when it has something to open', () => {
  // Where it is drawn is asserted in test/commentsView.test.js — it moved out
  // of the footer onto the bubble's corner, as a circle. What matters here is
  // that it exists only when there is a thread, and that a comment arriving
  // live can find it.
  const fn = app.slice(app.indexOf('  // ── The comments badge ──'), app.indexOf('  if (!msg._uploading) {'));
  assert.ok(fn.length > 0, 'no badge is built — this check would be vacuous');
  assert.ok(/Comments\.badgeLabel\(msg\.comment_count\)/.test(fn), 'the badge writes its own number');
  assert.ok(/classList\.toggle\('hidden', !Comments\.showsBadge\(msg\.comment_count\)\)/.test(fn),
    'every message in the room carries a "0"');
  assert.ok(/dataset\.msgId = msg\.id/.test(fn),
    'a comment arriving live cannot find its badge, so the number only moves on reload');
  assert.ok(/Comments\.canComment\(msg\)/.test(fn), 'comments are offered on comments');
});

test('the menu offers it', () => {
  assert.ok(/id="ctx-comment-btn" onclick="ctxComments\(\)"/.test(html), 'there is no Comments entry');
  assert.ok(/function ctxComments\(\)/.test(app), 'the entry calls nothing');
});

test('THE POINT OF THE DESIGN: the thread uses the real composer', () => {
  // Media, voice, one-time, location, emoji, paste and the upload progress all
  // work in a thread because they are the same code that works in the room. A
  // composer of its own would have been a second, poorer one — and "comments
  // have all the features" would have been a promise instead of a fact.
  assert.ok(!/id="comments-panel"[\s\S]{0,600}?<input/.test(html),
    'the comments panel grew a composer of its own');
  assert.ok(/function sendingParentId\(\)/.test(app), 'sends have no idea a thread is open');
  const sends = app.match(/parentId: sendingParentId\(\)/g) || [];
  assert.ok(sends.length >= 2, `only ${sends.length} upload paths send into the thread`);
  assert.ok(/roomId, type: 'text', content: wire, replyToId, clientId, oneTimeSeconds,\s*\n\s*parentId,/.test(app),
    'text is sent to the room even with a thread open');
});

test('…and the panel does not cover the composer it depends on', () => {
  const rule = /#comments-panel \{([^}]*)\}/.exec(css);
  assert.ok(rule, '#comments-panel has no rule — this check would be vacuous');
  assert.ok(!/position:\s*absolute/.test(rule[1]) && !/inset:\s*0/.test(rule[1]),
    'the panel is an overlay, so it covers the composer that writes the comments');
  assert.ok(/flex:\s*1/.test(rule[1]), 'the panel does not take the space the message list had');
  assert.ok(/body\.commenting #messages/.test(css), 'the conversation is still behind the thread');
});

test('a comment lands in the thread, not in the room behind it', () => {
  const fn = app.slice(app.indexOf('function dispatchText('), app.indexOf('function dispatchText(') + 1600);
  assert.ok(/const into = parentId \? document\.getElementById\('comments-list'\)/.test(fn),
    'your own comment appears in the conversation it was written about');
});

test('the parent is read at the moment of sending, not captured early', () => {
  // An upload that takes twenty seconds must land where the composer was
  // pointing when Send was pressed — and closing the thread mid-upload must
  // not silently redirect the photo into the room.
  const fn = app.slice(app.indexOf('function sendingParentId()'), app.indexOf('function sendingParentId()') + 200);
  assert.ok(/return commentParent \? commentParent\.id : null;/.test(fn));
});

test('a comment arriving live moves the badge and fills an open thread', () => {
  const fn = app.slice(app.indexOf("socket.on('comment_added'"), app.indexOf("socket.on('message_received'"));
  assert.ok(fn.length > 0, 'the web ignores comments arriving');
  assert.ok(/bumpCommentBadge\(ev\.parentId, ev\.count\)/.test(fn), 'the badge never moves');
  assert.ok(/commentParent && String\(commentParent\.id\) === String\(ev\.parentId\)/.test(fn),
    'a comment on one message is appended to whatever thread happens to be open');
  assert.ok(/appendCommentBubble\(ev\.comment\)/.test(fn), 'an open thread does not update');
  assert.ok(html.includes('/js/comments.js'), 'the rules are never loaded by the page');
});

// ── The app ─────────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('the app draws the badge only when earned', () => {
  // Its placement is asserted in test/commentsView.test.js.
  assert.ok(/canComment\(msg\) && showsBadge\(commentCountOf\(msg\)\)/.test(chat),
    'every message in the room carries a badge, or comments are offered on comments');
  assert.ok(/badgeLabel\(commentCountOf\(msg\)\)/.test(chat), 'the badge writes its own number');
});

test('the app menu offers comments, named for what is there', () => {
  assert.ok(/label=\{commentsTitle\(commentCountOf\(m\)\)\}/.test(chat),
    'the menu entry does not say how many comments there are');
  assert.ok(/\{canComment\(m\) && \(/.test(chat), 'the entry is offered on a comment too');
  assert.ok(/onPress=\{\(\) => \{ close\(\); openComments\(m\); \}\}/.test(chat), 'the entry opens nothing');
});

test('THE SAME DESIGN: the thread is not a Modal, so it keeps the composer', () => {
  const view = chat.slice(chat.indexOf('{commentParent && ('), chat.indexOf('{/* Messages */}'));
  assert.ok(view.length > 0, 'there is no comments screen');
  assert.ok(!/<Modal/.test(view), 'the thread is a Modal, which covers the composer that writes the comments');
  assert.ok(/renderMessage\(\{ item: commentParent \}\)/.test(view),
    'the message being commented on is drawn some other way than the chat draws it');
  assert.ok(/renderItem=\{renderMessage\}/.test(view), 'the comments are not real message rows');
  assert.ok(/EMPTY_HINT/.test(view), 'an empty thread says nothing at all');
  // …and the conversation is hidden rather than unmounted, so its scroll
  // position, loaded history and uploads survive the trip.
  assert.ok(/\{commentParent \? null : loading \?/.test(chat),
    'the conversation is still rendered underneath the thread');
});

test('every one of the app\'s four send paths reaches the thread', () => {
  // Text captures its parent into a local first (so a retry from a timer
  // cannot follow the screen instead of its thread); the three upload paths
  // read it at the emit. Both spellings count.
  const sends = chat.match(/parentId: sendingParentId\(\)|clientId, oneTimeSeconds: oneTime \?\? undefined, parentId,/g) || [];
  assert.strictEqual(sends.length, 4,
    `${sends.length} of 4 send paths carry the parent — text, media, gallery and voice must all work in a thread`);
});

test('the app reads the parent at the moment of sending', () => {
  const fn = chat.slice(chat.indexOf('function sendingParentId()'), chat.indexOf('function sendingParentId()') + 260);
  assert.ok(/commentParentRef\.current/.test(fn),
    'the parent comes from state, which a long upload has already left behind');
});

test('a comment arriving live moves the app badge too', () => {
  const fn = chat.slice(chat.indexOf("sock.on('comment_added'"), chat.indexOf("sock.on('message_received'"));
  assert.ok(fn.length > 0, 'the app ignores comments arriving');
  assert.ok(/String\(ev\.roomId\) !== String\(room\.id\)/.test(fn),
    'a comment in another chat moves this one\'s badges');
  assert.ok(/setCommentCounts/.test(fn), 'the badge only moves on a reload');
  assert.ok(/commentParentRef\.current && String\(commentParentRef\.current\.id\) === String\(ev\.parentId\)/.test(fn),
    'a comment on one message is appended to whatever thread is open');
  assert.ok(/prev\.some\(c => String\(c\.id\) === String\(msg\.id\)\)/.test(fn),
    'the same comment can be appended twice if the event arrives twice');
});

// ── Your own comment ────────────────────────────────────────────────────────
//
// The bug this section exists for: every optimistic bubble went into the
// ROOM's list. For a comment that is the exact thing this feature must not do
// — your own comment appears in the conversation it was written about, and
// never shows up in the thread until the screen is reopened. It was true on
// the app for all four send paths, and half-true on the web for uploads.

test('THE GAP: an outgoing comment goes into the thread, not the room', () => {
  const fn = chat.slice(chat.indexOf('function addOutgoing('), chat.indexOf('function replaceOutgoing('));
  assert.ok(fn.length > 0, 'the app has no idea where an outgoing bubble belongs');
  assert.ok(/if \(parentId\) \{\s*\n\s*setComments\(prev => \[\.\.\.prev, msg\]\);/.test(fn),
    'a comment being sent is added to the conversation behind it');
  assert.ok(/\} else setMessages\(prev => \[\.\.\.prev, msg\]\);/.test(fn),
    'an ordinary message no longer reaches the room');
  // Both optimistic paths — text, and every upload — go through it.
  const uses = chat.match(/addOutgoing\(optimistic, parentId\)/g) || [];
  assert.strictEqual(uses.length, 2, `${uses.length} of 2 optimistic paths route by thread`);
  assert.ok(!/setMessages\(prev => \[\.\.\.prev, optimistic\]\)/.test(chat),
    'an optimistic bubble still goes straight into the room');
});

test('the thread is captured when the send STARTS, not when it lands', () => {
  // A photo uploading for twenty seconds must land in the thread it was sent
  // to, even after the user has gone back to the room.
  const dispatch = chat.slice(chat.indexOf('function dispatchText('), chat.indexOf('function dispatchText(') + 2200);
  assert.ok(/const parentId = sendingParentId\(\);\n\s*addOutgoing\(optimistic, parentId\)/.test(dispatch),
    'the parent is read again later, so a slow send follows the screen instead of its thread');
  assert.ok(/clientId, oneTimeSeconds: oneTime \?\? undefined, parentId,/.test(dispatch),
    'the emit re-reads the parent rather than using the captured one');
  const upload = chat.slice(chat.indexOf('function addOptimisticMessage('), chat.indexOf('function addOptimisticMessage(') + 300);
  assert.ok(/const parentId = sendingParentId\(\);/.test(upload), 'an upload never captures its thread');
});

test('a comment\'s own echo does the bookkeeping the room\'s echo does', () => {
  // None of it runs otherwise: a comment never arrives as `message_received`,
  // so an upload bar would spin forever, a voice player would keep the
  // temporary id, and the crash-safety copy would be left to resend at the
  // next launch.
  const fn = chat.slice(chat.indexOf("sock.on('comment_added'"), chat.indexOf("sock.on('message_received'"));
  for (const call of ['up.finish(pendingId)', 'outbox.markDone(pendingId)', 'removeFailedMsg(pendingId)',
    'audioManager.retarget(pendingId, msg.id)', 'replaceOutgoing(pendingId, msg)']) {
    assert.ok(fn.includes(call), `the comment echo never calls ${call}`);
  }
  assert.ok(/if \(replaceOutgoing\(pendingId, msg\)\) return;/.test(fn),
    'the optimistic bubble is left in place and the real comment added beside it');
});

test('and the web reconciles its own comment too', () => {
  const fn = app.slice(app.indexOf('function appendCommentBubble('), app.indexOf('function bumpCommentBadge('));
  assert.ok(fn.length > 0, 'appendCommentBubble is gone — this check would be vacuous');
  assert.ok(/const pending = msg\.client_id && pendingUploads\[msg\.client_id\]/.test(fn),
    'a comment upload leaves its placeholder bubble beside the real one');
  assert.ok(/pending\.wrapper\.replaceWith\(buildMessageElement\(msg\)\)/.test(fn), 'the placeholder is never swapped');
  assert.ok(/URL\.revokeObjectURL\(pending\.previewUrl\)/.test(fn), 'the local preview is leaked');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
