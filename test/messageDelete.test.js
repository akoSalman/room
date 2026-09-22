// Two different things both called "delete".
//
// Asked for as: add delete to the other side's message, but the delete is just
// for me.
//
// Until now Delete meant `delete_message` — the message leaves the
// conversation for everybody in it — and it was offered only on your own
// messages, because it is the only kind of delete that makes sense there.
// There was no way to get rid of something somebody else sent.
//
// So there are two deletes now, and the thing this file exists to stop is
// their being confused for one another. Sending `delete_message` for a message
// you did not write would be one person silently removing another person's
// words from the conversation — not a failed delete, a different and much
// worse feature.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'messageDelete.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'msgdel-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'messageDelete.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'messageDelete.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rule skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Which delete ────────────────────────────────────────────────────────────

test('THE RULE: your message goes for everyone, theirs goes only for you', () => {
  assert.strictEqual(W.deleteKind({ mine: true }), 'everyone');
  assert.strictEqual(W.deleteKind({ mine: false }), 'me');
});

test('THE DANGER: the other side\'s message can never send delete_message', () => {
  // This is the assertion that matters. Everything else here is labelling.
  assert.strictEqual(W.deleteEvent(W.deleteKind({ mine: false })), 'hide_message');
  assert.notStrictEqual(W.deleteEvent(W.deleteKind({ mine: false })), 'delete_message');
  assert.strictEqual(W.deleteEvent(W.deleteKind({ mine: true })), 'delete_message');
});

test('nothing sensible in still does not delete for everyone', () => {
  // A missing or malformed message must fall to the safe side of the two.
  assert.strictEqual(W.deleteKind(null), 'me');
  assert.strictEqual(W.deleteKind(undefined), 'me');
  assert.strictEqual(W.deleteKind({}), 'me');
});

test('the label says which delete this is before it is tapped', () => {
  assert.strictEqual(W.deleteLabel('everyone'), 'Delete');
  assert.strictEqual(W.deleteLabel('me'), 'Delete for me');
});

test('the confirmation says WHO it disappears for', () => {
  // "Delete message?" over somebody else's message reads as unsending theirs.
  const mine = W.deleteConfirm('everyone');
  assert.ok(/everyone/i.test(mine.body), 'a delete for everyone does not say so');
  const theirs = W.deleteConfirm('me');
  assert.ok(/for me/i.test(theirs.title), 'the title does not distinguish the two');
  assert.ok(/sender still has it/i.test(theirs.body),
    'nothing tells the user the other person keeps the message');
  assert.ok(!/everyone/i.test(theirs.body), 'a delete for me claims to affect everyone');
});

test('the confirmation counts', () => {
  assert.ok(/3 messages/.test(W.deleteConfirm('everyone', 3).title));
  assert.ok(/message\?/.test(W.deleteConfirm('everyone', 1).title));
  // Nonsense counts still produce a sentence rather than "NaN messages".
  assert.ok(!/NaN/.test(W.deleteConfirm('me', 0).title));
  assert.ok(!/NaN/.test(W.deleteConfirm('me', null).title));
});

// ── A selection covering both sides ─────────────────────────────────────────

test('THE OLD BUG: a mixed selection is split rather than half-refused', () => {
  // Selecting a run of messages across a conversation and deleting used to
  // send delete_message for every one of them. The server refused the ones
  // that were not the user's, so the selection half-vanished and nothing said
  // why.
  const mine = new Set([1, 3]);
  const split = W.splitForDeletion([1, 2, 3, 4], id => mine.has(id));
  assert.deepStrictEqual(split.forEveryone, [1, 3]);
  assert.deepStrictEqual(split.forMe, [2, 4]);
});

test('…and nothing is dropped on the floor', () => {
  const ids = [10, 11, 12, 13, 14];
  const split = W.splitForDeletion(ids, id => id % 2 === 0);
  assert.strictEqual(split.forEveryone.length + split.forMe.length, ids.length,
    'some of the selection would be silently ignored');
});

test('an unknown message is treated as somebody else\'s', () => {
  // A message not in the loaded list — scrolled away, or arrived since — must
  // not be guessed into a delete for everyone.
  const split = W.splitForDeletion([99], () => false);
  assert.deepStrictEqual(split.forEveryone, []);
  assert.deepStrictEqual(split.forMe, [99]);
});

test('a mixed selection asks once, and says what happens to each half', () => {
  const both = W.splitConfirm({ forEveryone: [1, 2], forMe: [3] });
  assert.ok(/2 of yours/.test(both.body), 'the user is not told how many go for everyone');
  assert.ok(/3 messages/.test(both.title));
  assert.ok(/1 from other people/.test(both.body) || /1 /.test(both.body));
  // One-sided selections get the plain sentence, not the mixed one.
  assert.deepStrictEqual(W.splitConfirm({ forEveryone: [1], forMe: [] }), W.deleteConfirm('everyone', 1));
  assert.deepStrictEqual(W.splitConfirm({ forEveryone: [], forMe: [1, 2] }), W.deleteConfirm('me', 2));
});

