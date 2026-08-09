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
db.exec(`
  CREATE TABLE IF NOT EXISTS room_reads (
    user_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    last_read_msg_id INTEGER DEFAULT 0,
    UNIQUE(user_id, room_id)
  );
`);

// Seed a default room
const existing = db.prepare('SELECT id FROM rooms WHERE name = ?').get('General');
if (!existing) {
  db.prepare('INSERT INTO rooms (name) VALUES (?)').run('General');
}

module.exports = db;
