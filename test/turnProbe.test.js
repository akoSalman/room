// The TURN probe's own correctness (scripts/turn-probe.py).
//
// WHY THIS IS TESTED AT ALL. Every TURN measurement today was made with a
// broken instrument, and each wrong reading cost hours:
//
//   • listener counts stood in for reachability, which they cannot do;
//   • two coturn instances share a log directory, so "cannot bind" was read
//     off a merged stream and blamed on the wrong process;
//   • turnutils_uclient was run under `timeout`, which SIGTERMs it and
//     discards its buffered output — three transports reported FAILED with
//     no explanation whatsoever, a verdict indistinguishable from "the client
//     was killed before it spoke".
//
// So the replacement speaks STUN itself, and a bug in ITS encoding would
// report a healthy server as unreachable — the same class of mistake one
// layer down. A probe that is trusted has to be checked first.
//
// It is checked against a STUN/TURN responder written here, which implements
// the long-term-credential flow from the other side: 401 with a realm and a
// nonce, then verify MESSAGE-INTEGRITY over the header with the length field
// counting the attribute that holds it. That last detail is the classic way
// to get a 401 out of a server that is working perfectly.
const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

const PROBE = path.join(__dirname, '..', 'scripts', 'turn-probe.py');
const MAGIC = 0x2112a442;
const USERNAME = 'relayuser';
const PASSWORD = 'relaysecret';
const REALM = 'chat.example.org';
const NONCE = 'f//499k954d6OL34oL9FSTvy64sA';

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── A STUN/TURN server, from the other side of the wire ─────────────────────

function pad(buf) {
  const over = buf.length % 4;
  return over === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - over)]);
}

function attr(kind, value) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(kind, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, pad(value)]);
}

function message(kind, txid, attrs) {
  const head = Buffer.alloc(20);
  head.writeUInt16BE(kind, 0);
  head.writeUInt16BE(attrs.length, 2);
  head.writeUInt32BE(MAGIC, 4);
  txid.copy(head, 8);
  return Buffer.concat([head, attrs]);
}

function parse(buf) {
  if (buf.length < 20 || buf.readUInt32BE(4) !== MAGIC) return null;
  const kind = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  const txid = buf.subarray(8, 20);
  const body = buf.subarray(20, 20 + length);
  const attrs = new Map();
  let i = 0;
  while (i + 4 <= body.length) {
    const k = body.readUInt16BE(i);
    const len = body.readUInt16BE(i + 2);
    if (!attrs.has(k)) attrs.set(k, body.subarray(i + 4, i + 4 + len));
    i += 4 + len + ((4 - (len % 4)) % 4);
  }
  return { kind, txid, attrs, length };
}

/**
 * Verify MESSAGE-INTEGRITY the way a server must.
 *
 * Independently derived from the RFC's description rather than copied from the
 * probe: the HMAC covers everything up to the attribute, with the header's
 * length field set as though the attribute were already there.
 */
function integrityOk(buf) {
  const got = parse(buf);
  const mac = got.attrs.get(0x0008);
  if (!mac || mac.length !== 20) return false;
  // Everything before the 24-byte MESSAGE-INTEGRITY attribute.
  const upto = buf.subarray(0, buf.length - 24);
  const head = Buffer.from(upto.subarray(0, 20));
  head.writeUInt16BE(got.length, 2);   // already counts the attribute
  const key = crypto.createHash('md5')
    .update(`${USERNAME}:${REALM}:${PASSWORD}`).digest();
  const want = crypto.createHmac('sha1', key)
    .update(Buffer.concat([head, upto.subarray(20)])).digest();
  return want.equals(mac);
}

function errorCode(code) {
  const v = Buffer.alloc(4);
  v[2] = Math.floor(code / 100);
  v[3] = code % 100;
  return v;
}