test('the web and the app agree, case for case', () => {
  if (!A) return;
  let checked = 0;
  for (const mine of [true, false]) {
    const kind = W.deleteKind({ mine });
    assert.strictEqual(kind, A.deleteKind({ mine }));
    assert.strictEqual(W.deleteEvent(kind), A.deleteEvent(kind));
    assert.strictEqual(W.deleteLabel(kind), A.deleteLabel(kind));
    for (const n of [1, 2, 7]) {
      assert.deepStrictEqual(W.deleteConfirm(kind, n), A.deleteConfirm(kind, n),
        `the confirmation diverges for ${kind}/${n}`);
    }
    checked++;
  }
  const isMine = id => id % 2 === 1;
  assert.deepStrictEqual(W.splitForDeletion([1, 2, 3], isMine), A.splitForDeletion([1, 2, 3], isMine));
  assert.deepStrictEqual(
    W.splitConfirm({ forEveryone: [1], forMe: [2, 3] }),
    A.splitConfirm({ forEveryone: [1], forMe: [2, 3] }));
  assert.strictEqual(checked, 2, 'the drift check did not actually run');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const dbjs = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');

test('THE FEATURE: the app offers Delete on the other side too', () => {
  // It used to be `{mineMsg && <Row … label="Delete" …>}` — no delete at all
  // on anything somebody else sent.
  assert.ok(/label=\{deleteLabel\(deleteKind\(\{ mine: mineMsg \}\)\)\}/.test(chat),
    'the menu item is labelled by hand, or is still only on your own messages');
  assert.ok(/deleteMsg\(m\.id, mineMsg\)/.test(chat),
    'the menu does not tell deleteMsg whose message it is');
});

test('…and sends the right event for it', () => {
  const at = chat.indexOf('function deleteMsg(');
  assert.ok(at > 0, 'deleteMsg moved');
  const fn = chat.slice(at, chat.indexOf('function hideLocally('));
  assert.ok(fn.length > 100, 'deleteMsg is empty');
  assert.ok(/emit\(deleteEvent\(kind\)/.test(fn),
    'the event is named by hand, which is how the wrong one gets sent');
  // The literal must NOT appear: a stray emit('delete_message') next to the
  // rule would pass every check above and still delete somebody else's message.
  assert.ok(!/emit\('delete_message'/.test(fn),
    "deleteMsg can still send delete_message for a message it does not own");
});

test('a mixed multi-selection is split on the app too', () => {
  const at = chat.indexOf('function deleteSelected(');
  assert.ok(at > 0, 'deleteSelected moved');
  const fn = chat.slice(at, at + 1600);
  assert.ok(/splitForDeletion\(ids,/.test(fn), 'the selection is deleted without being split');
  assert.ok(/split\.forEveryone\.forEach/.test(fn) && /split\.forMe\.forEach/.test(fn),
    'only one half of the split is acted on');
  assert.ok(/emit\('hide_message'/.test(fn), 'the other side\'s messages are not hidden');
});

test('the message goes off screen without waiting for a round trip', () => {
  assert.ok(/function hideLocally\(/.test(chat), 'nothing removes a hidden message locally');
  assert.ok(/onSock\('message_hidden'/.test(chat),
    'a hide done on another device never reaches this one');
  // Removed BY REFERENCE now. This used to assert off('message_hidden') — the
  // blanket form, which socket.io reads as "remove EVERY listener for this
  // event", and which is what tore the notification listener off the socket
  // from this file and silenced notifications for a week.
  assert.ok(/for \(const \[event, handler\] of chatHandlersRef\.current\) sock\.off\(event, handler\)/.test(chat),
    'the listeners are never removed, so leaving and re-entering stacks them');
});

// ── The web ─────────────────────────────────────────────────────────────────

const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('the web offers Delete on the other side too, with the right label', () => {
  // It used to be `display = isMine ? '' : 'none'` — no delete at all on
  // anything somebody else sent.
  assert.ok(/MessageDelete\.deleteLabel\(MessageDelete\.deleteKind\(\{ mine: isMine \}\)\)/.test(web),
    'the web labels the delete by hand, or still hides it on the other side');
  assert.ok(!/menu\.querySelector\('button\.danger'\)\.style\.display = isMine/.test(web),
    'the delete button is still hidden on the other side');
  assert.ok(/id="ctx-delete-btn"/.test(html), 'the button cannot be relabelled');
});

test('THE DANGER, on the web: the event comes from the rule', () => {
  const at = web.indexOf('function confirmDelete(');
  assert.ok(at > 0, 'confirmDelete moved');
  const fn = web.slice(at, web.indexOf('// ─── File / Audio'));
  assert.ok(/socket\.emit\(MessageDelete\.deleteEvent\(kind\)/.test(fn),
    'the web names the event by hand, which is how the wrong one gets sent');
  assert.ok(!/emit\('delete_message'/.test(fn),
    'the web can still send delete_message for a message it does not own');
});

test('the web reads isMine BEFORE the menu closes', () => {
  // closeCtxMenu() sets ctxTarget to null. Reading authorship after it would
  // make every delete look like somebody else's — so your own messages would
  // be hidden instead of deleted, silently, for everyone else.
  const at = web.indexOf('function ctxDelete()');
  assert.ok(at > 0, 'ctxDelete moved');
  // Comments stripped first: the explanation of why the order matters names
  // closeCtxMenu() before the code reaches it, and matching prose is not
  // checking behaviour.
  const fn = web.slice(at, at + 500)
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(fn.indexOf('ctxTarget.isMine') < fn.indexOf('closeCtxMenu()'),
    'authorship is read after ctxTarget has been cleared');
  assert.ok(/confirmDelete\(id, mine\)/.test(fn), 'confirmDelete is not told whose message it is');
});

test('the web takes a hidden message off screen, here and on other devices', () => {
  assert.ok(/socket\.on\('message_hidden'/.test(web),
    'a hide done on another device never reaches this one');
  assert.ok(/src="\/js\/messageDelete\.js"/.test(html), 'messageDelete.js is never loaded');
  assert.ok(html.indexOf('messageDelete.js') < html.indexOf('js/app.js'),
    'app.js runs before MessageDelete exists');
});

// ── The server ──────────────────────────────────────────────────────────────

test('the hide is stored per user, and indexed', () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS hidden_messages/.test(dbjs), 'there is nowhere to store it');
  assert.ok(/UNIQUE\(user_id, message_id\)/.test(dbjs), 'hiding twice makes two rows');
  assert.ok(/idx_hidden_user/.test(dbjs), 'every message query would scan the whole table');
});

test('THE SERVER RULE: hide_message never touches the message itself', () => {
  const at = server.indexOf("socket.on('hide_message'");
  assert.ok(at > 0, 'there is no hide_message handler');
  const fn = server.slice(at, server.indexOf("socket.on('view_one_time'"));
  assert.ok(fn.length > 100, 'the handler is empty');
  assert.ok(/INSERT OR IGNORE INTO hidden_messages/.test(fn), 'nothing is stored');
  // The message must survive: no DELETE, no destroyMessage, no UPDATE.
  assert.ok(!/destroyMessage/.test(fn), 'hiding a message destroys it for everyone');
  assert.ok(!/DELETE FROM messages/.test(fn), 'hiding a message deletes it');
  assert.ok(!/UPDATE messages/.test(fn), 'hiding a message edits it');
  // Access is checked — hiding is harmless, but it should not be a way to
  // probe which message ids exist in rooms you cannot see.
  assert.ok(/canAccessRoom\(socket\.user\.id, room\)/.test(fn), 'no access check');
  // …and ownership is deliberately NOT, because hiding someone else's message
  // is the entire feature.
  assert.ok(!/msg\.user_id !== socket\.user\.id\) return/.test(fn),
    'an ownership check is back, which refuses the only case this exists for');
});

test('only the user who hid it is told', () => {
  const at = server.indexOf("socket.on('hide_message'");
  const fn = server.slice(at, server.indexOf("socket.on('view_one_time'"));
  assert.ok(/io\.to\('user:' \+ socket\.user\.id\)\.emit\('message_hidden'/.test(fn),
    'the hide does not reach this user\'s other devices');
  // Broadcasting to the room would tell the sender their message had been
  // deleted, which is exactly what this must not do.
  assert.ok(!/io\.to\(String\(msg\.room_id\)\)/.test(fn),
    'the whole room is told, so the sender thinks their message was deleted');
});

test('a hidden message disappears from EVERY list, not just the chat', () => {
  // Media tabs, search, unread counts and the chat all go through one helper.
  const at = server.indexOf('function visibleMessagesSql(');
  assert.ok(at > 0, 'visibleMessagesSql moved');
  const fn = server.slice(at, server.indexOf('function notHiddenSql('));
  assert.ok(/NOT IN \(SELECT message_id FROM hidden_messages WHERE user_id = /.test(fn),
    'the shared visibility rule does not filter hidden messages');
  // And the three unread counts that build their SQL by hand.
  assert.ok((server.match(/notHiddenSql\(/g) || []).length >= 4,
    'some unread count still counts messages the user deleted for themselves');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
