let token = localStorage.getItem('token');
let username = localStorage.getItem('username');
let currentRoomId = null;
let socket = null;
let socketReady = false;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recTimerInterval = null;
let recSeconds = 0;
let recAnalyser = null;
let recAnimFrame = null;
let recAudioCtx = null;
let previewAudio = null;
let previewWaveformPeaks = [];
let recordedBlob = null;
let recordedMime = '';
let pickerTarget = null;
let editingMsgId = null;
let ctxTarget = null;
let editingRoomId = null;

let typingTimer = null;
let isTyping = false;
const typingUsers = new Set();
let replyTo = null; // { id, username, content, type }

let onlineUsers = [];
const unreadCounts = {};
let dmDividerInserted = false;

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const t of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','🤔','😍','👎','😡'];

// ─── Boot ─────────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}
function showNotif(msg) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && String(msg.room_id) === String(currentRoomId)) return;
  const body = msg.type === 'text' ? (msg.content || '') : msg.type === 'audio' ? '🎙 Voice message' : msg.type === 'image' ? '🖼 Image' : '📄 File';
  new Notification(msg.username, { body, icon: '/icons/icon-192.png', tag: 'chatroom-' + msg.room_id, silent: false });
}

window.addEventListener('DOMContentLoaded', () => {
  buildEmojiPicker();
  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
  // Prevent document-level scroll from touch gestures on mobile
  document.addEventListener('touchmove', e => {
    if (e.target.closest('#messages, #room-list, .modal-overlay, #online-panel')) return;
    e.preventDefault();
  }, { passive: false });
  if (token && username) { enterApp(); requestNotifPermission(); }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function signin() {
  const user = document.getElementById('auth-user').value.trim();
  const pass = document.getElementById('auth-pass').value;
  if (!user || !pass) return showAuthError('Please enter username and password');
  const btn = document.getElementById('auth-btn');
  btn.disabled = true; btn.textContent = 'Please wait…';
  document.getElementById('auth-error').textContent = '';
  try {
    const res = await api('/auth/signin', 'POST', { username: user, password: pass });
    if (res.error) return showAuthError(res.error);
    saveSession(res.token, res.username);
    enterApp();
  } catch { showAuthError('Connection error — is the server running?'); }
  finally { btn.disabled = false; btn.textContent = 'Continue →'; }
}

function saveSession(t, u) {
  token = t; username = u;
  localStorage.setItem('token', t);
  localStorage.setItem('username', u);
}
function showAuthError(msg) { document.getElementById('auth-error').textContent = msg; }

function logout() {
  localStorage.clear(); token = null; username = null; currentRoomId = null; socketReady = false;
  if (socket) { socket.disconnect(); socket = null; }
  closeProfile();
  document.body.classList.remove('in-app');
  show('auth-screen'); hide('app-screen');
}

// ─── App ──────────────────────────────────────────────────────────────────────
async function enterApp() {
  show('app-screen'); hide('auth-screen');
  document.body.classList.add('in-app');
  dmDividerInserted = false;
  setAvatarInitials(username);
  document.getElementById('current-user-display').textContent = username;
  requestNotifPermission();
  await connectSocket();
  await loadRooms();
  await loadDMRooms();
}

function setAvatarInitials(name) {
  const initials = (name || '?').slice(0, 2).toUpperCase();
  const sa = document.getElementById('sidebar-avatar');
  const pb = document.getElementById('profile-avatar-big');
  if (sa) sa.textContent = initials;
  if (pb) pb.textContent = initials;
  const pd = document.getElementById('profile-name-display');
  if (pd) pd.textContent = name;
}

function connectSocket() {
  return new Promise((resolve) => {
    if (socket) socket.disconnect();
    socket = io({ auth: { token }, reconnectionAttempts: 10 });

    socket.once('connect', () => { socketReady = true; hideConnectionBanner(); resolve(); });

    socket.on('connect', () => { socketReady = true; hideConnectionBanner(); });
    socket.on('disconnect', () => { socketReady = false; showConnectionBanner(); });
    socket.on('reconnecting', () => showConnectionBanner());
    socket.on('reconnect', () => { socketReady = true; hideConnectionBanner(); });
    socket.on('connect_error', (err) => {
      showConnectionBanner();
      if (err.message === 'Unauthorized') logout();
    });

    socket.on('message_received', (msg) => {
      showNotif(msg);
      if (String(msg.room_id) !== String(currentRoomId)) {
        unreadCounts[msg.room_id] = (unreadCounts[msg.room_id] || 0) + 1;
        updateUnreadBadge(msg.room_id);
      } else {
        appendMessage(msg);
      }
    });
    socket.on('message_edited', ({ messageId, content }) => applyEdit(messageId, content));
    socket.on('message_deleted', ({ messageId }) => applyDelete(messageId));
    socket.on('reactions_updated', ({ messageId, reactions }) => renderReactions(messageId, reactions));
    socket.on('room_online', ({ users }) => updateOnlineUsers(users));
    socket.on('room_created', (room) => addRoomToList(room));
    socket.on('room_deleted', ({ roomId }) => removeRoomFromList(roomId));
    socket.on('room_updated', (room) => updateRoomInList(room));
    socket.on('user_typing', ({ username: u }) => showTyping(u));
    socket.on('user_stopped_typing', ({ username: u }) => hideTyping(u));
    socket.on('dm_activity', ({ room }) => ensureDMInSidebar(room));
  });
}

// ─── Connection banner ────────────────────────────────────────────────────────
function showConnectionBanner() { show('connection-banner'); }
function hideConnectionBanner() { hide('connection-banner'); }

// ─── Unread badges ────────────────────────────────────────────────────────────
function updateUnreadBadge(roomId) {
  const li = document.querySelector(`[data-room-id="${roomId}"]`);
  if (!li) return;
  let badge = li.querySelector('.unread-badge');
  const count = unreadCounts[roomId] || 0;
  if (count === 0) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'unread-badge';
    li.appendChild(badge);
  }
  badge.textContent = count > 99 ? '99+' : count;
}

function clearUnread(roomId) {
  delete unreadCounts[roomId];
  updateUnreadBadge(roomId);
}

// ─── Typing ───────────────────────────────────────────────────────────────────
function onTypingInput() {
  if (!currentRoomId || !socketReady) return;
  if (!isTyping) { isTyping = true; socket.emit('typing_start', { roomId: currentRoomId }); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { isTyping = false; socket.emit('typing_stop', { roomId: currentRoomId }); }, 1500);
}

function showTyping(user) { typingUsers.add(user); renderTypingBar(); }
function hideTyping(user) { typingUsers.delete(user); renderTypingBar(); }
function renderTypingBar() {
  const bar = document.getElementById('typing-bar');
  if (typingUsers.size === 0) { bar.classList.add('hidden'); return; }
  const names = [...typingUsers];
  const text = names.length === 1 ? `${names[0]} is typing`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
    : `${names[0]} and ${names.length - 1} others are typing`;
  bar.innerHTML = `<span>${text}</span><span class="typing-dots"><span></span><span></span><span></span></span>`;
  bar.classList.remove('hidden');
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar').classList.remove('collapsed');
  document.getElementById('sidebar-overlay').classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}
function collapseSidebar() {
  document.getElementById('sidebar').classList.add('collapsed');
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
  document.getElementById('collapse-btn').textContent = '›';
}
function expandSidebar() {
  document.getElementById('sidebar').classList.remove('collapsed');
  document.getElementById('collapse-btn').textContent = '‹';
}
function toggleSidebar() {
  document.getElementById('sidebar').classList.contains('collapsed') ? expandSidebar() : collapseSidebar();
}
function isMobile() { return window.innerWidth <= 640; }

// ─── Profile ──────────────────────────────────────────────────────────────────
function openProfile() {
  if (document.getElementById('sidebar').classList.contains('collapsed')) return;
  document.getElementById('prof-username').value = '';
  document.getElementById('prof-cur-pass').value = '';
  document.getElementById('prof-new-pass').value = '';
  document.getElementById('profile-error').textContent = '';
  document.getElementById('profile-success').textContent = '';
  setAvatarInitials(username);
  loadMyRooms();
  show('profile-modal');
}

async function loadMyRooms() {
  const rooms = await api('/rooms');
  const list = document.getElementById('my-rooms-list');
  list.innerHTML = '';
  const myId = getUserId();
  const mine = Array.isArray(rooms) ? rooms.filter(r => String(r.created_by) === String(myId)) : [];
  if (!mine.length) {
    const li = document.createElement('li');
    li.className = 'my-room-empty';
    li.textContent = 'No rooms created yet';
    list.appendChild(li);
    return;
  }
  mine.forEach(r => {
    const li = document.createElement('li');
    li.className = 'my-room-item';
    const name = document.createElement('span');
    name.className = 'my-room-name';
    name.textContent = '# ' + r.name;
    const editBtn = document.createElement('button');
    editBtn.className = 'room-action-btn';
    editBtn.textContent = '✏️';
    editBtn.title = 'Rename';
    editBtn.onclick = () => { closeProfile(); openRoomEdit(r.id, r.name); };
    const delBtn = document.createElement('button');
    delBtn.className = 'room-action-btn del';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete';
    delBtn.onclick = () => { closeProfile(); confirmDeleteRoom(r.id, r.name); };
    li.appendChild(name);
    li.appendChild(editBtn);
    li.appendChild(delBtn);
    list.appendChild(li);
  });
}
function closeProfile() { hide('profile-modal'); }

async function saveProfile() {
  const newUsername = document.getElementById('prof-username').value.trim();
  const currentPassword = document.getElementById('prof-cur-pass').value;
  const newPassword = document.getElementById('prof-new-pass').value;
  document.getElementById('profile-error').textContent = '';
  document.getElementById('profile-success').textContent = '';
  if (!newUsername && !newPassword)
    return document.getElementById('profile-error').textContent = 'Nothing to update';
  if (!currentPassword)
    return document.getElementById('profile-error').textContent = 'Current password is required';
  const res = await api('/profile', 'PUT', { newUsername: newUsername || undefined, currentPassword, newPassword: newPassword || undefined });
  if (res.error) { document.getElementById('profile-error').textContent = res.error; return; }
  saveSession(res.token, res.username);
  username = res.username;
  setAvatarInitials(res.username);
  document.getElementById('current-user-display').textContent = res.username;
  document.getElementById('prof-cur-pass').value = '';
  document.getElementById('prof-new-pass').value = '';
  document.getElementById('prof-username').value = '';
  document.getElementById('profile-success').textContent = 'Profile updated successfully';
}

// ─── Rooms ────────────────────────────────────────────────────────────────────
async function loadRooms() {
  const rooms = await api('/rooms');
  if (!Array.isArray(rooms)) return;
  document.getElementById('room-list').innerHTML = '';
  dmDividerInserted = false;
  rooms.forEach(addRoomToList);
  const general = rooms.find(r => r.name === 'General') || rooms[0];
  if (general) {
    const li = document.querySelector(`[data-room-id="${general.id}"]`);
    if (li) { await joinRoom(general.id, general.name, li); collapseSidebar(); }
  }
}

function addRoomToList(room) {
  if (document.querySelector(`[data-room-id="${room.id}"]`)) return;
  const li = document.createElement('li');
  li.dataset.roomId = room.id;
  li.title = room.name;

  const icon = document.createElement('span');
  icon.className = 'room-icon'; icon.textContent = '#';

  const label = document.createElement('span');
  label.className = 'room-label'; label.textContent = room.name;

  li.appendChild(icon);
  li.appendChild(label);

  li.onclick = () => { joinRoom(room.id, room.name, li); isMobile() ? closeSidebar() : collapseSidebar(); };
  document.getElementById('room-list').appendChild(li);
}

function isRoomOwner(room) {
  return room.created_by && String(room.created_by) === String(getUserId());
}
function getUserId() {
  if (!token) return null;
  try { return JSON.parse(atob(token.split('.')[1])).id; } catch { return null; }
}

function removeRoomFromList(roomId) {
  document.querySelector(`[data-room-id="${roomId}"]`)?.remove();
  if (currentRoomId === roomId) {
    currentRoomId = null;
    document.getElementById('room-title').textContent = 'Select a room';
    document.getElementById('messages').innerHTML = '';
  }
}
function updateRoomInList(room) {
  const li = document.querySelector(`[data-room-id="${room.id}"]`);
  if (!li) return;
  const label = li.querySelector('.room-label');
  if (label) label.textContent = room.name;
  li.title = room.name;
  if (currentRoomId === room.id) document.getElementById('room-title').textContent = '# ' + room.name;
}

async function createRoom() {
  const input = document.getElementById('new-room-name');
  const name = input.value.trim();
  if (!name) return;
  const res = await api('/rooms', 'POST', { name });
  if (res.error) return alert(res.error);
  input.value = '';
}

// ─── Room edit/delete ────────────────────────────────────────────────────────
function openRoomEdit(roomId, currentName) {
  editingRoomId = roomId;
  document.getElementById('room-edit-name').value = currentName;
  document.getElementById('room-edit-error').textContent = '';
  show('room-edit-modal');
}
function closeRoomEdit() { editingRoomId = null; hide('room-edit-modal'); }
function saveRoomEdit() {
  const name = document.getElementById('room-edit-name').value.trim();
  if (!name || !editingRoomId) return;
  socket.emit('edit_room', { roomId: editingRoomId, name });
  closeRoomEdit();
}
function confirmDeleteRoom(roomId, roomName) {
  if (!confirm(`Delete room "${roomName}"? All messages will be lost.`)) return;
  socket.emit('delete_room', { roomId });
}

// ─── DM rooms ────────────────────────────────────────────────────────────────
async function loadDMRooms() {
  const rooms = await api('/dm-rooms');
  if (!Array.isArray(rooms)) return;
  rooms.forEach(r => addDMToSidebar(r, r.other_username));
}

function ensureDMDivider() {
  if (dmDividerInserted) return;
  dmDividerInserted = true;
  const d = document.createElement('li');
  d.className = 'dm-divider'; d.id = 'dm-divider'; d.textContent = 'Direct Messages';
  document.getElementById('room-list').appendChild(d);
}

function addDMToSidebar(room, otherUsername) {
  if (!otherUsername || document.querySelector(`[data-room-id="${room.id}"]`)) return;
  ensureDMDivider();
  const li = document.createElement('li');
  li.dataset.roomId = room.id; li.dataset.isDm = '1'; li.title = otherUsername;
  const icon = document.createElement('span'); icon.className = 'room-icon'; icon.textContent = '👤';
  const label = document.createElement('span'); label.className = 'room-label'; label.textContent = otherUsername;
  li.appendChild(icon); li.appendChild(label);
  li.onclick = () => { joinRoom(room.id, otherUsername, li, true); isMobile() ? closeSidebar() : collapseSidebar(); };
  document.getElementById('room-list').appendChild(li);
}

function ensureDMInSidebar(room) {
  if (document.querySelector(`[data-room-id="${room.id}"]`)) return;
  api('/dm-rooms').then(rooms => {
    if (!Array.isArray(rooms)) return;
    const found = rooms.find(r => r.id === room.id);
    if (found) addDMToSidebar(found, found.other_username);
  });
}

async function openDM(otherUsername) {
  closeOnlinePanel();
  const users = await api('/users');
  if (!Array.isArray(users)) return;
  const other = users.find(u => u.username === otherUsername);
  if (!other) return;
  const res = await api('/dm/' + other.id, 'POST');
  if (res.error) return alert(res.error);
  addDMToSidebar(res, res.otherUsername || otherUsername);
  const li = document.querySelector(`[data-room-id="${res.id}"]`);
  if (li) { joinRoom(res.id, res.otherUsername || otherUsername, li, true); isMobile() ? closeSidebar() : collapseSidebar(); }
}

async function joinRoom(roomId, roomName, li, isDM = false) {
  if (currentRoomId === roomId) return;
  cancelEdit(); stopTypingSignal();
  if (isRecording) stopRecording();
  typingUsers.clear(); renderTypingBar();
  currentRoomId = roomId;
  clearUnread(roomId);
  document.querySelectorAll('#room-list li').forEach(el => el.classList.remove('active'));
  li.classList.add('active');
  document.getElementById('room-title').textContent = (isDM ? '💬 ' : '# ') + roomName;
  document.getElementById('messages').innerHTML = '';
  document.getElementById('online-indicator').classList.add('hidden');
  socket.emit('join_room', roomId);
  const msgs = await api('/messages/' + roomId);
  if (Array.isArray(msgs)) msgs.forEach(appendMessage);
  scrollBottom();
}

// ─── Online users ─────────────────────────────────────────────────────────────
function updateOnlineUsers(users) {
  onlineUsers = users;
  const badge = document.getElementById('online-indicator');
  if (!users.length) { badge.classList.add('hidden'); return; }
  badge.classList.remove('hidden');
  badge.textContent = `● ${users.length} online`;
  if (!document.getElementById('online-panel').classList.contains('hidden')) renderOnlinePanel();
}
function toggleOnlinePanel() {
  document.getElementById('online-panel').classList.contains('hidden') ? openOnlinePanel() : closeOnlinePanel();
}
function openOnlinePanel() { renderOnlinePanel(); show('online-panel'); }
function closeOnlinePanel() { hide('online-panel'); }
function renderOnlinePanel() {
  const ul = document.getElementById('online-list');
  ul.innerHTML = '';
  onlineUsers.forEach(u => {
    const li = document.createElement('li');
    li.textContent = u;
    if (u !== username) { li.title = `Message ${u}`; li.onclick = () => openDM(u); }
    ul.appendChild(li);
  });
}

// ─── Messaging ────────────────────────────────────────────────────────────────
function handleInputKey(e) { if (e.key === 'Enter') sendOrSave(); }
function sendOrSave() { editingMsgId ? saveEdit() : sendText(); }

// ─── Reply ────────────────────────────────────────────────────────────────────
function setReply(msg) {
  replyTo = { id: msg.id, username: msg.username, content: msg.content, type: msg.type };
  document.getElementById('reply-bar-user').textContent = msg.username;
  const preview = msg.type === 'text' ? (msg.content || '').slice(0, 60) : msg.type === 'audio' ? '🎙 Voice message' : msg.type === 'image' ? '🖼 Image' : '📄 File';
  document.getElementById('reply-bar-text').textContent = preview;
  show('reply-bar');
  document.getElementById('msg-input').focus();
}
function cancelReply() { replyTo = null; hide('reply-bar'); }

function sendText() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !currentRoomId || !socketReady) return;
  stopTypingSignal();
  socket.emit('send_message', { roomId: currentRoomId, type: 'text', content, replyToId: replyTo?.id || null });
  input.value = '';
  cancelReply();
}

