// ── Coming back to where you were ──────────────────────────────────────────
//
// Asked for as: a video played from the files tab should play there, and
// closing it should put the files tab back at the file that was played; and
// "show in chat" should be a step you can come BACK from.
//
// The files tab is a Modal and the video player is not, so the player cannot
// be drawn over it — the browser has to be closed on the way in. That makes
// restoring it on the way out the whole of the behaviour, and there was
// nothing doing it: the player closed to the conversation, and "show in chat"
// left back meaning "leave the chat".
//
// The same was true of a PHOTO opened from the files tab. The code closed the
// browser on the way in while the comment beside it described a design where
// it was left open underneath — the design changed and the comment did not
// follow, so the restore it described was never written.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const CHAT = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const BROWSER = fs.readFileSync(path.join(NAT, 'src', 'components', 'MediaBrowser.tsx'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE FILES TAB COMES BACK WHEN A VIDEO CLOSES', () => {
  assert.ok(/const \[videoFromMedia, setVideoFromMedia\] = useState\(false\)/.test(CHAT),
    'nothing records that the player was opened from the files tab');
  const fn = /function closedVideo\(\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(fn, 'could not find closedVideo');
  assert.ok(/if \(!videoFromMedia\) return;/.test(fn[1]),
    'closing a video opened from the CHAT reopens the files tab as well');
  assert.ok(/reopenMedia\(\)/.test(fn[1]), 'the files tab is never put back');
  assert.ok(/setVideoFromMedia\(false\)/.test(fn[1]),
    'the flag survives, so the next video from the chat reopens the browser too');
  // …and the files tab actually sets it on the way in. Without this the
  // return above is correct and never happens, which is the same as not
  // existing.
  const open = /async function onMediaAction\(action: MediaAction, item: MediaItem\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(open, 'could not find onMediaAction');
  assert.ok(/setVideoFromMedia\(true\)/.test(open[1]),
    'opening a video from the files tab never records where it came from');
});

test('…BY EVERY WAY OF CLOSING IT', () => {
  // The button on the player and the hardware back are two different paths
  // out, and a return that only one of them takes is a return that works
  // half the time.
  assert.ok(/onClose=\{\(\) => \{ setVideoItem\(null\); setVideoMini\(false\); closedVideo\(\); \}\}/.test(CHAT),
    'the player\'s own close button does not come back');
  const back = /if \(!videoItem\) return;([\s\S]*?)\n  \}, \[videoItem, videoMini, videoFromMedia\]\);/.exec(CHAT);
  assert.ok(back, 'the video back handler no longer depends on where it came from');
  assert.ok(/if \(videoFromMedia\) \{[\s\S]*?closedVideo\(\);/.test(back[1]),
    'hardware back on a video from the files tab does not come back to it');
  // And it does NOT shrink to the floating window first, which would be a
  // detour out of a journey the person is trying to finish.
  const branch = /if \(videoFromMedia\) \{([\s\S]*?)\n      \}/.exec(back[1]);
  assert.ok(branch && !/setVideoMini\(true\)/.test(branch[1]),
    'back from the files tab shrinks the video instead of closing it');
});

test('A PHOTO FROM THE FILES TAB COMES BACK TOO', () => {
  // Same bug, older: the browser is closed on the way in and the restore the
  // comment described was never written.
  const fn = /function closeViewer\(\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(fn, 'could not find closeViewer');
  assert.ok(/if \(viewerFromMedia\) \{ setViewerFromMedia\(false\); reopenMedia\(\); \}/.test(fn[1]),
    'closing a photo opened from the files tab leaves the person in the chat');
  // The place in the grid is still remembered, which is the other half of
  // "where you were".
  assert.ok(/setMediaFocusIndex\(viewerIdx\)/.test(fn[1]),
    'the grid comes back at the top rather than at the photo');
});

test('"SHOW IN CHAT" IS A STEP YOU CAN COME BACK FROM', () => {
  assert.ok(/setBackToMedia\(true\)/.test(CHAT), 'nothing records where the jump came from');
  const eff = /if \(!backToMedia \|\| showMedia \|\| videoItem \|\| viewer\) return;([\s\S]*?)\n  \}, \[backToMedia, showMedia, videoItem, viewer\]\);/.exec(CHAT);
  assert.ok(eff, 'there is no back handler for the jump');
  assert.ok(/setBackToMedia\(false\)/.test(eff[1]), 'back returns for ever, from then on');
  assert.ok(/reopenMedia\(\)/.test(eff[1]), 'back does not reopen the files tab');
  assert.ok(/return true;/.test(eff[1]), 'back also leaves the chat, which is what it did before');
});

