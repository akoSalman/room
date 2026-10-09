// Which phone makes which noise.
//
// Reported as: the call ringtone should be on the receiver's device, not the
// caller's.
//
// Both ends were playing ring.wav. That file is a RINGTONE — loud, bright, and
// written to be heard from across a room through a pocket — which is right for
// the phone being called and wrong for the phone doing the calling, where it is
// held to an ear and drowns out the moment the other person picks up.
//
// A ringback is the other half of the pair and a different thing: the quiet
// purring tone a telephone network plays down the line to say "it is ringing at
// the other end". Nobody is meant to notice a ringback, only its absence.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');

global.window = global;
const W = require(path.join(ROOT, 'public', 'js', 'callTones.js'));

let A = null;
let AUDIO = null;
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tones-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'callTones.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'callTones.js'));
  // The two ring timings live next door, in callAudio.ts.
  execFileSync(TSC, [path.join(NAT, 'src', 'callAudio.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  AUDIO = require(path.join(OUT, 'callAudio.js'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
} else {
  console.log('  ! app-side rules skipped (native-app deps not installed); web copy still checked');
}

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The rule ────────────────────────────────────────────────────────────────

test('THE BUG: the ringtone belongs to the phone being CALLED', () => {
  assert.strictEqual(W.toneFor({ role: 'callee' }), 'ringtone');
  assert.strictEqual(W.toneFor({ role: 'caller' }), 'ringback',
    'the caller still plays the ringtone at their own ear');
  assert.strictEqual(W.toneFile('ringtone'), 'ring.wav');
  assert.strictEqual(W.toneFile('ringback'), 'ringback.wav');
  assert.notStrictEqual(W.toneFile('ringtone'), W.toneFile('ringback'),
    'both ends are playing the same file again');
});

test('a connected call is silent at both ends', () => {
  // A tone that survives the answer is behind half the call bugs this file's
  // history is made of.
  assert.strictEqual(W.toneFor({ role: 'caller', connected: true }), null);
  assert.strictEqual(W.toneFor({ role: 'callee', connected: true }), null);
  assert.strictEqual(W.toneFile(null), '');
  assert.strictEqual(W.toneVolume(null), 0);
  assert.strictEqual(W.toneLoops(null), false);
});

test('the ringback is the quieter of the two', () => {
  // It plays at the earpiece, an inch from an ear, and is meant to be heard
  // UNDER somebody's attention rather than for it.
  assert.ok(W.toneVolume('ringback') < W.toneVolume('ringtone'),
    'the ringback is as loud as a ringtone, in an ear');
  assert.ok(W.toneVolume('ringback') > 0, 'the caller hears nothing at all');
  assert.ok(W.toneVolume('ringtone') <= 1);
});

test('both tones repeat until something stops them', () => {
  assert.strictEqual(W.toneLoops('ringtone'), true);
  assert.strictEqual(W.toneLoops('ringback'), true);
});

test('nonsense in, silence out', () => {
  assert.strictEqual(W.toneFor(null), null);
  assert.strictEqual(W.toneFor({ role: 'bystander' }), null);
});

test('the web and the app agree', () => {
  if (!A) return;
  let checked = 0;
  for (const role of ['caller', 'callee', 'nobody']) {
    for (const connected of [true, false, undefined]) {
      const o = { role, connected };
      const t = W.toneFor(o);
      assert.strictEqual(t, A.toneFor(o), `tones diverge for ${JSON.stringify(o)}`);
      assert.strictEqual(W.toneFile(t), A.toneFile(t));
      assert.strictEqual(W.toneVolume(t), A.toneVolume(t));
      assert.strictEqual(W.toneLoops(t), A.toneLoops(t));
      checked++;
    }
  }
  assert.strictEqual(checked, 9, 'the drift check did not actually run');
});

// ── The sound itself ────────────────────────────────────────────────────────

test('THE RINGBACK IS A RINGBACK: two tones, on then off, and quiet', () => {
  for (const p of [path.join(NAT, 'assets', 'ringback.wav'),
                   path.join(ROOT, 'public', 'ringback.wav')]) {
    const wav = fs.readFileSync(p);
    assert.strictEqual(wav.slice(0, 4).toString(), 'RIFF', p);
    const rate = wav.readUInt32LE(24);
    const samples = (wav.length - 44) / 2;
    const seconds = samples / rate;
    // One cycle, looped by both clients. Long enough to have a gap in it.
    assert.ok(seconds >= 4 && seconds <= 10, `${seconds.toFixed(1)}s is not one ring cycle`);

    let peak = 0;
    const rms = [];
    for (let sec = 0; sec + rate <= samples; sec += rate) {
      let sum = 0;
      for (let i = 0; i < rate; i++) {
        const v = wav.readInt16LE(44 + (sec + i) * 2);
        sum += v * v;
        if (Math.abs(v) > peak) peak = Math.abs(v);
      }
      rms.push(Math.sqrt(sum / rate));
    }
    // Quieter than the ringtone, which peaks near full scale.
    assert.ok(peak < 20000, `${p} peaks at ${peak}: that is a ringtone, not a ringback`);
    assert.ok(peak > 3000, `${p} peaks at ${peak}: nobody will hear that`);
    // On, then off — a continuous tone is a fault signal, not a ring.
    assert.ok(rms.some(r => r > 1000), `${p} is silent`);
    assert.ok(rms.some(r => r < 200), `${p} never stops, which is a drone`);
  }
  // The same file on both platforms, and a recipe to remake it.
  assert.deepStrictEqual(
    fs.readFileSync(path.join(NAT, 'assets', 'ringback.wav')),
    fs.readFileSync(path.join(ROOT, 'public', 'ringback.wav')),
    'the app and the web ring back differently');
  assert.ok(fs.existsSync(path.join(NAT, 'assets', 'make-ringback.py')),
    'the tone cannot be regenerated or adjusted');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const mgr = fs.readFileSync(path.join(NAT, 'src', 'callManager.ts'), 'utf8');
const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'calls.js'), 'utf8');

test('neither client can reach for the ringtone on the wrong end', () => {
  // The role is passed in and the FILE is chosen by the rule, so "which sound"
  // is decided in one place that both clients share.
  assert.ok(/startTone\('callee'\)/.test(mgr) && /startTone\('caller'\)/.test(mgr),
    'the app does not distinguish the two ends');
  assert.ok(!/this\.startRing\(\)/.test(mgr), 'the app still has a call that rings unconditionally');
  // The rule chooses, not the call site. What is passed IN to it is checked by
  // "both clients ask whether the call is already up" below.
  assert.ok(/[^.]toneFor\(\{ role,/.test(mgr), 'the app picks its sound by hand');

  assert.ok(/startTone\('callee'\)/.test(web) && /startTone\('caller'\)/.test(web),
    'the web does not distinguish the two ends');
  assert.ok(!/startRing\(\);/.test(web), 'the web still has a call that rings unconditionally');
  assert.ok(/CallTones\.toneFor\(\{ role,/.test(web), 'the web picks its sound by hand');
  assert.ok(/CallTones\.toneFile\(tone\)/.test(web), 'the web names the file by hand');

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/src="\/js\/callTones\.js"/.test(html),
    'callTones.js is never loaded, so CallTones is undefined and starting a call throws');
});

test('and the caller is not given two tones at once', () => {
  // InCallManager's own ringback was started alongside ours, so two sounds
  // played over each other and the loud one won.
  const start = mgr.slice(mgr.indexOf('async startDM('), mgr.indexOf('async accept()'));
  assert.ok(start.length > 0, 'startDM is gone — this check would be vacuous');
  assert.ok(!/startRingback/.test(start), 'the caller plays two ringbacks at once');
});

// ── A tone that arrives after it was cancelled ──────────────────────────────
//
// Reported as: the ringing is still sounding while the call is in progress, on
// both video and audio calls.
//
// toneFor has always said "no tone once connected", so the rule was right and
// the phone still rang. The fault was in the gap between deciding to play a
// sound and the sound existing: loading is asynchronous and the sound comes
// back ALREADY PLAYING, so a stop in that window silences nothing — there is
// nothing loaded yet — and the sound is then stored as the current one with
// everything that would have stopped it already finished.
//
// Small window, open at exactly the two moments that matter: the callee taps
// Accept a second after the ring starts, and the caller's ringback is still
// loading when the other end picks up. Accepting from the notification shade
// loses it every time, because the accept is dispatched in the same breath as
// the ring is started.

test('THE BUG: a tone that finishes loading after a stop is thrown away', () => {
  // The generation is captured before the load and compared after it.
  assert.strictEqual(W.toneStillWanted(3, 3), true, 'a tone nobody stopped was discarded');
  assert.strictEqual(W.toneStillWanted(3, 4), false, 'a cancelled tone is kept and plays on');
  if (A) {
    assert.strictEqual(A.toneStillWanted(3, 3), true);
    assert.strictEqual(A.toneStillWanted(3, 4), false);
  }
});

test('the app bumps the generation on EVERY stop, and checks it after loading', () => {
  // The two halves. Either one alone leaves the bug in place: a counter that
  // never moves always matches, and a check against a counter nobody reads
  // does nothing.
  const stop = mgr.slice(mgr.indexOf('private stopRing()'), mgr.indexOf('private stopRing()') + 400);
  assert.ok(stop.length > 50, 'stopRing moved');
  assert.ok(/this\.ringGeneration\+\+/.test(stop),
    'stopping the ring does not move the generation on, so nothing is ever discarded');

  // Bounded by the NEXT member rather than by a character count, so the slice
  // cannot silently shrink past the guard and make these checks vacuous.
  const startAt = mgr.indexOf('private async startTone(');
  const start = mgr.slice(startAt, mgr.indexOf('private ringGeneration', startAt));
  assert.ok(start.length > 100, 'startTone moved');
  assert.ok(/const generation = this\.ringGeneration;/.test(start),
    'the generation is not captured before the load, so there is nothing to compare');
  assert.ok(/if \(!toneStillWanted\(generation, this\.ringGeneration\)\)/.test(start),
    'the loaded tone is stored without asking whether it is still wanted');
  // And discarded properly: leaving it loaded but unreferenced is the bug.
  const guard = start.slice(start.indexOf('if (!toneStillWanted('), start.indexOf('this.ringSound = sound;'));
  assert.ok(guard.length > 40, 'the guard no longer sits before the tone is stored');
  assert.ok(/sound\.unloadAsync\(\)/.test(guard),
    'an obsolete tone is dropped without being silenced, so it keeps playing');
  assert.ok(/return;/.test(guard), 'the obsolete tone is stored anyway');
});

test('both clients ask whether the call is already up before making a noise', () => {
  // `toneFor({ role })` alone asks "which tone does a caller get", not "should
  // this device be making a noise at all" — so a call that was already
  // connected could still start ringing.
  assert.ok(/toneFor\(\{ role, connected: !!this\.connectedAt \}\)/.test(mgr),
    'the app decides the tone without telling toneFor the call is connected');
  assert.ok(/toneFor\(\{ role, connected: !!connectedAt \}\)/.test(web),
    'the web decides the tone without telling toneFor the call is connected');
});

test('the web guards the same window', () => {
  const at = web.indexOf('function startTone(');
  assert.ok(at > 0, 'startTone moved');
  const fn = web.slice(at, web.indexOf('function stopRing()'));
  assert.ok(/const generation = ringGeneration;/.test(fn),
    'the web captures no generation, so a stop during play() is invisible');
  assert.ok(/CallTones\.toneStillWanted\(generation, ringGeneration\)/.test(fn),
    'the web never checks whether the tone it just started is still wanted');
  const stop = web.slice(web.indexOf('function stopRing()'), web.indexOf('function stopRing()') + 250);
  assert.ok(/ringGeneration\+\+/.test(stop), 'the web never moves the generation on');
});

test('connecting stops the ring on both clients', () => {
  // The other half of the same complaint: whatever else markConnected does, it
  // has to silence the tone.
  const at = mgr.indexOf('private markConnected()');
  assert.ok(at > 0, 'markConnected moved');
  assert.ok(/this\.stopRing\(\)/.test(mgr.slice(at, at + 500)),
    'the app leaves the ring playing over a connected call');
  const wat = web.indexOf('function markConnected()');
  assert.ok(wat > 0, 'the web markConnected moved');
  assert.ok(/stopRing\(\)/.test(web.slice(wat, wat + 400)),
    'the web leaves the ring playing over a connected call');
});

// ── A ring that ends by itself ─────────────────────────────────────────────
//
// Reported as: calling from the web, the ringing does not stop at all. Both
// tones loop, and the browser had no timer of any kind — so a call nobody
// answered rang until the tab was closed. The app has had both of these from
// the start, one of them as a bare literal.

test('THE BUG: the web knows how long a ring may last', () => {
  assert.ok(W.NO_ANSWER_MS > 0, 'the caller rings for ever');
  assert.ok(W.RING_TIMEOUT_MS > 0, 'the ringing side rings for ever');
});

test('THE CALLER GIVES UP FIRST, or the backstop pre-empts every call', () => {
  // The ordinary ending is the caller stopping. The other number exists only
  // for when that never arrives — a dead tab, a dropped network — so it has
  // to be the longer of the two. The relationship was described in a comment
  // and enforced nowhere, with the two numbers in different files.
  assert.ok(W.NO_ANSWER_MS < W.RING_TIMEOUT_MS,
    'the phone being called gives up before the caller does');
  if (AUDIO) {
    assert.ok(AUDIO.NO_ANSWER_MS < AUDIO.RING_TIMEOUT_MS,
      'the app has the same two numbers the wrong way round');
  }
});

test('BOTH PLATFORMS GIVE UP AT THE SAME MOMENT', () => {
  if (!AUDIO) return;
  assert.strictEqual(W.NO_ANSWER_MS, AUDIO.NO_ANSWER_MS,
    'a browser and a phone disagree about when a caller gives up');
  assert.strictEqual(W.RING_TIMEOUT_MS, AUDIO.RING_TIMEOUT_MS,
    'a browser and a phone disagree about when a ringing device gives up');
});

test('…AND NEITHER IS ABSURD', () => {
  // Agreeing on something, not merely agreeing: two copies both set to a
  // second, or to an hour, would pass the comparison above.
  assert.ok(W.NO_ANSWER_MS >= 20000, 'a caller gives up before anybody could answer');
  assert.ok(W.RING_TIMEOUT_MS <= 180000, 'a phone rings for minutes with nobody there');
});

test('THE APP NO LONGER CARRIES THE NUMBER TWICE', () => {
  // It was a bare 45000 in callManager while a comment in callAudio described
  // what it should be. Two places, one of them unnamed.
  const mgr = fs.readFileSync(path.join(NAT, 'src', 'callManager.ts'), 'utf8');
  assert.ok(/\}, NO_ANSWER_MS\);/.test(mgr), 'the caller\'s timer is not the shared number');
  assert.ok(!/\b45000\b/.test(mgr), 'the literal is still there beside the constant');
});

test('THE WEB ACTUALLY SETS BOTH TIMERS, AND CLEARS THEM', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'calls.js'), 'utf8');
  assert.ok(/CallTones\.NO_ANSWER_MS\)/.test(js), 'the caller still rings for ever');
  assert.ok(/CallTones\.RING_TIMEOUT_MS\)/.test(js), 'the ringing side still rings for ever');
  // Cleared, or a timer from a finished call ends the NEXT one.
  assert.ok(/function clearRingTimers\(\)/.test(js), 'nothing cancels them');
  const teardown = /function teardown\(\) \{([\s\S]*?)\n  \}/.exec(js);
  assert.ok(teardown && /clearRingTimers\(\)/.test(teardown[1]),
    'a finished call leaves its timers running');
  // Answering must cancel the give-up, or a call that connects slowly is
  // hung up 45 seconds after it was placed.
  const ans = /s\.on\('call_answer', async \(\{ fromUserId, sdp \}\) => \{([\s\S]*?)\n    \}\);/.exec(js);
  assert.ok(ans, 'could not find the answer handler');
  assert.ok(/clearTimeout\(noAnswerTimer\)/.test(ans[1]),
    'answering leaves the give-up timer armed');
});

