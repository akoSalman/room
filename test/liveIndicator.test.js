// ── "Dr.Soran is recording…", from somebody who is not online ───────────────
//
// Photographed. Reported as happening for typing too.
//
// Every one of these indicators was a LATCH: a name went into a list on
// "started" and came out on "stopped". So the display was correct only if the
// stop event always arrived — and it does not. The sender's app is killed,
// their socket drops, they lose signal mid-recording, the process is swiped
// away. In every one of those cases the last thing anybody heard was
// "started", and it then stands on screen for ever.
//
// Recording was the worst of the set because it announced itself ONCE, at the
// beginning: a two-minute voice note sent one event and nothing after it.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const WEB = require(path.join(ROOT, 'public', 'js', 'liveIndicator.js'));

let APP = null;
const TSC = path.join(NAT, 'node_modules', '.bin', 'tsc');
if (fs.existsSync(TSC)) {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  process.on('exit', () => fs.rmSync(OUT, { recursive: true, force: true }));
  execFileSync(TSC, [path.join(NAT, 'src', 'liveIndicator.ts'),
    '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019',
    '--skipLibCheck', '--esModuleInterop'], { stdio: 'pipe' });
  APP = require(path.join(OUT, 'liveIndicator.js'));
}

const tests = [];
const test = (n, f) => tests.push({ n, f });
const T = 1_800_000_000_000;

test('THE BUG: a claim nobody repeats stops being believed', () => {
  const c = WEB.note({}, 'Dr.Soran', T);
  assert.deepStrictEqual(WEB.active(c, T + 1000), ['Dr.Soran']);
  assert.deepStrictEqual(WEB.active(c, T + WEB.EXPIRY_MS + 1), [],
    'a sender who went away still shows as recording, for ever');
});

test('…and one that IS repeated goes on being believed', () => {
  // The other half. An expiry that drops a live indicator would be its own
  // bug: somebody recording a two-minute voice note must not flicker out.
  let c = WEB.note({}, 'Dr.Soran', T);
  for (let t = T; t < T + 120000; t += WEB.HEARTBEAT_MS) {
    c = WEB.note(c, 'Dr.Soran', t);
    assert.deepStrictEqual(WEB.active(c, t), ['Dr.Soran'], `lost at ${t - T}ms`);
  }
});

test('THE HEARTBEAT FITS INSIDE THE EXPIRY, with room to spare', () => {
  // If they were close, one dropped packet would make the indicator blink.
  // Two whole heartbeats must fit, or the margin is not a margin.
  assert.ok(WEB.EXPIRY_MS > WEB.HEARTBEAT_MS * 2,
    `expiry ${WEB.EXPIRY_MS}ms leaves no room for a missed heartbeat of ${WEB.HEARTBEAT_MS}ms`);
});

test('an explicit stop is still instant', () => {
  // The expiry is a safety net, not a replacement: when the stop does arrive
  // the indicator goes at once rather than lingering for the timeout.
  const c = WEB.note({}, 'sara', T);
  assert.deepStrictEqual(WEB.active(WEB.drop(c, 'sara'), T), []);
});

test('several people at once, each on their own clock', () => {
  let c = WEB.note({}, 'sara', T);
  c = WEB.note(c, 'ako', T + 5000);
  assert.deepStrictEqual(WEB.active(c, T + 6000).sort(), ['ako', 'sara']);
  // sara's claim expires while ako's is still good.
  assert.deepStrictEqual(WEB.active(c, T + 9000), ['ako']);
});

test('NOTHING IS BELIEVED ON A TIMESTAMP THAT IS NOT ONE', () => {
  // Number(null) is 0, and a claim "from 1970" must not be treated as
  // current. Wrong in this direction hides an indicator for a moment; wrong
  // in the other is the bug being fixed.
  for (const bad of [null, undefined, NaN, 'x', 0, -1]) {
    assert.deepStrictEqual(WEB.active({ sara: bad }, T), [], String(bad));
  }
  assert.deepStrictEqual(WEB.active(null, T), []);
  assert.deepStrictEqual(WEB.active({ sara: T }, NaN), []);
  // An empty or missing name is not a person.
  assert.deepStrictEqual(Object.keys(WEB.note({}, '', T)), []);
  assert.deepStrictEqual(Object.keys(WEB.note({}, '   ', T)), []);
});

