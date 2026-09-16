// A half-written message is still a message.
//
// Asked for as: keep the draft when typing anything into the composer, or
// adding media, and exiting the chat.
//
// The media half already worked — pendingMedia.ts was written for exactly the
// same complaint about staged photos. The TEXT half did not, and for a reason
// that is invisible from outside: the composer keeps its text in its own local
// state, deliberately, so that a keystroke re-renders one small component
// rather than a list of two thousand messages. That component is unmounted the
// moment you go back to the chat list, and React drops the text with it.
//
// So the two halves of the same half-written message behaved differently: the
// photos survived leaving the chat and the sentence did not.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'textDraft.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tdraft-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'textDraft.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'textDraft.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rule skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

const NOW = 1_700_000_000_000;

// ── What survives leaving the chat ──────────────────────────────────────────

test('THE BUG: what was typed comes back', () => {
  const raw = W.serialize('سلام، کی میای؟', NOW);
  assert.ok(raw, 'a typed sentence was not worth storing');
  assert.strictEqual(W.parse(raw, NOW), 'سلام، کی میای؟');
});

test('the text comes back EXACTLY as typed, trailing space and all', () => {
  // Somebody who typed "see you at " and went to look up the time gets their
  // space back with the rest of the sentence.
  const raw = W.serialize('see you at ', NOW);
  assert.strictEqual(W.parse(raw, NOW), 'see you at ');
  // Newlines and emoji survive a round trip too.
  const multi = 'line one\nline two 🙂';
  assert.strictEqual(W.parse(W.serialize(multi, NOW), NOW), multi);
});

test('whitespace is not a draft', () => {
  // Otherwise tapping into the composer and out again stores a " " that comes
  // back as an empty-looking composer with a live Send button.
  assert.strictEqual(W.serialize('', NOW), null);
  assert.strictEqual(W.serialize('   ', NOW), null);
  assert.strictEqual(W.serialize('\n\t ', NOW), null);
  assert.strictEqual(W.serialize(null, NOW), null);
  assert.strictEqual(W.worthKeeping('x'), true);
  assert.strictEqual(W.worthKeeping('  '), false);
});

test('one chat\'s draft cannot appear in another', () => {
  assert.notStrictEqual(W.draftKey(1), W.draftKey(2));
  assert.ok(/1/.test(W.draftKey(1)));
  // And it cannot collide with the staged-photo draft, which is keyed per room
  // in the same storage.
  assert.notStrictEqual(W.draftKey(7), 'pending-media-7');
});

test('a draft does not haunt the composer for ever', () => {
  const raw = W.serialize('old news', NOW);
  assert.strictEqual(W.parse(raw, NOW + W.MAX_AGE_MS - 1000), 'old news');
  assert.strictEqual(W.parse(raw, NOW + W.MAX_AGE_MS + 1000), '');
});

test('nothing unreadable takes the chat screen down with it', () => {
  // This runs while a chat is opening.
  assert.strictEqual(W.parse(null, NOW), '');
  assert.strictEqual(W.parse('', NOW), '');
  // Truncated JSON is corrupt, not an older bare string: putting "{not json"
  // in somebody's composer is worse than losing the draft.
  assert.strictEqual(W.parse('{not json', NOW), '');
  assert.strictEqual(W.parse('[1,2', NOW), '');
  assert.strictEqual(W.parse('{"at":1}', NOW), '');
  assert.strictEqual(W.parse('[1,2,3]', NOW), '');
  assert.strictEqual(W.parse('{"at":0,"text":"kept"}', NOW), 'kept');
});

test('a bare string from the first version is still read', () => {
  // Rather than throwing away somebody's draft on the upgrade.
  assert.strictEqual(W.parse('just text', NOW), 'just text');
  assert.strictEqual(W.parse(JSON.stringify('quoted'), NOW), 'quoted');
});

// ── What a restore must not do ──────────────────────────────────────────────

test('THE TRAP: a restore never lands on top of what is already there', () => {
  // By the time the stored draft has been read back off disk, the composer may
  // already hold text the user just put there — shared in from another app, a
  // forward, an edit being prefilled. Overwriting any of those loses something
  // done on purpose, seconds ago, for a draft from last week.
  assert.strictEqual(W.restoredText('old draft', 'shared in just now'), 'shared in just now');
  assert.strictEqual(W.restoredText('old draft', ''), 'old draft');
  assert.strictEqual(W.restoredText('old draft', null), 'old draft');
  assert.strictEqual(W.restoredText('old draft', undefined), 'old draft');
  // Even a single character counts as "the user is doing something".
  assert.strictEqual(W.restoredText('old draft', 'h'), 'h');
});