function stopTypingSignal() {
  if (isTyping) {
    isTyping = false; clearTimeout(typingTimer);
    if (currentRoomId) socket.emit('typing_stop', { roomId: currentRoomId });
  }
}

// ─── Edit ─────────────────────────────────────────────────────────────────────
function startEdit(messageId) {
  const bubble = document.querySelector(`[data-msg-id="${messageId}"] .msg-bubble`);
  if (!bubble) return;
  editingMsgId = messageId;
  const input = document.getElementById('msg-input');
  input.value = bubble.dataset.text || bubble.textContent.replace('(edited)', '').trim();
  input.focus(); show('edit-banner');
}
function saveEdit() {
  const content = document.getElementById('msg-input').value.trim();
  if (!content || !editingMsgId) return;
  socket.emit('edit_message', { messageId: editingMsgId, content });
  cancelEdit();
}
function cancelEdit() {
  editingMsgId = null;
  document.getElementById('msg-input').value = '';
  hide('edit-banner');
}
function applyEdit(messageId, content) {
  const wrapper = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!wrapper) return;
  const bubble = wrapper.querySelector('.msg-bubble');
  bubble.dataset.text = content;
  const tag = bubble.querySelector('.edited-tag');
  bubble.textContent = content;
  if (tag) bubble.appendChild(tag);
  else { const t = document.createElement('span'); t.className = 'edited-tag'; t.textContent = '(edited)'; bubble.appendChild(t); }
}