test('note() and drop() do not mutate what they are given', () => {
  // These feed React state setters; mutating the previous value means the
  // re-render never happens and the fix looks like it did nothing.
  const before = WEB.note({}, 'sara', T);
  const after = WEB.drop(before, 'sara');
  assert.deepStrictEqual(Object.keys(before), ['sara']);
  assert.deepStrictEqual(Object.keys(after), []);
  const added = WEB.note(before, 'ako', T);
  assert.deepStrictEqual(Object.keys(before), ['sara']);
  assert.deepStrictEqual(Object.keys(added).sort(), ['ako', 'sara']);
});

test('THE TWO CLIENTS AGREE, function by function', () => {
  if (!APP) { console.log('    (native-app deps not installed)'); return; }
  assert.strictEqual(APP.EXPIRY_MS, WEB.EXPIRY_MS);
  assert.strictEqual(APP.HEARTBEAT_MS, WEB.HEARTBEAT_MS);
  const c = { sara: T, ako: T - 20000, bad: null };
  for (const now of [T, T + 5000, T + 20000]) {
    assert.deepStrictEqual(APP.active(c, now).sort(), WEB.active(c, now).sort(), `active @${now}`);
  }
  assert.deepStrictEqual(APP.note({}, 'x', T), WEB.note({}, 'x', T));
  assert.deepStrictEqual(APP.drop({ x: T }, 'x'), WEB.drop({ x: T }, 'x'));
});

// ── The wiring ──────────────────────────────────────────────────────────────

const chat = fs.readFileSync(path.join(NAT, 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
const chatCode = chat.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const web = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const webCode = web.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('THE APP EXPIRES THEM, and keeps a timer only while it must', () => {
  assert.ok(/live\.active\(/.test(chatCode), 'the app still shows whatever it was last told');
  assert.ok(/setIndicatorTick/.test(chatCode), 'nothing ages the claims out without an event');
  // An idle chat must not tick once a second for nothing.
  assert.ok(/if \(!somethingLive\) return;/.test(chatCode),
    'the expiry timer runs in every chat for ever');
});

test('…and the SENDER repeats itself while it is still true', () => {
  // Without this, an expiry would cut off a genuine two-minute recording.
  assert.ok(/recordingBeat/.test(chatCode), 'a recording is still announced only once');
  assert.ok(/sendingBeat/.test(chatCode), 'a long upload is still announced only once');
  const i = chatCode.indexOf('function startRecordingUI');
  const body = chatCode.slice(i, chatCode.indexOf('\n  }', i));
  assert.ok(/setInterval/.test(body) && /live\.HEARTBEAT_MS/.test(body),
    'the recording heartbeat does not use the shared interval');
});

test('THE WEB DOES THE SAME', () => {
  assert.ok(/LiveIndicator\.active\(/.test(webCode), 'the web still shows whatever it was last told');
  assert.ok(/js\/liveIndicator\.js/.test(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')),
    'the rules are never loaded by the page');
  assert.ok(/setTimeout\(renderTypingBar, 1000\)/.test(webCode),
    'nothing re-reads the bar, so an expired claim stays on screen');
});

test('THE SERVER SPEAKS FOR A SOCKET THAT HAS GONE', () => {
  // For the builds already on people's phones, which have no expiry: the one
  // moment the server KNOWS the sender is gone, it says so on their behalf.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const code = server.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = code.indexOf("socket.on('disconnect', (reason)");
  assert.ok(i > 0, 'the logging disconnect handler is gone');
  const body = code.slice(i, code.indexOf('\n  });', i));
  for (const ev of ['user_stopped_typing', 'user_stopped_recording', 'user_stopped_sending']) {
    assert.ok(body.includes(ev), `${ev} is not sent when the socket dies`);
  }
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
