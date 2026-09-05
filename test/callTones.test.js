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
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tones-'));
  execFileSync(TSC, [path.join(NAT, 'src', 'callTones.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'], { stdio: 'pipe' });
  A = require(path.join(OUT, 'callTones.js'));
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
  assert.ok(/toneFor\(\{ role \}\)/.test(mgr), 'the app picks its sound by hand');

  assert.ok(/startTone\('callee'\)/.test(web) && /startTone\('caller'\)/.test(web),
    'the web does not distinguish the two ends');
  assert.ok(!/startRing\(\);/.test(web), 'the web still has a call that rings unconditionally');
  assert.ok(/CallTones\.toneFor\(\{ role \}\)/.test(web), 'the web picks its sound by hand');
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

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
