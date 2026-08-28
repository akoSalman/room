// What a tap on a voice message does.
//
// Asked for as: tapping everywhere on the voice message itself should play or
// pause it, and outside of the message should still pop up the menu.
//
// Before this only the small round ▶ was live. The waveform, the duration and
// the space around them were a dead zone — a tap there was swallowed by the
// bubble and did nothing — so playing a voice message meant hitting a
// 36-pixel target, and missing it felt like the app had ignored you.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
require(path.join(ROOT, 'public', 'js', 'voiceTap.js'));
const W = global.window.VoiceTap;

let V = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetap-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'voiceTap.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  V = require(path.join(OUT, 'voiceTap.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE POINT: a tap anywhere on the row plays it', () => {
  for (const region of ['button', 'waveform', 'elsewhere']) {
    assert.strictEqual(W.tapAction({ region, isCurrent: false }), 'toggle',
      `tapping the ${region} of a voice message still does nothing`);
  }
});

test('…and pauses it, from the same places', () => {
  // `toggle` is the same action either way: the player knows whether it is
  // running, and two rules for one gesture is how they drift apart.
  assert.strictEqual(W.tapAction({ region: 'elsewhere', isCurrent: true }), 'toggle');
  assert.strictEqual(W.tapAction({ region: 'button', isCurrent: true }), 'toggle');
});

test('THE EXCEPTION: the waveform is a timeline while it is the one playing', () => {
  // Turning that into play/pause would take away the only way to skip back
  // over a word you missed.
  assert.strictEqual(W.tapAction({ region: 'waveform', isCurrent: true }), 'seek');
});

test('but a waveform with nothing loaded is a picture, and plays', () => {
  // There is no position to seek to and no sound to seek in.
  assert.strictEqual(W.tapAction({ region: 'waveform', isCurrent: false }), 'toggle');
});

test('the speed button is never anything but the speed button', () => {
  assert.strictEqual(W.tapAction({ region: 'speed', isCurrent: false }), 'speed');
  assert.strictEqual(W.tapAction({ region: 'speed', isCurrent: true }), 'speed');
});

test('picking messages outranks all of it', () => {
  // Playing somebody's voice by accident while forwarding six messages is a
  // worse surprise than a tap that does nothing.
  for (const region of ['button', 'waveform', 'speed', 'elsewhere']) {
    assert.strictEqual(W.tapAction({ region, isCurrent: true, selectMode: true }), 'select',
      `${region} played the message while the chat was selecting`);
  }
});

test('the menu stays reachable from every part of the row', () => {
  // A voice message you can play but cannot reply to, forward or delete is
  // worse than one you have to aim at.
  for (const region of ['button', 'waveform', 'speed', 'elsewhere']) {
    assert.strictEqual(W.longPressOpensMenu(region), true);
  }
});

test('a seek that leaves the waveform stops at the ends', () => {
  assert.strictEqual(W.seekFraction(50, 100), 0.5);
  assert.strictEqual(W.seekFraction(-20, 100), 0, 'dragging off the left wrapped or went negative');
  assert.strictEqual(W.seekFraction(300, 100), 1, 'dragging off the right ran past the end');
  assert.strictEqual(W.seekFraction(10, 0), 0, 'a zero-width waveform divided by zero');
  assert.strictEqual(W.seekFraction(NaN, 100), 0);
});

test('the app and the web agree, region by region', () => {
  if (!V) return;
  let checked = 0;
  for (const region of ['button', 'waveform', 'speed', 'elsewhere']) {
    for (const isCurrent of [true, false]) {
      for (const selectMode of [true, false, undefined]) {
        const o = { region, isCurrent, selectMode };
        assert.strictEqual(W.tapAction(o), V.tapAction(o), `disagree for ${JSON.stringify(o)}`);
        checked++;
      }
    }
  }
  assert.strictEqual(checked, 24, 'the drift check did not actually run');
  for (const [x, w] of [[50, 100], [-1, 10], [999, 10], [0, 0], [NaN, 5]]) {
    assert.strictEqual(W.seekFraction(x, w), V.seekFraction(x, w), `seekFraction disagrees for ${x}/${w}`);
  }
});

// ── The wiring ──────────────────────────────────────────────────────────────

const vp = fs.readFileSync(path.join(NAT, 'src', 'components', 'VoicePlayer.tsx'), 'utf8');
const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('the whole row is the press target, not just the button', () => {
  assert.ok(/<Pressable\s+style=\{s\.container\}[\s\S]{0,200}?onPress=\{\(\) => onTap\('elsewhere'\)\}/.test(vp),
    'the bubble body is still a dead zone');
  assert.ok(/onPress=\{\(\) => onTap\('button'\)\}/.test(vp), 'the play button bypasses the rule');
});

test('and it still hands the long press to the message menu', () => {
  assert.ok(/onLongPress=\{onLongPress\}/.test(vp), 'the menu cannot be reached from the voice row');
  assert.ok(/onLongPress=\{\(\) => onMessageLongPress\(msg\)\}[\s\S]{0,200}?selectMode=\{selectMode\}/.test(chat),
    'the chat never passes the menu or select mode to the voice player');
  assert.ok(/onSelect=\{\(\) => toggleSelected\(msg\)\}/.test(chat), 'a voice message cannot be picked');
});

test('the waveform claims the touch only when it is a timeline', () => {
  // This is what makes the rest of the bubble reachable at all: a pan
  // responder that always claimed the touch would swallow every tap on it.
  assert.ok(/onStartShouldSetPanResponder: \(\) => wantsSeek\(\)/.test(vp),
    'the waveform grabs every touch again, so a tap on it never plays');
  assert.ok(/tapAction\(\{\s*region: 'waveform'/.test(vp), 'the waveform decides for itself');
  assert.ok(vp.includes('seekFraction('), 'the seek position is computed by hand');
});

test('the web plays from the row too, and does not open the menu doing it', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const fn = app.slice(app.indexOf('function buildVoicePlayer'), app.indexOf('// ─── Jump to replied message'));
  assert.ok(fn.includes('player.onclick'), 'the web row is still a dead zone');
  assert.ok(fn.includes('e.stopPropagation()'), 'playing from the row also opens the message menu');
  assert.ok(/VoiceTap\.tapAction\(/.test(fn), 'the web decides for itself what a tap means');
  assert.ok(fn.includes('VoiceTap.seekFraction('), 'the web computes the seek position by hand');
  // The three controls keep their own handlers; the row must not fire as well.
  assert.ok(/closest\('\.voice-play-btn, \.voice-waveform, \.voice-speed-btn'\)/.test(fn),
    'a click on the button runs both the button and the row');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('/js/voiceTap.js'), 'the rules are never loaded by the page');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