// ─── Delete ───────────────────────────────────────────────────────────────────
function applyDelete(messageId) { document.querySelector(`[data-msg-id="${messageId}"]`)?.remove(); }
function confirmDelete(messageId) {
  if (!confirm('Delete this message?')) return;
  socket.emit('delete_message', { messageId });
}

// ─── File / Audio ─────────────────────────────────────────────────────────────
async function sendFile() {
  const file = document.getElementById('file-input').files[0];
  if (!file || !currentRoomId) return;
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form }).then(r => r.json());
  if (res.error) return alert(res.error);
  const type = file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : 'file';
  socket.emit('send_message', { roomId: currentRoomId, type, content: null, filePath: res.url, fileName: res.name || file.name, replyToId: replyTo?.id || null });
  cancelReply();
  document.getElementById('file-input').value = '';
}

// ─── Recording ────────────────────────────────────────────────────────────────

async function startRecording() {
  if (!currentRoomId) return;
  if (!navigator.mediaDevices?.getUserMedia) return alert('Audio recording not supported.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedMime = getSupportedMimeType() || 'audio/webm';
    audioChunks = [];
    previewWaveformPeaks = [];
    mediaRecorder = new MediaRecorder(stream, recordedMime ? { mimeType: recordedMime } : {});
    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      recordedBlob = new Blob(audioChunks, { type: recordedMime });
      if (recordedBlob.size < 500) { resetRecordingUI(); return; }
      showPreviewBar();
    };
    mediaRecorder.start(100);
    isRecording = true;

    // Web Audio analyser for live waveform
    recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = recAudioCtx.createMediaStreamSource(stream);
    recAnalyser = recAudioCtx.createAnalyser();
    recAnalyser.fftSize = 64;
    source.connect(recAnalyser);

    recSeconds = 0;
    updateRecTimer();
    recTimerInterval = setInterval(() => { recSeconds++; updateRecTimer(); }, 1000);

    show('recording-bar'); hide('input-bar');
    buildRecWaveformBars();
    animateRecWaveform();
  } catch { alert('Microphone access denied.'); }
}

