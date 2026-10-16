// A live location that never moved (native-app/src/liveShare.ts + locationManager).
//
// Reported with everything the user could check already checked: the app
// open, location permission granted and on, the network up — and the pin
// still sitting where the share had started while the person it was tracking
// drove fifty-three kilometres. The card read "updated 1 h ago".
//
// THE CAUSE. locationManager took the socket ONCE, when the share began, and
// the watcher's callback used that same object for the hours the share ran:
//
//     const sock = await getSocket();
//     … watchPositionAsync(…, pos => sock.emit('location_update', …))
//
// Sockets do not last hours on these connections. Every send after a
// reconnect went into an orphaned socket, which accepts an emit and delivers
// nothing. Nothing looked wrong from the phone: permission granted, watcher
// running, network up, notification showing.
//
// api.ts says this, in as many words, above onSocket:
//
//     Handing a socket out once and hoping nothing replaces it is the bug.
//
// written after the same mistake left the app deaf to every message that
// arrived. This file was making it too, hidden inside a closure, where
// nothing was looking.
//
// TWO THINGS MADE IT INVISIBLE, and they are fixed here as well. The watcher
// only fires once the phone has moved 15 m, so a still phone sends nothing
// and "has not moved" is indistinguishable from "has stopped reporting"; and
// a lost send was permanent, because nothing would try again until the next
// real movement.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NATIVE = path.join(__dirname, '..', 'native-app');
const SRC = path.join(NATIVE, 'src');
const TSC = path.join(NATIVE, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping live-share tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'liveshare-'));
execFileSync(TSC, [
  path.join(SRC, 'liveShare.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
], { stdio: 'pipe' });
const L = require(path.join(OUT, 'liveShare.js'));

const mgrSrc = fs.readFileSync(path.join(SRC, 'locationManager.ts'), 'utf8');
const apiSrc = fs.readFileSync(path.join(SRC, 'api.ts'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** The body of `export async function name(…) { … }`, by matching braces. */
function fnBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is not in the file`);
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name} never closes`);
}

/** Code with comments stripped — these assertions are about absences. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

// ── THE BUG ─────────────────────────────────────────────────────────────────

test('THE BUG: the socket is never captured for later', () => {
  const body = code(fnBody(mgrSrc, 'startSharing'));
  // What it must not do: resolve a socket into a variable that outlives the
  // call and is then used by a callback running for hours.
  //
  // Checked by WHERE the resolution happens, not by whether the two words
  // appear in order — the first version of this assertion matched the correct
  // code, because the per-send path contains a getSocket() too and the
  // watcher is set up after it.
  const push = /const push = async[\s\S]*?\n  \};/.exec(body);
  assert.ok(push, 'the per-send path is gone');
  const outside = body.replace(push[0], '');
  assert.ok(!/getSocket\(\)/.test(outside),
    'startSharing resolves a socket outside the per-send path — it will be stale within the hour');
  assert.ok(!/\bsock\b/.test(outside),
    'a socket variable is in scope for the watcher to capture');
});

test('…every send asks for the socket that exists NOW', () => {
  const body = code(fnBody(mgrSrc, 'startSharing'));
  const push = /const push = async[\s\S]*?\n  \};/.exec(body);
  assert.ok(push, 'the per-send path is gone');
  assert.ok(/await getSocket\(\)/.test(push[0]),
    'the sender does not resolve a socket, so it must have captured one somewhere');
  const emitAt = push[0].indexOf("emit('location_update'");
  const getAt = push[0].indexOf('getSocket()');
  assert.ok(getAt >= 0 && emitAt > getAt,
    'the emit does not follow a fresh getSocket()');
});

test('…and the share is re-checked after that await', () => {
  // getSocket() can create a connection, which takes time. A share stopped
  // while that was in flight must not then send a position.
  const push = /const push = async[\s\S]*?\n  \};/.exec(code(fnBody(mgrSrc, 'startSharing')));
  const guards = push[0].match(/if \(!active \|\| active\.messageId !== messageId\) return;/g) || [];
  assert.ok(guards.length >= 2,
    `only ${guards.length} guard(s): a share that ended mid-await still sends`);
});

test('THE BUG, second half: an outage does not stop the share for good', () => {
  // Reported as "when connection is lost, after that update does not work".
  //
  // An emit on a disconnected socket is accepted and queued — and
  // ensureSocketAlive(), the probe that recovers a zombie connection, does
  // `s.disconnect(); s.connect();`, which throws that queue away. So the
  // thing that repairs the connection also destroyed the position waiting on
  // it, and the old code had already counted that position as sent.
  const push = /const push = async[\s\S]*?\n  \};/.exec(code(fnBody(mgrSrc, 'startSharing')));
  assert.ok(/if \(sock\.connected === false\) return;/.test(push[0]),
    'positions are handed to a socket that is down, where they are silently dropped');
  const guardAt = push[0].indexOf('sock.connected === false');
  const emitAt = push[0].indexOf("emit('location_update'");
  assert.ok(guardAt >= 0 && guardAt < emitAt, 'the check comes after the emit it is meant to prevent');
  // And the repair this depends on must still exist.
  assert.ok(/export function ensureSocketAlive/.test(apiSrc),
    'the zombie-connection probe is gone, so a dead socket is never noticed');
});

test('…and a send counts only once the server has answered', () => {
  // Set before the emit, the heartbeat's clock was pushed forward by sends
  // that went nowhere, and it stayed quiet through the whole outage
  // believing it was up to date.
  const push = /const push = async[\s\S]*?\n  \};/.exec(code(fnBody(mgrSrc, 'startSharing')));
  const ack = /\}, \(res: any\) => \{[\s\S]*?\n    \}\);/.exec(push[0]);
  assert.ok(ack, 'the reply handler is gone');
  assert.ok(/lastSentAt = Date\.now\(\)/.test(ack[0]),
    'the send clock is not advanced by the reply');
  // Exactly once, and inside the reply handler. Slicing at "before the emit
  // call" was not enough: a mutation that put the assignment among the emit's
  // own arguments sat after that boundary and passed.
  const sets = (push[0].match(/lastSentAt = Date\.now\(\)/g) || []).length;
  assert.strictEqual(sets, 1,
    `the send clock is advanced in ${sets} places — one of them is not the reply`);
  assert.strictEqual((ack[0].match(/lastSentAt = Date\.now\(\)/g) || []).length, 1,
    'the one place that advances the send clock is not the reply handler');
  // The last position is kept regardless — before the socket is even
  // consulted — or an outage leaves the heartbeat with nothing to repeat
  // once the connection comes back.
  const keptAt = push[0].indexOf('lastPos = pos;');
  const bailAt = push[0].indexOf('sock.connected === false');
  assert.ok(keptAt >= 0, 'an outage loses the position the heartbeat would have retried');
  assert.ok(bailAt < 0 || keptAt < bailAt,
    'the position is only kept when the socket is up, which is when it is least needed');
});

test('the warning this ignored is still in api.ts, where it was ignored', () => {
  // If this note ever goes, the reason the bug above is a bug goes with it.
  assert.ok(/Handing a socket out once and hoping nothing replaces it is the bug/.test(apiSrc),
    'the note explaining why a captured socket is wrong has been deleted');
  assert.ok(/export function onSocket\(/.test(apiSrc),
    'the subscription that exists because of it has been removed');
});

// ── The heartbeat ───────────────────────────────────────────────────────────

test('a first fix always goes out', () => {
  assert.strictEqual(L.sendDue(1_000_000, null), true, 'the opening position is withheld');
  assert.strictEqual(L.sendDue(1_000_000, undefined), true);
  // Anything that is not a time means "nothing has been sent".
  for (const bad of [NaN, Infinity, 'soon', {}]) {
    assert.strictEqual(L.sendDue(1_000_000, bad), true, `lastSentAt ${String(bad)} blocked the first send`);
  }
});

test('a still phone still reports, so silence means something', () => {
  const now = 1_000_000;
  assert.strictEqual(L.sendDue(now, now), false, 'it repeats itself immediately');
  assert.strictEqual(L.sendDue(now + L.HEARTBEAT_MS - 1, now), false, 'it beats early');
  assert.strictEqual(L.sendDue(now + L.HEARTBEAT_MS, now), true, 'it never beats at all');
  assert.strictEqual(L.sendDue(now + 10 * L.HEARTBEAT_MS, now), true);
});

test('…often enough to be useful, rarely enough to be free', () => {
  // The card says "updated N min ago" in whole minutes. A beat slower than a
  // minute makes that number wrong; much faster buys nothing and costs a
  // radio wake on a metered phone.
  assert.ok(L.HEARTBEAT_MS >= 30_000, `${L.HEARTBEAT_MS}ms is too chatty for a metered connection`);
  assert.ok(L.HEARTBEAT_MS <= 120_000, `${L.HEARTBEAT_MS}ms leaves the time on the card visibly wrong`);
});

test('a clock that jumps backwards does not park the heartbeat', () => {
  // These phones correct their time, and a backwards step would otherwise
  // hold the beat until real time caught up — minutes of silence that look
  // exactly like the bug this is here to prevent.
  assert.strictEqual(L.sendDue(1_000_000, 5_000_000), true, 'a backwards clock stopped the heartbeat');
});

test('nonsense never triggers a send', () => {
  for (const bad of [NaN, Infinity, null, undefined, 'now', {}]) {
    assert.strictEqual(L.sendDue(bad, 1_000), false, `now=${String(bad)} sent anyway`);
  }
});

test('a custom interval is honoured, and a nonsense one is not', () => {
  assert.strictEqual(L.sendDue(1_000 + 10, 1_000, 10), true);
  assert.strictEqual(L.sendDue(1_000 + 9, 1_000, 10), false);
  for (const bad of [0, -5, NaN, Infinity]) {
    // Falls back to the real interval rather than beating every tick or never.
    assert.strictEqual(L.sendDue(1_000 + L.HEARTBEAT_MS, 1_000, bad), true,
      `interval ${String(bad)} stopped the heartbeat`);
    assert.strictEqual(L.sendDue(1_000 + 1, 1_000, bad), false,
      `interval ${String(bad)} made it beat every tick`);
  }
});

// ── Expiry ──────────────────────────────────────────────────────────────────

test('a share that has run out is over', () => {
  assert.strictEqual(L.shareOver(2_000, 1_000), true);
  assert.strictEqual(L.shareOver(1_000, 1_000), false, 'it ends a share on its last instant');
  assert.strictEqual(L.shareOver(999, 1_000), false);
});

test('an unknown expiry does not silently end a share', () => {
  // Treating "I do not know" as "it is over" would stop a working share.
  for (const bad of [null, undefined, NaN, 'later', {}]) {
    assert.strictEqual(L.shareOver(2_000, bad), false, `until=${String(bad)} killed the share`);
    assert.strictEqual(L.shareOver(bad, 2_000), false, `now=${String(bad)} killed the share`);
  }
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('the heartbeat is actually started, and actually stopped', () => {
  const start = code(fnBody(mgrSrc, 'startSharing'));
  // Assigned straight from setInterval. Asserting that the WORD setInterval
  // appears let `const beat = null && setInterval(…)` through when mutation
  // tried it — present is not the same as running.
  assert.ok(/const beat = setInterval\(/.test(start),
    'nothing repeats a position that has not changed');
  assert.ok(/sendDue\(Date\.now\(\), lastSentAt\)/.test(start),
    'the heartbeat does not consult the rule that decides when it is due');
  const stop = code(fnBody(mgrSrc, 'stopSharing'));
  assert.ok(/clearInterval\(cur\.beat\)/.test(stop),
    'the heartbeat outlives the share, so a stopped share keeps broadcasting');
});

test('a new share does not inherit the last one\'s clock', () => {
  // Left set, the heartbeat would believe it had just sent and stay quiet
  // through the start of the next share.
  const stop = code(fnBody(mgrSrc, 'stopSharing'));
  assert.ok(/lastSentAt = null/.test(stop) && /lastPos = null/.test(stop),
    'the heartbeat bookkeeping survives a share ending');
});

test('both ends still enforce the expiry', () => {
  const start = code(fnBody(mgrSrc, 'startSharing'));
  // In BOTH places that can send: the watcher and the heartbeat. Matching the
  // call once anywhere in the function let a mutation delete the watcher's
  // copy and pass on the heartbeat's.
  const watcher = /watchPositionAsync\([\s\S]*?\n  \);/.exec(start);
  assert.ok(watcher, 'the watcher is no longer in a shape this can read');
  assert.ok(/shareOver\(Date\.now\(\), active\.until\)/.test(watcher[0]),
    'the watcher no longer stops the share at the deadline');
  const beat = /const beat = setInterval\([\s\S]*?\n  \}, /.exec(start);
  assert.ok(beat, 'the heartbeat is no longer in a shape this can read');
  assert.ok(/shareOver\(Date\.now\(\), active\.until\)/.test(beat[0]),
    'the heartbeat keeps broadcasting past the deadline');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(/liveUntil <= Date\.now\(\)/.test(server),
    'the server no longer refuses updates to an expired share');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
