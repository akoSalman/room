// Turning disappearing messages on and off, on the web.
//
// Reported as: disappearing chat could not be activated or deactivated on the
// web version.
//
// It could not. The server has always accepted `set_disappearing`, and the web
// has always DRAWN the result — the banner along the top, the marker in the
// sidebar, the system notice in the chat — but nothing on the page could ever
// send it. Every web user was at the mercy of somebody on the app to turn it
// on, and could not turn it off again.
//
// The other half of this file is the vocabulary. The web had grown three
// hand-written copies of the same ladder of durations, and a chat that says
// "5 minutes" in one place and "300 seconds" in another is not one to trust
// with a promise about deleting messages.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
require(path.join(ROOT, 'public', 'js', 'disappearing.js'));
const W = global.window.Disappearing;

let A = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'disapp-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'disappearing.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'disappearing.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The vocabulary ──────────────────────────────────────────────────────────

test('the offered durations are exactly the ones the server accepts', () => {
  // Read out of server.js, so a menu can never drift into offering a duration
  // that gets refused.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = /const DISAPPEARING_CHOICES = \[([^\]]+)\]/.exec(src);
  assert.ok(m, 'the server no longer has a list of choices — this check would be vacuous');
  const accepted = m[1].split(',').map(x => parseInt(x.trim(), 10));
  assert.deepStrictEqual(W.DISAPPEARING_OPTIONS.slice().sort((a, b) => a - b),
    accepted.slice().sort((a, b) => a - b),
    'the chips offer a duration the server will refuse, or hide one it accepts');
});

test('each one reads the same in the banner and in the notice', () => {
  assert.strictEqual(W.disappearingLabel(30), '30 seconds');
  assert.strictEqual(W.disappearingLabel(300), '5 minutes');
  assert.strictEqual(W.disappearingLabel(3600), '1 hour');
  assert.strictEqual(W.disappearingLabel(86400), '24 hours');
  assert.strictEqual(W.disappearingLabel(604800), '1 week');
  assert.strictEqual(W.disappearingLabel(0), 'Off');
});

test('the chips are the same durations, short enough to fit', () => {
  assert.deepStrictEqual(W.DISAPPEARING_OPTIONS.map(W.chipLabel),
    ['Off', '30s', '5m', '1h', '24h', '1w']);
});

test('a duration this client has never heard of still reads sensibly', () => {
  // An older page meeting a newer server must not print "600 seconds" as the
  // banner of a chat set to ten minutes.
  assert.strictEqual(W.disappearingLabel(600), '10 minutes');
  assert.strictEqual(W.disappearingLabel(7200), '2 hours');
  assert.strictEqual(W.disappearingLabel(172800), '2 days');
  assert.strictEqual(W.chipLabel(600), '10m');
  assert.strictEqual(W.chipLabel(172800), '2d');
});

test('the banner says what will happen and when', () => {
  const b = W.bannerText(300);
  assert.ok(b.includes('5 minutes'), b);
  assert.ok(/after reading/i.test(b), 'the banner does not say the clock starts at reading');
  assert.strictEqual(W.bannerText(0), '', 'a chat with it off still shows a banner');
});

test('the notice names the reader as "You", and everyone else by name', () => {
  assert.ok(W.disappearingNotice('Ako', 300, false).startsWith('Ako turned on'));
  assert.ok(W.disappearingNotice('Ako', 300, true).startsWith('You turned on'));
  assert.ok(/turned off/.test(W.disappearingNotice('Ako', 0, false)));
});

test('the OFF notice does not describe a timer', () => {
  const off = W.disappearingNotice('ako', 0, false);
  assert.ok(/off disappearing/.test(off), off);
  assert.ok(!off.includes('vanish'), 'the off notice describes a timer that no longer exists');
  assert.ok(!W.disappearingNotice('ako', 30, true).includes('ako'),
    'your own change is attributed to you by name rather than "You"');
  assert.ok(W.disappearingPredicate(300).startsWith('turned on'),
    'the predicate carries a name, so the chat cannot style it separately');
});

test('the promise is about READING, not sending', () => {
  // A message sitting unread does not start counting; the wording had to
  // change rather than the rule, and it must not drift back.
  assert.ok(/after they are read/.test(W.disappearingPredicate(30)),
    'the notice promises a clock that starts at sending');
});

test('the app and the web say exactly the same thing', () => {
  if (!A) return;
  let checked = 0;
  const durations = [0, 30, 300, 3600, 86400, 604800, 1, 59, 600, 7200, 172800, 999999];
  for (const secs of durations) {
    assert.strictEqual(W.disappearingLabel(secs), A.disappearingLabel(secs), `label ${secs}`);
    assert.strictEqual(W.chipLabel(secs), A.chipLabel(secs), `chip ${secs}`);
    assert.strictEqual(W.disappearingPredicate(secs), A.disappearingPredicate(secs), `predicate ${secs}`);
    assert.strictEqual(W.disappearingNotice('Ako', secs, false), A.disappearingNotice('Ako', secs, false));
    assert.strictEqual(W.disappearingNotice('Ako', secs, true), A.disappearingNotice('Ako', secs, true));
    checked++;
  }
  assert.strictEqual(checked, durations.length, 'the drift check did not actually run');
  assert.deepStrictEqual(W.DISAPPEARING_OPTIONS, Array.from(A.DISAPPEARING_OPTIONS));
});

