// ── The web call window, and what you can do inside it ─────────────────────
//
// Five things asked for at once, and four of them were the web being behind
// the app rather than anything being broken:
//
//   • the window was one fixed 260px box, with no way to make it bigger — you
//     cannot watch a video call in a 260px box;
//   • there was no flip-camera button, which the app has had all along;
//   • your own face came back unmirrored, while the app mirrors it;
//   • calls made from a browser were never written into the chat at all.
//
// The fifth, screen sharing, was missing from both.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'public', 'js', 'callStatus.js'));
const strip = (f) => fs.readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const CALLS = strip(path.join(ROOT, 'public', 'js', 'calls.js'));
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── Three sizes ────────────────────────────────────────────────────────────

test('ONE BUTTON REACHES ALL THREE SIZES', () => {
  // Wrapping matters: with one control, a cycle that stopped at either end
  // would leave a size unreachable, which is the same as not having it.
  const seen = new Set();
  let size = 'half';
  for (let i = 0; i < 3; i++) { size = C.nextCallSize(size); seen.add(size); }
  assert.deepStrictEqual([...seen].sort(), ['full', 'half', 'minimized']);
  // …and it comes back to where it started, rather than wandering.
  assert.strictEqual(size, 'half');
});

test('A STORED SIZE FROM AN OLDER BUILD DOES NOT KILL THE BUTTON', () => {
  // Anything unrecognised has to start the cycle rather than sticking, or the
  // control does nothing at all and the call is trapped at one size.
  assert.strictEqual(C.nextCallSize('enormous'), 'half');
  assert.strictEqual(C.nextCallSize(undefined), 'half');
  assert.strictEqual(C.nextCallSize(null), 'half');
  assert.strictEqual(C.callSizeClass('nonsense'), 'size-half');
});

test('THE BUTTON IS NAMED AFTER WHERE IT GOES, not where you are', () => {
  // A button labelled with the state you are already in is a button nobody
  // presses.
  assert.strictEqual(C.sizeButtonTitle('half'), 'Full screen');
  assert.strictEqual(C.sizeButtonTitle('full'), 'Minimize');
  assert.strictEqual(C.sizeButtonTitle('minimized'), 'Half screen');
});

test('EVERY SIZE HAS GEOMETRY TO GO WITH IT', () => {
  // A class the stylesheet has never heard of is a size that does nothing.
  for (const size of C.SIZES) {
    assert.ok(CSS.includes('#call-overlay.' + C.callSizeClass(size)),
      `${size} has no rule, so choosing it changes nothing`);
  }
});

test('FULL SCREEN IS NOT THE FULLSCREEN API', () => {
  // That is a per-element mode the browser can refuse, that exits on Escape
  // without telling the page, and that would take the chat with it. The panel
  // is sized to the viewport instead, so no control can vanish mid-call.
  assert.ok(!/requestFullscreen/.test(CALLS),
    'the call asks the browser for fullscreen, which it may refuse or exit on its own');
  assert.ok(/#call-overlay\.size-full\s*\{[^}]*inset:\s*0/.test(CSS),
    'full screen does not actually fill the window');
});

test('AN INCOMING CALL CANNOT BE SHRUNK TO A BAR', () => {
  // The existing rule, which the new sizes must not step around: an incoming
  // call is a question that wants an answer now, and shrinking it is how one
  // ends up ringing in a corner while somebody carries on scrolling. A call
  // you placed yourself may be put down — you already know it is there.
  assert.strictEqual(C.canMinimize('idle'), false);
  assert.strictEqual(C.canMinimize('incoming'), false);
  assert.strictEqual(C.canMinimize('outgoing'), true);
  assert.strictEqual(C.canMinimize('connected'), true);
  assert.ok(/CallStatus\.canMinimize\(phase\)/.test(CALLS),
    'the size code no longer asks whether minimizing is allowed');
});

// ── The mirror ─────────────────────────────────────────────────────────────

test('ONLY YOUR OWN FRONT CAMERA IS MIRRORED', () => {
  // The same rule as the app's, which a drift test also compares. Mirroring
  // the other person shows their writing backwards.
  assert.strictEqual(C.mirrors('local', true), true);
  assert.strictEqual(C.mirrors('local', false), false, 'the back camera was mirrored');
  assert.strictEqual(C.mirrors('remote', true), false, 'the other person was mirrored');
  assert.strictEqual(C.mirrors('remote', false), false);
});

