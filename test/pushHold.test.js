// ── Not pushing what the socket already delivered ──────────────────────────
//
// Reported as: "don't send firebase notification of a message already arrived
// through socket and opened".
//
// Both routes to a notification are deliberate and neither can be switched
// off: Firebase does not reach every device on these networks, which is why
// the app draws its own from the socket, and the socket is gone once Android
// has killed the process, which is why the push exists. When both work, both
// arrive — the phone draws one of them, but the push was still sent, still
// paid for in data, and still queued at Firebase to be handed over later if
// the phone drops off in between.
//
// The direction of failure is the whole design. A push too many is noise. A
// push too few is "I don't get notifications", which is the report this part
// of the codebase already exists because of — so every uncertainty here ends
// in the push being sent.
const assert = require('assert');
const { createHolder } = require('../pushHold');

const tests = [];
const test = (n, f) => tests.push({ n, f });

/** Timers under the test's control, so nothing waits five seconds. */
function fakeTimers() {
  let next = 1;
  const jobs = new Map();
  return {
    setTimeout(fn) { const id = next++; jobs.set(id, fn); return id; },
    clearTimeout(id) { jobs.delete(id); },
    /** Fire everything still pending, as the clock would. */
    run() { const fns = [...jobs.values()]; jobs.clear(); fns.forEach(f => f()); },
    pending() { return jobs.size; },
  };
}

test('A HELD PUSH IS SENT WHEN NOBODY SAYS OTHERWISE', () => {
  // The case that must never break: the app was killed in those few seconds,
  // so nothing acknowledges, and the phone still has to be told.
  const t = fakeTimers();
  const h = createHolder(5000, t);
  let sent = 0;
  h.hold(7, 101, () => { sent++; });
  assert.strictEqual(sent, 0, 'the push went immediately, so the hold does nothing');
  t.run();
  assert.strictEqual(sent, 1, 'a held push was dropped instead of sent');
});

test('…AND NOT SENT WHEN THE APP GOT THERE FIRST', () => {
  const t = fakeTimers();
  const h = createHolder(5000, t);
  let sent = 0;
  h.hold(7, 101, () => { sent++; });
  assert.strictEqual(h.cancel(7, 101), true, 'nothing was waiting to cancel');
  t.run();
  assert.strictEqual(sent, 0, 'the push was sent even though the socket had drawn it');
});

test('CANCELLING NAMES BOTH THE PERSON AND THE MESSAGE', () => {
  // One recipient acknowledging must not drop another's push for the same
  // message — a group chat is one message and many pushes.
  const t = fakeTimers();
  const h = createHolder(5000, t);
  const sent = [];
  h.hold(7, 101, () => sent.push('a'));
  h.hold(8, 101, () => sent.push('b'));
  h.cancel(7, 101);
  t.run();
  assert.deepStrictEqual(sent, ['b'], "one person's acknowledgement silenced another's push");
});

test('…AND ONE MESSAGE DOES NOT CANCEL ANOTHER', () => {
  const t = fakeTimers();
  const h = createHolder(5000, t);
  const sent = [];
  h.hold(7, 101, () => sent.push(101));
  h.hold(7, 102, () => sent.push(102));
  h.cancel(7, 101);
  t.run();
  assert.deepStrictEqual(sent, [102], 'acknowledging one message dropped the next one too');
});

test('A NUMBER AND ITS STRING ARE THE SAME MESSAGE', () => {
  // The id arrives as a number from the database and as a string from the
  // socket payload. If those were different keys, the acknowledgement would
  // never match and the hold would always expire — the feature would appear
  // to work while doing nothing at all.
  const t = fakeTimers();
  const h = createHolder(5000, t);
  let sent = 0;
  h.hold(7, 101, () => { sent++; });
  assert.strictEqual(h.cancel('7', '101'), true, 'a string id does not match a numeric one');
  t.run();
  assert.strictEqual(sent, 0);
});

test('HOLDING THE SAME THING TWICE IS ONE PUSH', () => {
  // A re-sent or duplicated message must not queue two notifications.
  const t = fakeTimers();
  const h = createHolder(5000, t);
  let sent = 0;
  assert.strictEqual(h.hold(7, 101, () => { sent++; }), true);
  assert.strictEqual(h.hold(7, 101, () => { sent++; }), false, 'the second hold was accepted');
  t.run();
  assert.strictEqual(sent, 1, `${sent} pushes for one message`);
});

test('CANCELLING SOMETHING THAT IS NOT WAITING SAYS SO', () => {
  // The difference between "the socket got there first" and "the push had
  // already gone", which are worth telling apart in a log.
  const h = createHolder(5000, fakeTimers());
  assert.strictEqual(h.cancel(7, 101), false);
  h.hold(7, 101, () => {});
  assert.strictEqual(h.cancel(7, 101), true);
  assert.strictEqual(h.cancel(7, 101), false, 'cancelled twice, reported as waiting twice');
});

test('NOTHING IS LEFT BEHIND, either way', () => {
  // Every entry holds a timer and a closure over a whole push payload. One
  // leak per message is a server that grows until it is restarted.
  const t = fakeTimers();
  const h = createHolder(5000, t);
  h.hold(1, 1, () => {});
  h.hold(2, 2, () => {});
  assert.strictEqual(h.size(), 2);
  h.cancel(1, 1);
  assert.strictEqual(h.size(), 1, 'a cancelled push is still remembered');
  t.run();
  assert.strictEqual(h.size(), 0, 'a sent push is still remembered');
  assert.strictEqual(t.pending(), 0, 'the timer outlived the entry');
});

test('A SEND THAT THROWS DOES NOT WEDGE THAT MESSAGE FOR EVER', () => {
  // The entry is removed before the send, so a failing send cannot leave a
  // key behind that makes every later hold for it a no-op.
  const t = fakeTimers();
  const h = createHolder(5000, t);
  h.hold(7, 101, () => { throw new Error('network'); });
  assert.throws(() => t.run());
  assert.strictEqual(h.size(), 0, 'the failed push is still holding its key');
  let sent = 0;
  assert.strictEqual(h.hold(7, 101, () => { sent++; }), true,
    'that message can never be held again');
  t.run();
  assert.strictEqual(sent, 1);
});

test('THE REAL TIMERS ARE USED WHEN NONE ARE GIVEN', () => {
  // Otherwise the server holds pushes that nothing ever fires, and every
  // message to a connected device is silently dropped.
  const h = createHolder(1);
  let sent = 0;
  h.hold(7, 101, () => { sent++; });
  assert.strictEqual(h.size(), 1);
  return new Promise((resolve) => setTimeout(() => {
    assert.strictEqual(sent, 1, 'nothing fires a held push in the real server');
    assert.strictEqual(h.size(), 0);
    resolve();
  }, 30));
});

(async () => {
  let passed = 0, failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ✓ ${n}`); passed++; }
    catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
