// Why a call did not connect (native-app/src/callFailure.ts, callManager, server.js).
//
// Reported as: on one device the call never connects, it used to work fine.
// Asked for: the call logging, and show why it failed.
//
// There was nothing to look at. Not one [call] line existed anywhere in
// server.js, and the app's entire account of a failure was the words
// "Connection failed" — the same position the video player was in before it
// started printing its reason, which took three rounds of guessing and then
// minutes once the phone said what had happened.
//
// THE CAUSE FOUND WHILE LOOKING. callManager.doInit() did
//
//     const s = await getSocket(); this.sock = s; s.on('call_offer', …)
//
// and init() memoises its promise for the life of the process, so that
// binding happens exactly once. The socket does not last that long:
// disconnectSocket() drops it on sign-out, and a session that expires signs
// the user out for them. Signing back in builds a NEW socket, init() returns
// its old promise and binds nothing, and from then on every call event
// arrives on a socket nobody is listening to — calls dead on that device
// until the app is force-killed, everything else fine. api.ts says it above
// onSocket: "Handing a socket out once and hoping nothing replaces it is the
// bug." This was the third place doing it.
//
// WHAT THE FACTS MEAN. srflx=0 says STUN told this phone nothing, and ours
// points at a Google host, which these networks block. relay=0 with turn=0
// says no TURN is configured, so a phone behind carrier NAT has nowhere to go.
// turn=1 with relay=0 says a relay IS configured and could not be reached.
// ans=0 says the other side never answered and none of the rest matters.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NATIVE = path.join(__dirname, '..', 'native-app');
const SRC = path.join(NATIVE, 'src');
const TSC = path.join(NATIVE, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping call-failure tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'callfail-'));
execFileSync(TSC, [
  path.join(SRC, 'callFailure.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
], { stdio: 'pipe' });
const F = require(path.join(OUT, 'callFailure.js'));

const mgrSrc = fs.readFileSync(path.join(SRC, 'callManager.ts'), 'utf8');
const uiSrc = fs.readFileSync(path.join(SRC, 'components', 'CallOverlay.tsx'), 'utf8');
const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');

/** A real candidate line, with addresses in it, as WebRTC hands them over. */
const HOST = 'candidate:1 1 udp 2122260223 192.168.1.47 54321 typ host generation 0';
const SRFLX = 'candidate:2 1 udp 1686052607 5.112.33.201 41234 typ srflx '
  + 'raddr 192.168.1.47 rport 54321 generation 0';
const RELAY = 'candidate:3 1 udp 41885439 185.51.200.2 60000 typ relay '
  + 'raddr 5.112.33.201 rport 41234 generation 0';

// ── NOTHING THAT IS AN ADDRESS ──────────────────────────────────────────────

test('THE RULE: a candidate gives up its type and nothing else', () => {
  // A candidate carries this phone's address on its own network AND its
  // public one. This text is written to be read off a photograph of a
  // screen, so an address reaching it would be handing out the user's IP to
  // anybody who sees the picture.
  assert.strictEqual(F.candidateKind(HOST), 'host');
  assert.strictEqual(F.candidateKind(SRFLX), 'srflx');
  assert.strictEqual(F.candidateKind(RELAY), 'relay');
  for (const c of [HOST, SRFLX, RELAY]) {
    const out = String(F.candidateKind(c));
    assert.ok(!/\d/.test(out), `candidateKind leaked digits: ${out}`);
    assert.ok(out.length <= 6, `candidateKind returned something too big to be a type: ${out}`);
  }
});

test('…and an unknown candidate gives nothing, never a guess', () => {
  // A word passed through from an unrecognised shape would be printed on a
  // screen. Null is the only safe answer.
  for (const bad of ['candidate:9 1 udp 1 10.0.0.1 1 typ wat', 'nonsense',
    '', null, undefined, 42, {}, { candidate: '' }, { type: 5 }, []]) {
    assert.strictEqual(F.candidateKind(bad), null, `${JSON.stringify(bad)} produced a type`);
  }
});

test('…the object form is read too, since that is what arrives', () => {
  assert.strictEqual(F.candidateKind({ candidate: SRFLX }), 'srflx');
  assert.strictEqual(F.candidateKind({ type: 'relay' }), 'relay');
  assert.strictEqual(F.candidateKind({ type: 'relay', candidate: HOST }), 'relay');
});

test('NOTHING the user sees can contain an address', () => {
  // The belt-and-braces version of the rule above, over everything that is
  // rendered: feed the real addresses in and insist they do not come out.
  const facts = { host: 3, srflx: 1, relay: 0, answered: true, relayOffered: false };
  const shown = [F.callFailureReason(facts), F.callFacts(facts)].join(' ');
  for (const ip of ['192.168.1.47', '5.112.33.201', '185.51.200.2']) {
    assert.ok(!shown.includes(ip), `an address reached the screen: ${ip}`);
  }
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(shown), `something IP-shaped reached the screen: ${shown}`);
  assert.ok(!/candidate:/.test(shown), 'a raw candidate reached the screen');
});