/** The reply this server would send, or null to stay silent. */
function replyTo(buf, opts = {}) {
  const got = parse(buf);
  if (!got) return null;
  if (got.kind === 0x0001) {                           // Binding request
    if (opts.noBinding) return null;
    return message(0x0101, got.txid, Buffer.alloc(0));
  }
  if (got.kind === 0x0003) {                           // Allocate request
    if (opts.noAllocate) return null;
    const hasIntegrity = got.attrs.has(0x0008);
    if (!hasIntegrity) {
      return message(0x0113, got.txid, Buffer.concat([
        attr(0x0009, errorCode(401)),
        attr(0x0014, Buffer.from(REALM)),
        attr(0x0015, Buffer.from(NONCE)),
      ]));
    }
    if (!integrityOk(buf)) {
      return message(0x0113, got.txid, attr(0x0009, errorCode(401)));
    }
    return message(0x0103, got.txid, Buffer.alloc(0));
  }
  return null;
}

function udpServer(opts = {}) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    const out = replyTo(msg, opts);
    if (out) sock.send(out, rinfo.port, rinfo.address);
  });
  return new Promise(res => sock.bind(0, '127.0.0.1', () => res({
    port: sock.address().port, close: () => sock.close(),
  })));
}

function tcpServer(opts = {}) {
  const srv = net.createServer(c => {
    c.on('data', msg => {
      const out = replyTo(msg, opts);
      if (out) c.write(out);
    });
    c.on('error', () => {});
  });
  return new Promise(res => srv.listen(0, '127.0.0.1', () => res({
    port: srv.address().port, close: () => srv.close(),
  })));
}

/**
 * Run the probe, asynchronously, and return its stdout whatever the exit code.
 *
 * ── TWO SEPARATE HARNESS BUGS LIVED HERE ──────────────────────────────────
 *
 * execFileSync BLOCKS NODE'S EVENT LOOP, so the fake server above could not
 * answer one datagram while the probe waited for it: every test read
 * UNREACHABLE against a server that was running perfectly, and the reading
 * was about this file rather than about anything it measures.
 *
 * And a non-zero exit arrives here as an error, which the probe returns
 * whenever a transport is not OK — the outcome most of these tests are ABOUT.
 * Treating that as a crash is the same fault being tested for one layer down:
 * a harness that aborts on the thing it is measuring reports nothing at all.
 */
function run(spec, env = {}) {
  return new Promise((resolve, reject) => {
    execFile('python3', ['-I', PROBE, '127.0.0.1', spec], {
      encoding: 'utf8',
      env: { ...process.env, TURN_USERNAME: USERNAME, TURN_PASSWORD: PASSWORD, ...env },
      timeout: 60000,
    }, (err, stdout, stderr) => {
      if (stdout && stdout.trim()) return resolve(stdout);
      reject(new Error(`${err ? err.message : 'no output'}\nstderr: ${stderr || '(none)'}`));
    });
  });
}

// ── THE VERDICTS, EACH AGAINST A SERVER THAT PRODUCES IT ────────────────────

test('a working relay reads OK, over UDP', async () => {
  const s = await udpServer();
  try {
    const out = await run(String(s.port));
    assert.match(out, /OK\s+relay allocated/,
      `a server that allocates must read OK, got: ${out.trim()}`);
  } finally { s.close(); }
});

test('…and over TCP, which is the fallback that matters here', async () => {
  // TURN over TCP is the route for networks that block UDP, which is the
  // case being chased. It had no public listener for most of today and the
  // surveys did not say so.
  const s = await tcpServer();
  try {
    const out = await run(`${s.port}/tcp`);
    assert.match(out, /tcp\s+\d+\s+OK\s+relay allocated/,
      `tcp must be probed as tcp, got: ${out.trim()}`);
  } finally { s.close(); }
});

