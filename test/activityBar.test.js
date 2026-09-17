// The line above the composer: typing, recording, and now sending.
//
// Asked for: just like "is typing", sending an image or a file should be
// reported.
//
// Typing and recording already had this, and the two clients each wrote their
// own sentence — the web said "is recording", the app said "is recording…" and
// joined names with commas. Neither knew what the other did. Adding a third
// activity to that would have meant writing it twice and watching them drift,
// so the wording moved into one place first and both clients now read it.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'activityBar.js'));

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'actbar-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'activityBar.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'activityBar.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rule skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The new line ────────────────────────────────────────────────────────────

test('THE FEATURE: sending a photo is reported like typing is', () => {
  const bar = W.activityBar({ sending: [{ username: 'sara', kind: 'photo' }], me: 'ako' });
  assert.strictEqual(bar.kind, 'sending');
  assert.strictEqual(bar.text, 'sara is sending a photo');
});

test('the noun follows what is actually being sent', () => {
  const say = kind => W.activityBar({ sending: [{ username: 'sara', kind }], me: 'ako' }).text;
  assert.strictEqual(say('photo'), 'sara is sending a photo');
  assert.strictEqual(say('photos'), 'sara is sending photos');
  assert.strictEqual(say('video'), 'sara is sending a video');
  assert.strictEqual(say('voice'), 'sara is sending a voice message');
  assert.strictEqual(say('audio'), 'sara is sending an audio file');
  assert.strictEqual(say('file'), 'sara is sending a file');
});

test('a message type nobody thought about still makes a sentence', () => {
  // Rather than "is sending undefined".
  assert.strictEqual(W.sendKindFor('sticker'), 'file');
  assert.strictEqual(W.sendKindFor(null), 'file');
  assert.strictEqual(W.sendKindFor(undefined), 'file');
  assert.strictEqual(W.activityBar({ sending: [{ username: 's', kind: 'nonsense' }] }).text,
    's is sending a file');
});

test('the same answer comes from a mime type', () => {
  // The web holds a File and the app holds a message type; a third copy of
  // this mapping for the new feature is how the wording drifts.
  assert.strictEqual(W.sendKindForMime('image/jpeg'), 'photo');
  assert.strictEqual(W.sendKindForMime('video/mp4'), 'video');
  assert.strictEqual(W.sendKindForMime('audio/mpeg'), 'audio');
  assert.strictEqual(W.sendKindForMime('application/pdf'), 'file');
  assert.strictEqual(W.sendKindForMime(''), 'file');
  assert.strictEqual(W.sendKindForMime(null), 'file');
});

// ── Who is named ────────────────────────────────────────────────────────────

test('you are never told about yourself', () => {
  // The sender sees their own upload progress on the bubble; a line saying
  // they are sending it too is noise.
  assert.strictEqual(W.activityBar({ sending: [{ username: 'ako', kind: 'photo' }], me: 'ako' }), null);
  assert.strictEqual(W.activityBar({ typing: ['ako'], me: 'ako' }), null);
  assert.strictEqual(W.activityBar({ recording: ['ako'], me: 'ako' }), null);
});

test('one person on two devices is one person', () => {
  // Typing on a phone and a laptop would otherwise read "ako and ako".
  const bar = W.activityBar({ typing: ['sara', 'sara'], me: 'ako' });
  assert.strictEqual(bar.text, 'sara is typing');
});

test('two are named, more are counted', () => {
  assert.strictEqual(W.activityBar({ typing: ['a', 'b'], me: 'me' }).text, 'a and b are typing');
  assert.strictEqual(W.activityBar({ typing: ['a', 'b', 'c'], me: 'me' }).text,
    'a and 2 others are typing');
});

test('several senders drop the noun rather than listing two', () => {
  // "Ali is sending a photo and Sara is sending a video" does not fit on a
  // line, and picking one of their nouns for both would be wrong.
  const bar = W.activityBar({
    sending: [{ username: 'a', kind: 'photo' }, { username: 'b', kind: 'video' }], me: 'me',
  });
  assert.strictEqual(bar.text, 'a and b are sending files');
});

test('the verb agrees with the number of people', () => {
  assert.ok(/\bis\b/.test(W.activityBar({ typing: ['a'], me: 'me' }).text));
  assert.ok(/\bare\b/.test(W.activityBar({ typing: ['a', 'b'], me: 'me' }).text));
  assert.ok(/\bis\b/.test(W.activityBar({ sending: [{ username: 'a', kind: 'photo' }] }).text));
  assert.ok(/\bare\b/.test(W.activityBar({
    sending: [{ username: 'a', kind: 'photo' }, { username: 'b', kind: 'photo' }] }).text));
});

