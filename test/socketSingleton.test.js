// ── One phone, one socket ───────────────────────────────────────────────────
//
// Measured on the server, which had never logged connections until it was
// looked for:
//
//     08:35:44  connect    user=11          (seven times, same second)
//     08:35:51  disconnect user=11 held=7s  (seven times, same second)
//
// Seven sockets for one handset, all created in the same second, all dead
// seven seconds later. Two compounding faults in getSocket():
//
//   1. the guard asked `socket?.connected` rather than whether a socket
//      EXISTED, so a socket that was merely reconnecting — most of the time,
//      on these connections — was replaced. Replaced is not closed: socket.io
//      goes on reconnecting the abandoned one forever.
//   2. `await getToken()` sits between the check and the assignment, so every
//      caller arriving during that await passed the guard and made its own.
//
// Together, one bad minute of network leaves a handful of permanent sockets,
// each reconnecting on its own schedule. This is checked against the source,
// because the failure only appears with real concurrency and a real network,
// and it went unseen for as long as nobody was counting.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'api.ts'), 'utf8');
const code = api.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('THE GUARD ASKS IF A SOCKET EXISTS, not if it is connected', () => {
  // `socket?.connected` replaced a reconnecting socket with a new one and
  // left the old one reconnecting forever.
  const fn = code.slice(code.indexOf('export async function getSocket'),
                        code.indexOf('async function createSocket'));
  assert.ok(fn.length > 40, 'getSocket moved');
  assert.ok(/if \(socket\) return socket;/.test(fn),
    'getSocket still replaces a socket that is merely reconnecting');
  assert.ok(!/if \(socket\?\.connected\) return socket;/.test(fn),
    'the .connected guard is back — every reconnect will orphan another socket');
});

test('CONCURRENT CALLERS SHARE ONE CREATION', () => {
  // The await between the check and the assignment is the race. The app calls
  // getSocket() from several places at once on resume.
  const fn = code.slice(code.indexOf('export async function getSocket'),
                        code.indexOf('async function createSocket'));
  assert.ok(/if \(creating\) return creating;/.test(fn),
    'concurrent callers each create their own socket');
  assert.ok(/creating = createSocket\(\)/.test(fn));
  assert.ok(/\.finally\(\(\) => \{ creating = null; \}\)/.test(fn),
    'a failed creation would be cached forever and the app could never connect again');
});

test('the token is fetched INSIDE the guarded creation, not before it', () => {
  // If the await moved back above the guard, the race returns whatever the
  // guard says.
  const g = code.indexOf('export async function getSocket');
  const c = code.indexOf('async function createSocket');
  assert.ok(!/await getToken\(\)/.test(code.slice(g, c)),
    'getSocket awaits before its own guard, which is the race all over again');
  assert.ok(/await getToken\(\)/.test(code.slice(c, c + 400)),
    'createSocket no longer gets a token');
});

test('createSocket hands back the socket it made', () => {
  const body = code.slice(code.indexOf('async function createSocket'));
  const end = body.indexOf('\n}\n');
  assert.ok(/return socket;/.test(body.slice(0, end + 3)),
    'createSocket returns undefined, so every caller gets undefined');
});

test('signing out clears the in-flight creation too', () => {
  // Otherwise a creation started before sign-out resolves afterwards and
  // hands the next account the previous one's socket.
  const d = code.slice(code.indexOf('export function disconnectSocket'));
  assert.ok(/socket = null;/.test(d));
  assert.ok(/creating = null;/.test(d),
    'a socket created during sign-out survives it');
});

// ── The server-side counter, which lied on its first outing ─────────────────

test('THE COUNT IS OF SOCKETS, not of people in a room', () => {
  // It printed "sockets=1" while seven were open, and "sockets=-1" on the way
  // out, because onlineUsers only holds sockets that have sent join_room. A
  // diagnostic reporting something other than its label is the failure this
  // whole investigation has been made of; this one lasted one report.
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const s = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const fn = s.slice(s.indexOf('const socketsFor ='), s.indexOf('console.log(presenceLine'));
  assert.ok(/io\.of\('\/'\)\.sockets/.test(fn),
    'the socket count is still derived from onlineUsers and cannot see unjoined sockets');
  assert.ok(!/onlineUsers/.test(fn), 'onlineUsers is back in the socket count');
  // And no arithmetic on it: +1/-1 is what produced -1.
  assert.ok(!/socketsFor\([^)]*\)\s*[-+]\s*1/.test(s),
    'the count is adjusted by hand again, which is how it printed -1');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
