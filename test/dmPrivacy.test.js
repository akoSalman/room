// A DM's existence is not public (server.js)
//
// Found while looking for a missing call log, not reported.
//
// Four places told the whole server when a DM had activity:
//
//     io.emit('dm_activity', { room });
//
// io.emit reaches EVERY connected socket, and the payload carries room.name —
// which for a DM is literally `__dm__<a>__<b>__`. So every user was told,
// continuously, which pairs of people were talking to each other, with both
// user ids in plain text. The clients only ever used it for their own sidebar
// and threw the rest away, so nothing was visible; the information went out
// regardless, to anyone who opened a socket and listened.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const code = srv.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const tests = [];
const test = (n, f) => tests.push({ n, f });

test('NO DM ACTIVITY IS BROADCAST TO EVERYONE', () => {
  assert.doesNotMatch(code, /io\.emit\(\s*'dm_activity'/,
    'a DM\'s name, which contains both user ids, is sent to every connected socket');
});

test('it goes to the two people in the DM, and nobody else', () => {
  const fn = code.slice(code.indexOf('function emitDmActivity'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /io\.to\('user:' \+ id\)\.emit\('dm_activity'/,
    'the activity is not addressed to a specific person');
  // Parsed from the room name, which is where DM membership lives in this
  // schema — there are no room_members rows for a DM.
  assert.match(body, /room\.name\.split\('__'\)/);
  assert.match(body, /parts\.length !== 3/,
    'a malformed room name is not rejected before its parts are used');
  assert.match(body, /!room\.is_dm/, 'a non-DM room would be treated as one');
});

test('every call site uses it', () => {
  // Four of them. One left as io.emit would leak exactly as much as all four.
  const uses = (code.match(/emitDmActivity\(/g) || []).length;
  assert.ok(uses >= 5, `only ${uses} references — a call site was missed`);
});

test('a junk room name emits nothing at all', () => {
  // The guard has to come before the ids are parsed, or a malformed name
  // sends to user:NaN — harmless, but it would mean the guard is decoration.
  const fn = code.slice(code.indexOf('function emitDmActivity'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const guard = body.indexOf('parts.length !== 3');
  const emit = body.indexOf("io.to('user:'");
  assert.ok(guard > 0 && emit > guard, 'the name is used before it is checked');
  assert.match(body, /if \(id\)/, 'an unparseable id is still emitted to');
});

let failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ok  ${n}`); }
  catch (e) { failed++; console.log(`  FAIL ${n}\n       ${e.message}`); }
}
if (failed) { console.log(`\n  ${failed} dm-privacy test(s) failed`); process.exit(1); }
console.log(`  ${tests.length} dm-privacy tests passed`);