test('THE MIRROR FOLLOWS THE STREAM, not the pane', () => {
  // Applied per pane as the panes are laid out, so swapping which video is
  // big cannot leave you mirrored in one place and not the other.
  assert.ok(/CallStatus\.mirrors\(pane, frontCamera\)/.test(CALLS),
    'the mirror is not decided per stream');
  assert.ok(/video\.mirrored\s*\{[^}]*scaleX\(-1\)/.test(CSS),
    'the mirrored class does not actually flip anything');
});

test('A SHARED SCREEN IS NEVER MIRRORED', () => {
  // It is not a face. Mirroring it would show every word on it backwards.
  assert.ok(/mirrors\(pane, frontCamera\) && !sharedScreen/.test(CALLS),
    'sharing your screen would show it reversed');
});

// ── Flip ───────────────────────────────────────────────────────────────────

test('THE FLIP BUTTON APPEARS ONLY WHERE THERE IS SOMETHING TO FLIP TO', () => {
  // Counted, not guessed from whether the device looks like a phone: a laptop
  // with a USB webcam has two cameras and a tablet may have one.
  assert.strictEqual(C.canFlipCamera(2), true);
  assert.strictEqual(C.canFlipCamera(1), false);
  assert.strictEqual(C.canFlipCamera(0), false);
  assert.strictEqual(C.canFlipCamera(undefined), false);
  assert.ok(/enumerateDevices/.test(CALLS), 'the cameras are never counted');
});

test('FLIPPING REPLACES THE TRACK RATHER THAN RENEGOTIATING', () => {
  // A fresh offer mid-call is a chance for the call to drop, which on these
  // networks is not a small risk.
  assert.ok(/replaceTrack/.test(CALLS), 'flipping renegotiates the call');
  assert.ok(!/createOffer/.test(/async function flipCamera[\s\S]*?\n  \}/.exec(CALLS)?.[0] || ''),
    'flipping makes a new offer');
});

test('A CAMERA THAT WAS OFF STAYS OFF WHEN FLIPPED', () => {
  // Flipping is not a request to be seen.
  const fn = /async function flipCamera\(\)[\s\S]*?\n  \}/.exec(CALLS);
  assert.ok(fn, 'could not find flipCamera');
  assert.ok(/track\.enabled = !wasOff/.test(fn[0]),
    'flipping turns somebody\'s camera back on without being asked');
});

// ── Screen share ───────────────────────────────────────────────────────────

test('SHARING PUTS THE CAMERA BACK AS IT FOUND IT', () => {
  assert.deepStrictEqual(C.screenShareRestore({ cameraWasOff: true }), { track: 'camera', enabled: false });
  assert.deepStrictEqual(C.screenShareRestore({ cameraWasOff: false }), { track: 'camera', enabled: true });
  // No information is the safe case: show the camera rather than leaving
  // somebody silently dark for the rest of the call.
  assert.deepStrictEqual(C.screenShareRestore({}), { track: 'camera', enabled: true });
});

test('STOPPING FROM THE BROWSER\'S OWN BAR ALSO PUTS IT BACK', () => {
  // That is where most people will stop it. Without this the call carries on
  // sending a dead track and the other end sees a frozen picture.
  assert.ok(/track\.onended = \(\) => stopShareScreen\(\)/.test(CALLS),
    'stopping the share from the system bar leaves a dead track in the call');
});

test('THE SHARE BUTTON IS HIDDEN WHERE THE BROWSER CANNOT DO IT', () => {
  // A control that cannot work teaches people the app is broken.
  assert.ok(/getDisplayMedia/.test(CALLS), 'screen sharing is never requested');
  assert.ok(/canShareScreen\(\)/.test(CALLS), 'the button is shown without checking');
});

test('BOTH NEW BUTTONS EXIST IN THE PAGE AND ARE WIRED UP', () => {
  // A rule nothing calls is a feature nobody has.
  for (const [id, fn] of [['call-flip-btn', 'flipCamera'],
                          ['call-share-btn', 'toggleShareScreen'],
                          ['call-size-btn', 'cycleSize']]) {
    assert.ok(HTML.includes('id="' + id + '"'), `${id} is missing from the page`);
    assert.ok(new RegExp('Calls\\.' + fn + '\\(\\)').test(HTML), `${id} is not wired to ${fn}`);
    assert.ok(new RegExp('\\b' + fn + '\\b').test(CALLS), `${fn} is not exported`);
  }
});

