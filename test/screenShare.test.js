// ── Getting a phone screen through a call negotiated for a camera ──────────
//
// Where this stands, from the device's own report rather than from reasoning:
//
//     captured=1  senders=1  switched=1
//
// The capture starts, the call has one video sender, and that sender ends up
// holding the screen track. The swap works, and the far end still freezes on
// the last camera frame — which is what a receiver shows when frames stop.
//
// So the track is in the call and nothing comes out of it, and the remaining
// explanation is the encoder. A camera call negotiates something like 640x480;
// a phone screen is about 1080x2400. WebRTC adapts a CAMERA source down to
// fit, but the library builds a screencast source with adaptation off on
// purpose, so that text stays sharp — and then nothing brings the frame size
// down to what was negotiated.
//
// This is the cheap thing to try before renegotiating, which is the expensive
// thing. It also reports what the encoder did, so the next round is a reading
// rather than another argument.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping screen-share tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'sshare-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'screenShare.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const S = require(path.join(OUT, 'screenShare.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('A PHONE SCREEN IS BROUGHT DOWN TO SOMETHING THE CALL CAN CARRY', () => {
  // The actual case: a tall modern panel.
  const scale = S.scaleFor({ width: 1080, height: 2400 });
  assert.ok(scale > 1, 'a 1080x2400 screen is sent at full size');
  // …and down to about the cap rather than to something arbitrary.
  assert.ok(Math.abs(2400 / scale - S.MAX_DIMENSION) < 20,
    `scaled to ${Math.round(2400 / scale)}px, which is not near the ${S.MAX_DIMENSION} cap`);
});

test('ORIENTATION DOES NOT MATTER: the LONGEST side is what must fit', () => {
  // A phone shares a tall screen and a tablet a wide one; both have to end up
  // under the cap, and testing only the width would let one through.
  assert.strictEqual(S.scaleFor({ width: 2400, height: 1080 }),
    S.scaleFor({ width: 1080, height: 2400 }));
});

test('SOMETHING ALREADY SMALL IS LEFT ALONE', () => {
  // scaleResolutionDownBy is a DIVISOR. Returning less than one would be an
  // instruction to upscale — wasteful, and refused by some encoders.
  assert.strictEqual(S.scaleFor({ width: 640, height: 480 }), 1);
  assert.strictEqual(S.scaleFor({ width: 1280, height: 720 }), 1);
  assert.strictEqual(S.scaleFor({ width: 1, height: 1 }), 1);
});

test('UNKNOWN DIMENSIONS MEAN NO SCALING, not a guess', () => {
  // Guessing here shrinks screens that were already fine.
  assert.strictEqual(S.scaleFor({}), 1);
  assert.strictEqual(S.scaleFor(null), 1);
  assert.strictEqual(S.scaleFor({ width: 0, height: 0 }), 1);
  assert.strictEqual(S.scaleFor({ width: NaN, height: 100 }), 1);
  assert.strictEqual(S.scaleFor({ width: -1080, height: -2400 }), 1);
});

test('THE SCREEN\'S OWN CONTRIBUTION IS THE DIFFERENCE, NOT THE TOTAL', () => {
  // The first version of this measured the total, and the first report it
  // produced could not be read: framesEncoded is cumulative for the whole
  // outgoing stream, so it carries whatever the CAMERA encoded before the
  // swap. On a working call a dead share hides inside a large number; on a
  // call that never connected the total is zero whatever the screen does.
  assert.strictEqual(S.madeNoProgress({ before: 0, after: 0, seconds: 5 }), true);
  assert.strictEqual(S.madeNoProgress({ before: 900, after: 900, seconds: 5 }), true,
    'a dead share on a call that was already working is reported as fine');
  assert.strictEqual(S.madeNoProgress({ before: 900, after: 1050, seconds: 5 }), false);
  assert.strictEqual(S.madeNoProgress({ before: 0, after: 150, seconds: 5 }), false);
});

test('…AND AN UNANSWERED QUESTION IS NOT AN ANSWER', () => {
  // -1 is the platform not exposing the statistic. Read as a count it makes
  // every share, working or not, report that nothing is going out — which
  // is the message being shown to people, so it has to mean something.
  assert.strictEqual(S.madeNoProgress({ before: -1, after: 0, seconds: 5 }), false,
    'a missing baseline is treated as a count');
  assert.strictEqual(S.madeNoProgress({ before: 0, after: -1, seconds: 5 }), false,
    'a missing reading is treated as a count');
  assert.strictEqual(S.madeNoProgress({ before: -1, after: -1, seconds: 5 }), false);
  assert.strictEqual(S.madeNoProgress({ seconds: 5 }), false);
  assert.strictEqual(S.madeNoProgress(null), false);
  // Too early to say, as before.
  assert.strictEqual(S.madeNoProgress({ before: 0, after: 0, seconds: 0 }), false);
  assert.strictEqual(S.madeNoProgress({ before: 0, after: 0, seconds: 1 }), false);
  // A counter that went BACKWARDS is a reconfigured encoder, not a failure.
  assert.strictEqual(S.madeNoProgress({ before: 900, after: 10, seconds: 5 }), false);
});

