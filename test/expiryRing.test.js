// Tests for the disappearing-message countdown ring
// (native-app/src/expiryRing.ts).
//
// The fraction drives what the user sees of a message's remaining life, so it
// has to be right at the edges: a message that has just been seen must read as
// full, and one past its deadline as empty, never as something in between or
// as NaN.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ringtest-'));
const SRC = path.join(__dirname, '..', 'native-app', 'src', 'expiryRing.ts');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping expiry-ring tests (native-app deps not installed)');
  process.exit(0);
}
// Compiled with JSX stripped to plain calls; only the exported maths is used.
execFileSync(TSC, [SRC, '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck'], { stdio: 'pipe' });
const R = require(path.join(OUT, 'expiryRing.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`);

test('a message just seen shows a full ring', () => {
  const now = 1_000_000;
  near(R.remainingFraction(now + 30_000, 30, now), 1, 1e-9, 'full');
});

test('halfway through, the ring is half', () => {
  const now = 1_000_000;
  near(R.remainingFraction(now + 15_000, 30, now), 0.5, 1e-9, 'half');
});

test('at and past the deadline the ring is empty, never negative', () => {
  const now = 1_000_000;
  assert.strictEqual(R.remainingFraction(now, 30, now), 0);
  assert.strictEqual(R.remainingFraction(now - 99_000, 30, now), 0,
    'a long-dead message produced a negative ring');
});

test('a clock skew cannot push the ring past full', () => {
  // The deadline is computed on the server; a phone whose clock is behind
  // would otherwise render more than 100%.
  const now = 1_000_000;
  assert.strictEqual(R.remainingFraction(now + 60_000, 30, now), 1);
});

test('a message with no timer reads as full rather than as NaN', () => {
  assert.strictEqual(R.remainingFraction(0, 0), 1);
  assert.strictEqual(R.remainingFraction(null, 30), 1);
  assert.strictEqual(R.remainingFraction(123456, 0), 1);
  assert.strictEqual(R.remainingFraction(123456, -5), 1);
});

test('the repaint rate suits the timer length', () => {
  // A 30-second ring must visibly move; a week-long one must not wake the
  // device twice a second to redraw something that has not changed.
  assert.ok(R.tickInterval(30) <= 500, 'a short timer repaints too slowly to look alive');
  assert.ok(R.tickInterval(3600) >= 1000, 'an hour-long timer repaints too often');
  assert.ok(R.tickInterval(604800) >= 10000, 'a week-long timer repaints far too often');
  assert.ok(R.tickInterval(0) > 0, 'a zero timer produced a non-positive interval');
});

// ── Going at the right moment ───────────────────────────────────────────────
//
// Reported as: disappearing messages do not disappear exactly after the time
// they were set to. Three causes, and these tests cover the two that were
// genuine delays:
//
//   • the server swept for expired messages every THIRTY SECONDS, so a
//     thirty-second timer could last a minute;
//   • both clients waited to be told, so the bubble stayed until a delete
//     event arrived — a pause on a slow link, and forever on a dropped socket.
//
// (The third was wording: the clock starts when the message is READ, and the
// banner did not say so. That is a sentence, not a timer.)

global.window = global;
require(path.join(__dirname, '..', 'public', 'js', 'expiry.js'));
const W = global.window.Expiry;

const NOW = 1_800_000_000_000;

test('THE POINT: a message past its deadline is not shown', () => {
  assert.strictEqual(R.hasExpired(NOW - 1, NOW), true);
  assert.strictEqual(R.hasExpired(NOW, NOW), true, 'the exact moment is still expired');
});

test('one still counting down stays', () => {
  assert.strictEqual(R.hasExpired(NOW + 1, NOW), false);
});

test('a message with no countdown never expires', () => {
  // Every ordinary message in every chat goes through this.
  assert.strictEqual(R.hasExpired(null, NOW), false);
  assert.strictEqual(R.hasExpired(undefined, NOW), false);
  assert.strictEqual(R.hasExpired(0, NOW), false);
});

test('only the expired ones are dropped', () => {
  const msgs = [
    { id: 1 }, { id: 2, expires_at: NOW - 5 }, { id: 3, expires_at: NOW + 5000 },
  ];
  assert.deepStrictEqual(R.dropExpired(msgs, NOW).map(m => m.id), [1, 3]);
});

test('THE OTHER HALF: the next wake-up is the EARLIEST deadline', () => {
  // One timer for the whole chat. Fifty countdowns on screen do not need fifty
  // timers, and waking for a later one first would leave the earliest message
  // sitting there past its time — which is the bug in miniature.
  const msgs = [
    { expires_at: NOW + 9000 }, { expires_at: NOW + 400 }, { expires_at: NOW + 60000 },
  ];
  assert.strictEqual(R.msUntilNextExpiry(msgs, NOW), 400);
});

test('nothing counting down means no timer at all', () => {
  assert.strictEqual(R.msUntilNextExpiry([{ id: 1 }, { id: 2 }], NOW), null);
  assert.strictEqual(R.msUntilNextExpiry([], NOW), null);
});

test('a deadline already past wakes immediately, but never spins', () => {
  // A zero-delay timer that re-arms from a clock which has not moved is a
  // busy loop that pins the phone.
  assert.strictEqual(R.msUntilNextExpiry([{ expires_at: NOW - 10_000 }], NOW), 1);
});

test('the web agrees with the app, message for message', () => {
  const cases = [
    [], [{ id: 1 }], [{ expires_at: NOW - 1 }], [{ expires_at: NOW }],
    [{ expires_at: NOW + 1 }], [{ expires_at: NOW + 5 }, { expires_at: NOW - 5 }],
    [{ expires_at: null }, { expires_at: NOW + 250 }],
  ];
  for (const c of cases) {
    assert.strictEqual(W.msUntilNextExpiry(c, NOW), R.msUntilNextExpiry(c, NOW),
      `next-expiry drifted for ${JSON.stringify(c)}`);
    assert.deepStrictEqual(W.dropExpired(c, NOW), R.dropExpired(c, NOW),
      `dropExpired drifted for ${JSON.stringify(c)}`);
  }
  for (const at of [null, undefined, 0, NOW - 1, NOW, NOW + 1]) {
    assert.strictEqual(W.hasExpired(at, NOW), R.hasExpired(at, NOW), `hasExpired drifted at ${at}`);
  }
});

// ── The wiring ──────────────────────────────────────────────────────────────

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const screen = fs.readFileSync(
  path.join(__dirname, '..', 'native-app', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

test('THE BUG: the server no longer waits for a thirty-second sweep', () => {
  assert.ok(server.includes('function scheduleNextExpiry()'),
    'expiry is still only handled by the periodic sweep, so a 30s timer can take 60s');
  assert.ok(/MIN\(expires_at\)/.test(server), 'the next deadline is never looked up');
  // Inside the handler, not merely somewhere after it: the module's export
  // list mentions the function too, and a slice running to the end of the file
  // matched that instead — passing while the re-arm was gone.
  const seenStart = server.indexOf("socket.on('messages_seen'");
  const handler = server.slice(seenStart, server.indexOf("socket.on('set_disappearing'", seenStart));
  assert.ok(handler.length > 0, 'the messages_seen handler is gone — this check would be vacuous');
  assert.ok(/scheduleNextExpiry\(\);/.test(handler),
    'a countdown starting does not re-arm the timer, so it fires too late or not at all');
});

test('the sweep survives as the safety net, not as the mechanism', () => {
  // A deadline that passed while the process was down still has to be
  // honoured, and a capped timer defers long ones deliberately.
  assert.ok(/setInterval\(\(\) => \{/.test(server), 'the periodic sweep is gone');
  // At MODULE level, once, before the first request — not just mentioned
  // somewhere. A deadline that passed while the process was down otherwise
  // waits up to thirty seconds for the interval.
  assert.ok(/\ntry \{ sweepExpired\(\); \} catch \{\}\nscheduleNextExpiry\(\);/.test(server),
    'nothing sweeps and re-arms at startup');
  assert.ok(/Math\.min\(Math\.max\(0, next\.at - Date\.now\(\)\), 60 \* 1000\)/.test(server),
    'a week-long timer sits in a single setTimeout for a week');
});

test('the app removes an expired message itself', () => {
  assert.ok(screen.includes('dropExpired(prev, now)'),
    'the phone still waits to be told before hiding an expired message');
  assert.ok(screen.includes('msUntilNextExpiry(messages)'), 'nothing schedules the removal');
});

test('the page does too, and finds its deadlines on screen', () => {
  assert.ok(web.includes('function scheduleExpirySweep()'), 'the browser waits to be told');
  assert.ok(web.includes('Expiry.hasExpired('), 'the page decides expiry by its own rule');
  assert.ok(/dataset\.expiresAt = String\(msg\.expires_at\)/.test(web),
    'the deadline is never written onto the bubble, so the sweep cannot find it');
});

test('the promise made to the user matches when the clock starts', () => {
  // "vanish after 30 seconds" is a claim about a countdown the reader has not
  // started yet: the timer begins when the message is READ. Starting it at
  // send time would destroy messages nobody ever saw, which is worse — so the
  // sentence is what changed.
  const dis = fs.readFileSync(
    path.join(__dirname, '..', 'native-app', 'src', 'disappearing.ts'), 'utf8');
  assert.ok(/after they are read/.test(dis), 'the notice still promises a clock that is not running');
  assert.ok(/after they are read/.test(web), 'the web notice still promises it');
  assert.ok(/after reading/.test(screen) && /after reading/.test(web),
    'the banner does not say when the countdown starts');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