test('THE GIVE-UP CHECKS THE CALL IS STILL UNANSWERED WHEN IT FIRES', () => {
  // Otherwise it ends a call that connected while it was waiting.
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'calls.js'), 'utf8');
  const fn = /noAnswerTimer = setTimeout\(\(\) => \{([\s\S]*?)\}, CallTones\.NO_ANSWER_MS\);/.exec(js);
  assert.ok(fn, 'could not find the give-up timer');
  // The whole guard, not just the word: both bodies mention these names
  // again further down, so a looser check passed against a version with no
  // guard at all.
  assert.ok(/if \(!mode \|\| mode\.indexOf\('dm'\) !== 0 \|\| connectedAt\) return;/.test(fn[1]),
    'the give-up ends a call that had already connected');
  const ring = /ringTimeout = setTimeout\(\(\) => \{([\s\S]*?)\}, CallTones\.RING_TIMEOUT_MS\);/.exec(js);
  assert.ok(ring, 'could not find the backstop');
  assert.ok(/if \(!incoming \|\| String\(incoming\.fromUserId\) !== String\(offer\.fromUserId\)\) return;/.test(ring[1]),
    'the backstop silences whatever is ringing, including a later call');
});

// ── A call placed before the socket is up ──────────────────────────────────
//
// Reported as: for about half a minute after opening the app, tapping call
// logs a missed call and nothing happens; after a while it works.
//
// socket.io BUFFERS an emit made while it is still connecting and sends it on
// connect. That is right for a chat message and wrong for a call: the offer
// sat in the buffer, no phone rang, the caller watched a silent "Calling…",
// and the call_log emit was buffered too — so the missed call appeared later
// as the one visible trace of a call that was never placed.