test('THE APP CAN SHARE ITS SCREEN TOO', () => {
  // Asked for on both. The track goes into the sender the camera was using,
  // so the far end sees one video throughout and is told nothing.
  const cm = strip(path.join(ROOT, 'native-app', 'src', 'callManager.ts'));
  assert.ok(/getDisplayMedia/.test(cm), 'the app cannot share a screen');
  assert.ok(/replaceTrack/.test(cm), 'the app renegotiates to share, which can drop the call');
  const overlay = strip(path.join(ROOT, 'native-app', 'src', 'components', 'CallOverlay.tsx'));
  assert.ok(/toggleScreenShare\(\)/.test(overlay), 'there is no button for it');
  // Android refuses screen capture without this, and the refusal is silent.
  const app = fs.readFileSync(path.join(ROOT, 'native-app', 'app.json'), 'utf8');
  assert.ok(/FOREGROUND_SERVICE_MEDIA_PROJECTION/.test(app),
    'Android 14 will refuse the capture and nothing will say why');
});

// ── Which video is on top ──────────────────────────────────────────────────
//
// Reported as: the other person's pane is under yours and not shown. It was a
// regression from the mirror in this same change — the corner pane is
// absolutely positioned and the big one is an ordinary flex item, so the
// corner painted above it for free. Adding a transform to the self-view
// changed that: a transform makes an element paint in the same step as
// positioned ones, and the local video comes later in the markup, so it
// started covering the corner completely.

// Comments stripped first: a rule preceded by an explanation is still a rule,
// and an earlier version of this helper could not see past one.
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The z-index a selector is given, or null. Last declaration wins. */
function zFor(selector) {
  const re = new RegExp('(^|,|\\}|\\n)\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '\\s*(,[^{]*)?\\{([^}]*)\\}', 'g');
  let m, z = null;
  while ((m = re.exec(CSS_CODE))) {
    const hit = /z-index:\s*(-?\d+)/.exec(m[3]);
    if (hit) z = Number(hit[1]);
  }
  return z;
}

test('THE CORNER PANE IS ABOVE THE BIG ONE, both ways round', () => {
  // Stated outright rather than left to paint order, which is what broke.
  const cornerDefault = zFor('#call-remote-video');
  const bigDefault = zFor('#call-local-video');
  assert.ok(cornerDefault !== null && bigDefault !== null,
    'the panes have no stacking order at all, so it depends on paint accidents');
  assert.ok(cornerDefault > bigDefault,
    `the other person's pane (${cornerDefault}) is not above yours (${bigDefault})`);

  const cornerSwapped = zFor('#call-overlay.swapped #call-local-video');
  const bigSwapped = zFor('#call-overlay.swapped #call-remote-video');
  assert.ok(cornerSwapped !== null && bigSwapped !== null,
    'swapping the panes leaves their stacking order undeclared');
  assert.ok(cornerSwapped > bigSwapped,
    `swapped, the corner (${cornerSwapped}) is not above the big pane (${bigSwapped})`);
});

test('THE MIRROR IS WHY THIS NEEDS SAYING', () => {
  // If the transform ever goes away the z-indexes are harmless; while it is
  // here they are load-bearing. This records the connection so the next person
  // to tidy one does not quietly undo the other.
  assert.ok(/video\.mirrored\s*\{[^}]*transform:/.test(CSS),
    'the mirror is gone — check whether the pane stacking is still needed');
});

// ── A share that shares nothing must not say it is sharing ─────────────────
//
// Reported as: share screen does not show anything to the other side, and
// actually does not share anything. The defect was in how the attempt was
// written, not in which browser or phone it ran on: every failure on the path
// was swallowed. No sender to put the track in, a replaceTrack that rejected,
// a capture that was refused, a device that returned nothing — all of them
// ended looking exactly like success, and the panel said "sharing" while the
// call carried on sending the camera.

test('REPLACING THE TRACK REPORTS WHETHER ANYTHING TOOK IT', () => {
  // Promise.all with an empty list resolves. That is the bug: no senders at
  // all was indistinguishable from every sender accepting.
  assert.ok(/allSettled/.test(CALLS),
    'a rejected replaceTrack is still swallowed');
  assert.ok(/return replaced;/.test(CALLS),
    'useVideoTrack does not say how many senders took the track');
  assert.ok(!/await Promise\.all\(jobs\)\.catch\(\(\) => \{\}\)/.test(CALLS),
    'the failures are still thrown away');
});

test('A SHARE THAT NOTHING TOOK IS UNDONE AND SAID OUT LOUD', () => {
  const fn = /async function toggleShareScreen\(\)[\s\S]*?\n  \}/.exec(CALLS);
  assert.ok(fn, 'could not find toggleShareScreen');
  assert.ok(/if \(!replaced\)/.test(fn[0]), 'a share that replaced nothing still claims success');
  // …and the camera must go back, or the call is left sending nothing at all.
  assert.ok(/if \(cam\) await useVideoTrack\(cam\)/.test(fn[0]),
    'the camera is not restored when the share fails');
  assert.ok(/alert\(shareFailure/.test(fn[0]), 'the failure is silent');
});

test('DISMISSING THE PICKER IS NOT AN ERROR', () => {
  // Changing your mind must not throw an alert. Everything else must.
  const fn = /async function toggleShareScreen\(\)[\s\S]*?\n  \}/.exec(CALLS);
  assert.ok(/NotAllowedError/.test(fn[0]) && /AbortError/.test(fn[0]),
    'dismissing the picker would be reported as a failure');
});