function buildRecWaveformBars() {
  const el = document.getElementById('rec-waveform');
  el.innerHTML = '';
  for (let i = 0; i < 40; i++) {
    const b = document.createElement('div');
    b.className = 'bar';
    b.style.height = '4px';
    el.appendChild(b);
  }
}

function animateRecWaveform() {
  if (!recAnalyser) return;
  const bars = document.querySelectorAll('#rec-waveform .bar');
  const data = new Uint8Array(recAnalyser.frequencyBinCount);
  function frame() {
    recAnalyser.getByteFrequencyData(data);
    const peak = data.reduce((s, v) => s + v, 0) / data.length / 255;
    previewWaveformPeaks.push(peak);
    // Shift bars left, append new
    const heights = Array.from(bars).map(b => parseInt(b.style.height));
    heights.shift();
    heights.push(Math.max(4, Math.round(peak * 30)));
    bars.forEach((b, i) => b.style.height = heights[i] + 'px');
    recAnimFrame = requestAnimationFrame(frame);
  }
  recAnimFrame = requestAnimationFrame(frame);
}

function togglePauseRecording() {
  if (!mediaRecorder) return;
  const btn = document.getElementById('rec-pause-btn');
  if (mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    clearInterval(recTimerInterval);
    cancelAnimationFrame(recAnimFrame);
    btn.textContent = '▶';
  } else if (mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    recTimerInterval = setInterval(() => { recSeconds++; updateRecTimer(); }, 1000);
    animateRecWaveform();
    btn.textContent = '⏸';
  }
}

