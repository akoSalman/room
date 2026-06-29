const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'chat_secret_key_change_in_prod';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Auth
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET);
    res.json({ token, username });
  } catch {
    res.status(409).json({ error: 'Username already taken' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username }, JWT_SECRET);
  res.json({ token, username });
});

// Profile update
app.put('/profile', authMiddleware, async (req, res) => {
  const { newUsername, currentPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (currentPassword) {
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  }

  if (newUsername && newUsername !== user.username) {
    const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, req.user.id);
    if (taken) return res.status(409).json({ error: 'Username already taken' });
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(newUsername, req.user.id);
  }

  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required to set new password' });
    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const token = jwt.sign({ id: updated.id, username: updated.username }, JWT_SECRET);
  res.json({ token, username: updated.username });
});

// Rooms
app.get('/rooms', authMiddleware, (req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY name').all();
  res.json(rooms);
});

app.post('/rooms', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  try {
    const result = db.prepare('INSERT INTO rooms (name) VALUES (?)').run(name.trim());
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(result.lastInsertRowid);
    io.emit('room_created', room);
    res.json(room);
  } catch {
    res.status(409).json({ error: 'Room already exists' });
  }
});

// Messages
app.get('/messages/:roomId', authMiddleware, (req, res) => {
  const messages = db.prepare(`
    SELECT m.*, u.username FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.room_id = ?
    ORDER BY m.created_at DESC LIMIT 50
  `).all(req.params.roomId);
  res.json(messages.reverse());
});

// Reactions
app.get('/reactions/:messageId', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT r.emoji, u.username, r.user_id FROM reactions r
    JOIN users u ON r.user_id = u.id
    WHERE r.message_id = ?
  `).all(req.params.messageId);
  res.json(rows);
});

// Upload
app.post('/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    mimetype: req.file.mimetype
  });
});

// Socket.IO
const onlineUsers = new Map(); // socketId -> { userId, username, roomId }

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.on('join_room', (roomId) => {
    const prev = onlineUsers.get(socket.id);
    if (prev?.roomId) {
      socket.leave(prev.roomId);
      // update online list for old room
      const oldOnline = [...onlineUsers.values()]
        .filter(u => u.roomId === prev.roomId && u.username !== socket.user.username)
        .map(u => u.username);
      io.to(prev.roomId).emit('room_online', { users: oldOnline });
    }
    onlineUsers.set(socket.id, { userId: socket.user.id, username: socket.user.username, roomId: String(roomId) });
    socket.join(String(roomId));
    // send full online list to everyone in the room
    const roomOnline = [...onlineUsers.values()]
      .filter(u => u.roomId === String(roomId))
      .map(u => u.username);
    io.to(String(roomId)).emit('room_online', { users: roomOnline });
  });

  socket.on('send_message', (data) => {
    const { roomId, type, content, filePath, fileName } = data;
    const result = db.prepare(`
      INSERT INTO messages (room_id, user_id, type, content, file_path, file_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(roomId, socket.user.id, type || 'text', content || null, filePath || null, fileName || null);

    const msg = db.prepare(`
      SELECT m.*, u.username FROM messages m
      JOIN users u ON m.user_id = u.id WHERE m.id = ?
    `).get(result.lastInsertRowid);

    io.to(String(roomId)).emit('message_received', msg);
  });

  socket.on('typing_start', ({ roomId }) => {
    socket.to(String(roomId)).emit('user_typing', { username: socket.user.username });
  });

  socket.on('typing_stop', ({ roomId }) => {
    socket.to(String(roomId)).emit('user_stopped_typing', { username: socket.user.username });
  });

  socket.on('edit_message', ({ messageId, content }) => {
    if (!content || !content.trim()) return;
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg || msg.type !== 'text') return;
    db.prepare('UPDATE messages SET content = ?, edited = 1 WHERE id = ?').run(content.trim(), messageId);
    io.to(String(msg.room_id)).emit('message_edited', { messageId, content: content.trim() });
  });

  socket.on('delete_message', ({ messageId }) => {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg) return;
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
    db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    io.to(String(msg.room_id)).emit('message_deleted', { messageId });
  });

  socket.on('toggle_reaction', ({ messageId, emoji }) => {
    const existing = db.prepare(
      'SELECT id FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
    ).get(messageId, socket.user.id, emoji);

    if (existing) {
      db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
    } else {
      db.prepare(
        'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)'
      ).run(messageId, socket.user.id, emoji);
    }

    const reactions = db.prepare(`
      SELECT r.emoji, u.username, r.user_id FROM reactions r
      JOIN users u ON r.user_id = u.id WHERE r.message_id = ?
    `).all(messageId);

    // Find the roomId for this message
    const msg = db.prepare('SELECT room_id FROM messages WHERE id = ?').get(messageId);
    if (msg) io.to(String(msg.room_id)).emit('reactions_updated', { messageId, reactions });
  });

  socket.on('disconnect', () => {
    const info = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (info?.roomId) {
      const roomOnline = [...onlineUsers.values()]
        .filter(u => u.roomId === info.roomId)
        .map(u => u.username);
      io.to(info.roomId).emit('room_online', { users: roomOnline });
    }
  });
});

server.listen(PORT, () => console.log(`Chat server running on http://localhost:${PORT}`));
