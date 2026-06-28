# ChatRoom

A lightweight real-time chat application inspired by Telegram/WhatsApp. Built with Node.js, Socket.IO, and SQLite — no build step required.

## Features

- **Real-time messaging** — instant delivery via WebSockets
- **Audio messages** — hold the mic button to record, release to send
- **File & image sharing** — attach any file up to 20MB; images preview inline
- **Multiple rooms** — create and join named chat rooms
- **Persistent history** — last 50 messages reload from SQLite on room join
- **Authentication** — register/login with username & password (JWT-based)
- **Online presence** — see when users join or leave a room

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Real-time | Socket.IO |
| Database | SQLite via `better-sqlite3` |
| Auth | bcrypt + JSON Web Tokens |
| Frontend | Vanilla JS + HTML/CSS (no framework) |
| File storage | Local disk (`uploads/` folder) |

## Getting Started

### Prerequisites

- Node.js 16 or higher

### Install & Run

```bash
npm install
node server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Custom Port

```bash
PORT=8080 node server.js
```

## Project Structure

```
room/
├── server.js          # Express + Socket.IO server
├── db.js              # SQLite schema and seed
├── public/
│   ├── index.html     # Single-page UI
│   ├── css/style.css  # Dark theme styles
│   └── js/app.js      # Client-side logic
└── uploads/           # Uploaded files and audio
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Create a new account |
| POST | `/auth/login` | Login and get JWT |
| GET | `/rooms` | List all rooms |
| POST | `/rooms` | Create a new room |
| GET | `/messages/:roomId` | Fetch last 50 messages |
| POST | `/upload` | Upload a file (multipart) |

## Socket Events

| Event | Direction | Description |
|---|---|---|
| `join_room` | Client → Server | Join a chat room |
| `send_message` | Client → Server | Send a message |
| `message_received` | Server → Client | New message broadcast |
| `user_online` | Server → Client | User joined room |
| `user_offline` | Server → Client | User left room |
| `room_created` | Server → Client | New room broadcast |

## Database Schema

```sql
users    (id, username, password_hash, created_at)
rooms    (id, name, created_at)
messages (id, room_id, user_id, type, content, file_path, file_name, created_at)
```

Message `type` is one of: `text`, `audio`, `image`, `file`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `JWT_SECRET` | `chat_secret_key_change_in_prod` | JWT signing secret — **change in production** |