test('writes that would change nothing are not made', () => {
  assert.strictEqual(W.changed('a', 'a'), false);
  assert.strictEqual(W.changed('a', 'b'), true);
  assert.strictEqual(W.changed('', null), false);
  assert.strictEqual(W.changed(null, ''), false);
  assert.strictEqual(W.changed('x', null), true);
});

test('the debounce is short enough to beat the back button', () => {
  // The last keystroke before leaving has to have been written, or flushed on
  // the way out. Anything approaching a second here is a draft lost.
  assert.ok(W.SAVE_DEBOUNCE_MS > 0 && W.SAVE_DEBOUNCE_MS <= 600,
    `${W.SAVE_DEBOUNCE_MS}ms is long enough to lose the last thing typed`);
});

test('the web and the app agree, string for string', () => {
  if (!A) return;
  const texts = ['hello', '  ', '', 'سلام', 'a\nb', 'trailing ', null, '🙂'];
  let checked = 0;
  for (const t of texts) {
    assert.strictEqual(W.serialize(t, NOW), A.serialize(t, NOW), `serialize diverges for ${t}`);
    assert.strictEqual(W.worthKeeping(t), A.worthKeeping(t));
    assert.strictEqual(W.parse(W.serialize(t, NOW), NOW), A.parse(A.serialize(t, NOW), NOW));
    for (const cur of ['', 'typed', null]) {
      assert.strictEqual(W.restoredText(String(t || ''), cur), A.restoredText(String(t || ''), cur));
    }
    checked++;
  }
  assert.strictEqual(W.draftKey(9), A.draftKey(9));
  assert.strictEqual(W.MAX_AGE_MS, A.MAX_AGE_MS);
  assert.strictEqual(W.SAVE_DEBOUNCE_MS, A.SAVE_DEBOUNCE_MS);
  assert.strictEqual(checked, texts.length, 'the drift check did not actually run');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const composer = fs.readFileSync(path.join(NAT, 'src', 'components', 'Composer.tsx'), 'utf8');

test('THE FIX: the composer reports what is typed', () => {
  // Without this the parent cannot see the text at all — which is the bug.
  assert.ok(/onDraftChange\?: \(text: string\) => void;/.test(composer),
    'the composer does not accept a draft reporter');
  const at = composer.indexOf('onChangeText={(v: string) => {');
  assert.ok(at > 0, 'the input moved');
  assert.ok(/onDraftChange && onDraftChange\(v\)/.test(composer.slice(at, at + 700)),
    'typing is not reported, so nothing is ever saved');
  assert.ok(/onDraftChange={onDraftChange}/.test(chat), 'the chat never passes it in');
});

test('…but NOT from set(), which is how an edit is prefilled', () => {
  // Reporting there would store a half-finished edit as a draft, and coming
  // back with the edit no longer in progress would send it as a new message.
  const at = composer.indexOf('const set = useCallback(');
  assert.ok(at > 0, 'set moved');
  const fn = composer.slice(at, composer.indexOf('const updateSuggestions'));
  assert.ok(!/onDraftChange/.test(fn), 'prefilling the composer stores it as a draft');
});

test('the text is held in a ref, not in this screen\'s state', () => {
  // Putting it in state would re-render the message list on every keystroke,
  // which is the exact cost the composer's local state exists to avoid — this
  // fix must not undo the thing it is built on.
  assert.ok(/const draftRef = useRef\(''\)/.test(chat), 'the draft is not kept in a ref');
  assert.ok(!/setDraftText\(/.test(chat), 'the draft was put into state after all');
});

test('the draft is written on a debounce AND flushed on the way out', () => {
  // The last keystroke before tapping back is still inside the debounce window
  // when the screen goes away, so the flush is what actually saves it.
  assert.ok(/textDraft\.SAVE_DEBOUNCE_MS/.test(chat), 'the write is not debounced');
  const at = chat.indexOf('const roomAtOpen = room.id;');
  assert.ok(at > 0, 'the cleanup no longer pins the room');
  const cleanup = chat.slice(at, at + 700);
  assert.ok(/textDraft\.serialize\(text, Date\.now\(\)\)/.test(cleanup),
    'nothing is written when the chat is left');
  // Pinned to the room this effect belongs to: leaving chat A for chat B must
  // not file A's draft under B.
  assert.ok(/textDraft\.draftKey\(roomAtOpen\)/.test(cleanup),
    "the draft is filed under whichever room happens to be current");
});

test('sending the message clears its draft', () => {
  const at = chat.indexOf('function sendText(');
  assert.ok(at > 0, 'sendText moved');
  assert.ok(/clearDraft\(\);/.test(chat.slice(at, at + 400)),
    'a sent message is still sitting in the composer next time the chat opens');
});

test('the restore does not clobber, and is skipped while editing', () => {
  assert.ok(/textDraft\.restoredText\(saved, composerRef\.current\?\.getText\(\)\)/.test(chat),
    'the restore overwrites whatever is already in the composer');
  assert.ok((chat.match(/editingIdRef\.current != null\) return;/g) || []).length >= 2,
    'an edit in progress is stored as a draft, and sent as a new message later');
});

// ── The web, which had the worse half of this ───────────────────────────────

const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE WEB BUG: a draft does not follow you into the next chat', () => {
  // Switching chats left whatever was typed sitting in the composer — not
  // lost, but one Enter away from being sent to the wrong person.
  const at = web.indexOf('async function joinRoom(');
  assert.ok(at > 0, 'joinRoom moved');
  const fn = web.slice(at, at + 1400);
  assert.ok(/flushDraft\(currentRoomId\)/.test(fn),
    'the chat being left does not keep what was typed in it');
  assert.ok(/restoreDraft\(roomId\)/.test(fn), 'the chat being entered does not get its own back');
  // Order matters: the outgoing draft must be filed before currentRoomId moves
  // on, or it is filed under the chat being opened.
  assert.ok(fn.indexOf('flushDraft(currentRoomId)') < fn.indexOf('currentRoomId = roomId'),
    "the outgoing draft is filed under the chat being opened");
  assert.ok(fn.indexOf('restoreDraft(roomId)') > fn.indexOf('currentRoomId = roomId'),
    'the restore runs before the room has changed');
});