test('EACH FAILURE NAMES ITS OWN REMEDY', () => {
  // "It did not work" is the remedy for none of them.
  const msgs = [
    C.shareErrorMessage({ name: 'no-sender' }, { secure: true }),
    C.shareErrorMessage({ name: 'no-video-track' }, { secure: true }),
    C.shareErrorMessage({ name: 'TypeError' }, { secure: true }),
    C.shareErrorMessage({ name: 'NotReadableError' }, { secure: true }),
    C.shareErrorMessage({}, { secure: false }),
  ];
  assert.strictEqual(new Set(msgs).size, msgs.length,
    'two different failures give the same message, so the message says nothing');
  // no-sender specifically. It is the one where the capture WORKED and the
  // call refused the picture, so the remedy is about the call and not about
  // the device or the browser — and it is the case that produced the original
  // report. A generic "could not be shared" sends somebody to check their
  // screen-recording permission for a problem that has nothing to do with it.
  const noSender = C.shareErrorMessage({ name: 'no-sender' }, { secure: true });
  assert.ok(/call/i.test(noSender),
    'the one failure that is about the call does not mention the call');
  assert.ok(/nothing is being shared/i.test(noSender),
    'it does not say plainly that nothing is going out');
  // The insecure-page case must win over everything: it is the one cause the
  // user can actually do something about, and it makes the API absent
  // entirely, which otherwise reads as "this browser cannot".
  assert.ok(/https/.test(C.shareErrorMessage({ name: 'TypeError' }, { secure: false })),
    'a page not allowed to ask is blamed on the browser instead');
  // A phone browser genuinely cannot do this, and should say where to go.
  assert.ok(/app|computer/i.test(C.shareErrorMessage({ name: 'TypeError' }, { secure: true })),
    'a browser that cannot share does not say what would work');
});

test('THE APP DOES THE SAME, and says so in the overlay', () => {
  const cm = strip(path.join(ROOT, 'native-app', 'src', 'callManager.ts'));
  assert.ok(/allSettled/.test(cm), 'the app still swallows a rejected replaceTrack');
  assert.ok(/if \(!replaced\)/.test(cm), 'the app claims to share when nothing took the track');
  assert.ok(/shareFailed/.test(cm), 'the app has nowhere to record why it failed');
  const overlay = strip(path.join(ROOT, 'native-app', 'src', 'components', 'CallOverlay.tsx'));
  assert.ok(/cm\.shareFailed/.test(overlay), 'the app never shows the failure');
  assert.ok(/shareFailureText/.test(overlay), 'the failure is shown as a raw error name');
});

test('THE APP DOES NOT TRUST replaceTrack\'S PROMISE', () => {
  // Established by reading the library, not guessed. Its replaceTrack catches
  // the native error and returns, so the promise RESOLVES having done nothing:
  //
  //     try { await WebRTCModule.senderReplaceTrack(...); }
  //     catch (e) { return; }
  //     this._track = track;      // only reached on success
  //
  // Counting resolved promises therefore counts failures as successes — which
  // is what I shipped. The sender's own track is the only honest test.
  const cm = strip(path.join(ROOT, 'native-app', 'src', 'callManager.ts'));
  assert.ok(/sn\.track\.id === track\.id/.test(cm),
    'the app still decides success from the promise, which this library always resolves');
  assert.ok(!/results\.filter\(r => r\.status === 'fulfilled'\)\.length/.test(cm),
    'the fulfilled-count check is still there');
});

test('WHAT THE SHARE DID IS REPORTED, not asked about', () => {
  // Three numbers that separate the remaining possibilities: the capture never
  // started, it started but no sender took the track, or the track went in and
  // the far end froze anyway. Guessing between those has already cost rounds.
  const cm = strip(path.join(ROOT, 'native-app', 'src', 'callManager.ts'));
  for (const f of ['shareCaptured', 'shareSenders', 'shareSwitched']) {
    assert.ok(new RegExp('\\b' + f + '\\b').test(cm), `${f} is never recorded`);
  }
  const app = strip(path.join(ROOT, 'native-app', 'App.tsx'));
  assert.ok(/shareCap:/.test(app) && /shareSend:/.test(app) && /shareSwap:/.test(app),
    'the share outcome never leaves the phone');
  const server = strip(path.join(ROOT, 'server.js'));
  assert.ok(/shareSwap=/.test(server), 'the server receives it and does not log it');
});