function stopRecording() {
  clearInterval(recTimerInterval);
  cancelAnimationFrame(recAnimFrame);
  if (recAudioCtx) { recAudioCtx.close(); recAudioCtx = null; recAnalyser = null; }
  if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop();
  isRecording = false;
}

function cancelRecording() {
  clearInterval(recTimerInterval);
  cancelAnimationFrame(recAnimFrame);
  if (recAudioCtx) { recAudioCtx.close(); recAudioCtx = null; recAnalyser = null; }
  if (mediaRecorder?.state !== 'inactive') {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
    mediaRecorder.stream?.getTracks().forEach(t => t.stop());
  }
  isRecording = false;
  resetRecordingUI();
}

function resetRecordingUI() {
  hide('recording-bar'); hide('preview-bar'); show('input-bar');
  document.getElementById('rec-pause-btn').textContent = '⏸';
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  recordedBlob = null;
}

function updateRecTimer() {
  const m = Math.floor(recSeconds / 60);
  const s = String(recSeconds % 60).padStart(2, '0');
  document.getElementById('rec-timer').textContent = `${m}:${s}`;
}

// ─── Preview bar ──────────────────────────────────────────────────────────────

function showPreviewBar() {
  hide('recording-bar'); show('preview-bar');
  // Build waveform bars from collected peaks
  const bars = document.getElementById('preview-bars');
  bars.innerHTML = '';
  const peaks = normalizePeaks(previewWaveformPeaks, 50);
  peaks.forEach(h => {
    const b = document.createElement('div');
    b.className = 'bar';
    b.style.height = Math.max(3, Math.round(h * 30)) + 'px';
    bars.appendChild(b);
  });
  // Set up preview audio
  const url = URL.createObjectURL(recordedBlob);
  previewAudio = new Audio(url);
  previewAudio.onended = () => {
    document.getElementById('preview-play-btn').textContent = '▶';
    updatePreviewBars(1);
  };
  previewAudio.ontimeupdate = () => {
    const pct = previewAudio.duration ? previewAudio.currentTime / previewAudio.duration : 0;
    updatePreviewBars(pct);
    document.getElementById('preview-duration').textContent = fmtTime(previewAudio.currentTime);
  };
  previewAudio.onloadedmetadata = () => {
    document.getElementById('preview-duration').textContent = fmtTime(previewAudio.duration);
  };
}