// ── Which line wins ─────────────────────────────────────────────────────────

test('recording still beats everything, as it always did', () => {
  const bar = W.activityBar({
    typing: ['a'], recording: ['b'], sending: [{ username: 'c', kind: 'photo' }], me: 'me',
  });
  assert.strictEqual(bar.kind, 'recording');
});

test('sending beats typing', () => {
  // A slow upload is why nothing has arrived yet, which is more use to the
  // reader than knowing somebody is also typing.
  const bar = W.activityBar({ typing: ['a'], sending: [{ username: 'b', kind: 'video' }], me: 'me' });
  assert.strictEqual(bar.kind, 'sending');
});

test('nothing happening is null, not an empty line', () => {
  assert.strictEqual(W.activityBar({}), null);
  assert.strictEqual(W.activityBar({ typing: [], recording: [], sending: [] }), null);
  assert.strictEqual(W.activityBar(null), null);
  // A sender with no name cannot be announced.
  assert.strictEqual(W.activityBar({ sending: [{ username: '', kind: 'photo' }] }), null);
});

// ── Announcing your own uploads ─────────────────────────────────────────────

test('THE TRAP: two uploads do not clear each other\'s indicator', () => {
  // The obvious version emits on each upload's start and end. With two files
  // the first to finish clears the line while the second is still going, and
  // the other side sees it vanish with a file on the way.
  let n = 0;
  const step = d => { const b = n; n = W.nextInFlight(n, d); return W.announceOnChange(b, n); };
  assert.strictEqual(step(1), 'start');   // first upload begins
  assert.strictEqual(step(1), null);      // second begins — already announced
  assert.strictEqual(step(-1), null);     // first finishes — still one running
  assert.strictEqual(step(-1), 'stop');   // second finishes — now it is over
  assert.strictEqual(n, 0);
});

test('the count never goes negative', () => {
  // A double stop — a cancel that also resolves, say — would otherwise leave
  // the count at -1, and the next upload would never announce itself.
  assert.strictEqual(W.nextInFlight(0, -1), 0);
  assert.strictEqual(W.nextInFlight(1, -5), 0);
  let n = W.nextInFlight(0, -1);
  assert.strictEqual(W.announceOnChange(n, W.nextInFlight(n, 1)), 'start');
});

test('announceOnChange only speaks when the count crosses zero', () => {
  assert.strictEqual(W.announceOnChange(0, 1), 'start');
  assert.strictEqual(W.announceOnChange(1, 0), 'stop');
  assert.strictEqual(W.announceOnChange(1, 2), null);
  assert.strictEqual(W.announceOnChange(2, 1), null);
  assert.strictEqual(W.announceOnChange(0, 0), null);
});

test('the web and the app say exactly the same thing', () => {
  if (!A) return;
  const cases = [
    { sending: [{ username: 'sara', kind: 'photo' }], me: 'ako' },
    { sending: [{ username: 'a', kind: 'video' }, { username: 'b', kind: 'file' }], me: 'me' },
    { typing: ['a', 'b', 'c'], me: 'me' },
    { recording: ['a'], typing: ['b'], sending: [{ username: 'c', kind: 'photos' }], me: 'me' },
    { typing: ['ako'], me: 'ako' },
    {},
  ];
  let checked = 0;
  for (const c of cases) {
    assert.deepStrictEqual(W.activityBar(c), A.activityBar(c), `diverges for ${JSON.stringify(c)}`);
    checked++;
  }
  for (const t of ['image', 'gallery', 'video', 'audio', 'music', 'file', 'nonsense', null]) {
    assert.strictEqual(W.sendKindFor(t), A.sendKindFor(t));
  }
  for (const m of ['image/png', 'video/mp4', 'audio/ogg', 'application/zip', null]) {
    assert.strictEqual(W.sendKindForMime(m), A.sendKindForMime(m));
  }
  for (const [b, a] of [[0, 1], [1, 0], [1, 2], [0, 0]]) {
    assert.strictEqual(W.announceOnChange(b, a), A.announceOnChange(b, a));
  }
  assert.strictEqual(checked, cases.length, 'the drift check did not actually run');
});