test('THE SHARE LOG LINE STILL CARRIES NO NAME AND NO CONTENT', () => {
  // It goes into a log that is read into a repository that has been public.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const line = /\[device\] user=\$\{socket\.user\.id\}[\s\S]{0,1800}?;\n/.exec(server);
  assert.ok(line, 'could not find the device log line');
  assert.ok(/shareSwap=/.test(line[0]), 'the share numbers are not on that line');
  assert.ok(!/username/.test(line[0]), 'the device log line now names the user');
});

test('THE DISPLAY STREAM IS HELD, not just its track', () => {
  // The capturer belongs to the stream. A stream this side forgets about is
  // one nothing is keeping alive.
  const cm = strip(path.join(ROOT, 'native-app', 'src', 'callManager.ts'));
  assert.ok(/this\.screenStream = stream/.test(cm), 'only the track is kept');
  assert.ok(/screenStream\?\.release\?\.\(\)/.test(cm), 'the stream is never released');
});

// ── The call screen's buttons ──────────────────────────────────────────────
//
// Reported as: the icons on the call screen do not look good, they look like
// they have a shade, and not as modern as the rest of the app.
//
// They did. One style gave EVERY button `elevation: 8` and a drop shadow,
// including the translucent toggles — and on Android elevation paints a grey
// halo around a semi-transparent circle. That is the shade.

const OVERLAY = strip(path.join(ROOT, 'native-app', 'src', 'components', 'CallOverlay.tsx'));
const styleBlock = (name) => {
  const m = new RegExp('\\b' + name + ':\\s*\\{([^}]*(?:\\{[^}]*\\}[^}]*)*)\\}').exec(OVERLAY);
  return m ? m[1] : null;
};

test('THE TRANSLUCENT TOGGLES CARRY NO SHADOW', () => {
  // The shade. A shadow under a see-through circle is dirt, not depth.
  const base = styleBlock('roundBtn');
  assert.ok(base, 'could not find roundBtn');
  assert.ok(!/elevation/.test(base), 'every call button still has elevation');
  assert.ok(!/shadow/i.test(base), 'every call button still has a drop shadow');
});

test('…but ANSWER AND END still look like raised buttons', () => {
  // They are opaque and they are the primary actions; a lift means something
  // there. Removing it everywhere would have been the other mistake.
  const call = styleBlock('callBtn');
  assert.ok(call, 'the call-action buttons lost their own style');
  assert.ok(/elevation/.test(call) && /shadow/i.test(call),
    'answer and end no longer stand out from the toggles');
  assert.ok(/style=\{\[s\.roundBtn, s\.callBtn, s\.declineBtn\]\}/.test(OVERLAY),
    'the end button does not use the raised style');
  assert.ok(/style=\{\[s\.roundBtn, s\.callBtn, s\.acceptBtn\]\}/.test(OVERLAY),
    'the answer button does not use the raised style');
});

test('A TOGGLE THAT IS ON IS LEGIBLE, not a shade of grey', () => {
  // "My microphone is off" has to be readable at a glance. It used to be a
  // slightly lighter translucent circle, which is the same problem as the
  // shadow: everything the same colour.
  const on = styleBlock('ctrlActive');
  assert.ok(on, 'could not find ctrlActive');
  assert.ok(/#fff/.test(on), 'an active toggle is still only a lighter grey');
  // …and its icon must stop being white, or it vanishes into the fill.
  assert.ok(/cm\.muted \? '#111827' : '#fff'/.test(OVERLAY),
    'the icon stays white on a white fill, so an active toggle is blank');
  assert.ok(/cm\.cameraOff \? '#111827' : '#fff'/.test(OVERLAY),
    'the camera icon stays white on a white fill');
});

test('THE ICONS ARE ONE FAMILY AT ONE SIZE', () => {
  // The app's own convention, written down in the message menu: an icon font
  // inherits size and colour, so a row of controls reads as one surface.
  // Emoji would arrive in whatever the system font felt like.
  const sizes = [...OVERLAY.matchAll(/<Ionicons[^>]*?size=\{(\d+)\}/g)]
    .map(m => Number(m[1]));
  assert.ok(sizes.length >= 5, `only found ${sizes.length} icons — the scan is broken`);
  const inControls = sizes.filter(n => n === 25).length;
  assert.ok(inControls >= 4,
    `the control icons are not one size (${sizes.join(', ')})`);
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
