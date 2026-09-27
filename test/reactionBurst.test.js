// ── The emoji that flies up when somebody reacts ────────────────────────────
//
// Asked for: on a reaction, show that emoji animated on the message for three
// seconds.
//
// The animation is the easy half. The hard half is knowing that a reaction
// HAPPENED, because the server does not say so — it sends the message's whole
// list of reactions every time any of them changes. So "somebody reacted" has
// to be worked out by comparing the list against what it was, and the obvious
// ways of getting that wrong give you either nothing at all or a screen full
// of emoji every time a chat is opened.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping reaction-burst tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'rburst-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'reactionBurst.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
  '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
const B = require(path.join(OUT, 'reactionBurst.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const r = (emoji, username) => ({ emoji, username });

test('A NEW REACTION IS THE THING THAT ANIMATES', () => {
  assert.strictEqual(B.addedEmoji({ prev: [], next: [r('❤️', 'sara')] }), '❤️');
  assert.strictEqual(
    B.addedEmoji({ prev: [r('❤️', 'sara')], next: [r('❤️', 'sara'), r('🔥', 'ako')] }), '🔥');
});

test('OPENING A CHAT DOES NOT BURST EVERY MESSAGE IN IT', () => {
  // The one that would be embarrassing. Opening a chat loads every message's
  // reactions at once; treating those as new would set the whole history off
  // at the same moment.
  assert.strictEqual(B.addedEmoji({ prev: undefined, next: [r('❤️', 'sara')] }), null);
  assert.strictEqual(B.addedEmoji({ prev: null, next: [r('❤️', 'sara'), r('🔥', 'ako')] }), null);
});

test('…but an EMPTY list is not the same as an unseen one', () => {
  // A message known to have no reactions is exactly the state a first
  // reaction arrives into. Treating [] as "never seen" would silence the most
  // common case there is — which is what `!prev` would have done.
  assert.strictEqual(B.addedEmoji({ prev: [], next: [r('👍', 'sara')] }), '👍');
});

test('TAKING A REACTION BACK IS NOT AN EVENT', () => {
  assert.strictEqual(B.addedEmoji({ prev: [r('❤️', 'sara')], next: [] }), null);
  assert.strictEqual(
    B.addedEmoji({ prev: [r('❤️', 'sara'), r('🔥', 'ako')], next: [r('❤️', 'sara')] }), null);
});

test('and neither is nothing changing', () => {
  const same = [r('❤️', 'sara')];
  assert.strictEqual(B.addedEmoji({ prev: same, next: same }), null);
  assert.strictEqual(B.addedEmoji({ prev: same, next: [r('❤️', 'sara')] }), null);
});

test('THE SECOND PERSON TO USE AN EMOJI COUNTS TOO', () => {
  // Compared by COUNT, not as a set. Two people reacting with the same emoji
  // is one entry in a set and two in the list, and the second person's
  // reaction is every bit as much an event as the first's — a set comparison
  // would show nothing for it.
  assert.strictEqual(
    B.addedEmoji({ prev: [r('❤️', 'sara')], next: [r('❤️', 'sara'), r('❤️', 'ako')] }), '❤️');
});

test('one emoji, even when several arrive at once', () => {
  // A reconnect can deliver a batch. Three overlapping animations say nothing;
  // one says "somebody reacted" perfectly well.
  const out = B.addedEmoji({ prev: [], next: [r('❤️', 'a'), r('🔥', 'b'), r('👍', 'c')] });
  assert.ok(['❤️', '🔥', '👍'].includes(out));
  assert.strictEqual(typeof out, 'string');
});

test('NOTHING IS ANIMATED FOR NONSENSE', () => {
  for (const o of [{}, undefined, { prev: [] }, { prev: [], next: null },
                   { prev: [], next: 'nope' }, { prev: 'x', next: [r('❤️', 'a')] }]) {
    assert.doesNotThrow(() => B.addedEmoji(o), JSON.stringify(o));
  }
  // An entry with no emoji is not a reaction.
  assert.strictEqual(B.addedEmoji({ prev: [], next: [{ username: 'sara' }] }), null);
  assert.strictEqual(B.addedEmoji({ prev: [], next: [r('', 'sara')] }), null);
  assert.strictEqual(B.addedEmoji({ prev: [], next: [r(null, 'sara')] }), null);
});

test('three seconds, as asked for', () => {
  assert.strictEqual(B.BURST_MS, 3000);
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const chatCode = chat.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

test('THE FIRST REACTION ON A MESSAGE ANIMATES — reported as "only some emoji"', () => {
  // The bug. A message with no reactions has no entry in the map, and the
  // handler passed that `undefined` straight through, which addedEmoji reads
  // as "never seen, say nothing". So the FIRST reaction on any message never
  // animated — for anybody — and the second one did.
  //
  // Tried on a message that had already been reacted to it worked; tried on a
  // fresh one it did not. That is why it came back as "should work for all
  // emojis" and "should show for both sender and receiver": both are the same
  // fact, seen from two angles.
  const i = chatCode.indexOf("onSock('reactions_updated'");
  assert.ok(i > 0, 'the app no longer listens for reactions');
  const body = chatCode.slice(i, chatCode.indexOf('});', i));
  assert.ok(/reactionsRef\.current\[messageId\] \|\| \[\]/.test(body),
    'a message with no reactions yet is still treated as never seen, so its first reaction is silent');
});

test('THE COMPARISON USES THE LIST AS IT IS, not a stale copy', () => {
  // This listener is created once. Reading the previous reactions from the
  // component's own `reactions` would capture whatever they were when the
  // chat opened — so it would animate once and then silently never again,
  // which is a bug that looks like a flaky animation. A ref is always
  // current; the state variable is not.
  const i = chatCode.indexOf("onSock('reactions_updated'");
  const body = chatCode.slice(i, chatCode.indexOf('});', i));
  assert.ok(/reactionsRef\.current/.test(body),
    'the comparison is made against something other than the live list');
  assert.ok(/reactionsRef\.current = reactions/.test(chatCode),
    'the ref is never kept in step, so it is stale from the first render');
  // And no setState from inside another setState's updater: React may run an
  // updater more than once, which would fire the animation twice.
  assert.ok(!/setReactions\(prev => \{[\s\S]{0,400}setBursts/.test(chatCode),
    'the animation is triggered from inside a state updater, which may run twice');
});

test('OPENING A CHAT STILL CANNOT BURST THE WHOLE HISTORY', () => {
  // The protection the old guard was believed to provide. It does not live in
  // addedEmoji — it lives in the fact that the bulk load sets the reactions
  // directly and never asks whether anything was added.
  const i = chatCode.indexOf('/room-reactions/');
  assert.ok(i > 0, 'reactions are no longer loaded on open');
  const body = chatCode.slice(i, i + 400);
  assert.ok(/setReactions\(/.test(body), 'the bulk load no longer sets the reactions');
  assert.ok(!/addedEmoji|setBursts/.test(body),
    'loading a chat now animates every reaction in its history at once');
});

test('BOTH PEOPLE ARE TOLD, including whoever reacted', () => {
  // "It should show for both sender and receiver." Nothing can animate on a
  // device that is never told, so the server has to reach both — and it must
  // be io.to, not socket.to, which excludes the sender.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const i = server.indexOf("socket.on('toggle_reaction'");
  assert.ok(i > 0, 'reactions can no longer be toggled');
  const body = server.slice(i, server.indexOf('\n  });', i));
  assert.ok(/io\.to\(String\(msg\.room_id\)\)\.emit\('reactions_updated'/.test(body),
    'the reaction is not broadcast to the room, or is sent with socket.to, which skips the sender');
  assert.ok(/getRoomMemberIds\(room\)\.forEach\(id => io\.to\('user:' \+ id\)/.test(body),
    'a member whose app is backgrounded is never told');
});

test('THE EMOJI IS ACTUALLY DRAWN, on the message', () => {
  assert.ok(/<ReactionBurst/.test(chatCode), 'nothing renders the animation');
  assert.ok(/bursts\[String\(msg\.id\)\]/.test(chatCode),
    'the animation is not tied to the message it belongs to');
  assert.ok(/onDone=\{/.test(chatCode), 'the emoji never goes away');
});

test('IT CANNOT SWALLOW A TAP', () => {
  // It sits over the bubble. Without this it would eat touches on the message
  // for three seconds, which feels exactly like the app having frozen.
  const src = fs.readFileSync(path.join(NAT, 'src', 'components', 'ReactionBurst.tsx'), 'utf8');
  assert.ok(/pointerEvents="none"/.test(src),
    'the animation takes touches, so the message under it is dead for 3 seconds');
});

test('…and it stops when the message scrolls away', () => {
  // These are mounted and thrown away constantly by the list. An animation
  // left running against a dead view is wasted work on a phone with little
  // to spare.
  const src = fs.readFileSync(path.join(NAT, 'src', 'components', 'ReactionBurst.tsx'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(/return \(\) => \{/.test(code), 'the effect has no cleanup');
  assert.ok(/anim\.stop\(\)/.test(code), 'the animation is left running after unmount');
  assert.ok(/clearTimeout\(t\)/.test(code), 'the three-second timer outlives the component');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