test('THE CALL WAITS FOR THE SOCKET, and says so', () => {
  if (!AUDIO) return;
  assert.ok(AUDIO.CONNECT_WAIT_MS > 0, 'a call is still placed into a buffer');
  assert.ok(AUDIO.CONNECT_WAIT_MS <= 20000, 'the caller stares at "Connecting…" for ages');
  assert.ok(AUDIO.CONNECT_WAIT_MS < AUDIO.NO_ANSWER_MS,
    'the wait outlasts the whole call, so the give-up fires while still connecting');

  const mgr = fs.readFileSync(path.join(NAT, 'src', 'callManager.ts'), 'utf8');
  assert.ok(/if \(!this\.sock\?\.connected\) \{/.test(mgr), 'the call does not check the socket');
  assert.ok(/waitForSocket\(CONNECT_WAIT_MS\)/.test(mgr), 'it checks and then carries on regardless');
  assert.ok(/'Connecting…'/.test(mgr), 'the wait is invisible to the person calling');
  assert.ok(/'No connection'/.test(mgr), 'giving up is silent');
});

test('A CALL THAT NEVER LEFT THE DEVICE IS NOT A MISSED CALL', () => {
  // Nobody's phone rang, so an entry in the other person's chat is a record
  // of something that did not happen to them.
  const mgr = fs.readFileSync(path.join(NAT, 'src', 'callManager.ts'), 'utf8');
  assert.ok(/this\.offerSent = true;/.test(mgr), 'nothing records whether the offer went out');
  assert.ok(/if \(this\.mode\?\.startsWith\('dm'\) && \(!this\.outgoing \|\| this\.offerSent\)\) \{/.test(mgr),
    'a call that was never placed is still logged as missed');
  // Reset per call, or the second call inherits the first one's answer.
  assert.ok(/this\.offerSent = false;/.test(mgr), 'the flag is never reset');
  // An INCOMING call is always logged: the offer reached this device by
  // definition, so declining or missing it is real.
  assert.ok(/!this\.outgoing \|\|/.test(mgr), 'declining an incoming call stopped being logged');
});

test('THE WAIT REMOVES ITS OWN LISTENER, BY NAME', () => {
  // off('connect') with no handler removes every listener for that event,
  // including ones belonging to files that have never heard of this — the
  // mistake socketNotifier.ts exists to document.
  const mgr = fs.readFileSync(path.join(NAT, 'src', 'callManager.ts'), 'utf8');
  const fn = /private waitForSocket\(ms: number\): Promise<boolean> \{([\s\S]*?)\n  \}/.exec(mgr);
  assert.ok(fn, 'could not find waitForSocket');
  assert.ok(/s\.off\('connect', onConnect\)/.test(fn[1]),
    'it removes the handler by event alone, taking others with it');
  assert.ok(/clearTimeout\(timer\)/.test(fn[1]), 'the timeout outlives the connection');
  assert.ok(/if \(s\.connected\) return Promise\.resolve\(true\)/.test(fn[1]),
    'an already-connected socket still waits for an event that has passed');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