test('THE CALL REPORTS WHETHER IT WAS EVEN CONNECTED', () => {
  // Without it, encoded=0 is uninterpretable: a share that sent nothing and
  // a call that was never carrying anything look exactly alike. The first
  // report could not be read for precisely this reason.
  const mgr = strip(path.join(NAT, 'src', 'callManager.ts'));
  assert.ok(/connState\(\)/.test(mgr), 'nothing records whether the call was up');
  assert.ok(/up: this\.connState\(\)/.test(mgr), 'the connection state is never reported');
  assert.ok(/before, up: this\.connState\(\)/.test(mgr),
    'the baseline is not reported alongside it');
  // And the baseline is an actual reading. A constant here would make every
  // share on a working call look like a failure, and every share on an idle
  // one look fine — the exact confusion this measurement exists to end.
  assert.ok(/const baseline = \(await this\.videoStats\(\)\)\.encoded;/.test(mgr),
    'the baseline is a constant rather than a reading');
  assert.ok(/sampleShare\(startedAt, baseline\)/.test(mgr),
    'the baseline is read and then not used');
  const srv = fs.readFileSync(path.join(NAT, '..', 'server.js'), 'utf8');
  assert.ok(/up=\$\{n\(d\.up\)\}/.test(srv), 'the server drops the connection state');
  assert.ok(/before=\$\{n\(d\.before\)\}/.test(srv), 'the server drops the baseline');
});

test('AN ENCODER THAT HAS PRODUCED NOTHING IS THE DIAGNOSIS', () => {
  // The one fact that cannot be read from the source: frames encoded lives
  // inside WebRTC.
  assert.strictEqual(S.encodedNothing({ framesEncoded: 0, seconds: 5 }), true);
  assert.strictEqual(S.encodedNothing({ framesEncoded: 120, seconds: 5 }), false);
});

test('…but NOT BEFORE IT HAS HAD TIME, or every share reports a failure', () => {
  // A share sampled immediately has encoded nothing yet, and that is normal.
  assert.strictEqual(S.encodedNothing({ framesEncoded: 0, seconds: 0 }), false);
  assert.strictEqual(S.encodedNothing({ framesEncoded: 0, seconds: 1 }), false);
  // Missing numbers are not evidence of anything either.
  assert.strictEqual(S.encodedNothing({ seconds: 5 }), false);
  assert.strictEqual(S.encodedNothing({}), false);
  assert.strictEqual(S.encodedNothing(null), false);
  // AND NEITHER IS A QUESTION THAT WAS NOT ANSWERED. The sampler starts the
  // counter at -1 and leaves it there when the platform exposes no outbound
  // video statistics. This returned true for -1, so on such a build every
  // share — working or not — told the person nothing was going out. A
  // diagnostic that cannot be wrong is not a diagnostic.
  assert.strictEqual(S.encodedNothing({ framesEncoded: -1, seconds: 5 }), false,
    'stats being unavailable is reported as the encoder producing nothing');
  // …and the sample is actually taken after a usable delay.
  assert.ok(S.SAMPLE_AFTER_MS >= 2000,
    'the sample is taken before the encoder could have produced anything');
});

// ── Wiring ─────────────────────────────────────────────────────────────────

const strip = (f) => fs.readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const CM = strip(path.join(NAT, 'src', 'callManager.ts'));

test('THE SCALE IS APPLIED TO THE SENDER, before the share is announced', () => {
  assert.ok(/scaleResolutionDownBy = scale/.test(CM), 'the scale is never applied');
  assert.ok(/setParameters\(params\)/.test(CM), 'the parameters are never set');
  // Before reportShare('ok'), so what is reported describes the stream that
  // is actually going out.
  const fitAt = CM.indexOf('await this.fitScreenToCall(track)');
  // Matched as a call rather than as an exact literal: it now carries the
  // connection state, and a test pinned to the old spelling fails for a
  // reason that has nothing to do with what it is checking.
  const okAt = CM.search(/this\.reportShare\('ok'/);
  assert.ok(fitAt > 0 && okAt > 0 && fitAt < okAt,
    'the share is announced before it has been sized');
});

test('IT DOES NOT RENEGOTIATE, which would hang up the other end', () => {
  // The web client treats a second offer mid-call as a NEW INCOMING CALL.
  // Renegotiating is the next thing to try and needs both ends changed first.
  const share = /async toggleScreenShare\(\)[\s\S]*?\n  \}/.exec(CM);
  assert.ok(share, 'could not find toggleScreenShare');
  assert.ok(!/createOffer/.test(share[0]), 'sharing renegotiates, which drops the call');
});

test('THE ENCODER IS ASKED, and the answer is sent where it can be read', () => {
  assert.ok(/getStats\(\)/.test(CM), 'nothing ever asks the encoder what it did');
  assert.ok(/framesEncoded/.test(CM), 'frames encoded is never read');
  assert.ok(/reportShare\('stats'/.test(CM), 'the answer is never reported');
  const server = strip(path.join(ROOT, 'server.js'));
  assert.ok(/encoded=/.test(server), 'the server does not log it');
});

test('A SHARE THAT ENCODES NOTHING SAYS SO ON THE CALL', () => {
  // Rather than looking like it is working, which is how this started.
  assert.ok(/'no-frames'/.test(CM), 'the encoder failure is never recorded');
  const win = strip(path.join(NAT, 'src', 'callWindow.ts'));
  assert.ok(/no-frames/.test(win), 'there are no words for it');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