test('…AND ONLY WHILE THERE IS NOTHING ELSE ON TOP', () => {
  // A back handler that fires while the viewer, the player or the browser
  // itself is open would steal back from them. The guard is the condition of
  // the effect, so the listener is not even attached.
  assert.ok(/if \(!backToMedia \|\| showMedia \|\| videoItem \|\| viewer\) return;/.test(CHAT),
    'the jump\'s back handler competes with the overlays above it');
});

test('OPENING THE BROWSER AFRESH FORGETS THE OLD RETURN', () => {
  // Otherwise back still goes "back" to a journey that ended long ago.
  const fn = /async function openMediaBrowser\(tab: MediaTab = 'images'\) \{([\s\S]*?)\n  \}/.exec(CHAT);
  assert.ok(fn, 'could not find openMediaBrowser');
  assert.ok(/setBackToMedia\(false\)/.test(fn[1]),
    'a fresh open keeps a stale return, so back goes somewhere nobody came from');
});

test('THE FILES TAB REMEMBERS WHERE IT WAS', () => {
  // Only the photo grid remembered anything. Files, music and links are plain
  // lists with no ref and no record, so coming back put you at the top of a
  // tab that may hold two hundred files.
  assert.ok(/const listOffsets = useRef<Record<string, number>>\(\{\}\)/.test(BROWSER),
    'the other tabs still do not record where they were');
  assert.ok(/const listRefs = useRef<Record<string, FlatList \| null>>\(\{\}\)/.test(BROWSER),
    'there is nothing to scroll them with');
  // Recorded on scroll…
  assert.ok(/listOffsets\.current\.files = e\.nativeEvent\.contentOffset\.y/.test(BROWSER),
    'the files tab never records its position');
  assert.ok(/listOffsets\.current\[key\] = e\.nativeEvent\.contentOffset\.y/.test(BROWSER),
    'the music and links tabs never record theirs');
  // …and put back on the next open, once per open.
  const eff = /if \(!visible \|\| tab === 'images'\) return;([\s\S]*?)\n  \}, \[token, visible, tab\]\);/.exec(BROWSER);
  assert.ok(eff, 'nothing restores the other tabs');
  assert.ok(/listRestored\.current === token/.test(eff[1]),
    'it restores on every render, which fights the person scrolling');
  assert.ok(/scrollToOffset\(\{ offset, animated: false \}\)/.test(eff[1]),
    'the restore is animated, so the list visibly scrolls itself');
});

test('…AND DOES NOT SCROLL A LIST THAT HAS NO ROWS YET', () => {
  // A scroll issued before the list has its rows lands nowhere and is
  // silently ignored, which is the whole reason this is deferred.
  const eff = /if \(!visible \|\| tab === 'images'\) return;([\s\S]*?)\n  \}, \[token, visible, tab\]\);/.exec(BROWSER);
  assert.ok(/setTimeout\(/.test(eff[1]), 'the restore runs before the rows exist');
  assert.ok(/clearTimeout\(t\)/.test(eff[1]), 'the deferred restore outlives the tab it was for');
  assert.ok(/if \(!offset\) return;/.test(eff[1]),
    'a tab never scrolled is scrolled to the top it is already at');
});

test('THE GRID STILL RESTORES THE WAY IT DID', () => {
  // The photo grid had this all along; nothing above should have disturbed it.
  assert.ok(/gridOffset\.current = e\.nativeEvent\.contentOffset\.y/.test(BROWSER),
    'the photo grid stopped recording its position');
  assert.ok(/gridRef\.current\?\.scrollToOffset/.test(BROWSER),
    'the photo grid stopped restoring it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
