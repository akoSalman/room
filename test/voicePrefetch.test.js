// ── Having the voice message before it is tapped ───────────────────────────
//
// Asked for: fetch voice messages when a chat opens or one arrives, and keep
// them so they are never fetched twice.
//
// The keeping half already worked. mediaCache writes every played voice note
// to permanent storage and plays it from there afterwards — so what was
// actually missing was only the FIRST play, which streams by design.
//
// The risk this adds is the whole reason the rule is tested rather than the
// wiring: "download things nobody asked for" is one bad cap away from being a
// year of voice notes on a connection paid for by the megabyte, and one bad
// guard away from keeping a message the sender said could not be kept.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping voice-prefetch tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'vpre-'));
process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
execFileSync(TSC, [path.join(NAT, 'src', 'voicePrefetch.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck'],
  { stdio: 'pipe' });
const V = require(path.join(OUT, 'voicePrefetch.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });
const voice = (id, extra) => Object.assign(
  { id, type: 'audio', file_path: `/uploads/v${id}.m4a` }, extra || {});

test('ONLY VOICE MESSAGES, and only ones that exist on the server', () => {
  const picked = V.pickVoice({ messages: [
    voice(1),
    { id: 2, type: 'text', content: 'hello' },
    { id: 3, type: 'image', file_path: '/uploads/a.jpg' },
    { id: 4, type: 'audio' },                      // no path
    voice(5, { _uploading: true }),                // still going up from here
    { id: 6, type: 'audio', file_path: '' },
  ] });
  assert.deepStrictEqual(picked.map(m => m.id), [1]);
});

test('NEWEST FIRST, because that is what somebody is about to play', () => {
  const msgs = [voice(1), voice(2), voice(3), voice(4), voice(5)];
  assert.deepStrictEqual(V.pickVoice({ messages: msgs, max: 3 }).map(m => m.id), [5, 4, 3]);
});

test('THE CAP IS REAL, or opening a chat becomes a large download', () => {
  const many = Array.from({ length: 200 }, (_, i) => voice(i + 1));
  assert.strictEqual(V.pickVoice({ messages: many }).length, V.MAX_ON_OPEN);
  assert.ok(V.MAX_ON_OPEN <= 20, `the cap is ${V.MAX_ON_OPEN}, which is not a cap`);
  // A cap of zero means off, and must mean off rather than meaning no cap.
  assert.deepStrictEqual(V.pickVoice({ messages: many, max: 0 }), []);
});

test('WHAT MAY NOT BE KEPT IS NEVER FETCHED', () => {
  // The important one. Pre-fetching a disappearing message, or someone
  // else's message in a private room, writes to permanent storage exactly
  // what the sender said could not be kept — and does it without anybody
  // even tapping play.
  const picked = V.pickVoice({
    messages: [voice(1), voice(2, { disappear_seconds: 30 }), voice(3)],
    canKeep: (m) => !m.disappear_seconds,
  });
  assert.deepStrictEqual(picked.map(m => m.id), [3, 1]);
});

test('ALREADY DOWNLOADED ONES ARE LEFT ALONE', () => {
  // Re-opening a chat should ask for nothing.
  const picked = V.pickVoice({
    messages: [voice(1), voice(2), voice(3)],
    isLocal: (m) => m.id !== 2,
  });
  assert.deepStrictEqual(picked.map(m => m.id), [2]);
});

test('NONSENSE IS NOT A REASON TO DOWNLOAD ANYTHING', () => {
  assert.deepStrictEqual(V.pickVoice({}), []);
  assert.deepStrictEqual(V.pickVoice({ messages: null }), []);
  assert.deepStrictEqual(V.pickVoice(null), []);
});

test('AN ARRIVING MESSAGE IS JUDGED BY THE SAME RULES', () => {
  assert.strictEqual(V.wantsPrefetch({ message: voice(1) }), true);
  assert.strictEqual(V.wantsPrefetch({ message: { id: 2, type: 'text' } }), false);
  assert.strictEqual(V.wantsPrefetch({ message: voice(3, { _uploading: true }) }), false);
  assert.strictEqual(V.wantsPrefetch({ message: { type: 'audio' } }), false);
  assert.strictEqual(V.wantsPrefetch({}), false);
  assert.strictEqual(V.wantsPrefetch({ message: null }), false);
  // …including the one that matters.
  assert.strictEqual(V.wantsPrefetch({
    message: voice(4, { disappear_seconds: 10 }),
    canKeep: (m) => !m.disappear_seconds,
  }), false);
});

// ── And the screen actually does it ────────────────────────────────────────

const strip = (f) => fs.readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const CHAT = strip(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'));

test('BOTH MOMENTS ARE WIRED: opening a chat, and a message arriving', () => {
  assert.ok(/pickVoice\(\{/.test(CHAT), 'nothing is pre-fetched when a chat opens');
  assert.ok(/wantsPrefetch\(\{ message: msg/.test(CHAT),
    'an arriving voice message is not pre-fetched');
});

test('IT USES THE SAME KEEP RULE THE PLAYER USES', () => {
  // Not a second opinion about what may be stored. A copy of this rule that
  // drifted would quietly start keeping disappearing messages.
  assert.ok(/canKeep: canTakeContent\b/.test(CHAT),
    'the chat-open path does not consult the keep rule');
  assert.ok(/canKeep: canTakeContentRef\.current/.test(CHAT),
    'the arriving-message path does not consult the keep rule');
  // Through a REF on the socket path: that listener is bound once, so the
  // function it captured would judge every later message with an empty name.
  assert.ok(/canTakeContentRef\.current = canTakeContent;/.test(CHAT),
    'the ref is never refreshed, so the keep rule goes stale');
});

test('IT NEVER DOWNLOADS WHAT IS ALREADY HERE', () => {
  // peek never fetches; resolve would. Using the wrong one turns "skip the
  // ones we have" into "download them again".
  assert.ok(/mediaCache\.peek\(url\)/.test(CHAT), 'the open path does not check what is cached');
  assert.ok(/mediaCache\.fetchAndKeep\(url\)/.test(CHAT),
    'the prefetch does not actually keep anything');
});

test('ONE AT A TIME, so it does not race the rest of the chat', () => {
  assert.ok(/prefetching\.current/.test(CHAT), 'the prefetch has no concurrency guard');
  assert.ok(/prefetchQueue\.current/.test(CHAT), 'there is no queue, so requests go out at once');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