function normalizePeaks(raw, count) {
  if (!raw.length) return Array(count).fill(0.2);
  const step = raw.length / count;
  return Array.from({ length: count }, (_, i) => {
    const slice = raw.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    return slice.length ? Math.max(...slice) : 0;
  });
}

function updatePreviewBars(pct) {
  const bars = document.querySelectorAll('#preview-bars .bar');
  bars.forEach((b, i) => b.classList.toggle('played', i / bars.length < pct));
}

function togglePreviewPlay() {
  if (!previewAudio) return;
  const btn = document.getElementById('preview-play-btn');
  if (previewAudio.paused) { previewAudio.play(); btn.textContent = '⏸'; }
  else { previewAudio.pause(); btn.textContent = '▶'; }
}

function cancelPreview() {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  resetRecordingUI();
}

async function sendRecording() {
  if (!recordedBlob || recordedBlob.size < 500) return;
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  const ext = recordedMime.includes('mp4') ? 'mp4' : recordedMime.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  // Store normalized peaks in content field for waveform rendering
  const peaks = normalizePeaks(previewWaveformPeaks, 50).map(v => Math.round(v * 100)).join(',');
  form.append('file', recordedBlob, `voice-${Date.now()}.${ext}`);
  const res = await fetch('/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form }).then(r => r.json());
  if (res.error) { alert(res.error); return; }
  socket.emit('send_message', { roomId: currentRoomId, type: 'audio', filePath: res.url, fileName: peaks, replyToId: replyTo?.id || null });
  resetRecordingUI();
  cancelReply();
}

// ─── Render messages ──────────────────────────────────────────────────────────
function appendMessage(msg) {
  const container = document.getElementById('messages');
  const isMine = msg.username === username;

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + (isMine ? 'mine' : 'theirs');
  wrapper.dataset.msgId = msg.id;
  addLongPress(wrapper, () => openCtxMenu(msg.id, msg.type, isMine, wrapper, msg));

  if (!isMine) {
    const sender = document.createElement('div');
    sender.className = 'msg-sender'; sender.textContent = msg.username;
    wrapper.appendChild(sender);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msg.reply_to_id && msg.reply_username) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    const quoteUser = document.createElement('span');
    quoteUser.className = 'reply-quote-user';
    quoteUser.textContent = msg.reply_username;
    const quoteText = document.createElement('span');
    quoteText.className = 'reply-quote-text';
    quoteText.textContent = msg.reply_type === 'text' ? (msg.reply_content || '').slice(0, 80)
      : msg.reply_type === 'audio' ? '🎙 Voice message'
      : msg.reply_type === 'image' ? '🖼 Image' : '📄 File';
    quote.appendChild(quoteUser);
    quote.appendChild(quoteText);
    bubble.appendChild(quote);
  }

  if (msg.type === 'text') {
    bubble.dataset.text = msg.content;
    bubble.textContent = msg.content;
    if (msg.edited) { const tag = document.createElement('span'); tag.className = 'edited-tag'; tag.textContent = '(edited)'; bubble.appendChild(tag); }
  } else if (msg.type === 'image') {
    const img = document.createElement('img');
    img.src = msg.file_path; img.onclick = () => openLightbox(msg.file_path);
    bubble.appendChild(img);
  } else if (msg.type === 'audio') {
    bubble.appendChild(buildVoicePlayer(msg));
  } else {
    const a = document.createElement('a');
    a.className = 'file-link'; a.href = msg.file_path;
    a.download = msg.file_name || 'file'; a.target = '_blank';
    a.innerHTML = '📄 ' + (msg.file_name || 'Download file');
    bubble.appendChild(a);
  }
  wrapper.appendChild(bubble);

  const footer = document.createElement('div');
  footer.className = 'msg-footer';
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  footer.appendChild(time);

  const reactBtn = document.createElement('button');
  reactBtn.className = 'react-btn'; reactBtn.textContent = '😊'; reactBtn.title = 'React';
  reactBtn.onclick = (e) => { e.stopPropagation(); showEmojiPicker(msg.id, reactBtn, wrapper); };
  footer.appendChild(reactBtn);

  if (isMine) {
    if (msg.type === 'text') {
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn'; editBtn.title = 'Edit'; editBtn.textContent = '✏️';
      editBtn.onclick = (e) => { e.stopPropagation(); startEdit(msg.id); };
      footer.appendChild(editBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-action-btn delete'; delBtn.title = 'Delete'; delBtn.textContent = '🗑';
    delBtn.onclick = (e) => { e.stopPropagation(); confirmDelete(msg.id); };
    footer.appendChild(delBtn);
  }

  wrapper.appendChild(footer);
  const reactionsRow = document.createElement('div');
  reactionsRow.className = 'reactions-row'; reactionsRow.id = 'reactions-' + msg.id;
  wrapper.appendChild(reactionsRow);
  container.appendChild(wrapper);
  scrollBottom();
}

// ─── Context menu ─────────────────────────────────────────────────────────────
function openCtxMenu(messageId, type, isMine, wrapperEl, msg) {
  ctxTarget = { messageId, type, isMine, username: msg?.username, content: msg?.content };
  const menu = document.getElementById('ctx-menu');
  menu.querySelectorAll('button')[1].style.display = (isMine && type === 'text') ? '' : 'none';
  menu.querySelector('button.danger').style.display = isMine ? '' : 'none';
  menu.querySelector('hr').style.display = isMine ? '' : 'none';
  menu.classList.remove('hidden');
  const rect = wrapperEl.getBoundingClientRect();
  const mw = 160, mh = 120;
  let left = rect.left, top = rect.bottom + 4;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight) top = rect.top - mh - 4;
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = Math.max(4, top) + 'px';
}
function closeCtxMenu() { document.getElementById('ctx-menu').classList.add('hidden'); ctxTarget = null; }
function ctxReply() { if (!ctxTarget) return; const t = ctxTarget; closeCtxMenu(); setReply(t); }
function ctxReact() {
  if (!ctxTarget) return;
  const wrapper = document.querySelector(`[data-msg-id="${ctxTarget.messageId}"]`);
  const btn = wrapper?.querySelector('.react-btn');
  closeCtxMenu();
  if (btn && wrapper) showEmojiPicker(ctxTarget.messageId, btn, wrapper);
}
function ctxEdit() { if (!ctxTarget) return; const id = ctxTarget.messageId; closeCtxMenu(); startEdit(id); }
function ctxDelete() { if (!ctxTarget) return; const id = ctxTarget.messageId; closeCtxMenu(); confirmDelete(id); }

function addLongPress(el, cb) {
  let t;
  el.addEventListener('touchstart', () => { t = setTimeout(cb, 500); }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(t));
  el.addEventListener('touchmove', () => clearTimeout(t));
}

// ─── Emoji reactions ──────────────────────────────────────────────────────────
function buildEmojiPicker() {
  const list = document.getElementById('emoji-list');
  EMOJIS.forEach(emoji => {
    const span = document.createElement('span');
    span.textContent = emoji; span.onclick = () => pickEmoji(emoji);
    list.appendChild(span);
  });
}
function showEmojiPicker(messageId, btn, wrapper) {
  const picker = document.getElementById('emoji-picker');
  if (pickerTarget?.messageId === messageId && !picker.classList.contains('hidden')) { hideEmojiPicker(); return; }
  document.querySelectorAll('.msg-wrapper.show-react').forEach(el => el.classList.remove('show-react'));
  wrapper.classList.add('show-react');
  pickerTarget = { messageId };
  picker.classList.remove('hidden');
  const rect = btn.getBoundingClientRect();
  const pw = 240, ph = 90;
  let left = rect.left, top = rect.top - ph - 8;
  if (left + pw > window.innerWidth) left = window.innerWidth - pw - 8;
  if (top < 8) top = rect.bottom + 8;
  picker.style.left = left + 'px'; picker.style.top = top + 'px';
}
function hideEmojiPicker() {
  document.getElementById('emoji-picker').classList.add('hidden');
  document.querySelectorAll('.msg-wrapper.show-react').forEach(el => el.classList.remove('show-react'));
  pickerTarget = null;
}
function pickEmoji(emoji) {
  if (!pickerTarget) return;
  socket.emit('toggle_reaction', { messageId: pickerTarget.messageId, emoji });
  hideEmojiPicker();
}
function renderReactions(messageId, reactions) {
  const row = document.getElementById('reactions-' + messageId);
  if (!row) return;
  row.innerHTML = '';
  const groups = {};
  reactions.forEach(r => {
    if (!groups[r.emoji]) groups[r.emoji] = { count: 0, users: [], mine: false };
    groups[r.emoji].count++; groups[r.emoji].users.push(r.username);
    if (r.username === username) groups[r.emoji].mine = true;
  });
  Object.entries(groups).forEach(([emoji, data]) => {
    const chip = document.createElement('div');
    chip.className = 'reaction-chip' + (data.mine ? ' mine' : '');
    chip.title = data.users.join(', ');
    chip.innerHTML = `${emoji}<span class="count">${data.count}</span>`;
    chip.onclick = () => socket.emit('toggle_reaction', { messageId, emoji });
    row.appendChild(chip);
  });
}

// ─── Voice player builder ─────────────────────────────────────────────────────

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function buildVoicePlayer(msg) {
  const peaks = (msg.file_name || '').split(',').map(Number).filter(n => !isNaN(n));
  const normalizedPeaks = peaks.length >= 10 ? peaks.map(v => v / 100) : Array(50).fill(null).map(() => 0.2 + Math.random() * 0.6);

  const player = document.createElement('div');
  player.className = 'voice-player';

  const playBtn = document.createElement('button');
  playBtn.className = 'voice-play-btn';
  playBtn.innerHTML = '▶';

  // Waveform
  const waveWrap = document.createElement('div');
  waveWrap.className = 'voice-waveform';
  waveWrap.style.cursor = 'pointer';

  const barsEl = document.createElement('div');
  barsEl.className = 'voice-bars';
  const barCount = 50;
  const peaksSampled = normalizePeaks(normalizedPeaks, barCount);
  peaksSampled.forEach(h => {
    const b = document.createElement('div');
    b.className = 'bar';
    b.style.height = Math.max(3, Math.round(h * 28)) + 'px';
    barsEl.appendChild(b);
  });
  waveWrap.appendChild(barsEl);

  // Meta: duration + speed
  const meta = document.createElement('div');
  meta.className = 'voice-meta';
  const durEl = document.createElement('span');
  durEl.className = 'voice-duration';
  durEl.textContent = '0:00';
  const speedBtn = document.createElement('button');
  speedBtn.className = 'voice-speed-btn';
  const speeds = [1, 1.5, 2];
  let speedIdx = 0;
  speedBtn.textContent = '1×';
  meta.appendChild(durEl);
  meta.appendChild(speedBtn);

  player.appendChild(playBtn);
  player.appendChild(waveWrap);
  player.appendChild(meta);

  // Audio element (hidden)
  const audio = new Audio(msg.file_path);
  let playing = false;
  let rafId = null;

  function updateBars() {
    if (!audio.duration) return;
    const pct = audio.currentTime / audio.duration;
    const bars = barsEl.querySelectorAll('.bar');
    bars.forEach((b, i) => b.classList.toggle('played', i / bars.length < pct));
    durEl.textContent = fmtTime(audio.currentTime);
  }

  function startRAF() {
    function tick() { updateBars(); if (!audio.paused) rafId = requestAnimationFrame(tick); }
    rafId = requestAnimationFrame(tick);
  }

  audio.onloadedmetadata = () => { durEl.textContent = fmtTime(audio.duration); };
  audio.onended = () => {
    playing = false; playBtn.innerHTML = '▶';
    cancelAnimationFrame(rafId);
    updateBars();
    durEl.textContent = fmtTime(audio.duration);
  };

  playBtn.onclick = () => {
    if (playing) { audio.pause(); playBtn.innerHTML = '▶'; playing = false; cancelAnimationFrame(rafId); }
    else { audio.play(); playBtn.innerHTML = '⏸'; playing = true; startRAF(); }
  };

  // Seek on waveform click
  waveWrap.onclick = e => {
    if (!audio.duration) return;
    const rect = waveWrap.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
    updateBars();
  };

  // Speed control
  speedBtn.onclick = () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    audio.playbackRate = speeds[speedIdx];
    speedBtn.textContent = speeds[speedIdx] + '×';
  };

  return player;
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  show('lightbox');
}
function closeLightbox() { hide('lightbox'); }

// ─── Global click ─────────────────────────────────────────────────────────────
function handleGlobalClick(e) {
  const picker = document.getElementById('emoji-picker');
  const menu = document.getElementById('ctx-menu');
  const panel = document.getElementById('online-panel');
  const badge = document.getElementById('online-indicator');
  if (!picker.classList.contains('hidden') && !picker.contains(e.target) && !e.target.classList.contains('react-btn'))
    hideEmojiPicker();
  if (!menu.classList.contains('hidden') && !menu.contains(e.target))
    closeCtxMenu();
  if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== badge)
    closeOnlinePanel();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scrollBottom() { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; }
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}
