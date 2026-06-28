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
      io.to(prev.roomId).emit('user_offline', { username: socket.user.username });
    }
    onlineUsers.set(socket.id, { userId: socket.user.id, username: socket.user.username, roomId: String(roomId) });
    socket.join(String(roomId));
    io.to(String(roomId)).emit('user_online', { username: socket.user.username });
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

  socket.on('disconnect', () => {
    const info = onlineUsers.get(socket.id);
    if (info?.roomId) {
      io.to(info.roomId).emit('user_offline', { username: info.username });
    }
    onlineUsers.delete(socket.id);
  });
});

server.listen(PORT, () => console.log(`Chat server running on http://localhost:${PORT}`));