// ── The switch that was missing ─────────────────────────────────────────────

const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('THE BUG: the web can now ask the server to change it', () => {
  assert.ok(/socket\.emit\('set_disappearing', \{ roomId: currentRoomId, seconds \}/.test(app),
    'nothing on the page can turn disappearing messages on or off');
});

test('and there is something to tap that does it', () => {
  assert.ok(html.includes('id="disappearing-chips"'), 'the sheet has no disappearing row');
  assert.ok(app.includes('function openFireSheet('), 'nothing opens the sheet');
  assert.ok(/function composerOneTime\(\) \{ openFireSheet\(\); \}/.test(app),
    'the 🔥 button still opens the old one-time prompt only');
  const fn = app.slice(app.indexOf('function renderFireSheet('), app.indexOf('/**\n * Turn the chat-wide timer'));
  assert.ok(fn.includes('Disappearing.DISAPPEARING_OPTIONS'), 'the chips are hand-built');
  assert.ok(fn.includes('Disappearing.chipLabel('), 'the chip labels are hand-written');
  assert.ok(/onclick = \(\) => setDisappearing\(/.test(fn), 'the chips do nothing');
});

test('tapping the chip that is already on turns it OFF', () => {
  // Otherwise it can be switched on and never off, which is the half of the
  // report that matters most.
  const fn = app.slice(app.indexOf('function renderFireSheet('), app.indexOf('/**\n * Turn the chat-wide timer'));
  assert.ok(/setDisappearing\(disappearingSeconds === secs && secs \? 0 : secs\)/.test(fn),
    'there is no way back to off');
  assert.ok(app.includes('.concat([0])'), 'the Off chip is missing from the row');
});

test('the screen changes only when the SERVER says it did', () => {
  // This setting is about everybody's messages in the chat; a switch that
  // looks flipped while the server refused it is a promise nobody kept.
  const fn = app.slice(app.indexOf('function setDisappearing('), app.indexOf('function stopTypingSignal'));
  assert.ok(fn.length > 0, 'setDisappearing is gone — this check would be vacuous');
  assert.ok(fn.indexOf('if (!res || res.error)') < fn.indexOf('disappearingSeconds = res.seconds'),
    'the local state is set before the answer is looked at');
  assert.ok(fn.includes("err.classList.remove('hidden')"), 'a refusal is never shown to anybody');
});

test('somebody else changing it updates the sheet you are looking at', () => {
  const at = app.indexOf("socket.on('disappearing_changed'");
  assert.ok(at > 0, 'the broadcast is not handled at all');
  const fn = app.slice(at, app.indexOf("socket.on('location_updated'", at));
  assert.ok(fn.length > 100, 'the handler could not be sliced — this check would be vacuous');
  assert.ok(fn.includes('disappearingSeconds = seconds || 0'), 'the page keeps a stale idea of the setting');
  assert.ok(fn.includes('renderFireSheet()'), 'an open sheet shows the old value');
});

test('opening a chat reads its setting, and does not carry the last one in', () => {
  const at = app.indexOf('api(`/room-settings/${roomId}`)');
  assert.ok(at > 0);
  assert.ok(/disappearingSeconds = 0;\s*\n\s*applyDisappearingSkin\(0\);/.test(app),
    'the previous chat\'s setting is still showing while the new one loads');
  assert.ok(app.slice(at, at + 400).includes('disappearingSeconds = r.disappearingSeconds || 0'),
    'the sheet would offer the wrong chip as the current one');
});

test('the one-time control did not lose its custom value', () => {
  // The web has always allowed any 1–3600 seconds; the sheet must not quietly
  // take that away.
  assert.ok(app.includes('function askOneTimeSeconds('), 'the custom duration is gone');
  assert.ok(app.includes("otChip('Custom…'"), 'there is no way to reach it');
  assert.ok(/\[5, 30, 60\]\.forEach/.test(app), 'the quick one-time choices are missing');
});

test('the three hand-written duration ladders are gone', () => {
  assert.ok(app.includes('Disappearing.bannerText(seconds)'), 'the banner still writes its own label');
  assert.ok(app.includes('Disappearing.disappearingPredicate('), 'the system notice still writes its own');
  assert.ok(!/secs === 604800 \? '1 week'/.test(app), 'a hand-written ladder survives in app.js');
  assert.ok(!/seconds === 604800 \? '1 week'/.test(app), 'a hand-written ladder survives in app.js');
  assert.ok(html.includes('/js/disappearing.js'), 'the shared vocabulary is never loaded by the page');
});

test('the app uses the shared chip labels too', () => {
  const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
  assert.ok(chat.includes('{chipLabel(secs)}'), 'the app builds chip labels with string replacement again');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
