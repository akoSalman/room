// ── Two hours, or for good ──────────────────────────────────────────────────
//
// Asked for as: mute in rooms and DMs, with a choice of two hours or forever.
//
// One mechanism for both. A mute row already meant "silent, permanently", so
// the change is that a row can carry an EXPIRY — and forever is the absence of
// one, which keeps every row written before today valid without inventing a
// date for it.
//
// Everything here fails in the same direction on purpose: when the answer is
// unclear, stay muted. A mute that outlives its welcome is two taps to undo; a
// mute that quietly expires early is the notification storm somebody muted to
// escape, arriving without warning.
const assert = require('assert');
const M = require('../mutes');

const tests = [];
const test = (n, f) => tests.push({ n, f });
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

test('TWO HOURS MEANS TWO HOURS', () => {
  assert.strictEqual(M.expiryFor('2h', NOW), NOW + 2 * HOUR);
  assert.strictEqual(M.TWO_HOURS_MS, 2 * HOUR);
});

test('…and everything else means forever', () => {
  // Including nonsense. A mute is a request for quiet; the failure that costs
  // something is the one that lets the noise back in.
  for (const c of ['forever', undefined, null, '', 'x', '2', '2H ', 0, {}]) {
    assert.strictEqual(M.expiryFor(c, NOW), null, JSON.stringify(c));
  }
  // A broken clock cannot produce a timed mute either — `now + 2h` off a
  // wrong clock is a date nobody chose.
  for (const n of [null, undefined, 0, -1, NaN, 'x']) {
    assert.strictEqual(M.expiryFor('2h', n), null, String(n));
  }
});

test('FOREVER IS NOT "EXPIRED IN 1970"', () => {
  // Number(null) is 0, and 0 is less than any timestamp — so a plain numeric
  // comparison reads a forever mute as long expired and unmutes everybody who
  // chose it. The single most damaging way to get this wrong.
  for (const until of [null, undefined, 0, '']) {
    assert.strictEqual(M.isActive({ until, now: NOW }), true, String(until));
    assert.strictEqual(M.hasExpired({ until, now: NOW }), false, String(until));
  }
});

test('a timed mute ends, and not before', () => {
  assert.strictEqual(M.isActive({ until: NOW + HOUR, now: NOW }), true);
  assert.strictEqual(M.isActive({ until: NOW - 1, now: NOW }), false);
  assert.strictEqual(M.hasExpired({ until: NOW - 1, now: NOW }), true);
  assert.strictEqual(M.hasExpired({ until: NOW + HOUR, now: NOW }), false);
  // Exactly at the boundary it is over. Either answer is defensible; this one
  // is stated so it cannot drift.
  assert.strictEqual(M.isActive({ until: NOW, now: NOW }), false);
  assert.strictEqual(M.hasExpired({ until: NOW, now: NOW }), true);
});

test('NO CLOCK MEANS STAY MUTED', () => {
  // If the time cannot be read, the safe answer is silence — see the header.
  assert.strictEqual(M.isActive({ until: NOW + HOUR }), true);
  assert.strictEqual(M.isActive({ until: NOW - HOUR, now: 'x' }), true);
  // …and nothing is swept on a clock nobody can read.
  assert.strictEqual(M.hasExpired({ until: NOW - HOUR }), false);
});

test('an absent row is not a mute, and not rubbish either', () => {
  // hasExpired must be false for a row that never existed: only something
  // that once meant silence and no longer does is worth deleting.
  assert.strictEqual(M.isActive(null), false);
  assert.strictEqual(M.isActive(undefined), false);
  assert.strictEqual(M.hasExpired(null), false);
});

test('the client is handed a timestamp, never a sentence', () => {
  // The phone knows the user's timezone and locale; this process does not. A
  // server rendering "until 14:30" is guessing at which 14:30.
  const d = M.describe({ until: NOW + HOUR, now: NOW });
  assert.deepStrictEqual(d, { muted: true, until: NOW + HOUR });
  assert.deepStrictEqual(M.describe({ until: null, now: NOW }), { muted: true, until: null });
  assert.deepStrictEqual(M.describe({ until: NOW - 1, now: NOW }), { muted: false, until: null });
});

// ── The wiring ──────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const serverCode = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('BOTH KINDS OF MUTE TAKE A DURATION', () => {
  for (const fn of ['function setRoomMute', 'function setUserMute']) {
    const i = serverCode.indexOf(fn);
    assert.ok(i > 0, `${fn} is missing`);
    const body = serverCode.slice(i, serverCode.indexOf('\n}', i));
    assert.ok(/mutes\.expiryFor\(req\.body && req\.body\.for/.test(body),
      `${fn} ignores how long the user asked for`);
    // Re-muting must REPLACE the expiry, or "2 hours" then "forever" leaves
    // the two-hour one standing and the chat speaks up again.
    assert.ok(/DO UPDATE SET until = excluded\.until/.test(body),
      `${fn} cannot change an existing mute's duration`);
  }
});

test('…and both are read through the expiry rule', () => {
  for (const fn of ['function hasMuted', 'function hasMutedRoom']) {
    const i = serverCode.indexOf(fn);
    const body = serverCode.slice(i, serverCode.indexOf('\n}', i));
    assert.ok(/mutes\.isActive/.test(body), `${fn} treats an expired mute as still muted`);
    assert.ok(/mutes\.hasExpired/.test(body) && /DELETE FROM/.test(body),
      `${fn} never sweeps the rows it has found to be over`);
  }
});

test('THE TABLES CAN HOLD AN EXPIRY, including ones already created', () => {
  const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  assert.ok(/ALTER TABLE user_mutes ADD COLUMN until INTEGER/.test(db),
    'existing person mutes have nowhere to record a duration');
  assert.ok(/ALTER TABLE room_mutes ADD COLUMN until INTEGER/.test(db),
    'a room_mutes table made before today can never hold an expiry');
});

test('THE APP OFFERS EXACTLY TWO CHOICES, both ways', () => {
  const pa = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'peerActions.ts'), 'utf8');
  assert.ok(/MUTE_CHOICES/.test(pa) && /'2h'/.test(pa) && /forever/.test(pa));
  // Two, and no more: a list of durations is a menu to read while already
  // irritated by a chat that will not be quiet.
  const m = pa.match(/export const MUTE_CHOICES: MuteFor\[\] = \[([^\]]*)\]/);
  assert.ok(m, 'the choices are no longer stated in one place');
  assert.strictEqual(m[1].split(',').filter(x => x.trim()).length, 2);

  for (const [file, what] of [
    ['screens/RoomsScreen.tsx', 'rooms'],
    ['screens/ChatScreen.tsx', 'DMs'],
  ]) {
    const src = fs.readFileSync(path.join(ROOT, 'native-app', 'src', file), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(/MUTE_CHOICES/.test(code), `${what} do not offer a duration`);
    assert.ok(/for: forHow|{ for: c }/.test(code) || /forHow/.test(code),
      `${what} ask how long and then do not send it`);
  }
});

test('unmuting asks nothing', () => {
  // There is only one way to stop being quiet, and a confirmation dialog for
  // it is a tap spent on nothing.
  const rooms = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'screens', 'RoomsScreen.tsx'), 'utf8');
  const i = rooms.indexOf('function toggleRoomMute');
  const body = rooms.slice(i, rooms.indexOf('\n  }', i));
  assert.ok(/if \(room\.muted\)[\s\S]{0,80}applyRoomMute\(room, false\)/.test(body),
    'unmuting opens a dialog asking how long to unmute for');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