test('the APP copy holds the counter rule too, not just the web one', () => {
  // Every behavioural test above drives W, the web copy. Without this the app
  // could be changed on its own and only the drift check would notice — and a
  // drift check says "they disagree", not "this one is wrong".
  if (!A) return;
  assert.strictEqual(A.announceOnChange(0, 1), 'start');
  assert.strictEqual(A.announceOnChange(1, 2), null,
    'the app announces a second upload, so finishing the first clears the line');
  assert.strictEqual(A.announceOnChange(2, 1), null,
    'the app stops on the first upload to finish, with the second still going');
  assert.strictEqual(A.announceOnChange(1, 0), 'stop');
  assert.strictEqual(A.nextInFlight(0, -1), 0, 'the app lets the count go negative');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('the server routes it exactly like typing and recording', () => {
  // emitToRoomUnblocked, not the socket.io room: somebody who blocked this
  // user must not be told what they are uploading, and a "stopped" has to
  // reach the same people the "start" did. Sending these to the room instead
  // is a bug this file has already had.
  const at = server.indexOf("socket.on('sending_start'");
  assert.ok(at > 0, 'there is no sending_start handler');
  const fn = server.slice(at, server.indexOf("socket.on('invite_to_room'"));
  assert.ok(/emitToRoomUnblocked\(roomId, socket\.user\.id, 'user_sending'/.test(fn),
    'sending_start does not go through the block filter');
  assert.ok(/emitToRoomUnblocked\(roomId, socket\.user\.id, 'user_stopped_sending'/.test(fn),
    'sending_stop does not go through the block filter');
});

test('the kind is whitelisted, not relayed', () => {
  // It is chosen by a client and ends up in a sentence on everybody else's
  // screen.
  assert.ok(/const SEND_KINDS = new Set\(/.test(server), 'there is no whitelist');
  assert.ok(/SEND_KINDS\.has\(String\(kind\)\) \? String\(kind\) : 'file'/.test(server),
    'a client can put any string into everybody else\'s chat');
});

test('the app announces its own uploads, and takes the line down again', () => {
  assert.ok(/function announceSending\(/.test(chat), 'the app never announces an upload');
  assert.ok(/announceOnChange\(before, after\)/.test(chat),
    'the app announces per upload, so two uploads clear each other');
  // Both entry points: the single-file path and the gallery path.
  assert.ok((chat.match(/announceSending\([^)]*, 1\)/g) || []).length >= 2,
    'one of the two upload paths never announces');
  assert.ok((chat.match(/announceSending\([^)]*, -1\)/g) || []).length >= 2,
    'one of the two upload paths never takes the line down');
  // In a finally, so a cancelled or failed upload does not leave it up for ever.
  assert.ok(/\} finally \{\s*(\/\/[^\n]*\n\s*)*announceSending/.test(chat),
    'the line is taken down only on the happy path');
});

test('the app draws the line from the rule, and lifts the button by the same one', () => {
  assert.ok(/activityBar\(\{ typing, recording: recordingUsers, sending: sendingUsers, me \}\)/.test(chat),
    'the app writes its own sentence again');
  assert.ok(/const someoneIsBusy = !!activityBar\(\{/.test(chat),
    'the button lift is computed separately, so it can disagree with the line');
  assert.ok(/sock\.on\('user_sending'/.test(chat) && /sock\.on\('user_stopped_sending'/.test(chat),
    'the app never hears about anybody else sending');
  assert.ok(/off\('user_sending'\)/.test(chat) && /off\('user_stopped_sending'\)/.test(chat),
    'the listeners are never removed, so re-entering a chat stacks them');
  // isForRoom, like every other presence event: these arrive on the personal
  // channel too, and without it another chat's upload shows up in this one.
  const at = chat.indexOf("sock.on('user_sending'");
  assert.ok(/isForRoom\(roomId, room\.id\)/.test(chat.slice(at, at + 400)),
    'a file being sent in another chat is announced in this one');
});

test('the web does the same, and loads the rule before using it', () => {
  assert.ok(/ActivityBar\.activityBar\(\{/.test(web), 'the web writes its own sentence again');
  assert.ok(/socket\.on\('user_sending'/.test(web), 'the web never hears about anybody sending');
  assert.ok(/announceSending\(kind, 1\)/.test(web), 'the web never announces its own uploads');
  assert.ok(/sendingUsers\.clear\(\)/.test(web),
    'switching chats leaves the previous one\'s senders on the line');
  assert.ok(/src="\/js\/activityBar\.js"/.test(html), 'activityBar.js is never loaded');
  assert.ok(html.indexOf('activityBar.js') < html.indexOf('js/app.js'),
    'app.js runs before ActivityBar exists');
});

test('a cancelled web upload also takes the line down', () => {
  // Cancelling resolves through the stored handle rather than through onDone,
  // so it needs the same teardown or the line outlives the upload.
  const at = web.indexOf('function resumableUpload(');
  assert.ok(at > 0, 'resumableUpload moved');
  const fn = web.slice(at, at + 1600);
  assert.ok(/const done = \(\) =>/.test(fn), 'there is no single teardown');
  assert.ok(/resolve: \(r\) => \{ done\(\); resolve\(r\); \}/.test(fn),
    'a cancelled upload leaves "is sending" on screen for ever');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
