// Choosing where the pin goes (native-app/src/locationPick.ts).
//
// Reported as: the location the app picks is sometimes not accurate, so let the
// user choose on a map before sending.
//
// A phone's fix is a guess with an error bar; indoors or on cell towers that
// error runs to hundreds of metres. The pin is now placed by hand, starting
// from the fix. Two of the rules here are easy to get quietly wrong, and both
// would put a false claim into a message someone is relying on to find a
// person or a place.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'locpick-'));
const ROOT = path.join(__dirname, '..', 'native-app', 'src');
const TSC = path.join(__dirname, '..', 'native-app', 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping location-picker tests (native-app deps not installed)');
  process.exit(0);
}
execFileSync(TSC, [
  path.join(ROOT, 'locationPick.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
], { stdio: 'pipe' });
const P = require(path.join(OUT, 'locationPick.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// Tehran, and points a known distance from it.
const HERE = { lat: 35.6892, lng: 51.3890 };
const fixAt = (p, accuracy = 30) => ({ ...p, accuracy });
/** A point `m` metres north of `p`. One degree of latitude is ~111,320 m. */
const north = (p, m) => ({ lat: p.lat + m / 111320, lng: p.lng });

// ── Where the map opens ─────────────────────────────────────────────────────

test('the map opens on the fix, close enough to place a pin on a street', () => {
  // The common case is that the fix is fine, and it must then cost one tap.
  const v = P.openingView(fixAt(HERE));
  assert.deepStrictEqual(v.center, HERE);
  assert.strictEqual(v.zoom, P.PICK_ZOOM);
  assert.ok(v.zoom >= 16, 'opened too far out to place a pin accurately');
});

test('with no fix, it opens near whatever this chat has already pinned', () => {
  // Far more useful than the middle of the ocean, which is what 0,0 is.
  const v = P.openingView(null, [HERE]);
  assert.deepStrictEqual(v.center, HERE);
});

test('with no fix and nothing pinned, it opens zoomed out rather than nowhere', () => {
  const v = P.openingView(null, []);
  assert.ok(v.zoom <= 6, `zoom ${v.zoom} at an unknown location — panning to your city is hopeless`);
});

// ── Has the pin been moved? ─────────────────────────────────────────────────

test('a map nobody touched counts as not moved', () => {
  // The centre is a float and the map cannot be held perfectly still, so an
  // untouched map drifts a metre or two. That is not a decision.
  assert.strictEqual(P.pinMoved(fixAt(HERE), north(HERE, 3)), false);
  assert.strictEqual(P.pinMoved(fixAt(HERE), HERE), false);
});

test('a pin dragged down the road counts as moved', () => {
  assert.strictEqual(P.pinMoved(fixAt(HERE), north(HERE, 120)), true);
});

test('with no fix at all, the pin is always the user\'s own choice', () => {
  assert.strictEqual(P.pinMoved(null, HERE), true);
});

// ── The payload ─────────────────────────────────────────────────────────────

test('an untouched pin keeps the accuracy the phone reported', () => {
  const p = P.locationPayload({ chosen: HERE, fix: fixAt(HERE, 25), liveUntil: null, now: 1000 });
  assert.strictEqual(p.accuracy, 25);
  assert.strictEqual(p.lat, HERE.lat);
  assert.strictEqual(p.updatedAt, 1000);
  assert.strictEqual(p.liveUntil, null);
});

test('THE LIE THIS PREVENTS: a hand-placed pin carries no accuracy figure', () => {
  // `accuracy` is the error bar on a MEASUREMENT. Carrying it across to a
  // point somebody placed by hand attaches a measured uncertainty to a number
  // that was never measured — and if anything it is backwards, since the
  // hand-placed pin is usually the better of the two. That is the entire
  // reason this feature exists.
  const p = P.locationPayload({
    chosen: north(HERE, 300), fix: fixAt(HERE, 25), liveUntil: null, now: 1000,
  });
  assert.strictEqual(p.accuracy, null, 'a hand-placed pin claimed GPS accuracy');
  assert.strictEqual(p.lat, north(HERE, 300).lat, 'the chosen point was not the one sent');
});

test('with no fix, a chosen point is sent with no accuracy claim', () => {
  const p = P.locationPayload({ chosen: HERE, fix: null, liveUntil: null, now: 1000 });
  assert.strictEqual(p.accuracy, null);
  assert.strictEqual(p.lat, HERE.lat);
});

test('THE OTHER LIE: a live share always starts from the real fix', () => {
  // Live means "follow me". The tracker overwrites the coordinates within
  // seconds of the first update, so a hand-placed starting point would show a
  // position that was never true and then quietly correct itself — worse than
  // not offering it at all.
  const p = P.locationPayload({
    chosen: north(HERE, 500), fix: fixAt(HERE, 25), liveUntil: 9_000, now: 1_000,
  });
  assert.strictEqual(p.lat, HERE.lat, 'a live share began at a hand-placed point');
  assert.strictEqual(p.lng, HERE.lng);
  assert.strictEqual(p.liveUntil, 9_000);
  assert.strictEqual(p.accuracy, 25, 'a live share from the fix dropped its accuracy');
});

test('a live share that has already expired is just a pin', () => {
  const p = P.locationPayload({
    chosen: north(HERE, 500), fix: fixAt(HERE), liveUntil: 500, now: 1_000,
  });
  assert.strictEqual(p.liveUntil, null);
  // …and being an ordinary pin, it honours the chosen point again.
  assert.strictEqual(p.lat, north(HERE, 500).lat);
});

test('live sharing needs a fix; there is nothing to follow without one', () => {
  assert.strictEqual(P.canShareLive(fixAt(HERE)), true);
  assert.strictEqual(P.canShareLive(null), false);
});

// ── What the user is told ───────────────────────────────────────────────────

test('an untouched pin says it is your position, and how well it is known', () => {
  const label = P.chosenLabel(fixAt(HERE, 30), HERE);
  assert.ok(/current position/i.test(label), label);
  assert.ok(/30 m/.test(label), `the accuracy was not shown: ${label}`);
});

test('a poor fix says so rather than hiding it', () => {
  // 400 m is the case this whole feature is about; the number is the reason
  // the user should reach for the map.
  const label = P.chosenLabel(fixAt(HERE, 400), HERE);
  assert.ok(/400 m/.test(label), label);
});

test('a moved pin says how far it is from the phone\'s idea of you', () => {
  // The honest answer to "have I dragged this to the right building or to the
  // next district", and the only feedback available without street names.
  const label = P.chosenLabel(fixAt(HERE, 30), north(HERE, 250));
  assert.ok(/250 m/.test(label), `distance missing: ${label}`);
  assert.ok(!/current position/i.test(label), `still claiming to be your position: ${label}`);
});

test('with no fix it says the point is a choice, and names it', () => {
  const label = P.chosenLabel(null, HERE);
  assert.ok(/chosen/i.test(label), label);
  assert.ok(label.includes('35.6892'), `the coordinates were not shown: ${label}`);
});

test('an unknown accuracy is not reported as a number', () => {
  const label = P.chosenLabel({ ...HERE, accuracy: null }, HERE);
  assert.ok(!/accurate to/.test(label), `invented an accuracy: ${label}`);
});

// ── The web copy must not drift ─────────────────────────────────────────────
//
// public/js/locationPick.js mirrors this module. The two rules that stop a
// false claim reaching a message — dropping accuracy from a hand-placed pin,
// and forcing a live share back onto the real fix — are exactly the sort of
// thing that gets simplified away in a second implementation.

const WEB = require(path.join(__dirname, '..', 'public', 'js', 'locationPick.js'));

test('the web build agrees on the constants', () => {
  assert.strictEqual(WEB.PICK_ZOOM, P.PICK_ZOOM);
  assert.strictEqual(WEB.UNKNOWN_ZOOM, P.UNKNOWN_ZOOM);
  assert.strictEqual(WEB.PIN_MOVED_M, P.PIN_MOVED_M);
});

test('THE DRIFT CHECK: web and app place and describe the pin identically', () => {
  const fixes = [null, fixAt(HERE), fixAt(HERE, 400), { ...HERE, accuracy: null }];
  const points = [HERE, north(HERE, 3), north(HERE, 120), north(HERE, 2500)];
  const bad = [];
  const same = (what, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      bad.push(`${what}\n        app: ${JSON.stringify(a)}\n        web: ${JSON.stringify(b)}`);
    }
  };

  for (const fix of fixes) {
    same(`openingView(${!!fix})`, P.openingView(fix), WEB.openingView(fix));
    same(`openingView(${!!fix}, nearby)`, P.openingView(fix, [HERE]), WEB.openingView(fix, [HERE]));
    same(`canShareLive(${!!fix})`, P.canShareLive(fix), WEB.canShareLive(fix));
    for (const at of points) {
      same(`pinMoved`, P.pinMoved(fix, at), WEB.pinMoved(fix, at));
      same(`chosenLabel`, P.chosenLabel(fix, at), WEB.chosenLabel(fix, at));
      for (const liveUntil of [null, 9000, 500]) {
        const args = { chosen: at, fix, liveUntil, now: 1000 };
        same(`locationPayload(live=${liveUntil})`, P.locationPayload(args), WEB.locationPayload(args));
      }
    }
  }
  assert.deepStrictEqual(bad, [], `the web copy has drifted:\n      ${bad.join('\n      ')}`);
});

// ── When this position was last heard ──────────────────────────────────────
//
// Asked for: show the last time a live location was updated.
//
// The card said how long the share has left — a promise about the future. It
// said nothing about the past, and the past is the question somebody has: is
// this where they are NOW, or where they were before the phone lost signal
// twenty minutes ago? A live pin that has silently stopped moving looks
// exactly like one that is moving.

const NOWL = 1_800_000_000_000;

test('UNDER A MINUTE IS "just now"', () => {
  assert.strictEqual(P.formatUpdated(NOWL, NOWL), 'updated just now');
  assert.strictEqual(P.formatUpdated(NOWL - 59_000, NOWL), 'updated just now');
});

test('…and after that it says how stale it is', () => {
  assert.strictEqual(P.formatUpdated(NOWL - 60_000, NOWL), 'updated 1 min ago');
  assert.strictEqual(P.formatUpdated(NOWL - 4 * 60_000, NOWL), 'updated 4 min ago');
  assert.strictEqual(P.formatUpdated(NOWL - 59 * 60_000, NOWL), 'updated 59 min ago');
  assert.strictEqual(P.formatUpdated(NOWL - 60 * 60_000, NOWL), 'updated 1 h ago');
  assert.strictEqual(P.formatUpdated(NOWL - 23 * 3600_000, NOWL), 'updated 23 h ago');
  assert.strictEqual(P.formatUpdated(NOWL - 25 * 3600_000, NOWL), 'updated 1 d ago');
});

test('RELATIVE, not a clock time', () => {
  // A clock time has to be read and subtracted from the current one before it
  // answers anything, and the question is always "how stale is this".
  const out = P.formatUpdated(NOWL - 7 * 60_000, NOWL);
  assert.ok(/ago/.test(out), 'the time is shown as a clock reading');
  assert.ok(!/:/.test(out), 'the time is shown as a clock reading');
});

test('A CLOCK THAT DISAGREES DOES NOT READ AS THE FUTURE', () => {
  // The two devices' clocks need not agree, and "updated in 3 minutes" is
  // nonsense. The honest thing to say is that it is current.
  assert.strictEqual(P.formatUpdated(NOWL + 5 * 60_000, NOWL), 'updated just now');
});

test('nothing is said about a timestamp there is not', () => {
  // An empty string so the caller can render nothing rather than a line
  // reading "updated NaN min ago".
  for (const v of [null, undefined, 0, '', NaN, 'x', {}, -1]) {
    assert.strictEqual(P.formatUpdated(v, NOWL), '', JSON.stringify(v));
  }
  assert.strictEqual(P.formatUpdated(NOWL, 'x'), '');
});

test('THE PAYLOAD CARRIES THE TIME, which is why nothing had to be added', () => {
  const out = P.locationPayload({
    chosen: { lat: 1, lng: 2 }, fix: null, liveUntil: NOWL + 60_000, now: NOWL,
  });
  assert.strictEqual(out.updatedAt, NOWL, 'a share records no time, so nothing can be said about it');
});

// ── The wiring ──────────────────────────────────────────────────────────────

const fsL = require('fs');
const chatSrc = fsL.readFileSync(require('path').join(__dirname, '..', 'native-app',
  'src', 'screens', 'ChatScreen.tsx'), 'utf8');

test('THE CARD SHOWS IT, for a live share', () => {
  assert.ok(/formatUpdated\(p\.updatedAt/.test(chatSrc),
    'the last update time is never shown');
  // Only for a live one: a pin dropped once was never going to move, so how
  // long ago it was dropped is the message timestamp's job.
  assert.ok(/live && !!p\.updatedAt/.test(chatSrc),
    'a one-off pin claims to be "updated", which it never is');
});

test('…and it does not freeze at whatever it said when drawn', () => {
  // "4 min ago" is only true for a minute. Something has to re-render it.
  assert.ok(/setClockTick\(n => n \+ 1\), 30000\)/.test(chatSrc),
    'nothing re-renders the card, so the age is stuck at what it was');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
