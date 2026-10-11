// ── The screenshot offer, as wired into the chat ────────────────────────────
//
// screenshots.test.js covers the deciding. This covers whether the decision is
// ever reached and what is done with it — a correct rule that nothing calls is
// the same as no feature, and it would pass every test in that file.
//
// Two of these guard things that are not about screenshots at all:
//
//   • the check must never ASK for permission. A prompt that appeared because
//     a conversation was opened would be unexplainable, and a "no" there is
//     remembered against the gallery picker, which is the feature people
//     actually need;
//
//   • it must ask about PHOTOS only. The default asks about audio and video
//     too, so somebody who granted pictures and nothing else — a choice
//     Android 13 offers — would read as having refused.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const CHAT = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const COMPOSER = fs.readFileSync(path.join(NAT, 'src', 'components', 'Composer.tsx'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** findScreenshot's body, which is where every decision below is made. */
function check() {
  const m = /async function findScreenshot\(mayAsk: boolean\)[^{]*\{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(m, 'could not find findScreenshot — every check here would be vacuous');
  return m[1];
}

test('THE AUTOMATIC LOOK NEVER ASKS FOR PERMISSION', () => {
  // A prompt that appeared because a conversation was opened is
  // unexplainable, and a "no" given to it is then remembered against the
  // gallery picker — the feature people actually need.
  const auto = /async function checkScreenshot\(\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(auto, 'could not find checkScreenshot');
  assert.ok(/findScreenshot\(false\)/.test(auto[1]),
    'the look that runs on every resume is allowed to raise a permission prompt');
  assert.ok(!/requestPermissionsAsync/.test(auto[1]), 'it asks for permission directly');
});

test('…AND ONLY A TAP ON PASTE MAY ASK', () => {
  // Which is the one moment a prompt about pictures answers something the
  // person just did. Without this route the offer would only ever reach
  // people who had granted the permission for some other reason — and on
  // Android 13 the photo picker needs none, so that is far from everybody.
  const fn = check();
  assert.ok(/mayAsk\s*\n?\s*\? await MediaLibrary\.requestPermissionsAsync\(false, \['photo'\]\)/.test(fn),
    'nothing can ever ask for permission, so a phone that has not granted it can never offer a screenshot');
  assert.ok(/: await MediaLibrary\.getPermissionsAsync\(false, \['photo'\]\)/.test(fn),
    'the look that may not ask has no way to check');
  const paste = /async function pasteFromClipboard\(\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(paste, 'could not find pasteFromClipboard');
  assert.ok(/findScreenshot\(true\)/.test(paste[1]),
    'tapping Paste with an empty clipboard still just says there is nothing to paste');
  assert.ok(/stageScreenshot\(found\)/.test(paste[1]), 'the screenshot it finds is not attached');
});

test('…ABOUT PHOTOS ONLY, both ways', () => {
  // Either call with no argument asks about audio and video as well, so a
  // photos-only grant — a choice Android 13 offers — reads as a refusal and
  // this silently never works for whoever made it.
  const fn = check();
  assert.ok(!/PermissionsAsync\(\)/.test(fn),
    'a permission call asks about audio and video too, so a photos-only grant reads as refused');
  assert.strictEqual((fn.match(/PermissionsAsync\(false, \['photo'\]\)/g) || []).length, 2,
    'one of the two permission calls is not narrowed to photos');
});

test('THE PASTE BUTTON IS REACHABLE WITH AN EMPTY CLIPBOARD', () => {
  // It used to be hidden unless the clipboard held something, which would
  // have made the route above dead code: a screenshot is never on the
  // clipboard, so there would have been nothing to reveal the button.
  assert.ok(!/\{!!clipboard && \(\s*\n\s*<TouchableOpacity style=\{s\.stripBtn\} onPress=\{onPaste\}/.test(COMPOSER),
    'the paste button is hidden when the clipboard is empty, so a screenshot can never be reached through it');
  assert.ok(/onPress=\{onPaste\}/.test(COMPOSER), 'there is no paste button at all');
});

test('THE ALBUM DECIDES, and the filename is only the fallback', () => {
  // The album is the folder name on disk and is not translated; the filenames
  // inside it are. This app's users have Persian and Kurdish phones.
  const fn = check();
  assert.ok(/getAlbumAsync\('Screenshots'\)/.test(fn), 'the screenshots album is never looked for');
  assert.ok(/isScreenshotAlbum\(/.test(fn),
    'a phone whose album is named differently has no second chance');
  assert.ok(/album \? assets : assets\.filter\(a => isScreenshotName\(a\.filename\)\)/.test(fn),
    'the filename is used even when the album already answered, or never used at all');
});

test('ONLY FRESH ASSETS ARE EVEN FETCHED', () => {
  // The window is enforced twice: once in the query, so a page of old photos
  // is not read at all, and once in pickShot, which is what is tested in
  // screenshots.test.js.
  assert.ok(/createdAfter: now - FRESH_MS/.test(check()),
    'every photo in the library is fetched and then thrown away');
});

test('AN OFFER THAT NO LONGER QUALIFIES IS TAKEN DOWN', () => {
  // Left up, it is an offer to send the wrong picture: the chip would still
  // be there, with a thumbnail of a screenshot that has gone stale or has
  // already been sent. The offer is ASSIGNED from the look, so every way the
  // look can come back empty clears it — including the catch.
  const auto = /async function checkScreenshot\(\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(/setShot\(await findScreenshot\(false\)\)/.test(auto[1]),
    'a stale or already-sent offer stays on screen');
  const fn = check();
  assert.ok(/if \(!pick\) return null;/.test(fn), 'nothing qualifying still reports something');
  assert.ok(/catch \{[\s\S]*?return null;/.test(fn), 'a failed look reports a screenshot anyway');
});

test('IT IS CHECKED AGAIN WHEN THE APP COMES BACK TO THE FRONT', () => {
  // Which is the whole case: the screenshot is taken in ANOTHER app, and this
  // one is opened afterwards. A check only on mount would miss every
  // screenshot taken while the chat was already open behind.
  const eff = /checkClipboard\(\);\n    checkScreenshot\(\);\n    const sub = AppState\.addEventListener\('change', st => \{([\s\S]*?)\n    \}\);/.exec(CHAT);
  assert.ok(eff, 'the screenshot is not checked alongside the clipboard on arrival and on resume');
  assert.ok(/checkScreenshot\(\);/.test(eff[1]), 'coming back to the app does not look for a new screenshot');
});

test('ATTACHING IT GOES THROUGH THE SAME STAGING AS EVERYTHING ELSE', () => {
  // Staged, not sent: the message being typed is its caption, and the quality
  // switch and the one-time timer have to apply to it.
  const fn = /function stageScreenshot\(s: \{ id: string; uri: string; name: string \}\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(fn, 'could not find stageScreenshot');
  assert.ok(/setPendingMedia\(prev => \[\.\.\.prev, \{ uri: s\.uri/.test(fn[1]),
    'the screenshot is sent immediately, or staged some other way');
  assert.ok(!/sendText\(|sendMedia\(|upload\(/.test(fn[1]),
    'attaching the screenshot sends it straight away, with no chance to caption it');
  // And both routes in use it, so neither can drift from the other.
  assert.ok(/function takeScreenshot\(\) \{\n    if \(shot\) stageScreenshot\(shot\);/.test(CHAT),
    'the chip stages the screenshot its own way');
});

test('…AS AN IMAGE, whatever the file is called', () => {
  // guessMime answers application/octet-stream for a name it does not know —
  // truthy, so a plain `||` fallback never fires — and a screenshot staged as
  // that is sent as a FILE: no preview in the bubble, no quality switch. The
  // localized filenames this feature exists for are exactly the ones whose
  // extension may not survive.
  const fn = /function stageScreenshot\(s: \{ id: string; uri: string; name: string \}\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(/guessed\.startsWith\('image\/'\) \? guessed : 'image\/png'/.test(fn[1]),
    'an unrecognised name makes the screenshot an octet-stream, and it is sent as a file');
});

test('ONE THAT HAS BEEN DEALT WITH IS NOT OFFERED AGAIN', () => {
  // Both ways out have to record it. The check runs on every resume, so the
  // one that forgot would put the chip straight back.
  const stage = /function stageScreenshot\(s: \{ id: string; uri: string; name: string \}\) \{([\s\S]*?)\n  \}/.exec(CHAT)[1];
  const drop = /function dismissScreenshot\(\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(drop, 'there is no way to dismiss the offer');
  for (const [name, body] of [['attaching', stage], ['dismissing', drop[1]]]) {
    assert.ok(/shotHandled\.current = \[\.\.\.shotHandled\.current, \w+\.id\]/.test(body),
      `${name} it does not record which one, so the chip comes back on the next resume`);
    assert.ok(/setShot\(null\)/.test(body), `${name} it leaves the chip on screen`);
  }
});

test('THE CHIP SHOWS THE PICTURE, not just a word', () => {
  // It offers to attach something the person did not pick from anywhere, so
  // they have to be able to see WHICH screenshot before they tap.
  const bar = /\{!!screenshot && \(([\s\S]*?)\n      \)\}/.exec(COMPOSER);
  assert.ok(bar, 'the composer never renders the offer');
  assert.ok(/source=\{\{ uri: screenshot\.uri \}\}/.test(bar[1]), 'the offer has no thumbnail');
  assert.ok(/onPress=\{onSendScreenshot\}/.test(bar[1]), 'tapping the offer does nothing');
  assert.ok(/onPress=\{onDismissScreenshot\}/.test(bar[1]), 'the offer cannot be dismissed');
});

test('…and the chat actually passes it down', () => {
  // The three props together. Any one missing is a chip that cannot appear,
  // cannot be used, or cannot be got rid of.
  assert.ok(/screenshot=\{shot\}/.test(CHAT), 'the offer is never handed to the composer');
  assert.ok(/onSendScreenshot=\{takeScreenshot\}/.test(CHAT), 'tapping it is not wired up');
  assert.ok(/onDismissScreenshot=\{dismissScreenshot\}/.test(CHAT), 'dismissing it is not wired up');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
