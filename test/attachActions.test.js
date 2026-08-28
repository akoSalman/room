// What the ＋ next to the composer opens, and what sits around the shutter.
//
// Asked for as: tapping the media button should open the camera straight away,
// with a menu left and right of the shutter for files, the gallery, voice and
// contacts, and photo/video switching like WhatsApp.
//
// The old flow put a sheet in the way: every attachment began with a list, and
// the commonest one — a photo of what is in front of you — cost two taps and a
// modal before the camera started warming up.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping attach-action tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
execFileSync(TSC, [path.join(NAT, 'src', 'attachActions.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const A = require(path.join(OUT, 'attachActions.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The row around the shutter ──────────────────────────────────────────────

test('THE POINT: all four ways to attach something are there', () => {
  const ids = A.ACTIONS.map(a => a.id).sort();
  assert.deepStrictEqual(ids, ['contact', 'file', 'gallery', 'voice']);
});

test('they are split evenly, so neither thumb has to stretch', () => {
  const left = A.actionsFor({ side: 'left' });
  const right = A.actionsFor({ side: 'right' });
  assert.strictEqual(left.length, 2, 'the left of the shutter is lopsided');
  assert.strictEqual(right.length, 2, 'the right of the shutter is lopsided');
  // No action may appear on both sides, or a tap means two different things.
  const both = left.filter(l => right.some(r => r.id === l.id));
  assert.deepStrictEqual(both, []);
});

test('every action has an icon and a word under it', () => {
  // Four unlabelled glyphs around a shutter is a puzzle, not a menu.
  for (const a of A.ACTIONS) {
    assert.ok(a.icon && a.icon.length > 2, `${a.id} has no icon`);
    assert.ok(a.label && a.label.length > 2, `${a.id} has no label`);
  }
});

test('Paste appears only when the clipboard holds something', () => {
  // An action that does nothing is worse than one that is absent — and this is
  // a fifth item in a row that is already full.
  assert.strictEqual(A.actionsFor({ side: 'right', clipboard: null }).length, 2);
  const withPaste = A.actionsFor({ side: 'right', clipboard: 'image' });
  assert.strictEqual(withPaste.length, 3);
  assert.strictEqual(withPaste[withPaste.length - 1].id, 'paste');
  // It never crowds the left side, which already has two.
  assert.strictEqual(A.actionsFor({ side: 'left', clipboard: 'image' }).length, 2);
});

test('the camera closes before any picker opens', () => {
  // A picker somebody may spend a minute in must not hold the preview — and
  // the phone's camera — open behind it.
  for (const id of ['gallery', 'file', 'voice', 'contact', 'paste']) {
    assert.strictEqual(A.closesCamera(id), true, `${id} leaves the camera running`);
  }
});

test('the camera opens in photo mode, not video', () => {
  assert.strictEqual(A.OPENS_IN, 'photo');
});

test('but not for a chat the user cannot post to', () => {
  assert.strictEqual(A.opensCamera({ canPost: true }), true);
  assert.strictEqual(A.opensCamera({ canPost: false }), false,
    'a camera was opened for somebody who cannot send the photo');
});

// ── Sending a contact ───────────────────────────────────────────────────────

test('a contact becomes a name and its numbers, each on its own line', () => {
  const msg = A.contactMessage({
    name: 'Soran', phoneNumbers: [{ number: '0770 123 4567' }, { number: '0750 999 1111' }],
  });
  assert.ok(msg.includes('Soran'));
  const lines = msg.split('\n');
  assert.strictEqual(lines.length, 3, 'the numbers are not on separate lines, so they are not tappable');
  assert.ok(lines[1].includes('0770'));
});

test('the same number stored twice is sent once', () => {
  // Very common: one number saved as both "mobile" and "WhatsApp".
  const msg = A.contactMessage({
    name: 'Ako', phoneNumbers: [{ number: '0770 1' }, { number: '0770 1' }],
  });
  assert.strictEqual(msg.split('\n').length, 2, 'a duplicate number was sent twice');
});

test('a contact with no number is not worth sending', () => {
  assert.strictEqual(A.contactWorthSending({ name: 'Nobody', phoneNumbers: [] }), false);
  assert.strictEqual(A.contactWorthSending({ name: 'Nobody' }), false);
  assert.strictEqual(A.contactWorthSending(null), false);
  assert.strictEqual(
    A.contactWorthSending({ name: 'Ako', phoneNumbers: [{ number: '123' }] }), true);
});

test('a nameless contact still sends its number', () => {
  const msg = A.contactMessage({ phoneNumbers: [{ number: '0770 1' }] });
  assert.ok(msg.includes('0770 1'), msg);
  assert.ok(msg.length > 0);
});

test('nothing at all produces nothing, rather than a stray emoji', () => {
  assert.strictEqual(A.contactMessage(null), '');
  assert.strictEqual(A.contactMessage({}), '');
  assert.strictEqual(A.contactMessage({ name: '  ', phoneNumbers: [] }), '');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const cam = fs.readFileSync(path.join(NAT, 'src', 'screens', 'CameraScreen.tsx'), 'utf8');

test('the ＋ opens the camera rather than a sheet', () => {
  const attach = chat.slice(chat.indexOf('onAttach={'), chat.indexOf('onRecord={'));
  assert.ok(attach.includes('setCameraMode(OPENS_IN)'), 'the button still opens the old sheet first');
  assert.ok(attach.includes('opensCamera('), 'nothing checks whether the chat can be posted to');
});

test('the camera hands the other choices back, and closes first', () => {
  assert.ok(cam.includes('onPick?.(a.id)'), 'the actions around the shutter do nothing');
  assert.ok(cam.includes("actionsFor({ side: 'left'"), 'the left side is hand-built');
  assert.ok(cam.includes("actionsFor({ side: 'right'"), 'the right side is hand-built');
  const pick = chat.slice(chat.indexOf('onPick={(action)'), chat.indexOf('onPick={(action)') + 400);
  assert.ok(pick.includes('setCameraMode(null)'), 'the camera is left running behind the picker');
});

test('every action the row offers is actually handled', () => {
  const handler = chat.slice(chat.indexOf('async function runAttachAction'),
    chat.indexOf('async function pickContact'));
  for (const id of ['gallery', 'file', 'voice', 'contact', 'paste']) {
    assert.ok(handler.includes(`case '${id}'`), `${id} is offered and does nothing`);
  }
});

test('the actions are hidden while a video is recording', () => {
  // A tap that closed the camera mid-clip would throw the recording away.
  assert.ok(/\{!recording && actionsFor\(\{ side: 'left'/.test(cam),
    'the left actions stay tappable while recording');
  assert.ok(/shots\.length === 0 && !recording \?/.test(cam),
    'the right actions stay tappable while recording, or hide the send button');
});

test('photo and video are still switchable, and the flip button survived', () => {
  assert.ok(/setMode\(m\)/.test(cam), 'the photo/video switch is gone');
  assert.ok(/setFacing\(f => \(f === 'back' \? 'front' : 'back'\)\)/.test(cam),
    'the camera can no longer be flipped');
});

test('contacts are declared, or the picker cannot open', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(NAT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['expo-contacts'], 'expo-contacts is not a dependency');
  const appJson = fs.readFileSync(path.join(NAT, 'app.json'), 'utf8');
  assert.ok(appJson.includes('expo-contacts'), 'the permission string is not configured');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