test('THE INTEGRITY IS RIGHT, judged by a separate implementation', async () => {
  // The whole value of the OK above. The server in this file verifies
  // MESSAGE-INTEGRITY from the RFC's description, written independently of
  // the probe: HMAC-SHA1 with key MD5(user:realm:password), over the message
  // whose length field ALREADY counts the 24 bytes of the attribute carrying
  // the result. Compute it over the real length — the obvious reading — and a
  // healthy server answers 401, which is indistinguishable from wrong
  // credentials and sends you to fix the wrong thing.
  const s = await udpServer();
  try {
    assert.match(await run(String(s.port)), /OK/);
    // And it is genuinely checked: a wrong password must NOT read OK.
    const bad = await run(String(s.port), { TURN_PASSWORD: 'wrong' });
    assert.doesNotMatch(bad, /OK/, 'a wrong password must not read OK');
    assert.match(bad, /AUTH\/CONFIG\s+credentials rejected/,
      `a wrong password must say so, got: ${bad.trim()}`);
  } finally { s.close(); }
});

test('nothing listening reads UNREACHABLE, not FAILED', async () => {
  // The distinction the old harness could not make. "No reply" and "answered
  // and said no" need opposite fixes — one is a firewall or a missing
  // listener, the other is configuration — and they were reported
  // identically all day.
  const s = await udpServer();
  const port = s.port;
  s.close();
  await new Promise(r => setTimeout(r, 50));
  const out = await run(String(port));
  assert.match(out, /UNREACHABLE\s+no reply to a STUN binding request/,
    `a dead port must read UNREACHABLE, got: ${out.trim()}`);
});

test('STUN answering while TURN does not reads HALF', async () => {
  // A real state, and one worth naming: it is what a coturn serving STUN on a
  // port it does not relay on looks like, and reading it as "unreachable"
  // would send somebody to the firewall instead of the config.
  const s = await udpServer({ noAllocate: true });
  try {
    const out = await run(String(s.port));
    assert.match(out, /HALF\s+STUN answers, TURN allocate does not/,
      `got: ${out.trim()}`);
  } finally { s.close(); }
});

test('with no credentials it still reports reachability', async () => {
  // So the probe is useful before the credentials are in hand, and so a
  // missing secret cannot be mistaken for a dead server — the last run exited
  // before measuring anything because it could not find the credentials.
  const s = await udpServer();
  try {
    const out = await run(String(s.port), { TURN_USERNAME: '', TURN_PASSWORD: '' });
    assert.match(out, /REACHABLE\s+TURN is alive/, `got: ${out.trim()}`);
  } finally { s.close(); }
});

test('the credentials are never put on the command line', async () => {
  // An argument is visible in `ps` to every user on the machine, and this
  // runs on a shared CI runner against a live relay's password.
  const src = require('fs').readFileSync(PROBE, 'utf8');
  const code = src.replace(/"""[\s\S]*?"""/g, ' ').replace(/^\s*#.*$/gm, ' ');
  assert.match(code, /os\.environ\.get\("TURN_USERNAME"/);
  assert.match(code, /os\.environ\.get\("TURN_PASSWORD"/);
  assert.doesNotMatch(code, /sys\.argv\[[^\]]*\].*(?:TURN_)?(?:PASSWORD|password)/i,
    'the password must not come from argv');
});

test('the probe prints no address of its own', async () => {
  // A STUN binding response CONTAINS the client's mapped public address, and
  // these outputs are pasted into reports in a repository that has been
  // public. The probe reads the reply and must not echo that attribute.
  const s = await udpServer();
  try {
    const out = await run(String(s.port));
    assert.doesNotMatch(out, /XOR|MAPPED|mapped/, 'the mapped address must not be printed');
    // Only the host it was asked about, which the caller already knew.
    const addrs = out.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
    for (const a of addrs) {
      assert.strictEqual(a, '127.0.0.1', `the probe printed an address: ${a}`);
    }
  } finally { s.close(); }
});

(async () => {
  let failed = 0;
  for (const { n, f } of tests) {
    try { await f(); console.log(`  ok  ${n}`); }
    catch (e) { failed++; console.log(`  FAIL ${n}\n       ${e.message}`); }
  }
  if (failed) { console.log(`\n  ${failed} turn-probe test(s) failed`); process.exit(1); }
  console.log(`  ${tests.length} turn-probe tests passed`);
})();
