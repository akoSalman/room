// A call you can put down without hanging up.
//
// Asked for as: the call should be minimizable, and while calling the user
// should be able to work — with or without the app on the device.
//
// Two failures behind that one sentence. The call screen was full-screen with
// no way out but "End", so looking something up meant hanging up. And leaving
// the app was worse: with nothing holding the process in the foreground,
// Android is free to freeze a backgrounded app, and a frozen app is a call
// whose audio stops and whose socket dies with neither side told.
//
// What is testable here is the part that goes wrong silently: a bubble dragged
// off the edge of the screen and lost, a call that can be shrunk while it is
// still ringing at you, and a foreground service that is never started or
// never stopped.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping call-window tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'callwindow-'));
execFileSync(TSC, [path.join(NAT, 'src', 'callWindow.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
const W = require(path.join(OUT, 'callWindow.js'));

global.window = global;
require(path.join(__dirname, '..', 'public', 'js', 'callStatus.js'));
const Web = global.window.CallStatus;

const tests = [];
const test = (n, f) => tests.push({ n, f });

const SCREEN = { w: 400, h: 860 };
const PILL = { w: 168, h: 56 };

// ── When a call may be shrunk ───────────────────────────────────────────────

test('THE POINT: a call in progress can be minimized', () => {
  assert.strictEqual(W.canMinimize('connected'), true);
});

test('so can one that is still ringing out — that is when there is time to spare', () => {
  assert.strictEqual(W.canMinimize('outgoing'), true);
});

test('THE BUG THIS AVOIDS: an incoming call cannot be shrunk away', () => {
  // A call ringing AT you is a question that wants an answer now. Minimizing
  // it is how a call ends up ringing in a corner while somebody keeps
  // scrolling, and then gets missed.
  assert.strictEqual(W.canMinimize('incoming'), false);
  assert.strictEqual(W.canMinimize('idle'), false);
});

test('the web agrees with the app about that', () => {
  for (const p of ['idle', 'incoming', 'outgoing', 'connected']) {
    assert.strictEqual(Web.canMinimize(p), W.canMinimize(p), `the two disagree about "${p}"`);
  }
});

// ── The bubble stays reachable ──────────────────────────────────────────────

test('THE BUG: a bubble dragged off the screen is brought back', () => {
  // Off the edge it is unreachable: no way back into the call, no way to hang
  // up, and nothing on screen to say it is still running.
  const far = W.clampToScreen({ x: 9999, y: 9999 }, PILL, SCREEN);
  assert.ok(far.x + PILL.w <= SCREEN.w, `x=${far.x} puts the bubble past the right edge`);
  assert.ok(far.y + PILL.h <= SCREEN.h, `y=${far.y} puts the bubble below the screen`);
  const near = W.clampToScreen({ x: -9999, y: -9999 }, PILL, SCREEN);
  assert.ok(near.x >= 0 && near.y >= 0, `${JSON.stringify(near)} is off the top-left`);
});

test('it is kept clear of the status bar and the home gesture', () => {
  const top = W.clampToScreen({ x: 10, y: 0 }, PILL, SCREEN);
  assert.ok(top.y >= 44, `y=${top.y} sits under the status bar`);
  const bottom = W.clampToScreen({ x: 10, y: SCREEN.h }, PILL, SCREEN);
  assert.ok(bottom.y + PILL.h <= SCREEN.h - 24, `y=${bottom.y} sits in the gesture area`);
});

test('a position already on screen is left exactly where it is', () => {
  const p = { x: 120, y: 300 };
  assert.deepStrictEqual(W.clampToScreen(p, PILL, SCREEN), p);
});

test('a screen too small for the bubble still yields a usable position', () => {
  // Rotating a small phone, or a split-screen window. The bubble must not end
  // up at a negative coordinate.
  const tiny = { w: 100, h: 100 };
  const p = W.clampToScreen({ x: 50, y: 50 }, PILL, tiny);
  assert.ok(p.x >= 0 && p.y >= 0, JSON.stringify(p));
});

test('let go, it snaps to the nearer edge', () => {
  // A bubble left floating in the middle sits on top of the message you are
  // trying to read.
  const left = W.snapToEdge({ x: 30, y: 300 }, PILL, SCREEN);
  assert.strictEqual(left.x, 8, `x=${left.x} did not snap left`);
  const right = W.snapToEdge({ x: 300, y: 300 }, PILL, SCREEN);
  assert.strictEqual(right.x, SCREEN.w - PILL.w - 8, `x=${right.x} did not snap right`);
  assert.strictEqual(right.y, 300, 'snapping sideways moved it vertically');
});

test('snapping decides by the bubble\'s middle, not its left edge', () => {
  // x=140 has its left edge left of centre and its middle right of it. Judging
  // by the edge sends a bubble the user pushed right back to the left.
  const centreRight = W.snapToEdge({ x: 140, y: 300 }, PILL, SCREEN);
  assert.strictEqual(centreRight.x, SCREEN.w - PILL.w - 8,
    'snapped by the left edge rather than the middle');
});

test('it starts somewhere sensible and on screen', () => {
  const p = W.defaultPosition(PILL, SCREEN);
  assert.deepStrictEqual(W.clampToScreen(p, PILL, SCREEN), p, 'the default position is off screen');
  assert.ok(p.x > SCREEN.w / 2, 'the bubble starts over the left of the chat');
});

test('a tap that wobbles is still a tap', () => {
  // Otherwise returning to the call by tapping the bubble fails about half the
  // time, because fingers move.
  assert.strictEqual(W.isDrag(2, 3), false);
  assert.strictEqual(W.isDrag(0, 0), false);
  assert.strictEqual(W.isDrag(20, 0), true);
  assert.strictEqual(W.isDrag(0, -20), true);
});

// ── What the shade says ─────────────────────────────────────────────────────

test('the service runs for any live call, and only for a live call', () => {
  for (const p of ['incoming', 'outgoing', 'connected']) {
    assert.strictEqual(W.serviceNeeded(p), true, `no service while ${p}`);
  }
  assert.strictEqual(W.serviceNeeded('idle'), false,
    'the foreground service outlives the call — an ongoing notification for nothing');
});

test('the shade says what the call is doing', () => {
  assert.strictEqual(
    W.ongoingText({ phase: 'connected', kind: 'voice', connected: true }), 'Voice call in progress');
  assert.strictEqual(
    W.ongoingText({ phase: 'connected', kind: 'video', connected: true }), 'Video call in progress');
  assert.strictEqual(
    W.ongoingText({ phase: 'outgoing', kind: 'voice', connected: false }), 'Voice call · connecting');
  assert.strictEqual(
    W.ongoingText({ phase: 'incoming', kind: 'video', connected: false }), 'Incoming video call');
});

test('the shade\'s timer starts when the call connects, not when it was placed', () => {
  // Otherwise it counts the ringing as call time and disagrees with the timer
  // on the call screen itself.
  assert.strictEqual(W.showsChronometer(true), true);
  assert.strictEqual(W.showsChronometer(false), false);
});

// ── Which video fills the screen ────────────────────────────────────────────
//
// Asked for as: on a video call the user should be able to swap between their
// own minimized video and the other side's maximized one.
//
// The panes were fixed — the other person always full screen, you always the
// corner. That is the right default and the wrong rule: checking your own
// framing, or showing somebody what is behind you, wants them the other way
// round.

test('THE DEFAULT: you fill the screen, the other side is the corner', () => {
  // Asked for in those words: "it should show me on the big window and the
  // other side on the small window".
  assert.deepStrictEqual(
    W.videoPanes({ swapped: false, hasRemote: true, hasLocal: true }),
    { big: 'local', small: 'remote' });
});

test('THE BUG: connecting does not rearrange the screen', () => {
  // Reported as "it changes instantly". A call begins with one video — yours —
  // and one video belongs on the screen rather than in the corner of a black
  // rectangle. If the arrangement AFTER the other side arrives disagrees with
  // that, every video call starts by throwing the picture across the screen.
  //
  // So the two must name the same big pane. This is the whole fix, and it is
  // the assertion that fails if the default is ever put back the other way.
  const before = W.videoPanes({ swapped: false, hasRemote: false, hasLocal: true });
  const after = W.videoPanes({ swapped: false, hasRemote: true, hasLocal: true });
  assert.strictEqual(before.big, after.big,
    'the big pane changes the moment the other side connects');
  assert.strictEqual(before.big, 'local');
  // Nothing moved: the corner was empty and now has them in it.
  assert.strictEqual(before.small, null);
  assert.strictEqual(after.small, 'remote');
});

test('THE POINT: swapped, the other person fills the screen', () => {
  assert.deepStrictEqual(
    W.videoPanes({ swapped: true, hasRemote: true, hasLocal: true }),
    { big: 'remote', small: 'local' });
});

test('before the other side\'s video arrives there is one video, full screen', () => {
  assert.deepStrictEqual(
    W.videoPanes({ swapped: false, hasRemote: false, hasLocal: true }),
    { big: 'local', small: null });
  // And a swap asked for earlier cannot strand them in the corner of nothing.
  assert.deepStrictEqual(
    W.videoPanes({ swapped: true, hasRemote: false, hasLocal: true }),
    { big: 'local', small: null });
});

test('THE TRAP: turning your camera off puts the other person on the screen', () => {
  // Otherwise the screen fills with black and the person talking disappears —
  // and with you as the default big pane this is now the ordinary case rather
  // than an odd one, so it is checked both ways round.
  assert.deepStrictEqual(
    W.videoPanes({ swapped: false, hasRemote: true, hasLocal: true, cameraOff: true }),
    { big: 'remote', small: null });
  assert.deepStrictEqual(
    W.videoPanes({ swapped: true, hasRemote: true, hasLocal: true, cameraOff: true }),
    { big: 'remote', small: null });
});

test('the two panes are NEVER the same side', () => {
  // Reported as "sometimes on both windows there is one side video". Whatever
  // else the rule says, it must never name one stream twice — two copies of
  // one person hides that the other has not arrived.
  for (const swapped of [true, false]) {
    for (const hasRemote of [true, false]) {
      for (const hasLocal of [true, false]) {
        for (const cameraOff of [true, false]) {
          const p = W.videoPanes({ swapped, hasRemote, hasLocal, cameraOff });
          assert.ok(p.small === null || p.small !== p.big,
            `both panes are ${p.big} for ${JSON.stringify({ swapped, hasRemote, hasLocal, cameraOff })}`);
        }
      }
    }
  }
});

test('the swap gesture is only offered when it would do something', () => {
  assert.strictEqual(W.canSwapVideos({ hasRemote: true, hasLocal: true }), true);
  assert.strictEqual(W.canSwapVideos({ hasRemote: false, hasLocal: true }), false);
  assert.strictEqual(W.canSwapVideos({ hasRemote: true, hasLocal: false }), false);
  assert.strictEqual(W.canSwapVideos({ hasRemote: true, hasLocal: true, cameraOff: true }), false);
});

test('the mirror follows the STREAM, not the pane', () => {
  // Your own front camera is mirrored wherever it is shown — that is what a
  // mirror does. The other person never is: mirroring them shows their text
  // backwards. Tying this to the pane instead is the bug swapping invites.
  assert.strictEqual(W.mirrors('local', true), true);
  assert.strictEqual(W.mirrors('remote', true), false, "the other person was mirrored");
  assert.strictEqual(W.mirrors('local', false), false, 'the back camera was mirrored');
});

test('the web lays the panes out exactly as the app does', () => {
  let checked = 0;
  for (const swapped of [true, false]) {
    for (const hasRemote of [true, false]) {
      for (const hasLocal of [true, false]) {
        for (const cameraOff of [true, false]) {
          const o = { swapped, hasRemote, hasLocal, cameraOff };
          assert.deepStrictEqual(Web.videoPanes(o), W.videoPanes(o),
            `panes drifted for ${JSON.stringify(o)}`);
          assert.strictEqual(Web.canSwapVideos(o), W.canSwapVideos(o),
            `swappability drifted for ${JSON.stringify(o)}`);
          checked++;
        }
      }
    }
  }
  assert.strictEqual(checked, 16, 'the drift check did not run over every case');
});

// ── The wiring, which no unit test can reach ────────────────────────────────

const manager = fs.readFileSync(path.join(NAT, 'src', 'callManager.ts'), 'utf8');
const overlay = fs.readFileSync(path.join(NAT, 'src', 'components', 'CallOverlay.tsx'), 'utf8');
const ongoing = fs.readFileSync(path.join(NAT, 'src', 'ongoingCall.ts'), 'utf8');
const app = fs.readFileSync(path.join(NAT, 'App.tsx'), 'utf8');

/** The body of one method of the call manager, by brace matching. */
function methodBody(name) {
  const m = new RegExp(`(private |async )*${name}\\([^)]*\\)\\s*\\{`).exec(manager);
  assert.ok(m, `${name}() is gone — the check using it would be vacuous`);
  let depth = 0, end = -1;
  for (let i = m.index + m[0].length - 1; i < manager.length; i++) {
    if (manager[i] === '{') depth++;
    else if (manager[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, `could not find the end of ${name}()`);
  return manager.slice(m.index, end);
}

test('the call can actually be minimized and restored', () => {
  assert.ok(/\bminimize\(\)\s*\{/.test(manager) && /\bexpand\(\)\s*\{/.test(manager),
    'the call manager has no minimize/expand');
  assert.ok(manager.includes('canMinimize(this.windowPhase)'),
    'minimize does not consult the rule, so an incoming call can be shrunk away');
  assert.ok(overlay.includes('cm.minimize()') && overlay.includes('cm.expand()'),
    'the call screen offers no way in or out of the bubble');
});

test('the bubble keeps a way to hang up, and a way back', () => {
  // A bubble you cannot end the call from is a trap: the only way out would be
  // to expand it first, and if it has drifted somewhere awkward, not even that.
  const pill = overlay.slice(overlay.indexOf('if (cm.minimized'), overlay.indexOf('// ── Active call'));
  assert.ok(pill.includes('cm.end()'), 'the minimized call cannot be ended');
  assert.ok(pill.includes('cm.expand()'), 'the minimized call cannot be restored');
  assert.ok(pill.includes('cm.toggleMute()'), 'the minimized call cannot be muted');
});

test('the minimized state is cleared when the call is', () => {
  // Otherwise the NEXT call opens as a bubble nobody asked for.
  assert.ok(methodBody('teardown').includes('this.minimized = false;'),
    'minimized survives the call, so the next one starts shrunk');
});

test('THE CAPABILITY THAT WAS GIVEN UP: a call no longer runs a service', () => {
  // This test used to assert the opposite, and it is worth keeping the reason
  // rather than quietly inverting it.
  //
  // A foreground service is what stops Android freezing the process when the
  // app is in the background — the whole reason it was added, so that leaving
  // the app during a call did not silently kill the audio. But "tapping call
  // crashes at the first ring" has now been reported twice, the second time on
  // a build carrying my fix for it, and the crash cannot be caught in
  // JavaScript: the service starts natively after displayNotification()
  // returns. A call that connects and can be frozen in the background beats an
  // app that dies before it rings.
  //
  // It goes back on when there is a crash log saying what Android objected to.
  assert.ok(/export const CALL_FOREGROUND_SERVICE = false;/.test(ongoing),
    'the service is back on without a crash log to justify it');
  assert.ok(/asForegroundService: wantsService,/.test(ongoing),
    'the notification asks for a service regardless of the switch');
  assert.ok(/ongoing: true/.test(ongoing),
    'the call notification can be swiped away, leaving a call running with nothing on screen');
});

test('the service task is registered at import time, not when a call starts', () => {
  // Notifee requires the task to exist before any foreground-service
  // notification is displayed. Registering it lazily is too late, and Android
  // kills the service on the spot.
  assert.ok(app.includes('registerCallService()'), 'the service task is never registered');
  const reg = app.indexOf('registerCallService()');
  const firstFn = app.search(/^(export default )?function /m);
  assert.ok(reg < firstFn || firstFn === -1,
    'registration happens inside a component, which runs far too late');
});

test('the service is started AND stopped, on every path', () => {
  // Stopped by the call ENDING, specifically. A stop that only happens inside
  // the state-sync helper leaves the notification — and the service holding
  // the process awake — behind on any path that tears down directly.
  assert.ok(methodBody('teardown').includes('ongoing.stopOngoing()'),
    'ending a call leaves the foreground service running');
  assert.ok((manager.match(/this\.syncOngoing\(\)/g) || []).length >= 4,
    'the shade is only updated on some of the call\'s state changes');
  const permissions = fs.readFileSync(path.join(NAT, 'app.json'), 'utf8');
  for (const p of ['FOREGROUND_SERVICE_PHONE_CALL', 'FOREGROUND_SERVICE_MICROPHONE']) {
    assert.ok(permissions.includes(p), `${p} is not declared, so the service cannot start`);
  }
});

test('"End call" in the shade actually ends the call', () => {
  assert.ok(ongoing.includes('END_ACTION'), 'the notification has no end action');
  assert.ok(app.includes('onEndFromShade('), 'nothing handles the end action');
  assert.ok(app.includes('handleNotifeeEvent('), 'notification presses never reach the call');
});

test('the web can collapse its call panel too', () => {
  // Collapsing is now one of three sizes rather than a toggle of its own —
  // the panel does minimized, half and full, and one button cycles them. What
  // this test is actually about is that the capability still exists and still
  // goes through the shared rule, so it asks for that rather than for one
  // particular function name.
  const calls = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calls.js'), 'utf8');
  assert.ok(/cycleSize/.test(calls), 'the web call panel cannot be resized at all');
  // Under its OWN name. `toggleMinimize: cycleSize` is kept as an alias for
  // cached pages from an older build, and it satisfied a looser match here —
  // so this requires the key itself, which is what the button calls.
  assert.ok(/[{,]\s*cycleSize\s*[,}]/.test(calls),
    'the size control is not exported, so the button cannot call it');
  assert.ok(calls.includes('CallStatus.canMinimize'), 'the web does not use the shared rule');
  assert.ok(/'minimized'/.test(calls), 'minimizing is no longer one of the sizes');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/Calls\.cycleSize\(\)/.test(html), 'there is no button to resize the panel');
});

test('the swap is wired up on the app, and kept where it survives a re-render', () => {
  assert.ok(/swapVideos\(\) \{/.test(manager), 'the call manager cannot swap the panes');
  // The GUARD, not merely a mention of it: `if (false && canSwapVideos(…))`
  // reads the same to a search and swaps unconditionally.
  assert.ok(/if \(!canSwapVideos\(\{/.test(manager),
    'the manager swaps without asking whether there is anything to swap with');
  assert.ok(/\}\)\) return;/.test(methodBody('swapVideos')),
    'the guard does not actually stop the swap');
  assert.ok(/videoSwapped = false;/.test(methodBody('teardown')),
    'the swap survives the call, so the next one opens the wrong way round');
  assert.ok(overlay.includes('cm.swapVideos()'), 'nothing on screen triggers the swap');
  assert.ok(overlay.includes('videoPanes({'), 'the overlay lays the videos out by hand again');
  assert.ok(/mirror=\{mirrors\(panes\.big/.test(overlay) && /mirror=\{mirrors\(panes\.small/.test(overlay),
    'the mirror is not taken from the rule, so a swapped call mirrors the wrong person');
});

test('the web swap is wired up too', () => {
  const calls = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calls.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(/function swapVideos\(\)/.test(calls), 'the web cannot swap');
  assert.ok(/swapVideos,?\s*\n?\s*\}/.test(calls) || calls.includes('swapVideos,'),
    'swapVideos is not exported, so the click handler cannot reach it');
  assert.ok(calls.includes('CallStatus.videoPanes('), 'the web decides the layout on its own');
  assert.ok((html.match(/onclick="Calls\.swapVideos\(\)"/g) || []).length >= 2,
    'the videos are not clickable');
  // Re-applied when the answer changes, not only when the user asks.
  for (const anchor of ['attachRemote', 'toggleCam']) {
    const i = calls.indexOf(`function ${anchor}`);
    assert.ok(i > 0, `${anchor} is gone`);
    assert.ok(calls.slice(i, i + 700).includes('applyVideoPanes()'),
      `${anchor} does not re-lay the videos, so the panes go stale`);
  }
});

test('the app never draws the same stream in both panes', () => {
  // "Sometimes on both windows there is one side video." The rule cannot
  // produce it, but two panes resolving to one stream object can — and the
  // corner is the one to drop.
  const at = overlay.indexOf('const bigStream =');
  assert.ok(at > 0, 'the overlay no longer picks the streams here');
  const slice = overlay.slice(at, at + 700);
  assert.ok(/wantSmall !== bigStream/.test(slice),
    'the corner is rendered even when it holds the same stream as the big pane');
});

test('the web puts the two videos where the rule says, and hides the empty one', () => {
  const calls = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calls.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  const at = calls.indexOf('function applyVideoPanes()');
  assert.ok(at > 0, 'applyVideoPanes moved');
  const fn = calls.slice(at, at + 1200);
  // The class must be driven by the rule's answer, not by a hardcoded guess.
  assert.ok(/classList\.toggle\('swapped', panes\.big === 'remote'\)/.test(fn),
    'the swapped class no longer follows the rule');
  assert.ok(/pane-empty/.test(fn), 'a pane with no stream is left on screen as a black box');
  assert.ok(/#call-overlay \.pane-empty \{[^}]*display: none/.test(css),
    'pane-empty does not actually hide anything');
  // Without the class, YOU are the big one — so the panel is already right in
  // the moment before any JavaScript runs, which is the flash this avoids.
  const local = css.indexOf('#call-local-video {');
  const remote = css.indexOf('#call-remote-video {');
  assert.ok(local > 0 && remote > 0, 'the pane rules are gone');
  assert.ok(/width: 100%/.test(css.slice(local, css.indexOf('}', local))),
    'your own video is not the big pane by default');
  assert.ok(/position: absolute/.test(css.slice(remote, css.indexOf('}', remote))),
    "the other side's video is not the corner by default");
});

// ── A camera that has been switched off ────────────────────────────────────
//
// Reported as: closing the camera on a video call shows a black screen.
//
// Switching the camera off does not remove the stream — toggleCamera only
// disables the video TRACK, and the audio track keeps the stream alive. So an
// RTCView was drawn over a track with nothing in it. The placeholder the
// overlay already had appears only when there is NO stream, which is a
// different situation: waiting for somebody to arrive, not somebody who has
// covered their camera.

test('WHOSE CAMERA IS OFF DEPENDS ON WHICH PANE', () => {
  // Known differently: your own camera is a fact you hold, theirs is
  // something you were told.
  assert.strictEqual(W.cameraOffFor('local', { cameraOff: true, remoteCameraOff: false }), true);
  assert.strictEqual(W.cameraOffFor('remote', { cameraOff: true, remoteCameraOff: false }), false,
    "your own camera being off blanked the OTHER person's picture");
  assert.strictEqual(W.cameraOffFor('remote', { cameraOff: false, remoteCameraOff: true }), true);
  assert.strictEqual(W.cameraOffFor('local', { cameraOff: false, remoteCameraOff: true }), false);
});

test('…and nothing is blank without a pane', () => {
  assert.strictEqual(W.cameraOffFor(null, { cameraOff: true, remoteCameraOff: true }), false);
  assert.strictEqual(W.cameraOffFor(undefined, { cameraOff: true }), false);
  assert.strictEqual(W.cameraOffFor('local', null), false);
});

test('THE PLACEHOLDER COVERS BOTH KINDS OF "no picture"', () => {
  // No stream yet, and a stream whose camera is off. Only the first was being
  // treated as no picture.
  assert.strictEqual(W.showBigPlaceholder({ isVideo: true, hasRemote: false }), true);
  assert.strictEqual(W.showBigPlaceholder({
    isVideo: true, hasRemote: true, bigPane: 'remote', remoteCameraOff: true,
  }), true, 'a camera that is off still shows a black rectangle');
  assert.strictEqual(W.showBigPlaceholder({
    isVideo: true, hasRemote: true, bigPane: 'local', cameraOff: true,
  }), true);
});

test('…and stays out of the way when there IS a picture', () => {
  assert.strictEqual(W.showBigPlaceholder({
    isVideo: true, hasRemote: true, bigPane: 'remote', cameraOff: true, remoteCameraOff: false,
  }), false, 'covering your own camera hid the other person');
  assert.strictEqual(W.showBigPlaceholder({
    isVideo: true, hasRemote: true, bigPane: 'local', cameraOff: false, remoteCameraOff: true,
  }), false);
});

test('a voice call is always the placeholder, as it was', () => {
  assert.strictEqual(W.showBigPlaceholder({ isVideo: false, hasRemote: true }), true);
  assert.strictEqual(W.showBigPlaceholder(null), true);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const fsc = require('fs');
const rdn = (...p) => fsc.readFileSync(require('path').join(__dirname, '..', 'native-app', 'src', ...p), 'utf8');

test('THE OTHER SIDE IS TOLD, or they only ever see black', () => {
  // Disabling a track is a LOCAL act; nothing about it reaches the peer, who
  // cannot tell a covered camera from a connection that has died.
  const cmSrc = rdn('callManager.ts');
  assert.ok(/emit\('call_camera'/.test(cmSrc), 'turning the camera off tells nobody');
  assert.ok(/s\.on\('call_camera'/.test(cmSrc), 'being told is never listened for');
  assert.ok(/remoteCameraOff = !!off/.test(cmSrc), 'what they said is not remembered');
  // A stale event from a previous call must not black out this one.
  const i = cmSrc.indexOf("s.on('call_camera'");
  assert.ok(/this\.peerId == null \|\| String\(this\.peerId\) !== String\(fromUserId\)\) return/
    .test(cmSrc.slice(i, i + 400)), 'an event from anybody at all blanks the picture');
  // …and forgotten when the call ends, or the next call starts blank.
  assert.ok(/this\.remoteCameraOff = false/.test(cmSrc), 'it is remembered into the next call');

  const server = fsc.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/socket\.on\('call_camera'/.test(server), 'the server does not pass it on');
});

test('THE PANE IS LIGHT, not another black rectangle', () => {
  // The whole point: black is what a dead connection looks like, and this is
  // the opposite — everything is fine, there is just nothing to look at.
  const ov = rdn('components', 'CallOverlay.tsx');
  assert.ok(/cameraOffPane/.test(ov), 'there is no camera-off pane');
  const style = /cameraOffPane: \{[\s\S]*?\}/.exec(ov);
  assert.ok(style && /backgroundColor: '#f1f5f9'/.test(style[0]),
    'the camera-off pane is dark, which is what it replaced');
  assert.ok(/cameraOffEmoji/.test(ov), 'nothing on it says what happened');
});

test('A CALL DISMISSES THE KEYBOARD', () => {
  // Asked for: a call arriving over an open keyboard leaves it across the
  // bottom of the screen with Accept and Decline behind it.
  const ov = rdn('components', 'CallOverlay.tsx');
  assert.ok(/Keyboard\.dismiss\(\)/.test(ov), 'a call arrives over an open keyboard');
  assert.ok(/const callUp = !!cm\.mode \|\| !!cm\.incoming/.test(ov),
    'only one of calling and being called dismisses it');
});

test('BOTH CALL NOTIFICATIONS CARRY THE APP ICON', () => {
  // The call bar had no icon at all, and the incoming-call notification named
  // 'ic_notification' — a drawable this app does not have, so Android drew a
  // blank square. The plugin generates 'notification_icon'.
  for (const f of ['ongoingCall.ts', 'incomingCall.ts']) {
    const src = rdn(f);
    assert.ok(/notificationIcon\.iconFields\(\)/.test(src), `${f} draws no app icon`);
    assert.ok(!/'ic_notification'/.test(src.replace(/\/\/.*$/gm, '')),
      `${f} names a drawable that does not exist`);
  }
});

// ── The swap that crashed the app ──────────────────────────────────────────
//
// Reported as: on a video call, the first tap to swap the panes sometimes
// crashes the whole app.
//
// Every null check was already in place and none of them could help: the
// swap handed a DIFFERENT stream to the same video view, and on Android that
// reaches into a live SurfaceViewRenderer and exchanges the track underneath
// it while frames are arriving. The web never does this and says why in its
// own stylesheet — the swap there is a class flip, because moving a <video>
// re-attaches its stream. The app was doing exactly what the web avoided.

test('A PANE IS KEYED BY THE STREAM IT SHOWS', () => {
  // So a swap unmounts the view and mounts a new one, which starts with the
  // right track instead of having one exchanged under it.
  assert.notStrictEqual(W.paneKey('remote', 'abc'), W.paneKey('local', 'abc'));
  assert.notStrictEqual(W.paneKey('remote', 'abc'), W.paneKey('remote', 'def'));
  assert.strictEqual(W.paneKey('remote', 'abc'), W.paneKey('remote', 'abc'));
});

test('…and the PANE is in the key as well as the stream', () => {
  // Two panes whose streams compare equal would otherwise produce one key,
  // React would reuse a single view, and that is the original bug by another
  // route. It happens: a renegotiation can hand back the local stream as the
  // remote one, which this file already has a guard for elsewhere.
  assert.notStrictEqual(W.paneKey('local', 'same'), W.paneKey('remote', 'same'));
});

test('A MISSING STREAM DOES NOT COLLIDE WITH A REAL ONE', () => {
  // An empty key, or one that is just the pane, would make "no stream yet"
  // and "this stream" the same view.
  assert.notStrictEqual(W.paneKey('remote', null), W.paneKey('remote', 'abc'));
  assert.notStrictEqual(W.paneKey('remote', undefined), W.paneKey('remote', ''));
  assert.ok(W.paneKey(null, null).length > 0, 'the key is empty, which React treats as no key');
});

test('BOTH VIDEO VIEWS ARE ACTUALLY KEYED', () => {
  // The rule is worth nothing if the views do not use it — and the crash is
  // in the one that is not.
  const overlay = fs.readFileSync(path.join(__dirname, '..',
    'native-app', 'src', 'components', 'CallOverlay.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(/key=\{paneKey\(panes\.big, bigStream\.id\)\}/.test(overlay),
    'the big pane is not keyed, so its track is still exchanged in place');
  assert.ok(/key=\{paneKey\(panes\.small, smallStream\.id\)\}/.test(overlay),
    'the corner pane is not keyed, so its track is still exchanged in place');
});

test('THE TWO CAPTURE FAILURES SAY DIFFERENT THINGS', () => {
  // One means the app never asked for the foreground service — the config
  // plugin not having applied — and the other means it asked and the
  // service did not come up. They need different fixes, and before the
  // capture path refused at all, both looked like a frozen picture at the
  // far end.
  const off = W.shareFailureText('ScreenCaptureServiceDisabled');
  const slow = W.shareFailureText('ScreenCaptureServiceNotRunning');
  const other = W.shareFailureText('something else entirely');
  assert.notStrictEqual(off, slow, 'both say the same thing to the person');
  assert.notStrictEqual(off, other, 'a disabled service falls through to the catch-all');
  assert.notStrictEqual(slow, other, 'a service that did not start falls through to the catch-all');
  // And one of them tells the person to try again, because it is the one
  // that a second attempt actually fixes.
  assert.ok(/again/i.test(slow), 'a transient failure does not suggest retrying');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