// ── Telling the causes apart ────────────────────────────────────────────────

const facts = (o) => ({ host: 0, srflx: 0, relay: 0, answered: true, relayOffered: false, ...o });

test('no answer is decided first, because nothing else can be read', () => {
  // A call nobody picked up says nothing about the network, and blaming the
  // network would send someone to fix a connection that is fine.
  const r = F.callFailureReason(facts({ answered: false, host: 4, srflx: 2, relay: 1 }));
  assert.ok(/never answered/i.test(r), `unanswered call reported as: ${r}`);
});

test('THE LIKELY ONE: a public address but nowhere to relay through', () => {
  // STUN worked, so this phone knows how the world sees it — and both sides
  // are behind carrier NAT with no TURN configured. This is what a phone on
  // Iranian mobile data does, and it is a server setting, not a code change.
  const r = F.callFailureReason(facts({ host: 3, srflx: 2, relay: 0, relayOffered: false }));
  assert.ok(/relay/i.test(r) && /no/i.test(r), `missing relay reported as: ${r}`);
});

test('…told apart from a relay that IS set up and unreachable', () => {
  const r = F.callFailureReason(facts({ host: 3, srflx: 2, relay: 0, relayOffered: true }));
  assert.ok(/could not be reached/i.test(r), `unreachable relay reported as: ${r}`);
  assert.notStrictEqual(r, F.callFailureReason(facts({ host: 3, srflx: 2, relayOffered: false })),
    'a configured-but-dead relay reads the same as no relay at all');
});

test('…and from STUN itself having told us nothing', () => {
  // Only our own address. Ours points at a Google host, which these networks
  // block — the same reason the map tiles are proxied.
  const r = F.callFailureReason(facts({ host: 4, srflx: 0, relay: 0 }));
  assert.ok(/own address/i.test(r), `blocked STUN reported as: ${r}`);
});

test('…and from a relay that worked but still could not reach the far end', () => {
  const r = F.callFailureReason(facts({ host: 3, srflx: 2, relay: 2, relayOffered: true }));
  assert.ok(/relay/i.test(r) && !/no relay/i.test(r), `relayed failure reported as: ${r}`);
});

test('no candidates at all is its own answer', () => {
  const r = F.callFailureReason(facts({ host: 0, srflx: 0, relay: 0 }));
  assert.ok(/nothing to connect/i.test(r), `empty gathering reported as: ${r}`);
});

test('every branch says something different, or it is not a diagnosis', () => {
  const seen = new Set([
    F.callFailureReason(facts({ answered: false })),
    F.callFailureReason(facts({ host: 3, srflx: 2, relay: 2, relayOffered: true })),
    F.callFailureReason(facts({ host: 3, srflx: 2, relay: 0, relayOffered: true })),
    F.callFailureReason(facts({ host: 3, srflx: 2, relay: 0, relayOffered: false })),
    F.callFailureReason(facts({ host: 3, srflx: 0, relay: 0 })),
    F.callFailureReason(facts({ host: 0, srflx: 0, relay: 0 })),
  ]);
  assert.strictEqual(seen.size, 6, `${seen.size} distinct messages for six distinct causes`);
  for (const r of seen) assert.ok(r.length > 10 && r.length < 90, `unusable message: ${r}`);
});

