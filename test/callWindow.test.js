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

test('THE DEFAULT: the other person fills the screen, you are the corner', () => {
  assert.deepStrictEqual(
    W.videoPanes({ swapped: false, hasRemote: true, hasLocal: true }),
    { big: 'remote', small: 'local' });
});

test('THE POINT: swapped, your own camera fills the screen', () => {
  assert.deepStrictEqual(
    W.videoPanes({ swapped: true, hasRemote: true, hasLocal: true }),
    { big: 'local', small: 'remote' });
});

test('before the other side\'s video arrives there is one video, full screen', () => {
  // Not you in the corner of a black rectangle, which is what a fixed layout
  // gives during the seconds before the call connects.
  assert.deepStrictEqual(
    W.videoPanes({ swapped: false, hasRemote: false, hasLocal: true }),
    { big: 'local', small: null });
  // And a swap asked for earlier cannot strand them there either.
  assert.deepStrictEqual(
    W.videoPanes({ swapped: true, hasRemote: false, hasLocal: true }),
    { big: 'local', small: null });
});

test('THE TRAP: turning your camera off while swapped puts them back', () => {
  // Otherwise the screen fills with black and the person talking disappears.
  assert.deepStrictEqual(
    W.videoPanes({ swapped: true, hasRemote: true, hasLocal: true, cameraOff: true }),
    { big: 'remote', small: null });
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

test('THE OTHER HALF: a live call runs a foreground service', () => {
  assert.ok(ongoing.includes('asForegroundService: true'),
    'the ongoing notification does not keep the process alive, so leaving the app freezes the call');
  assert.ok(/FOREGROUND_SERVICE_TYPE_PHONE_CALL/.test(ongoing)
    && /FOREGROUND_SERVICE_TYPE_MICROPHONE/.test(ongoing),
    'the service does not declare its types — Android 14 refuses to start it');
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
  const calls = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calls.js'), 'utf8');
  assert.ok(calls.includes('toggleMinimize'), 'the web call panel cannot be minimized');
  assert.ok(/toggleMinimize\s*\}/.test(calls) || /toggleMinimize,/.test(calls),
    'toggleMinimize is not exported, so the button cannot call it');
  assert.ok(calls.includes('CallStatus.canMinimize'), 'the web does not use the shared rule');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('Calls.toggleMinimize()'), 'there is no button to collapse the panel');
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

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
