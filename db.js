const Database = require('better-sqlite3');
const path = require('path');
const dbPath = process.env.DB_PATH || path.join(__dirname, 'chat.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_by INTEGER,
    is_dm INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    file_path TEXT,
    file_name TEXT,
    edited INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id, emoji),
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Migrations
try { db.exec('ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN created_by INTEGER'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN is_dm INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN avatar TEXT'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN is_private INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN forwarded_from TEXT'); } catch {}
// One-time (self-destructing) messages: seconds the message stays visible
// after first view, and when it was first viewed (ms since epoch).
try { db.exec('ALTER TABLE messages ADD COLUMN one_time_seconds INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN viewed_at INTEGER'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN played INTEGER DEFAULT 0'); } catch {}
// Disappearing messages: when a chat has the mode on, everything sent into it
// is stamped with the moment it should be destroyed. Distinct from
// one_time_seconds, which counts from when a message is OPENED — this counts
// from when it was sent, and applies to everyone's messages in the chat.
try { db.exec('ALTER TABLE messages ADD COLUMN expires_at INTEGER'); } catch {}
// The configured lifetime, recorded when the message is SENT; expires_at is
// only filled in once someone has actually seen it. Destroying a message the
// recipient never had a chance to read is not "disappearing", it is losing
// mail.
try { db.exec('ALTER TABLE messages ADD COLUMN disappear_seconds INTEGER'); } catch {}
try { db.exec('ALTER TABLE rooms ADD COLUMN disappearing_seconds INTEGER'); } catch {}
// One-time ("view once") messages, switched OFF for a whole chat.
//
// Asked for: either side of a chat can turn one-time and disappearing messages
// off for both sides. Disappearing was already mutual — it is one setting on
// the room and anyone in it may set it back to 0. One-time was not: it is
// chosen per message by whoever sends it, so the person on the receiving end
// of messages that burn after reading had no say at all. This column is that
// say: 1 means nobody in this chat may send one.
try { db.exec('ALTER TABLE rooms ADD COLUMN one_time_off INTEGER DEFAULT 0'); } catch {}
// How many times this account has changed its username. A username is how
// people find and address each other, so it is deliberately hard to churn.
try { db.exec('ALTER TABLE users ADD COLUMN username_changes INTEGER DEFAULT 0'); } catch {}
// ── Comments ────────────────────────────────────────────────────────────────
//
// A comment is an ordinary message with a parent. Everything a message can be
// — text, a photo, a voice note, a reply, a reaction on it — a comment can be
// too, because it IS one; nothing here is a second kind of row with a second
// set of rules to keep in step.
//
// Exactly one level deep, and that is enforced where comments are created: a
// message whose parent_id is set can never itself be a parent. A thread that
// can branch needs a tree to read it, and this is a chat.
try { db.exec('ALTER TABLE messages ADD COLUMN parent_id INTEGER'); } catch {}
// Every message list asks "how many comments does this have", and the comments
// screen asks "which are this message's" — both are this index.
try { db.exec('CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)'); } catch {}
// One-time backfill: voices sent before the played-status feature existed
// can never receive a voice_played event, so treat them as already played.
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
if (!db.prepare("SELECT value FROM meta WHERE key = 'voice_played_backfill'").get()) {
  db.prepare("UPDATE messages SET played = 1 WHERE type = 'audio'").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('voice_played_backfill', '1')").run();
}
// End-to-end encryption: the user's X25519 public key, plus their private key
// encrypted client-side with a password-derived key (the server can never
// read it) so the same identity works across web and mobile.
// Sent by somebody the recipient has blocked.
//
// The message is stored and shown to its AUTHOR — who sees it in a faded,
// unsent-looking style — but is never delivered to the person who blocked
// them. Refusing outright told the sender they had been blocked; this does
// not, while also never putting the message in front of someone who asked not
// to receive it.
try { db.exec('ALTER TABLE messages ADD COLUMN blocked_delivery INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN public_key TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN enc_priv TEXT'); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    UNIQUE(room_id, user_id)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS push_tokens (
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    platform TEXT
  );
`);
// Which service issued this token, because there are now two and their tokens
// are not interchangeable: a Najva subscriber token posted to Firebase is a
// rejected send, and an FCM token posted to Najva is the same in reverse.
//
// Added by migration rather than in the CREATE above, because every existing
// row predates Najva and is an FCM token — which is exactly what the default
// says. A table rebuilt from the CREATE alone on a fresh server would agree.
try {
  db.prepare("SELECT provider FROM push_tokens LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE push_tokens ADD COLUMN provider TEXT NOT NULL DEFAULT 'fcm'");
}
// Browsers — including an iPhone running this as a home-screen app, which is
// the only way an iPhone can have this app at all. One row per browser, keyed
// by the endpoint the push service gave it.
db.exec(`
  CREATE TABLE IF NOT EXISTS web_push_subs (
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// ── Blocking, muting, and clearing history ───────────────────────────────────
//
// All three are decisions ONE person makes about another, so all three are
// keyed by the person who made them rather than stored on the target.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(blocker_id, blocked_id)
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS user_mutes (
    user_id INTEGER NOT NULL,
    muted_id INTEGER NOT NULL,
    UNIQUE(user_id, muted_id)
  );
`);
// Muting a ROOM, which is a different thing from muting each of its members.
//
// A busy group is the one chat somebody actually wants quiet, and until now it
// was the only one they could not silence: user_mutes is per person, so a room
// of ten needed ten mutes and still made a noise when an eleventh joined.
//
// Like a person mute, this stops the NOTIFICATION and nothing else. The
// messages still arrive, the chat still shows them, and they are still counted
// as unread — a mute that hid messages would be a block wearing another name.
db.exec(`
  CREATE TABLE IF NOT EXISTS room_mutes (
    user_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    UNIQUE(user_id, room_id)
  );
`);
// "Clear for me" cannot delete anything — the other person's copy is theirs.
// So it records a HIGH-WATER MARK instead: everything up to and including this
// message id is hidden from this user, in this room, everywhere it would
// otherwise be read. A later message simply has a higher id and reappears
// normally, which is what makes the chat come back on its own when the
// conversation resumes.
db.exec(`
  CREATE TABLE IF NOT EXISTS room_clears (
    user_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    cleared_upto_id INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, room_id)
  );
`);
// One message, hidden from one person.
//
// Asked for as: add delete to the other side's message, but the delete is just
// for me.
//
// Deleting a message you did not write cannot mean what Delete has always
// meant here — `delete_message` removes it from the conversation for everyone,
// and one person quietly deleting another person's words out of a chat is not
// a feature. So it means this instead: the message stays exactly where it is
// for the person who sent it, and disappears from the asker's copy.
//
// Server-side rather than a list kept on the phone, for the same reason
// room_clears is: these users reinstall the app often and sign in on more than
// one device, and a message they deliberately got rid of coming back on the
// next install is precisely the kind of thing that gets reported as a bug.
//
// A row per message rather than room_clears' high-water mark, because this is
// not "everything up to here" — it is one message out of the middle, with the
// ones around it untouched.
db.exec(`
  CREATE TABLE IF NOT EXISTS hidden_messages (
    user_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    UNIQUE(user_id, message_id)
  );
`);
// Every message query filters on this, so it has to be a lookup rather than a
// scan of everything anybody has ever hidden.
db.exec('CREATE INDEX IF NOT EXISTS idx_hidden_user ON hidden_messages(user_id, message_id)');

// ── Who opened a one-time message, PER PERSON ───────────────────────────────
//
// Reported as: in a room, a one-time message disappears after the first
// member opens it, and nobody else ever sees it.
//
// That is exactly what the old design did. messages.viewed_at is a single
// column on the message, so the first person to open it started one global
// timer and the message was destroyed for every other member — including the
// ones it had never been shown to. Harmless in a DM, where there is only one
// recipient. Wrong in every room with three people in it.
//
// So the view is recorded per member. Each person's countdown starts when
// THEY open it, and the message is only destroyed once there is nobody left
// who could still see it.
db.exec(`
  CREATE TABLE IF NOT EXISTS message_views (
    message_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    viewed_at INTEGER NOT NULL,
    UNIQUE(message_id, user_id)
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_views_msg ON message_views(message_id)');

// ── When each read mark was set, so "seen by" can give a TIME ───────────────
//
// room_reads holds only how far each member has read — one row per member per
// room, overwritten as they read on. That answers "who has seen this message"
// but cannot answer "when", because by the time you ask, the row has moved on
// to a later message and carries no history.
//
// This keeps the marks as they were set: one row each time a member's read
// position advances. "When did X see message N" is then the earliest row for
// X in that room whose upto_msg_id reached N — an actual answer rather than
// the time of their most recent read, which is what a single timestamp column
// would have given and would have been wrong for every older message.
//
// Pruned, because it grows with reading rather than with messages: see
// pruneReadMarks in server.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS read_marks (
    user_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    upto_msg_id INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_marks_room ON read_marks(room_id, upto_msg_id)');
db.exec(`
  CREATE TABLE IF NOT EXISTS room_reads (
    user_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    last_read_msg_id INTEGER DEFAULT 0,
    UNIQUE(user_id, room_id)
  );
`);
// How far each user has read each THREAD.
//
// Comments are messages, so they counted towards a room's unread badge — but
// the position that clears that badge is advanced from the chat's own message
// list, which never contains a comment. So a comment's id stayed above the
// read mark for good and the badge could never go away. Reported exactly that
// way: the number on the chat list does not clear.
//
// Keyed by the PARENT rather than the room: a thread is read by opening it,
// and reading one says nothing about the others.
db.exec(`
  CREATE TABLE IF NOT EXISTS comment_reads (
    user_id INTEGER NOT NULL,
    parent_id INTEGER NOT NULL,
    last_read_msg_id INTEGER DEFAULT 0,
    UNIQUE(user_id, parent_id)
  );
`);

// ── One-time migrations ──────────────────────────────────────────────────────
//
// A "backfill" that runs on every boot is not a backfill, it is a policy. The
// two below re-added people to rooms every single time the process started, so
// leaving a room worked until the next restart — and with deploys restarting
// the service, a user who left a room found themselves back in it, its last
// message being their own "left the room" notice.
//
// They are now recorded as done, so they fix existing accounts exactly once and
// never touch anyone again.
db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)`);
function once(key, fn) {
  const done = db.prepare('SELECT 1 FROM schema_meta WHERE key = ?').get(key);
  if (done) return;
  fn();
  db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
    .run(key, new Date().toISOString());
}

// Backfill membership for public rooms.
//
// Public rooms used to have no membership at all — every account implicitly
// belonged to every one of them. Now that membership is explicit (so the room
// list shows only your own rooms, and messages only reach members), anyone who
// had already been using a public room would silently lose it. Treat having
// posted in a room, or having created it, as membership.
try {
  once('public_room_membership_backfill_v1', () => {
    db.exec(`
      INSERT OR IGNORE INTO room_members (room_id, user_id)
      SELECT DISTINCT m.room_id, m.user_id
      FROM messages m
      JOIN rooms r ON r.id = m.room_id
      WHERE r.is_dm = 0 AND r.is_private = 0
    `);
    db.exec(`
      INSERT OR IGNORE INTO room_members (room_id, user_id)
      SELECT r.id, r.created_by FROM rooms r
      WHERE r.is_dm = 0 AND r.created_by IS NOT NULL
    `);
  });
} catch (err) {
  console.error('[migration] public room membership backfill:', err.message);
}

// Seed a default room
const existing = db.prepare('SELECT id FROM rooms WHERE name = ?').get('General');
if (!existing) {
  db.prepare('INSERT INTO rooms (name) VALUES (?)').run('General');
}

// 'General' is the landing room and has no creator, so the backfill above
// would leave it memberless and it would vanish from everybody's list. Every
// existing account belongs to it; new accounts are added on sign-up.
try {
  once('default_room_membership_v1', () => {
    const general = db.prepare('SELECT id FROM rooms WHERE name = ?').get('General');
    if (general) {
      db.exec(`
        INSERT OR IGNORE INTO room_members (room_id, user_id)
        SELECT ${general.id}, id FROM users
      `);
    }
  });
} catch (err) {
  console.error('[migration] default room membership:', err.message);
}

module.exports = db;