test('nonsense facts do not produce a confident wrong answer', () => {
  for (const bad of [null, undefined, {}, { host: 'lots' }, { host: NaN, srflx: -2 }]) {
    const r = F.callFailureReason(bad);
    assert.ok(typeof r === 'string' && r.length > 0, `${JSON.stringify(bad)} produced no message`);
    assert.ok(!/undefined|NaN|\[object/.test(r), `internals leaked into: ${r}`);
  }
  // Missing counts read as none, and an absent answer reads as unanswered.
  assert.ok(/never answered/i.test(F.callFailureReason({})), 'an empty fact set blamed the network');
});

test('the short line is readable off a photograph', () => {
  const line = F.callFacts({ host: 3, srflx: 1, relay: 0, answered: true, relayOffered: false });
  assert.strictEqual(line, 'h3 s1 r0 ans=1 turn=0');
  assert.strictEqual(F.callFacts(null), 'h0 s0 r0 ans=0 turn=0', 'nothing known reads as nonsense');
  assert.ok(F.callFacts({}).length < 30, 'the line is too long to read at arm\'s length');
});

test('whether a relay was even offered is read from the config', () => {
  assert.strictEqual(F.offersRelay([{ urls: ['turn:example.org:3478'] }]), true);
  assert.strictEqual(F.offersRelay([{ urls: 'turns:example.org:5349' }]), true);
  assert.strictEqual(F.offersRelay([{ urls: ['stun:stun.l.google.com:19302'] }]), false);
  assert.strictEqual(F.offersRelay([
    { urls: ['stun:a'] }, { urls: ['turn:b', 'turn:b?transport=tcp'] },
  ]), true, 'a relay later in the list is missed');
  // The SCHEME decides, not the presence of the word anywhere in the string.
  // "stun:turn.example.org" does not distinguish those two readings — it has
  // no "turn:" in it at all — so it passed either way and proved nothing.
  // These do: each contains "turn:" somewhere that is not the scheme.
  for (const notRelay of ['stun:turn.example.org', 'xturn:example.org',
    'stun:a.example.org/turn:b', 'stun:example.org?next=turn:c']) {
    assert.strictEqual(F.offersRelay([{ urls: [notRelay] }]), false,
      `"${notRelay}" was counted as a relay — the scheme is not what is being checked`);
  }
  for (const bad of [null, undefined, 'turn:x', 42, [null], [{}], [{ urls: null }]]) {
    assert.strictEqual(F.offersRelay(bad), false, `${JSON.stringify(bad)} claimed a relay`);
  }
});

// ── The cause found on the way: listeners bound to one socket ──────────────

test('THE BUG: call listeners are bound to every socket, not one', () => {
  const init = code(mgrSrc);
  assert.ok(/onSocket\(s => this\.bindSocket\(s\)\)/.test(init),
    'call events are bound to whatever socket existed at startup again — '
    + 'a sign-out or an expired session kills calls until the app is restarted');
  assert.ok(!/const s = await getSocket\(\);\s*this\.sock = s;\s*s\.on\(/.test(init),
    'doInit is back to capturing one socket and hanging the listeners on it');
});

test('…and the thing that warns about it is still in api.ts', () => {
  const api = fs.readFileSync(path.join(SRC, 'api.ts'), 'utf8');
  assert.ok(/Handing a socket out once and hoping nothing replaces it is the bug/.test(api),
    'the note explaining why has been deleted');
  assert.ok(/export function onSocket\(/.test(api), 'the subscription it describes is gone');
});

// ── The wiring ──────────────────────────────────────────────────────────────

test('the facts are gathered by type, and the raw candidate is not kept', () => {
  const m = code(mgrSrc);
  assert.ok(/candidateKind\(e\.candidate\)/.test(m), 'nothing counts the candidates');
  for (const k of ['host', 'srflx', 'relay']) {
    assert.ok(new RegExp(`kind === '${k}'`).test(m), `${k} candidates are not counted`);
  }
  // The tally must hold numbers, never the candidate itself.
  assert.ok(!/this\.ice\.\w+ = e\.candidate/.test(m), 'a candidate is stored in the tally');
});

test('a failure computes the reason and reports it', () => {
  const m = code(mgrSrc);
  assert.ok(/this\.failureReason = callFailureReason\(this\.ice\)/.test(m),
    'a failed call still says only that it failed');
  assert.ok(/this\.reportCall\('failed'\)/.test(m), 'the failure is never reported to the server');
});

test('each call starts from its own facts', () => {
  const m = code(mgrSrc);
  assert.ok(/if \(this\.pcs\.size === 0\) this\.resetIceFacts\(\)/.test(m),
    'the tally is reset per peer, so a room call reports whoever joined last');
  assert.ok(/relayOffered: offersRelay\(this\.iceServers\)/.test(m),
    'whether a relay exists is assumed rather than read from the config in use');
});

test('the screen shows it', () => {
  assert.ok(/cm\.failureReason/.test(uiSrc), 'the reason is never displayed');
  assert.ok(/callFacts\(cm\.iceFacts\)/.test(uiSrc), 'the counts behind the sentence are not shown');
  // Not over a call that is running: `elapsed` is set once connected.
  assert.ok(/!!cm\.failureReason && !elapsed/.test(uiSrc),
    'a stale failure can appear over a call that is working');
});

// ── The server line ─────────────────────────────────────────────────────────

test('the server logs the call, which it never did before', () => {
  assert.ok(/\[call\] user=\$\{socket\.user\.id\}/.test(srvSrc),
    'there is still no [call] line to look at');
  for (const k of ['host=', 'srflx=', 'relay=', 'ans=', 'turn=']) {
    assert.ok(srvSrc.includes(k), `the log omits ${k}, which is one of the facts that decides the cause`);
  }
});

test('…and it cannot carry a name, a token or an address', () => {
  // These lines are read into diagnostics/*.md, which is committed to a
  // repository that has been public. Same rule as [device], [push], [share].
  const line = /console\.log\(`\[call\][\s\S]*?\);/.exec(srvSrc);
  assert.ok(line, 'the [call] line is no longer in a shape this can read');
  assert.ok(!/username/i.test(line[0]), 'the call log names the user');
  assert.ok(!/token|sdp|candidate/i.test(line[0]), 'the call log carries call contents');
  // Every interpolation goes through a sanitiser or is the numeric user id.
  const holes = line[0].match(/\$\{([^}]+)\}/g) || [];
  assert.ok(holes.length > 0, 'nothing is interpolated — this is reading the wrong text');
  for (const h of holes) {
    assert.ok(/socket\.user\.id|word\(|n\(/.test(h),
      `${h} reaches the log without being sanitised`);
  }
});

test('the app sends counts, not candidates', () => {
  const m = code(mgrSrc);
  // reportCall's emit specifically. There are two call_diag emits in this
  // file — the screen-share one came first and a plain search found that
  // instead, which is a test reading something it was not written about.
  const fn = /private reportCall\(outcome: string\) \{[\s\S]*?\n  \}/.exec(m);
  assert.ok(fn, 'reportCall is gone');
  const report = /this\.sock\?\.emit\('call_diag', \{[\s\S]*?\}\);/.exec(fn[0]);
  assert.ok(report, 'the call report is gone');
  assert.ok(!/candidate/i.test(report[0]), 'the report carries candidates, which carry addresses');
  assert.ok(!/sdp/i.test(report[0]), 'the report carries session descriptions');
  assert.ok(/what: 'call'/.test(report[0]), 'the report is not tagged as a call');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
