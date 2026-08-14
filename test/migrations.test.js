// Tests for db.js migrations, run across REAL process restarts.
//
// The bug this exists for: the membership backfills ran on every boot, so
// leaving a room worked until the next restart and then quietly undid itself.
// Deploys restart the service, so in practice a user who left a room found
// themselves back in it — with their own "left the room" notice as its last
// message. Catching that needs a second process, not a second function call:
// within one process the module is cached and the migration never re-runs.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tests = [];
const test = (n, f) => tests.push({ n, f });

/** Run a snippet with db.js loaded against `dbPath`; returns its stdout JSON. */
function inFreshProcess(dbPath, code) {
  const out = execFileSync(process.execPath, ['-e', `
    process.env.DB_PATH = ${JSON.stringify(dbPath)};
    const db = require(${JSON.stringify(path.join(ROOT, 'db.js'))});
    ${code}
  `], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const last = out.split('\n').filter(Boolean).pop() || '{}';
  return JSON.parse(last);
}

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migtest-'));
  return path.join(dir, 'chat.db');
}

test('leaving the default room survives a server restart', () => {
  const dbPath = freshDb();

  // A user in General, exactly as sign-up leaves them.
  inFreshProcess(dbPath, `
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('someone','x')").run();
    const g = db.prepare("SELECT id FROM rooms WHERE name='General'").get();
    const u = db.prepare("SELECT id FROM users WHERE username='someone'").get();
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?,?)').run(g.id, u.id);
    console.log(JSON.stringify({ ok: 1 }));
  `);

  // They leave.
  const afterLeave = inFreshProcess(dbPath, `
    const g = db.prepare("SELECT id FROM rooms WHERE name='General'").get();
    const u = db.prepare("SELECT id FROM users WHERE username='someone'").get();
    db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(g.id, u.id);
    const n = db.prepare('SELECT COUNT(*) c FROM room_members WHERE room_id=? AND user_id=?').get(g.id, u.id);
    console.log(JSON.stringify({ member: n.c }));
  `);
  assert.strictEqual(afterLeave.member, 0, 'the leave itself did not take effect');

  // The service restarts — a deploy, a crash, anything.
  const afterRestart = inFreshProcess(dbPath, `
    const g = db.prepare("SELECT id FROM rooms WHERE name='General'").get();
    const u = db.prepare("SELECT id FROM users WHERE username='someone'").get();
    const n = db.prepare('SELECT COUNT(*) c FROM room_members WHERE room_id=? AND user_id=?').get(g.id, u.id);
    console.log(JSON.stringify({ member: n.c }));
  `);
  assert.strictEqual(afterRestart.member, 0,
    'the restart put the user back into the room they had left');
});

test('leaving a public room you had posted in survives a restart', () => {
  const dbPath = freshDb();

  inFreshProcess(dbPath, `
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('poster','x')").run();
    const u = db.prepare("SELECT id FROM users WHERE username='poster'").get();
    db.prepare("INSERT INTO rooms (name, is_private) VALUES ('chatty', 0)").run();
    const r = db.prepare("SELECT id FROM rooms WHERE name='chatty'").get();
    // Having posted in the room is what the old backfill treated as membership.
    db.prepare("INSERT INTO messages (room_id, user_id, type, content) VALUES (?,?,'text','hi')").run(r.id, u.id);
    db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?,?)').run(r.id, u.id);
    db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(r.id, u.id);
    console.log(JSON.stringify({ ok: 1 }));
  `);

  const afterRestart = inFreshProcess(dbPath, `
    const u = db.prepare("SELECT id FROM users WHERE username='poster'").get();
    const r = db.prepare("SELECT id FROM rooms WHERE name='chatty'").get();
    const n = db.prepare('SELECT COUNT(*) c FROM room_members WHERE room_id=? AND user_id=?').get(r.id, u.id);
    console.log(JSON.stringify({ member: n.c }));
  `);
  assert.strictEqual(afterRestart.member, 0,
    'the restart re-added the user to a public room they had left');
});

test('the backfill still runs once, for accounts that predate membership', () => {
  // It must not become a no-op: an existing user who had posted in a public
  // room before membership existed still needs to be put in it — exactly once.
  const dbPath = freshDb();

  const first = inFreshProcess(dbPath, `
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('legacy','x')").run();
    const u = db.prepare("SELECT id FROM users WHERE username='legacy'").get();
    db.prepare("INSERT INTO rooms (name, is_private) VALUES ('old-room', 0)").run();
    const r = db.prepare("SELECT id FROM rooms WHERE name='old-room'").get();
    db.prepare("INSERT INTO messages (room_id, user_id, type, content) VALUES (?,?,'text','from before')").run(r.id, u.id);
    console.log(JSON.stringify({ ok: 1 }));
  `);
  assert.ok(first.ok);

  // The message was inserted AFTER this process had already migrated, so the
  // backfill has not seen it yet. A fresh process must not run it either —
  // the flag is set. This is the honest trade: the migration is one-shot.
  // What matters is that a NEW database gets it, which the next test covers.
  const second = inFreshProcess(dbPath, `
    const done = db.prepare("SELECT 1 x FROM schema_meta WHERE key='public_room_membership_backfill_v1'").get();
    console.log(JSON.stringify({ recorded: !!done }));
  `);
  assert.strictEqual(second.recorded, true, 'the migration was not recorded as done');
});

test('a database that has never been migrated still gets the backfill', () => {
  const dbPath = freshDb();
  // Build the legacy state with the migration flag pre-set to "not done" by
  // creating the rows in the same process that first opens the database is
  // impossible; instead, clear the flag and re-open, which is exactly what an
  // un-migrated database looks like.
  inFreshProcess(dbPath, `
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('legacy2','x')").run();
    const u = db.prepare("SELECT id FROM users WHERE username='legacy2'").get();
    db.prepare("INSERT INTO rooms (name, is_private) VALUES ('legacy-room', 0)").run();
    const r = db.prepare("SELECT id FROM rooms WHERE name='legacy-room'").get();
    db.prepare("INSERT INTO messages (room_id, user_id, type, content) VALUES (?,?,'text','old')").run(r.id, u.id);
    db.prepare("DELETE FROM schema_meta WHERE key='public_room_membership_backfill_v1'").run();
    console.log(JSON.stringify({ ok: 1 }));
  `);

  const migrated = inFreshProcess(dbPath, `
    const u = db.prepare("SELECT id FROM users WHERE username='legacy2'").get();
    const r = db.prepare("SELECT id FROM rooms WHERE name='legacy-room'").get();
    const n = db.prepare('SELECT COUNT(*) c FROM room_members WHERE room_id=? AND user_id=?').get(r.id, u.id);
    console.log(JSON.stringify({ member: n.c }));
  `);
  assert.strictEqual(migrated.member, 1,
    'an un-migrated database did not get the backfill it still needs');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