test('a reload does not lose it either', () => {
  // iOS reloads a backgrounded tab by itself, so this is not something people
  // choose to do. `pagehide`, because Safari does not reliably fire `unload`
  // for a tab it is discarding.
  assert.ok(/addEventListener\('pagehide', \(\) => flushDraft\(\)\)/.test(web),
    'leaving the page does not write the draft');
  assert.ok(/visibilityState === 'hidden'/.test(web),
    'backgrounding the tab does not write the draft');
});

test('the web writes on a debounce and clears on send', () => {
  const at = web.indexOf('function onTypingInput()');
  assert.ok(at > 0, 'onTypingInput moved');
  const fn = web.slice(at, at + 800);
  assert.ok(/TextDraft\.SAVE_DEBOUNCE_MS/.test(fn), 'the web writes on every keystroke, or never');
  // Pinned to the room the keystroke happened in, not whichever is current
  // when the timer fires.
  assert.ok(/const roomAtKeystroke = currentRoomId;/.test(fn),
    'a debounced write can land on the wrong chat');
  const send = web.slice(web.indexOf('function sendText()'), web.indexOf('function dispatchText('));
  assert.ok(/clearDraft\(roomId\)/.test(send), 'a sent message is still a draft next time');
});

test('the web will not store an edit in progress as a draft', () => {
  const at = web.indexOf('function flushDraft(');
  assert.ok(at > 0, 'flushDraft moved');
  const fn = web.slice(at, web.indexOf('function restoreDraft('));
  assert.ok(/if \(editingMsgId\) return;/.test(fn),
    'a half-finished edit is kept as a draft, and sent as a new message later');
});

test('the page loads the rule before the file that uses it', () => {
  assert.ok(/src="\/js\/textDraft\.js"/.test(html), 'textDraft.js is never loaded');
  assert.ok(html.indexOf('textDraft.js') < html.indexOf('js/app.js'),
    'app.js runs before TextDraft exists');
});

test('the staged-photo half still works, because it was never the broken one', () => {
  // Both halves of "keep the draft" were asked for together. This one already
  // worked; a check that it still does costs nothing and catches a regression
  // in the effect right next to the new one.
  assert.ok(/pending\.draftKey\(room\.id\)/.test(chat), 'staged photos no longer persist');
  assert.ok(/pending\.serialize\(pendingMedia, Date\.now\(\)\)/.test(chat),
    'staged photos are no longer written');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
