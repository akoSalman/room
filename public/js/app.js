let token = localStorage.getItem('token');
let username = localStorage.getItem('username');
let currentRoomId = null;
let currentRoomIsDM = false;
let maxOtherReadMsgId = 0; // highest message id any other room member has read (for seen checkmarks)
let currentDMPeerPk = null; // the DM partner's public key (E2E) or null
function setDMPeerPk(k) { currentDMPeerPk = k; }
let allChatImages = []; // every image of the current chat (from /room-media)
let e2eUnlockAsked = false;

// Sessions started before E2E existed never ran key setup at login — unlock
// (or create) the identity with the password when a DM is first opened.
async function ensureE2EUnlocked() {
  if (E2E.ready()) return true;
  if (e2eUnlockAsked) return false;
  e2eUnlockAsked = true;
  const pw = prompt('🔒 Enter your account password to unlock end-to-end encryption on this device:');
  if (!pw) { e2eUnlockAsked = false; return false; }
  const ok = await E2E.setup(pw, api);
  if (!ok) {
    e2eUnlockAsked = false; // let them try again with the right password
    alert('Could not unlock encryption with that password. Please try again.');
  }
  return ok;
}

// Per-brand APK release info, picked by the domain serving this page.
const IS_BISTBARG = location.hostname.includes('bistbarg');
const APK_RELEASE_TAG = IS_BISTBARG ? 'latest-apk-bistbarg' : 'latest-apk';
const APK_FILE_NAME = IS_BISTBARG ? 'BistbargChat-latest.apk' : 'ChatRoom-latest.apk';
// This server first. For the people this is built for, GitHub is unreliable at
// best and unreachable at worst — and if this page loaded, this link works.
// The GitHub release stays as the fallback for a server with no build yet.
const APK_SERVER_MANIFEST = '/app/latest.json';
const APK_SERVER_DOWNLOAD = '/app/download';
const APK_DOWNLOAD_URL = `https://github.com/akoSalman/room-releases/releases/download/${APK_RELEASE_TAG}/${APK_FILE_NAME}`;
const APK_RELEASE_API = `https://api.github.com/repos/akoSalman/room-releases/releases/tags/${APK_RELEASE_TAG}`;
const pendingUploads = {}; // clientId -> { wrapper, previewUrl, file, type, fileName, roomId, replyToId }
const revealedOneTime = new Set(); // one-time message ids this client has revealed
const oneTimeExpiry = {}; // messageId -> ms timestamp when it will self-destruct
setInterval(() => {
  document.querySelectorAll('.one-time-countdown').forEach(el => {
    const exp = Number(el.dataset.expire || 0);
    if (!exp) return;
    el.textContent = ` 🔥${Math.max(0, Math.ceil((exp - Date.now()) / 1000))}s`;
  });
}, 1000);
let pendingOneTimeSeconds = null; // set via the 🔥 composer button, applies to the next message sent
let oldestLoadedMsgId = null;
let hasMoreOlderMsgs = true;
let loadingOlderMsgs = false;
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
const recordingUsers = new Set();
let replyTo = null; // { id, username, content, type }

let onlineUsers = [];
const unreadCounts = {};
const openNotifications = {}; // msg id -> Notification, so deletes can close them
let dmDividerInserted = false;
// Who the open direct chat is with, for the profile sheet.
let currentDMPeerName = null;

// ── What the other scripts on this page are allowed to see ───────────────────
//
// `let` and `const` at the top level of a classic script do NOT become
// properties of window — only `function` declarations and `var` do. So
// `window.token` was undefined in every module loaded beside this one, and the
// uploader duly sent "Authorization: Bearer undefined" to every request. The
// symptom was an upload stuck at 0 B with no error on screen; the same hole
// silently broke the profile sheet, in-chat search, encrypted search and the
// location picker, all of which read state through window.
//
// Getters rather than copies, deliberately: a copy has to be re-assigned
// everywhere the original changes — on sign-out, on switching chats, on the
// socket reconnecting — and the one place somebody forgets is a module reading
// a stale token for the rest of the session.
//
// test/webGlobals.test.js reads every `window.X` in public/js and checks it is
// listed here, so a module written against a global that does not exist fails
// the suite instead of failing silently in a browser.
Object.defineProperties(window, {
  token: { get: () => token, configurable: true },
  username: { get: () => username, configurable: true },
  currentRoomId: { get: () => currentRoomId, configurable: true },
  currentRoomIsDM: { get: () => currentRoomIsDM, configurable: true },
  currentDMPeerPk: { get: () => currentDMPeerPk, configurable: true },
  socket: { get: () => socket, configurable: true },
});

/** The header's profile button. */
function openPeerFromHeader() {
  if (!currentRoomIsDM || !currentDMPeerName) return;
  window.Peer.open(currentDMPeerName, { isDm: true, roomId: currentRoomId });
}

/**
 * A chat was cleared — here, or on another device, or by the other person.
 *
 * The room list has to lose it too, or it sits there showing a last message
 * that no longer exists.
 */
window.onHistoryCleared = function (roomId) {
  if (String(roomId) === String(currentRoomId)) {
    document.getElementById('messages').innerHTML = '';
    oldestLoadedMsgId = null;
    hasMoreOlderMsgs = true;
  }
  loadRooms();
};

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const t of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','🤔','😍','👎','😡'];

// ─── Boot ─────────────────────────────────────────────────────────────────────
// ── Auto-update ──────────────────────────────────────────────────────────────
// Remember the front-end version this page loaded with, then re-check whenever
// the tab regains focus, on socket reconnect, and periodically. If the server
// is serving something newer, reload — otherwise a long-lived tab or installed
// PWA keeps running old code indefinitely after a deploy.
let loadedAppVersion = null;
let reloadingForUpdate = false;

async function checkAppVersion() {
  if (reloadingForUpdate) return;
  try {
    const res = await fetch('/version', { cache: 'no-store' });
    const { version } = await res.json();
    if (!version) return;
    if (loadedAppVersion === null) { loadedAppVersion = version; return; }
    if (version === loadedAppVersion) return;

    reloadingForUpdate = true;
    // Clear the service-worker caches first, so the reload genuinely fetches
    // the new files rather than replaying the old ones.
    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
    } catch {}
    showToast('Updating to the latest version…');
    setTimeout(() => location.reload(), 600);
  } catch {}
}

checkAppVersion();
setInterval(checkAppVersion, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkAppVersion();
});

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
  // Notifications are only for when the user is away from the app; while it's
  // open, unread badges/dots do the signalling.
  if (document.visibilityState === 'visible') return;
  // Another of this user's devices is looking at the chat right now — they are
  // already reading it, so a second buzz on the laptop is just noise.
  if (msg.seenElsewhere) return;
  // Never preview content — only the kind of message received
  const body = msg.type === 'text' ? '💬 New message'
    : msg.type === 'audio' ? '🎙 Voice message'
    : msg.type === 'image' ? '🖼 Photo'
    : msg.type === 'gallery' ? '🖼 Photos'
    : msg.type === 'video' ? '🎥 Video'
    : msg.type === 'location' ? '📍 Location'
    : msg.type === 'music' ? '🎵 Audio file'
    : msg.type === 'call' ? '📞 Call'
    : msg.type === 'system' ? 'ℹ️ Room update' : '📄 File';
  const n = new Notification(msg.username, { body, icon: '/icons/icon-192.png', tag: 'chatroom-msg-' + msg.id, silent: true });
  openNotifications[msg.id] = n;
  n.onclose = () => { delete openNotifications[msg.id]; };
  try { new Audio('/notify.wav').play().catch(() => {}); } catch {}
}

window.addEventListener('DOMContentLoaded', () => {
  setAuthMode('signin');
  buildEmojiPicker();
  initQuickEmoji();
  setupPasteAndDrop();

  // Keep the layout inside the visual viewport so the composer isn't hidden
  // behind the on-screen keyboard (iOS Safari doesn't resize the layout
  // viewport when the keyboard opens).
  if (window.visualViewport) {
    const syncViewport = () => {
      document.documentElement.style.height = window.visualViewport.height + 'px';
      document.body.style.height = window.visualViewport.height + 'px';
      window.scrollTo(0, 0);
    };
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
  }

  // The download links and the build number both come from this server when it
  // has a build, and from the GitHub release only when it does not.
  latestAppBuild().then(info => {
    document.querySelectorAll('#apk-banner, #update-download-btn')
      .forEach(a => { a.href = info.url; });
    const sub = document.getElementById('apk-banner-sub');
    if (sub && info.version) sub.textContent = `Latest build: version ${info.version} (APK)`;
  });
  document.addEventListener('click', handleGlobalClick);
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
  // Prevent document-level scroll from touch gestures on mobile
  document.addEventListener('touchmove', e => {
    if (e.target.closest('#messages, #room-list, .modal-overlay, #online-panel')) return;
    e.preventDefault();
  }, { passive: false });
  if (token && username) { enterApp(); requestNotifPermission(); }

  // Shared room link: /?join=<roomId>
  const joinParam = new URLSearchParams(location.search).get('join');
  if (joinParam && token) {
    setTimeout(() => openRoomById(joinParam), 800);
    history.replaceState(null, '', '/');
  }

  document.getElementById('messages').addEventListener('scroll', () => {
    updateScrollFab();
    if (document.getElementById('messages').scrollTop < 80) loadOlderMessages();
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
// ─── Auth ─────────────────────────────────────────────────────────────────────
// Rules come from /js/credentials.js — the same file the server requires, so
// what the form allows and what the server accepts cannot drift apart.
let authMode = 'signin';
let authTouched = { u: false, p: false };

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('auth-btn').textContent =
    mode === 'register' ? 'Create account' : 'Sign in';
  document.getElementById('auth-pass').setAttribute(
    'autocomplete', mode === 'register' ? 'new-password' : 'current-password');
  showAuthError('');
  renderAuthValidation();
}

function toggleAuthPw() {
  const inp = document.getElementById('auth-pass');
  const on = inp.type === 'password';
  inp.type = on ? 'text' : 'password';
  document.getElementById('auth-pw-toggle').textContent = on ? '🙈' : '👁';
}

function onAuthBlur(which) {
  authTouched[which] = true;
  renderAuthValidation();
}
function onAuthInput() {
  showAuthError('');
  renderAuthValidation();
}

function renderAuthValidation() {
  const C = window.Credentials;
  const user = document.getElementById('auth-user').value;
  const pass = document.getElementById('auth-pass').value;
  const registering = authMode === 'register';

  // The warning belongs wherever a password is being CHOSEN.
  const warn = document.getElementById('auth-warning');
  warn.classList.toggle('hidden', !registering);
  if (registering) {
    document.getElementById('auth-warning-en').textContent = C.PASSWORD_WARNING.en;
    document.getElementById('auth-warning-fa').textContent = C.PASSWORD_WARNING.fa;
  }

  document.getElementById('auth-user-hint').textContent = registering
    ? '3–20 characters · letters, numbers, dot, underscore · starts with a letter'
    : '';

  // Signing in is never blocked by the rules: an existing account may predate
  // them, and refusing someone their own working password would be absurd.
  const uErr = registering && authTouched.u ? C.validateUsername(user) : null;
  const pErr = registering && authTouched.p ? C.validatePassword(pass, user) : null;
  document.getElementById('auth-user-err').textContent = uErr ? uErr.en : '';
  document.getElementById('auth-user-err-fa').textContent = uErr ? uErr.fa : '';
  document.getElementById('auth-pass-err').textContent = pErr ? pErr.en : '';
  document.getElementById('auth-pass-err-fa').textContent = pErr ? pErr.fa : '';
  document.getElementById('auth-user').classList.toggle('bad', !!uErr);
  document.getElementById('auth-pass').classList.toggle('bad', !!pErr);

  const strengthBox = document.getElementById('auth-strength');
  if (registering && pass) {
    strengthBox.classList.remove('hidden');
    const score = C.passwordStrength(pass);
    const colors = ['#ef4444', '#ef4444', '#f59e0b', '#84cc16', '#22c55e'];
    const fill = document.getElementById('auth-strength-fill');
    fill.style.width = `${(score / 4) * 100}%`;
    fill.style.background = colors[score];
    const label = document.getElementById('auth-strength-label');
    label.textContent = C.STRENGTH_LABELS[score].en;
    label.style.color = colors[score];
  } else {
    strengthBox.classList.add('hidden');
  }
}

async function signin() {
  const Cr = window.Credentials;
  const user = document.getElementById('auth-user').value.trim();
  const pass = document.getElementById('auth-pass').value;
  authTouched = { u: true, p: true };
  if (!user || !pass) { renderAuthValidation(); return showAuthError('Please enter username and password'); }

  if (authMode === 'register') {
    const uErr = Cr.validateUsername(user);
    const pErr = Cr.validatePassword(pass, user);
    renderAuthValidation();
    if (uErr || pErr) return;
  }

  const btn = document.getElementById('auth-btn');
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Please wait…';
  showAuthError('');
  try {
    const res = await api('/auth/signin', 'POST',
      { username: user, password: pass, register: authMode === 'register' });

    // Signing in to a name that does not exist: offer the other tab rather
    // than silently creating an account from a typo.
    if (res.error && res.canRegister) {
      setAuthMode('register');
      return showAuthError(`No account named "${Cr.normalizeUsername(user)}". Check the spelling, or create it as a new account.`);
    }
    if (res.error) return showAuthError(res.error);
    saveSession(res.token, res.username, res.avatar);
    E2E.setup(pass, api).catch(() => {});
    enterApp();
  } catch { showAuthError('Connection error — is the server running?'); }
  finally { btn.disabled = false; btn.textContent = label; }
}

function saveSession(t, u, avatar) {
  token = t; username = u;
  expiredFired = false;   // re-arm expiry detection for the new session
  localStorage.setItem('token', t);
  localStorage.setItem('username', u);
  if (avatar !== undefined) {
    if (avatar) localStorage.setItem('avatar', avatar);
    else localStorage.removeItem('avatar');
  }
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
  // Restore unread badges from the server-side read positions
  const counts = await api('/unread-counts');
  if (counts && !counts.error) {
    Object.entries(counts).forEach(([roomId, cnt]) => {
      unreadCounts[roomId] = cnt;
      updateUnreadBadge(roomId);
    });
  }
}

function setAvatarInitials(name) {
  const avatar = localStorage.getItem('avatar');
  const display = avatar || (name || '?').slice(0, 2).toUpperCase();
  const sa = document.getElementById('sidebar-avatar');
  const pb = document.getElementById('profile-avatar-big');
  if (sa) { sa.textContent = display; sa.classList.toggle('emoji-avatar', !!avatar); }
  if (pb) { pb.textContent = display; pb.classList.toggle('emoji-avatar', !!avatar); }
  const pd = document.getElementById('profile-name-display');
  if (pd) pd.textContent = name;
}

const AVATAR_EMOJIS = ['🦄','🐉','🧙‍♂️','🧚‍♀️','🧛‍♂️','🧞‍♂️','🦊','🐺','🦁','🐯','🐼','🐸','🦉','🐙','🦋','🤖','👽','🐲','🦅','🐬','🔥','⚡','🌙','⭐'];

function buildAvatarPicker() {
  const grid = document.getElementById('avatar-emoji-grid');
  if (!grid || grid.childElementCount) return;
  const current = localStorage.getItem('avatar');
  const FIRST_ROW = 7;
  AVATAR_EMOJIS.forEach((e, i) => {
    const cell = document.createElement('button');
    cell.className = 'avatar-emoji-cell' + (current === e ? ' active' : '') + (i >= FIRST_ROW ? ' extra hidden' : '');
    cell.textContent = e;
    cell.onclick = () => setAvatarEmoji(e);
    grid.appendChild(cell);
  });
  const more = document.createElement('button');
  more.className = 'avatar-emoji-cell more-toggle';
  more.textContent = '⋯';
  more.onclick = () => {
    const expanded = more.classList.toggle('expanded');
    grid.querySelectorAll('.avatar-emoji-cell.extra').forEach(c => c.classList.toggle('hidden', !expanded));
    more.textContent = expanded ? '×' : '⋯';
  };
  grid.appendChild(more);
}

async function setAvatarEmoji(emoji) {
  const res = await api('/profile', 'PUT', { avatar: emoji });
  if (res.error) return alert(res.error);
  saveSession(res.token, res.username, res.avatar);
  setAvatarInitials(username);
  document.querySelectorAll('.avatar-emoji-cell').forEach(c => c.classList.toggle('active', c.textContent === emoji));
  document.getElementById('remove-avatar-btn').classList.toggle('hidden', !emoji);
}

function connectSocket() {
  return new Promise((resolve) => {
    if (socket) socket.disconnect();
    socket = io({ auth: { token }, reconnectionAttempts: 10 });

    socket.once('connect', () => { socketReady = true; setConnStatus('online'); resolve(); });

    socket.on('connect', () => {
      socketReady = true;
      setConnStatus('online');
      // On reconnect the server no longer has us in the room channel — re-join
      // and pull anything that arrived while the connection was down.
      if (currentRoomId) {
        socket.emit('join_room', currentRoomId);
        refreshLatestMessages();
      }
      checkAppVersion(); // a reconnect often follows a deploy
    });
    document.addEventListener('visibilitychange', () => {
      socket.emit('app_focus', document.visibilityState === 'visible');
      if (document.visibilityState === 'visible') {
        // Back on this tab: re-mark as viewing the open room and re-sync.
        if (currentRoomId) { socket.emit('join_room', currentRoomId); refreshLatestMessages(); }
      } else {
        // Tab hidden: we're no longer actively viewing, so let the account's
        // other devices receive push notifications again.
        socket.emit('leave_room');
      }
    });
    if (typeof Calls !== 'undefined') Calls.bindSocket(socket);
    socket.on('disconnect', () => { socketReady = false; setConnStatus(navigator.onLine ? 'reconnecting' : 'offline'); });
    socket.io.on('reconnect_attempt', () => setConnStatus(navigator.onLine ? 'reconnecting' : 'offline'));
    socket.on('reconnect', () => { socketReady = true; setConnStatus('online'); });
    socket.on('connect_error', (err) => {
      setConnStatus(navigator.onLine ? 'reconnecting' : 'offline');
      if (err.message === 'Unauthorized') sessionExpired();
    });
    window.addEventListener('offline', () => setConnStatus('offline'));
    window.addEventListener('online', () => { if (!socketReady) setConnStatus('reconnecting'); });

    socket.on('message_received', (msg) => {
      if (msg.client_id && pendingUploads[msg.client_id]) {
        const pending = pendingUploads[msg.client_id];
        if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
        pending.wrapper.replaceWith(buildMessageElement(msg));
        delete pendingUploads[msg.client_id];
        socket.emit('mark_read', { roomId: msg.room_id, lastMsgId: msg.id });
        return;
      }
      showNotif(msg);
      if (String(msg.room_id) !== String(currentRoomId)) {
        if (msg.username !== username) { // own messages are never "unread"
          unreadCounts[msg.room_id] = (unreadCounts[msg.room_id] || 0) + 1;
          updateUnreadBadge(msg.room_id);
        }
      } else {
        appendMessage(msg);
        socket.emit('mark_read', { roomId: msg.room_id, lastMsgId: msg.id });
        if (msg.type === 'text' && msg.username !== username) {
          let c = msg.content;
          if (E2E.isEncrypted(c)) c = E2E.decrypt(c, currentDMPeerPk);
          { const em = burstEmojiOf(c); if (em) triggerEmojiBurst(em); }
        }
      }
    });
    socket.on('voice_played', ({ messageId }) => {
      document.querySelectorAll(`.voice-played-dot[data-msg-id="${messageId}"]`)
        .forEach(d => d.classList.add('played'));
    });
    socket.on('message_edited', ({ messageId, content }) => {
      if (E2E.isEncrypted(content)) {
        const dec = E2E.decrypt(content, currentDMPeerPk);
        content = dec !== null ? dec : '🔒 Encrypted message';
      }
      applyEdit(messageId, content);
    });
    socket.on('message_deleted', ({ messageId }) => applyDelete(messageId));
    // Cleared — by me on another device, or by the other person for both of
    // us. Showing messages the server has already dropped would be showing a
    // lie until the next reload.
    socket.on('history_cleared', ({ roomId }) => window.onHistoryCleared(roomId));
    // Named in a message. It joins the queue even while the chat is open — it
    // is only cleared once it has actually been jumped to.
    socket.on('mentioned', ({ roomId, messageId }) => {
      if (String(roomId) !== String(currentRoomId)) return;
      if (!pendingMentions.includes(messageId)) pendingMentions.push(messageId);
      updateMentionFab();
    });
    // A countdown started somewhere — remember the deadline so a later render
    // does not re-report the message as newly seen.
    socket.on('expiry_started', ({ roomId, started }) => {
      if (roomId != null && String(roomId) !== String(currentRoomId)) return;
      (started || []).forEach(x => {
        seenReported.add(String(x.messageId));
        const el = document.querySelector(`[data-msg-id="${x.messageId}"]`);
        if (el && x.expiresAt) el.dataset.expiresAt = String(x.expiresAt);
      });
      scheduleExpirySweep();
    });
    // Disappearing mode changed: re-skin the chat so it is obvious here too.
    socket.on('disappearing_changed', ({ roomId, seconds }) => {
      // The sidebar marker updates for BOTH people, whichever chat they are
      // looking at; the skin only applies to the chat actually on screen.
      const li = document.querySelector(`[data-room-id="${roomId}"]`);
      if (li) {
        const existing = li.querySelector('.room-disappearing');
        if (seconds > 0 && !existing) {
          const m = disappearingMarker({ disappearing_seconds: seconds });
          if (m) li.appendChild(m);
        } else if (!seconds && existing) existing.remove();
      }
      if (roomId != null && String(roomId) !== String(currentRoomId)) return;
      applyDisappearingSkin(seconds || 0);
    });
    // A live share moved: swap the card in place, keeping everything else in
    // the bubble (reply quote, timestamp, reactions) untouched.
    socket.on('location_updated', ({ messageId, roomId, content }) => {
      if (roomId != null && String(roomId) !== String(currentRoomId)) return;
      const wrapper = document.querySelector(`[data-msg-id="${messageId}"]`);
      const old = wrapper && wrapper.querySelector('.loc-card');
      if (!old) return;
      old.replaceWith(buildLocationCard({ content }));
    });
    socket.on('reactions_updated', ({ messageId, roomId, reactions }) => {
      // Also delivered on our personal channel now, so other rooms land here too.
      if (roomId != null && String(roomId) !== String(currentRoomId)) return;
      renderReactions(messageId, reactions);
    });
    socket.on('room_online', ({ users }) => updateOnlineUsers(users));
    socket.on('room_created', (room) => addRoomToList(room));
    // Membership ended elsewhere — drop the room from the sidebar, and bail
    // out of it if it is the one on screen.
    const dropRoom = ({ roomId }) => {
      const li = document.querySelector(`[data-room-id="${roomId}"]`);
      if (li) li.remove();
      if (String(currentRoomId) === String(roomId)) {
        currentRoomId = null;
        document.getElementById('messages').innerHTML = '';
        document.getElementById('room-title').textContent = 'Select a room';
        document.getElementById('room-media-btn').classList.add('hidden');
    document.getElementById('peer-btn').classList.add('hidden');
    document.getElementById('chat-search-btn').classList.add('hidden');
        document.getElementById('join-bar').classList.add('hidden');
      }
    };
    socket.on('left_room', dropRoom);
    socket.on('removed_from_room', dropRoom);
    socket.on('room_deleted', ({ roomId }) => removeRoomFromList(roomId));
    socket.on('room_updated', (room) => updateRoomInList(room));
    socket.on('user_typing', ({ username: u }) => showTyping(u));
    socket.on('user_stopped_typing', ({ username: u }) => hideTyping(u));
    socket.on('user_recording', ({ username: u }) => showRecordingUser(u));
    socket.on('user_stopped_recording', ({ username: u }) => hideRecordingUser(u));
    socket.on('dm_activity', ({ room }) => ensureDMInSidebar(room));
    socket.on('one_time_viewed', ({ messageId, seconds }) => {
      oneTimeExpiry[messageId] = Date.now() + seconds * 1000;
      const tag = document.querySelector(`.one-time-countdown[data-msg-id="${messageId}"]`);
      if (tag) tag.dataset.expire = oneTimeExpiry[messageId];
    });
    socket.on('messages_read', ({ roomId, lastReadMsgId }) => {
      if (String(roomId) !== String(currentRoomId)) return;
      if (lastReadMsgId > maxOtherReadMsgId) { maxOtherReadMsgId = lastReadMsgId; updateSeenCheckmarks(); }
    });
  });
}

// ─── Connection banner ────────────────────────────────────────────────────────
// Connection-status pill (top center). States: online (briefly), reconnecting,
// offline. 'online' auto-hides after a moment; the others stay until resolved.
let connHideTimer = null;
function setConnStatus(state) {
  const el = document.getElementById('connection-banner');
  const txt = document.getElementById('connection-banner-text');
  if (!el || !txt) return;
  clearTimeout(connHideTimer);
  el.classList.toggle('online', state === 'online');
  if (state === 'online') {
    txt.textContent = 'Back online';
    el.classList.remove('hidden');
    connHideTimer = setTimeout(() => el.classList.add('hidden'), 1500);
  } else if (state === 'offline') {
    txt.textContent = 'No internet connection';
    el.classList.remove('hidden');
  } else {
    txt.textContent = 'Reconnecting…';
    el.classList.remove('hidden');
  }
}
function showConnectionBanner() { setConnStatus(navigator.onLine ? 'reconnecting' : 'offline'); }
function hideConnectionBanner() { setConnStatus('online'); }

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
  updateComposerButtons();
  refreshMentionSuggestions();
  if (!currentRoomId || !socketReady) return;
  if (!isTyping) { isTyping = true; socket.emit('typing_start', { roomId: currentRoomId }); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { isTyping = false; socket.emit('typing_stop', { roomId: currentRoomId }); }, 1500);
}

// The options strip stays pinned above the input bar at all times.
function updateComposerButtons() {}

function showTyping(user) { typingUsers.add(user); renderTypingBar(); }
function hideTyping(user) { typingUsers.delete(user); renderTypingBar(); }
function showRecordingUser(user) { recordingUsers.add(user); renderTypingBar(); }
function hideRecordingUser(user) { recordingUsers.delete(user); renderTypingBar(); }
function renderTypingBar() {
  const bar = document.getElementById('typing-bar');
  if (typingUsers.size === 0 && recordingUsers.size === 0) { bar.classList.add('hidden'); return; }
  // Recording takes priority over typing in the indicator
  let text;
  if (recordingUsers.size > 0) {
    const names = [...recordingUsers];
    text = names.length === 1 ? `🎙 ${names[0]} is recording`
      : `🎙 ${names[0]} and ${names.length - 1} others are recording`;
  } else {
    const names = [...typingUsers];
    text = names.length === 1 ? `${names[0]} is typing`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
      : `${names[0]} and ${names.length - 1} others are typing`;
  }
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
  buildAvatarPicker();
  document.getElementById('remove-avatar-btn').classList.toggle('hidden', !localStorage.getItem('avatar'));
  loadMyRooms();
  loadLatestAppVersion();
  show('profile-modal');
}

function copyRoomLink() {
  if (!currentRoomId || currentRoomIsDM) return;
  const link = location.origin + '/join/' + currentRoomId;
  (navigator.clipboard?.writeText(link) || Promise.reject()).then(
    () => alert('Room link copied:\n' + link),
    () => prompt('Room link (copy it):', link)
  );
}

// ─── Room dashboard ───────────────────────────────────────────────────────────
async function openRoomInfo() {
  if (!currentRoomId || currentRoomIsDM) return;
  const info = await api('/room-info/' + currentRoomId);
  if (info.error) return alert(info.error);

  document.getElementById('room-info-name').textContent = (info.is_private ? '🔒 ' : '# ') + info.name;
  document.getElementById('room-info-owner').textContent =
    (info.owner_avatar ? info.owner_avatar + ' ' : '') + (info.owner_username || 'unknown');
  const created = info.created_at
    ? new Date(info.created_at.includes('T') ? info.created_at : info.created_at.replace(' ', 'T') + 'Z')
        .toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })
    : '—';
  document.getElementById('room-info-created').textContent = created;
  document.getElementById('room-info-type').textContent = info.is_private ? 'Private room' : 'Public room';

  // (Joining is offered by the Join bar inside the room, not here.)
  // Leave is the counterpart to Join. The owner cannot leave their own room.
  document.getElementById('room-info-leave-section')
    .classList.toggle('hidden', !(info.is_member && !info.is_owner));

  // Link (public rooms only)
  const linkSection = document.getElementById('room-info-link-section');
  if (info.is_private) linkSection.classList.add('hidden');
  else {
    linkSection.classList.remove('hidden');
    document.getElementById('room-info-link').textContent = location.origin + '/join/' + info.id;
  }

  // Members (private rooms only)
  const membersSection = document.getElementById('room-info-members-section');
  const list = document.getElementById('room-info-members');
  list.innerHTML = '';
  if (info.is_private && Array.isArray(info.members)) {
    membersSection.classList.remove('hidden');
    document.getElementById('room-info-members-count').textContent = `(${info.members.length})`;
    info.members.forEach(m => {
      const li = document.createElement('li');
      li.textContent = (m.avatar ? m.avatar + ' ' : '') + m.username
        + (m.username === info.owner_username ? '  ·  owner' : '');
      list.appendChild(li);
    });
  } else {
    membersSection.classList.add('hidden');
  }

  // Invite (private room owner only)
  const inviteSection = document.getElementById('room-info-invite-section');
  inviteSection.classList.toggle('hidden', !(info.is_private && info.is_owner));
  document.getElementById('room-invite-input').value = '';

  show('room-info-modal');
}
function closeRoomInfo() { hide('room-info-modal'); }
// ─── Shared content of the open chat ─────────────────────────────────────────
// The app has had a Photos/Files/Music/Links browser for a while; the web had
// no way to see a chat's media at all, only whatever was scrolled into view.
let mediaData = null;
let mediaTab = 'images';

// Server-rendered, disk-cached thumbnail for an /uploads path.
function thumbUrl(uploadPath, w) {
  // Carry the media signature (?e=&s=) across — /thumb checks the same one.
  const [bare, query] = String(uploadPath).split('?');
  const name = encodeURIComponent(bare.replace(/^\/uploads\//, ''));
  return '/thumb/' + name + '?w=' + w + (query ? '&' + query : '');
}

async function openMedia() {
  if (!currentRoomId) return;
  mediaData = null;
  mediaTab = 'images';
  syncMediaTabs();
  document.getElementById('media-body').innerHTML = '<div class="media-empty">Loading…</div>';
  show('media-modal');
  const roomId = currentRoomId;
  const res = await api('/room-media/' + roomId);
  if (String(roomId) !== String(currentRoomId)) return;  // switched chats meanwhile
  mediaData = (res && !res.error) ? res : { images: [], files: [], music: [], links: [] };
  renderMedia();
}
function closeMedia() { hide('media-modal'); }

function setMediaTab(tab) {
  mediaTab = tab;
  syncMediaTabs();
  renderMedia();
}
function syncMediaTabs() {
  document.querySelectorAll('#media-tabs .media-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === mediaTab);
  });
}

function renderMedia() {
  const body = document.getElementById('media-body');
  body.innerHTML = '';
  if (!mediaData) { body.innerHTML = '<div class="media-empty">Loading…</div>'; return; }

  const empty = (what) => {
    const d = document.createElement('div');
    d.className = 'media-empty';
    d.textContent = `No ${what} yet`;
    body.appendChild(d);
  };

  if (mediaTab === 'images') {
    if (!mediaData.images.length) return empty('photos');
    const grid = document.createElement('div');
    grid.className = 'media-grid';
    // Absolute urls, in the order shown, so the lightbox swipes through the
    // gallery itself rather than through whatever the chat has rendered.
    const full = mediaData.images.map(x => location.origin + mediaUrl(x));
    full.forEach((src, i) => {
      const img = document.createElement('img');
      // Grid cells load a small server-rendered thumbnail; the full image is
      // only fetched when one is actually opened.
      // The smallest thumbnail the server makes: the grid cells are small,
      // and asking for a bigger one only makes the gallery slower to fill.
      img.src = thumbUrl(mediaUrl(mediaData.images[i]), 96);
      img.onerror = () => { img.onerror = null; img.src = src; };  // non-image or old upload
      img.loading = 'lazy';
      img.onclick = () => { lightboxList = full; lightboxIdx = i; showLightboxAt(i); show('lightbox'); };
      grid.appendChild(img);
    });
    body.appendChild(grid);
    return;
  }

  if (mediaTab === 'links') {
    if (!mediaData.links.length) return empty('links');
    const list = document.createElement('div');
    list.className = 'media-list';
    mediaData.links.forEach(item => {
      const l = mediaUrl(item);
      const a = document.createElement('a');
      a.className = 'media-row';
      a.href = /^https?:\/\//.test(l) ? l : 'https://' + l;
      a.target = '_blank';
      a.rel = 'noopener';
      const icon = document.createElement('span'); icon.textContent = '🌐';
      const text = document.createElement('span'); text.textContent = l;
      a.appendChild(icon); a.appendChild(text);
      list.appendChild(a);
    });
    body.appendChild(list);
    return;
  }

  if (mediaTab === 'music') {
    if (!mediaData.music.length) return empty('music');
    const list = document.createElement('div');
    list.className = 'media-list';
    mediaData.music.forEach(f => {
      const row = document.createElement('div');
      row.className = 'media-row';
      const name = document.createElement('span');
      name.textContent = '🎵 ' + (f.name || 'Audio');
      const audio = document.createElement('audio');
      audio.src = f.url; audio.controls = true; audio.preload = 'none';
      audio.onplay = () => claimPlayback(audio, () => audio.pause());
      const wrap = document.createElement('div');
      wrap.style.cssText = 'flex:1;min-width:0';
      wrap.appendChild(name); wrap.appendChild(audio);
      row.appendChild(wrap);
      list.appendChild(row);
    });
    body.appendChild(list);
    return;
  }

  if (!mediaData.files.length) return empty('files');
  const list = document.createElement('div');
  list.className = 'media-list';
  mediaData.files.forEach(f => {
    const a = document.createElement('a');
    a.className = 'media-row';
    a.href = f.url; a.target = '_blank'; a.download = f.name || 'file';
    const icon = document.createElement('span'); icon.textContent = '📄';
    const text = document.createElement('span'); text.textContent = f.name || 'File';
    a.appendChild(icon); a.appendChild(text);
    list.appendChild(a);
  });
  body.appendChild(list);
}


// Show the Join bar above the composer whenever the open room is one the user
// has not joined. Public rooms are readable before joining, so this is the
// prompt to actually become a member.
async function refreshJoinBar(roomId, isDM) {
  if (isDM) { setMembership(true); return; }
  const info = await api('/room-info/' + roomId);
  if (String(roomId) !== String(currentRoomId)) return;   // room switched while loading
  setMembership(!!(info.error || info.is_member));
}

// Non-members read only: the composer is replaced by the Join bar, so the room
// cannot be posted into without joining (the server enforces the same rule).
function setMembership(isMember) {
  document.getElementById('join-bar').classList.toggle('hidden', isMember);
  ['input-bar', 'composer-strip'].forEach(id => {
    document.getElementById(id).classList.toggle('hidden', !isMember);
  });
  if (!isMember) {
    document.getElementById('quick-emoji-bar').classList.add('hidden');
    ['recording-bar', 'preview-bar', 'media-preview-bar', 'reply-bar', 'edit-banner']
      .forEach(id => document.getElementById(id).classList.add('hidden'));
  }
}

function joinCurrentRoom() {
  if (!currentRoomId) return;
  const roomId = currentRoomId;
  socket.emit('accept_invite', { roomId }, (res) => {
    if (res?.error) return alert(res.error);
    setMembership(true);
    addRoomToList(res.room);
  });
}

function leaveCurrentRoom() {
  if (!currentRoomId) return;
  if (!confirm('Leave this room? You will stop receiving its messages.')) return;
  const roomId = currentRoomId;
  socket.emit('leave_room_membership', { roomId }, (res) => {
    if (res?.error) return alert(res.error);
    closeRoomInfo();
    const li = document.querySelector(`[data-room-id="${roomId}"]`);
    if (li) li.remove();
    currentRoomId = null;
    document.getElementById('messages').innerHTML = '';
    document.getElementById('room-title').textContent = 'Select a room';
    document.getElementById('room-media-btn').classList.add('hidden');
    document.getElementById('peer-btn').classList.add('hidden');
    document.getElementById('chat-search-btn').classList.add('hidden');
    document.getElementById('join-bar').classList.add('hidden');
  });
}

function sendRoomInvite() {
  const name = document.getElementById('room-invite-input').value.trim();
  if (!name || !currentRoomId) return;
  socket.emit('invite_to_room', { roomId: currentRoomId, username: name }, (res) => {
    if (res?.error) return alert(res.error);
    alert(`Invitation sent — ${name} received an invite in their DMs.`);
    document.getElementById('room-invite-input').value = '';
  });
}

// ─── Sidebar search ───────────────────────────────────────────────────────────
let sidebarSearchTimer = null;
function onSidebarSearch() {
  const q = document.getElementById('sidebar-search').value.trim();
  clearTimeout(sidebarSearchTimer);
  const box = document.getElementById('search-results');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  sidebarSearchTimer = setTimeout(async () => {
    const res = await api('/search?q=' + encodeURIComponent(q));
    if (!res || res.error) return;
    box.innerHTML = '';
    if (!res.users.length && !res.rooms.length) {
      const d = document.createElement('div'); d.className = 'search-empty'; d.textContent = 'No results';
      box.appendChild(d);
    }
    res.users.forEach(u => {
      const d = document.createElement('div');
      d.className = 'search-result';
      d.innerHTML = `<span>${u.avatar || '👤'}</span><b></b><em>Message</em>`;
      d.querySelector('b').textContent = u.username;
      d.onclick = () => { clearSidebarSearch(); openDM(u.username); };
      box.appendChild(d);
    });
    res.rooms.forEach(r => {
      const d = document.createElement('div');
      d.className = 'search-result';
      d.innerHTML = `<span>#</span><b></b><em>Open</em>`;
      d.querySelector('b').textContent = r.name;
      d.onclick = () => { clearSidebarSearch(); openRoomById(r.id); };
      box.appendChild(d);
    });
    box.classList.remove('hidden');
  }, 300);
}
function clearSidebarSearch() {
  document.getElementById('sidebar-search').value = '';
  const box = document.getElementById('search-results');
  box.classList.add('hidden'); box.innerHTML = '';
}

function openCreateRoomModal() { show('create-room-modal'); document.getElementById('create-room-name').focus(); }
function closeCreateRoomModal() { hide('create-room-modal'); }
async function submitCreateRoom() {
  const name = document.getElementById('create-room-name').value.trim();
  const isPrivate = document.getElementById('create-room-private').checked;
  if (!name) return;
  const res = await api('/rooms', 'POST', { name, isPrivate });
  if (res.error) return alert(res.error);
  document.getElementById('create-room-name').value = '';
  document.getElementById('create-room-private').checked = false;
  closeCreateRoomModal();
  if (!document.querySelector(`[data-room-id="${res.id}"]`)) addRoomToList(res);
  const li = document.querySelector(`[data-room-id="${res.id}"]`);
  if (li) joinRoom(res.id, res.name, li, false);
}

/**
 * The newest Android build, and where to get it.
 *
 * This server is asked first — it is the host this page came from, so it is
 * reachable by definition — and GitHub only if it has nothing. Neither
 * answering leaves the GitHub link in place, which is no worse than before.
 */
async function latestAppBuild() {
  try {
    const r = await fetch(APK_SERVER_MANIFEST, { cache: 'no-store' });
    if (r.ok) {
      const m = await r.json();
      const version = parseInt(m && m.version, 10);
      if (Number.isInteger(version) && version > 0) {
        return { version: version, url: m.url || APK_SERVER_DOWNLOAD, source: 'server' };
      }
    }
  } catch {}
  try {
    const res = await fetch(APK_RELEASE_API).then(r => r.json());
    const match = /version:(\d+)/.exec(res.body || '') || /v(\d+)/.exec(res.name || '');
    if (match) return { version: parseInt(match[1], 10), url: APK_DOWNLOAD_URL, source: 'github' };
  } catch {}
  return { version: null, url: APK_DOWNLOAD_URL, source: null };
}

// ── Taking an expired message off the screen ────────────────────────────────
//
// Reported as: disappearing messages do not disappear exactly after the set
// time. Half of that was the server sweeping every thirty seconds — fixed
// there — and half was this page waiting to be told: the bubble stayed until
// the delete event arrived, which on a slow connection is a pause and on a
// dropped socket is indefinite.
//
// Both ends know the deadline, so this end removes what it knows has gone. The
// server is still what destroys the message.
let expirySweepTimer = null;

function renderedDeadlines() {
  return [...document.querySelectorAll('#messages [data-expires-at]')].map(el => ({
    el, expires_at: parseInt(el.dataset.expiresAt, 10) || 0,
  }));
}

function scheduleExpirySweep() {
  clearTimeout(expirySweepTimer);
  const now = Date.now();
  const rows = renderedDeadlines();
  // Anything already past goes now.
  rows.forEach(r => { if (Expiry.hasExpired(r.expires_at, now)) r.el.remove(); });
  // One timer, for the EARLIEST remaining deadline: fifty countdowns on screen
  // still only need the next one.
  const wait = Expiry.msUntilNextExpiry(renderedDeadlines(), now);
  if (wait === null) return;
  expirySweepTimer = setTimeout(scheduleExpirySweep, Math.min(wait, 60000));
}

async function loadLatestAppVersion() {
  const hint = document.getElementById('update-hint');
  const info = await latestAppBuild();
  if (info.version && hint) {
    hint.textContent = `Latest Android build: version ${info.version} (mobile only).`;
  }
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
  if (!res.error && newPassword) E2E.rewrap(newPassword, api).catch(() => {});
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
  // Land on the list of chats/rooms after login rather than auto-opening a
  // chat. On desktop the sidebar is always visible; on mobile, open it.
  if (isMobile()) openSidebar();
}

// Both people see that a chat destroys its messages without having to open it:
// the mode belongs to the chat, not to whoever switched it on.
function disappearingMarker(room) {
  if (!room || !room.disappearing_seconds) return null;
  const m = document.createElement('span');
  m.className = 'room-disappearing';
  m.textContent = '\u23F3';
  m.title = 'Disappearing messages are on in this chat';
  return m;
}

function addRoomToList(room) {
  if (document.querySelector(`[data-room-id="${room.id}"]`)) return;
  const li = document.createElement('li');
  li.dataset.roomId = room.id;
  li.title = room.name;

  const icon = document.createElement('span');
  icon.className = 'room-icon'; icon.textContent = room.is_private ? '🔒' : '#';

  const label = document.createElement('span');
  label.className = 'room-label'; label.textContent = room.name;

  li.appendChild(icon);
  li.appendChild(label);
  const mark = disappearingMarker(room);
  if (mark) li.appendChild(mark);

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
    document.getElementById('room-media-btn').classList.add('hidden');
    document.getElementById('peer-btn').classList.add('hidden');
    document.getElementById('chat-search-btn').classList.add('hidden');
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
  const mark = disappearingMarker(room);
  if (mark) li.appendChild(mark);
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
  typingUsers.clear(); recordingUsers.clear(); renderTypingBar();
  currentRoomId = roomId;
  currentRoomIsDM = isDM;
  clearUnread(roomId);
  document.querySelectorAll('#room-list li').forEach(el => el.classList.remove('active'));
  li.classList.add('active');
  document.getElementById('room-title').textContent = (isDM ? '💬 ' : '# ') + roomName;
  document.getElementById('messages').innerHTML = '';
  document.getElementById('online-indicator').classList.add('hidden');
  document.getElementById('room-link-btn').classList.toggle('hidden', isDM);
  // Shared content works for DMs too — that's where most media lives.
  document.getElementById('room-media-btn').classList.remove('hidden');
  // Mute, block and clear are about a PERSON, so the button only appears
  // where there is exactly one of them.
  document.getElementById('peer-btn').classList.toggle('hidden', !isDM);
  document.getElementById('chat-search-btn').classList.remove('hidden');
  window.ChatSearch.close();
  closeMentionBox();
  loadMentionables(roomId);
  loadMentions(roomId);
  currentDMPeerName = isDM ? String(roomName || '').replace(/^💬\s*/, '') : null;
  refreshJoinBar(roomId, isDM);
  // Whether THIS chat destroys its messages — the skin must follow the room,
  // not linger from the last one.
  applyDisappearingSkin(0);
  api(`/room-settings/${roomId}`)
    .then(r => { if (r && !r.error && String(currentRoomId) === String(roomId)) applyDisappearingSkin(r.disappearingSeconds || 0); })
    .catch(() => {});
  hasNewerMsgs = false;
  document.getElementById('scroll-fab').classList.add('hidden');
  oldestLoadedMsgId = null;
  hasMoreOlderMsgs = true;
  loadingOlderMsgs = false;
  maxOtherReadMsgId = 0;
  setDMPeerPk(null);
  allChatImages = [];
  api('/room-media/' + roomId).then(m => {
    if (m && !m.error && String(roomId) === String(currentRoomId)) {
      allChatImages = m.images.slice().reverse().map(u => location.origin + u);
    }
  }).catch(() => {});
  document.getElementById('call-voice-btn').classList.toggle('hidden', !isDM);
  document.getElementById('call-video-btn').classList.toggle('hidden', !isDM);
  document.getElementById('room-voice-btn').classList.toggle('hidden', isDM);
  document.getElementById('room-voice-btn').textContent = '📞';
  Calls.setDMPeer(null, null);
  if (isDM) {
    try {
      await ensureE2EUnlocked();
      const pk = await api('/dm-peer-key/' + roomId);
      Calls.setDMPeer(pk?.userId || null, roomName);
      if (E2E.ready() && pk?.publicKey) {
        setDMPeerPk(E2E.decodeKey(pk.publicKey));
        document.getElementById('room-title').textContent = '🔒 ' + roomName;
      }
    } catch {}
  }
  socket.emit('join_room', roomId);
  const msgs = await api('/messages/' + roomId);
  try {
    const receipts = await api('/read-receipts/' + roomId);
    if (receipts && typeof receipts === 'object' && !receipts.error) {
      maxOtherReadMsgId = Math.max(0, ...Object.values(receipts));
    }
  } catch {}
  if (Array.isArray(msgs)) {
    msgs.forEach(appendMessage);
    if (msgs.length) {
      oldestLoadedMsgId = msgs[0].id;
      socket.emit('mark_read', { roomId, lastMsgId: msgs[msgs.length - 1].id });
    }
    hasMoreOlderMsgs = msgs.length >= MESSAGES_PAGE_SIZE;
  }
  // Paint reactions that already exist on these messages — they were only ever
  // applied from live events, so a reload showed none of them.
  try {
    const all = await api('/room-reactions/' + roomId);
    if (all && !all.error) {
      Object.keys(all).forEach(id => renderReactions(Number(id), all[id]));
    }
  } catch {}
  updateSeenCheckmarks();
  scrollBottom();
}

const MESSAGES_PAGE_SIZE = 20;

async function loadOlderMessages() {
  if (loadingOlderMsgs || !hasMoreOlderMsgs || !currentRoomId || !oldestLoadedMsgId) return;
  loadingOlderMsgs = true;
  const older = await api(`/messages/${currentRoomId}?before=${oldestLoadedMsgId}`);
  loadingOlderMsgs = false;
  if (!Array.isArray(older) || !older.length) { hasMoreOlderMsgs = false; return; }
  oldestLoadedMsgId = older[0].id;
  hasMoreOlderMsgs = older.length >= MESSAGES_PAGE_SIZE;
  prependMessages(older);
}

// ─── Online users ─────────────────────────────────────────────────────────────
function updateOnlineUsers(users) {
  onlineUsers = users;
  const badge = document.getElementById('online-indicator');
  if (currentRoomIsDM) {
    // DMs: just show whether the peer is online — no member list
    const peer = (document.getElementById('room-title').textContent || '').replace('💬', '').trim();
    const peerOnline = users.includes(peer);
    closeOnlinePanel();
    if (peerOnline) { badge.textContent = '● online'; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
    return;
  }
  if (!users.length) { badge.classList.add('hidden'); return; }
  badge.classList.remove('hidden');
  badge.textContent = `● ${users.length} online ›`;
  if (!document.getElementById('online-panel').classList.contains('hidden')) renderOnlinePanel();
}
function toggleOnlinePanel() {
  if (currentRoomIsDM) return; // DM badge is informational only
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
function handleInputKey(e) {
  // The suggestion list gets first refusal on the keys that mean something to
  // it, or Enter sends "@al" instead of completing it to "@ali".
  if (mentionSuggestions.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionPick(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionPick(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseMention(mentionPick); return; }
    if (e.key === 'Escape') { closeMentionBox(); return; }
  }
  if (e.key === 'Enter') sendOrSave();
}

// ─── @mentions ───────────────────────────────────────────────────────────────
//
// The rules for when "@" starts a mention live in mentions.js, shared with the
// app: the fiddly part is telling a mention from an email address, and getting
// it wrong pops this list over somebody typing one.
let mentionables = [];        // who is in this chat
let mentionSuggestions = [];
let mentionPick = 0;
let mentionAnchor = null;     // { start, query } while a name is being typed

/** Everyone who can be mentioned here. Loaded once per chat, not per keystroke. */
async function loadMentionables(roomId) {
  mentionables = [];
  if (!roomId || currentRoomIsDM) return;
  const info = await api('/room-info/' + roomId);
  if (!info || info.error || !Array.isArray(info.members)) return;
  if (String(roomId) !== String(currentRoomId)) return;
  mentionables = info.members.map(m => m.username).filter(u => u && u !== username);
}

function refreshMentionSuggestions() {
  const input = document.getElementById('msg-input');
  const q = window.Mentions.mentionQuery(input.value, input.selectionStart ?? input.value.length);
  if (!q || !mentionables.length) { closeMentionBox(); return; }
  mentionAnchor = q;
  mentionSuggestions = window.Mentions.filterUsernames(mentionables, q.query);
  if (!mentionSuggestions.length) { closeMentionBox(); return; }
  mentionPick = 0;
  renderMentionBox();
}

function renderMentionBox() {
  const box = document.getElementById('mention-box');
  box.innerHTML = '';
  mentionSuggestions.forEach((name, i) => {
    const d = document.createElement('div');
    d.className = 'mention-item' + (i === mentionPick ? ' active' : '');
    d.textContent = '@' + name;
    d.onmousedown = (e) => { e.preventDefault(); chooseMention(i); };
    box.appendChild(d);
  });
  box.classList.remove('hidden');
}

function moveMentionPick(delta) {
  mentionPick = (mentionPick + delta + mentionSuggestions.length) % mentionSuggestions.length;
  renderMentionBox();
}

function chooseMention(i) {
  const name = mentionSuggestions[i];
  if (!name || !mentionAnchor) return;
  const input = document.getElementById('msg-input');
  const caret = input.selectionStart ?? input.value.length;
  const next = window.Mentions.applyMention(input.value, mentionAnchor.start, caret, name);
  input.value = next.text;
  input.setSelectionRange(next.caret, next.caret);
  closeMentionBox();
  input.focus();
  updateComposerButtons();
}

function closeMentionBox() {
  mentionSuggestions = [];
  mentionAnchor = null;
  const box = document.getElementById('mention-box');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

// ─── Being mentioned ─────────────────────────────────────────────────────────
//
// A button that walks you through them oldest-first, because the point of a
// mention is that somebody wanted an answer — and that is rarely the newest
// message in the room.
let pendingMentions = [];

async function loadMentions(roomId) {
  pendingMentions = [];
  updateMentionFab();
  if (!roomId || currentRoomIsDM) return;
  const r = await api('/mentions/' + roomId);
  if (!r || r.error || !Array.isArray(r.mentions)) return;
  if (String(roomId) !== String(currentRoomId)) return;
  pendingMentions = r.mentions;
  updateMentionFab();
}

function updateMentionFab() {
  const fab = document.getElementById('mention-fab');
  if (!fab) return;
  fab.classList.toggle('hidden', !pendingMentions.length);
  fab.textContent = pendingMentions.length > 1 ? '@' + pendingMentions.length : '@';
}

function goToNextMention() {
  const next = pendingMentions.shift();
  updateMentionFab();
  // Cleared only once it has actually been jumped to, so closing the app
  // half-way through does not lose the rest.
  if (next) jumpToMessage(next);
}
function sendOrSave() {
  if (editingMsgId) return saveEdit();
  if (pendingFiles.length) return sendPendingFiles();
  sendText();
}

// ─── Reply ────────────────────────────────────────────────────────────────────
function setReply(msg) {
  replyTo = { id: msg.id, username: msg.username, content: msg.content, type: msg.type };
  document.getElementById('reply-bar-user').textContent = msg.username;
  const preview = msg.type === 'text' ? (msg.content || '').slice(0, 60) : msg.type === 'audio' ? '🎙 Voice message' : msg.type === 'image' ? '🖼 Image' : msg.type === 'gallery' ? '🖼 Photos' : msg.type === 'video' ? '🎥 Video' : msg.type === 'location' ? '📍 Location' : msg.type === 'music' ? '🎵 Audio file' : '📄 File';
  document.getElementById('reply-bar-text').textContent = preview;
  show('reply-bar');
  document.getElementById('msg-input').focus();
}
function cancelReply() { replyTo = null; hide('reply-bar'); }

function sendText() {
  const input = document.getElementById('msg-input');
  const plain = input.value.trim();
  if (!plain || !currentRoomId || !socket) return;
  stopTypingSignal();
  const roomId = currentRoomId;
  const replyToId = replyTo?.id || null;
  const oneTimeSeconds = pendingOneTimeSeconds || undefined;
  clearOneTime();
  input.value = '';
  updateComposerButtons();
  cancelReply();
  dispatchText(plain, roomId, replyToId, oneTimeSeconds);
}

// Appears in the chat instantly; a failed/timed-out send shows tap-to-retry.
function dispatchText(plain, roomId, replyToId, oneTimeSeconds) {
  const clientId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const tempMsg = {
    id: clientId, username, avatar: localStorage.getItem('avatar') || '',
    type: 'text', content: plain, file_path: null, file_name: null,
    created_at: new Date().toISOString(),
    reply_to_id: replyToId, reply_username: replyTo?.username || null,
    one_time_seconds: oneTimeSeconds || null,
  };
  const wrapper = buildMessageElement(tempMsg);
  if (String(roomId) === String(currentRoomId)) {
    document.getElementById('messages').appendChild(wrapper);
    scrollBottom();
  }
  pendingUploads[clientId] = { wrapper, previewUrl: null };
  { const em = burstEmojiOf(plain); if (em) triggerEmojiBurst(em); }
  // Encrypt + emit after the bubble has painted, so the send button feels
  // instant even when E2E key work makes the wire format slow to build.
  setTimeout(() => {
    let wire = plain;
    if (currentRoomIsDM && currentDMPeerPk && String(roomId) === String(currentRoomId)) {
      wire = E2E.encrypt(plain, currentDMPeerPk) || plain;
    }
    socket.timeout(8000).emit('send_message', {
      roomId, type: 'text', content: wire, replyToId, clientId, oneTimeSeconds,
    }, (err, res) => {
      if ((err || !res?.ok) && pendingUploads[clientId]) {
        markUploadFailed(wrapper, clientId, () => dispatchText(plain, roomId, replyToId, oneTimeSeconds));
      }
    });
  }, 0);
}

// ── Heart burst: a short full-screen love effect on heart-only messages ──────
// Emoji-only messages of these play a full-screen burst (keyed by first code
// point so \u2764\uFE0F with/without the variation selector both match).
const BURST_EMOJIS = ['\uD83D\uDE02','\u2764\uFE0F','\uD83D\uDC4D','\uD83D\uDE4F','\uD83D\uDE0D','\uD83D\uDD25','\uD83C\uDF89','\uD83D\uDE22','\uD83D\uDE2E','\uD83D\uDC4C','\uD83D\uDCAF','\uD83D\uDE2D','\uD83E\uDD70','\uD83D\uDE0E','\uD83D\uDC4F','\uD83D\uDE4C','\uD83E\uDD23'];
const EMOJI_EFFECTS = new Set(BURST_EMOJIS.map(e => [...e][0]));
const BURST_FORM = Object.fromEntries(BURST_EMOJIS.map(e => [[...e][0], e]));
const BURST_TINT = {
  '\u2764': 'rgba(244,114,182,0.16)', '\uD83D\uDE02': 'rgba(250,204,21,0.16)', '\uD83D\uDD25': 'rgba(251,146,60,0.18)',
  '\uD83C\uDF89': 'rgba(232,121,249,0.16)', '\uD83D\uDC4D': 'rgba(96,165,250,0.16)', '\uD83D\uDE4F': 'rgba(251,191,36,0.16)',
  '\uD83D\uDE0D': 'rgba(244,114,182,0.16)', '\uD83E\uDD70': 'rgba(244,114,182,0.16)', '\uD83D\uDE22': 'rgba(96,165,250,0.16)',
  '\uD83D\uDE2D': 'rgba(96,165,250,0.16)', '\uD83D\uDE0E': 'rgba(148,163,184,0.16)', '\uD83D\uDC4C': 'rgba(74,222,128,0.16)',
  '\uD83D\uDCAF': 'rgba(248,113,113,0.16)', '\uD83D\uDC4F': 'rgba(96,165,250,0.16)', '\uD83D\uDE4C': 'rgba(251,191,36,0.16)',
  '\uD83E\uDD23': 'rgba(250,204,21,0.16)', '\uD83D\uDE2E': 'rgba(148,163,184,0.16)',
};

// Returns the emoji to celebrate if the text is one emoji (repeated) only.
function burstEmojiOf(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (!t || t.length > 16) return null;
  const chars = [...t].filter(c => !/[\uFE0E\uFE0F\u200D\s]/.test(c));
  if (!chars.length || new Set(chars).size !== 1) return null;
  const first = chars[0];
  return EMOJI_EFFECTS.has(first) ? (BURST_FORM[first] || first) : null;
}

let burstTimer = null;
function triggerEmojiBurst(emoji) {
  const el = document.getElementById('heart-burst');
  if (!el) return;
  const first = [...emoji][0];
  el.innerHTML = '';
  el.style.background = `radial-gradient(circle at 50% 65%, ${BURST_TINT[first] || 'rgba(148,163,184,0.12)'}, transparent 70%)`;
  for (let i = 0; i < 9; i++) {
    const sp = document.createElement('span');
    sp.textContent = emoji;
    sp.style.left = (6 + (i * 12) % 84) + '%';
    sp.style.animationDelay = (i * 0.12) + 's';
    sp.style.fontSize = (26 + (i % 4) * 12) + 'px';
    el.appendChild(sp);
  }
  el.classList.remove('hidden');
  clearTimeout(burstTimer);
  burstTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ── Quick emoji bar ───────────────────────────────────────────────────────────
const QUICK_EMOJIS = ['😂', '❤️', '👍', '🙏', '😍', '🔥', '🎉', '😢', '😮', '👌'];
function initQuickEmoji() {
  const list = document.getElementById('quick-emoji-list');
  list.innerHTML = '';
  QUICK_EMOJIS.forEach(em => {
    const b = document.createElement('button');
    b.textContent = em;
    b.onclick = () => {
      const input = document.getElementById('msg-input');
      input.value += em;
      input.focus();
      updateComposerButtons();
    };
    list.appendChild(b);
  });
  if (localStorage.getItem('quickEmojiClosed') === '1') closeQuickEmoji();
  else openQuickEmoji();
}
function openQuickEmoji() {
  localStorage.removeItem('quickEmojiClosed');
  show('quick-emoji-bar');
  document.getElementById('composer-emoji').classList.add('hidden');
}
function closeQuickEmoji() {
  localStorage.setItem('quickEmojiClosed', '1');
  hide('quick-emoji-bar');
  document.getElementById('composer-emoji').classList.remove('hidden');
}

// ── Composer ＋ menu ──────────────────────────────────────────────────────────
function composerAttach() {
  document.getElementById('file-input').click();
}
function composerRecord() {
  startRecording();
}
function composerOneTime() {
  toggleOneTime();
}

// ── One-time (self-destructing) messages ──────────────────────────────────────
function toggleOneTime() {
  if (pendingOneTimeSeconds) return clearOneTime();
  const raw = prompt('One-time message: seconds visible after being opened (1–3600)?', '10');
  if (raw === null) return;
  const secs = parseInt(raw, 10);
  if (!Number.isInteger(secs) || secs < 1 || secs > 3600) return alert('Enter a number of seconds between 1 and 3600.');
  pendingOneTimeSeconds = secs;
  const otBtn = document.getElementById('composer-one-time');
  otBtn.textContent = `🔥 One-time: ${secs}s (turn off)`;
  otBtn.classList.add('one-time-armed');
}

function clearOneTime() {
  pendingOneTimeSeconds = null;
  const otBtn = document.getElementById('composer-one-time');
  otBtn.textContent = '🔥 One-time';
  otBtn.classList.remove('one-time-armed');
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
  updateComposerButtons();
  input.focus(); show('edit-banner');
}
function saveEdit() {
  let content = document.getElementById('msg-input').value.trim();
  if (!content || !editingMsgId) return;
  if (currentRoomIsDM && currentDMPeerPk) {
    content = E2E.encrypt(content, currentDMPeerPk) || content;
  }
  socket.emit('edit_message', { messageId: editingMsgId, content });
  cancelEdit();
}
function cancelEdit() {
  editingMsgId = null;
  document.getElementById('msg-input').value = '';
  updateComposerButtons();
  hide('edit-banner');
}
function applyEdit(messageId, content) {
  const wrapper = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!wrapper) return;
  const bubble = wrapper.querySelector('.msg-bubble');
  bubble.dataset.text = content;
  const quote = bubble.querySelector('.reply-quote');
  const tag = bubble.querySelector('.edited-tag');
  bubble.innerHTML = '';
  if (quote) bubble.appendChild(quote);
  const textSpan = document.createElement('span');
  textSpan.textContent = content;
  bubble.appendChild(textSpan);
  if (tag) bubble.appendChild(tag);
  else { const t = document.createElement('span'); t.className = 'edited-tag'; t.textContent = '(edited)'; bubble.appendChild(t); }
}

// ─── Delete ───────────────────────────────────────────────────────────────────
function applyDelete(messageId) {
  const wrapper = document.querySelector(`[data-msg-id="${messageId}"]`);
  // If the lightbox is open showing an image from the message being destroyed
  // (e.g. a one-time image whose timer expired), close it so it vanishes too.
  const lb = document.getElementById('lightbox');
  if (wrapper && lb && !lb.classList.contains('hidden')) {
    const srcs = [...wrapper.querySelectorAll('img')].map(i => i.src);
    if (srcs.includes(lightboxSrc)) closeLightbox(true);
  }
  wrapper?.remove();
  // If a notification for this message is still on screen, close it too.
  if (openNotifications[messageId]) { try { openNotifications[messageId].close(); } catch {} delete openNotifications[messageId]; }
}
function confirmDelete(messageId) {
  if (!confirm('Delete this message?')) return;
  socket.emit('delete_message', { messageId });
}

// ─── File / Audio ─────────────────────────────────────────────────────────────

// Whole-file POST, kept for nothing in particular any more — every send goes
// through resumable.js, which can be paused and survives a dropped
// connection. Left out rather than left lying around: an upload path with no
// pause button is the thing that was being fixed.

function updateUploadProgress(wrapper, pct) {
  const bar = wrapper.querySelector('.upload-progress-bar');
  if (bar) bar.style.width = pct + '%';
}

function markUploadFailed(wrapper, clientId, retryFn) {
  delete pendingUploads[clientId];
  wrapper.classList.remove('msg-uploading');
  wrapper.classList.add('msg-upload-failed');
  const overlay = wrapper.querySelector('.upload-overlay');
  if (overlay) overlay.remove();
  const bubble = wrapper.querySelector('.msg-bubble');
  const retry = document.createElement('div');
  retry.className = 'upload-retry';
  retry.textContent = '⚠️ Failed to send — tap to retry';
  retry.onclick = (e) => { e.stopPropagation(); wrapper.remove(); retryFn(); };
  bubble.appendChild(retry);
}

// uploadFilename: name given to the multipart upload (needs a real extension).
// messageFileName: what's stored/shown as the message's fileName (voice notes
// stash their waveform peaks here instead of a real filename).
async function uploadAndSendMedia(file, type, uploadFilename, messageFileName, roomId, replyToId, caption = null, oneTimeSeconds = undefined) {
  const clientId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const previewUrl = (type === 'image' || type === 'video' || type === 'audio') ? URL.createObjectURL(file) : null;
  const tempMsg = {
    id: clientId, username, avatar: localStorage.getItem('avatar') || '',
    type, content: caption, file_path: previewUrl, file_name: messageFileName,
    created_at: new Date().toISOString(),
    reply_to_id: replyTo?.id || null, reply_username: replyTo?.username || null,
    _uploading: true, _progress: 0,
  };
  const wrapper = buildMessageElement(tempMsg);
  document.getElementById('messages').appendChild(wrapper);
  scrollBottom();
  pendingUploads[clientId] = { wrapper, previewUrl };

  try {
    const res = await resumableUpload(file, uploadFilename, clientId, wrapper);
    if (!res) return;                      // cancelled: the bubble is gone
    if (res.error) throw new Error(res.error);
    if (!pendingUploads[clientId]) return; // user already dismissed/retried
    socket.emit('send_message', {
      roomId, type, content: caption, filePath: res.url,
      fileName: messageFileName, replyToId, clientId, oneTimeSeconds,
    });
  } catch (err) {
    if (pendingUploads[clientId]) {
      markUploadFailed(wrapper, clientId, () => uploadAndSendMedia(file, type, uploadFilename, messageFileName, roomId, replyToId, caption, oneTimeSeconds));
    }
  }
}

// Every upload in flight, so the bubble's buttons can reach the right one.
const uploadControls = {};   // clientId -> { handle, paused }

/**
 * Send one file, resumably, reporting onto its own bubble.
 *
 * Resolves with the server's answer, or with null when the user cancelled —
 * cancelling is a decision, not a failure, and must not leave a bubble
 * offering a retry nobody asked for.
 */
function resumableUpload(file, filename, clientId, wrapper) {
  return new Promise((resolve, reject) => {
    let sentAt = [];
    const handle = window.Resumable.upload(file, filename, {
      onProgress(sent, total) {
        updateUploadProgress(wrapper, total ? Math.round((sent / total) * 100) : 0);
        const now = Date.now();
        sentAt.push({ at: now, sent });
        // A speed measured over the last few seconds, not since the beginning:
        // "it has averaged 200 KB/s since you pressed send" is no use to
        // somebody whose connection just died.
        sentAt = sentAt.filter(s => s.at >= now - 5000 || s === sentAt[0]);
        setUploadStatus(wrapper, uploadLine(sent, total, sentAt));
      },
      onPaused() { setUploadStatus(wrapper, 'Paused · ' + window.Resumable.fmtBytes(0)); },
      onDone: resolve,
      onFailed: reject,
    });
    uploadControls[clientId] = { handle, paused: false, resolve };
  });
}

function uploadLine(sent, total, samples) {
  const F = window.Resumable.fmtBytes;
  const size = F(sent) + ' / ' + F(total);
  if (samples.length < 2) return size;
  const first = samples[0], last = samples[samples.length - 1];
  const secs = (last.at - first.at) / 1000;
  const bytes = last.sent - first.sent;
  if (secs <= 0 || bytes <= 0) return size;
  const rate = bytes / secs;
  const left = Math.max(0, total - sent) / rate;
  return size + ' · ' + F(rate) + '/s · ' + (left < 60 ? Math.ceil(left) + 's left'
    : Math.floor(left / 60) + 'm ' + Math.ceil(left % 60) + 's left');
}

function setUploadStatus(wrapper, text) {
  const el = wrapper.querySelector('.upload-status');
  if (el) el.textContent = text;
}

function togglePause(clientId) {
  const c = uploadControls[clientId];
  if (!c) return;
  const wrapper = pendingUploads[clientId] && pendingUploads[clientId].wrapper;
  const btn = wrapper && wrapper.querySelector('.upload-btn[data-role="pause"]');
  if (c.paused) {
    c.paused = false;
    c.handle.resume();
    if (btn) { btn.textContent = '⏸'; btn.title = 'Pause'; }
  } else {
    c.paused = true;
    c.handle.pause();
    if (btn) { btn.textContent = '▶'; btn.title = 'Resume'; }
  }
}

function cancelUpload(clientId) {
  const c = uploadControls[clientId];
  if (c) { c.handle.cancel(); delete uploadControls[clientId]; }
  const p = pendingUploads[clientId];
  if (p) {
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    if (p.wrapper) p.wrapper.remove();
    delete pendingUploads[clientId];
  }
  // Cancelling is a decision, not a failure: unwind quietly rather than
  // leaving a bubble offering a retry nobody asked for.
  if (c && c.resolve) c.resolve(null);
}

// Selecting media only STAGES it; everything staged is sent when the user
// hits send (with any typed text as the first item's caption). Multiple
// selection supported; staged images can be previewed and removed.
let pendingFiles = [];
// 'standard' re-encodes to something that still looks right on a screen and is
// typically five to ten times smaller; 'hd' sends the original untouched. The
// rules are shared with the app (imageQuality.js) so the same photo comes out
// the same size whichever one sent it.
let sendQuality = localStorage.getItem('sendQuality') === 'hd' ? 'hd' : 'standard';

function toggleSendQuality() {
  sendQuality = sendQuality === 'hd' ? 'standard' : 'hd';
  localStorage.setItem('sendQuality', sendQuality);
  renderPendingFiles();
}

/**
 * Re-encode one picture for sending, or hand it back untouched.
 *
 * Drawn through a canvas, which is the only resizer a browser has. Untouched
 * when the rules say so — HD, a format that must not be re-encoded, an image
 * already small enough — and untouched on any failure, because a photo that
 * sends at full size is better than a photo that does not send.
 */
async function compressForSend(file, quality) {
  if (!window.ImageQuality.shouldCompress(file.type, quality)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const target = window.ImageQuality.resizeTarget(bitmap.width, bitmap.height, quality);
    if (!target) { bitmap.close?.(); return file; }

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, target.width, target.height);
    bitmap.close?.();

    const blob = await new Promise(res =>
      canvas.toBlob(res, 'image/jpeg', window.ImageQuality.STANDARD_JPEG_QUALITY));
    if (!blob) return file;
    // A re-encode that came out BIGGER is not a saving; keep the original.
    if (blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
// ── Pasting and dropping ─────────────────────────────────────────────────────
//
// Asked for as: accept pasted and dropped images and files.
//
// Dropping a photo onto the page used to make the BROWSER open it, throwing
// away the conversation to display a JPEG, and Ctrl+V with a screenshot on the
// clipboard did nothing at all. Both now stage the files exactly as the ＋
// button does, so everything downstream — the preview strip, the HD/standard
// toggle, captions, galleries, resumable upload — works without knowing where
// the files came from.
//
// The rules (which of the things a paste carries was meant, what to call a
// nameless blob, what to refuse) are in pasteDrop.js and are tested; this is
// only the wiring.

/** Stage files that arrived by paste, drop, or the file picker. */
function stageFiles(files, opts) {
  if (!currentRoomId) return false;
  const { accepted, tooLarge, folders } = PasteDrop.partitionDropped(files);
  const complaint = PasteDrop.rejectionMessage({ tooLarge, folders });
  if (complaint) showToast(complaint);
  if (!accepted.length) return false;
  accepted.forEach(f => pendingFiles.push({ file: f, url: URL.createObjectURL(f) }));
  renderPendingFiles();
  if (!opts || !opts.keepFocus) document.getElementById('msg-input').focus();
  return true;
}

function setupPasteAndDrop() {
  // Paste anywhere in the page: the composer rarely has focus when somebody
  // takes a screenshot and hits Ctrl+V, and requiring them to click into the
  // box first is exactly the kind of small refusal that makes a feature feel
  // absent.
  document.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt || !currentRoomId) return;
    const kinds = [...(dt.items || [])].map(i => ({ kind: i.kind, type: i.type }));
    if (!PasteDrop.pasteCarriesFiles(kinds)) return;   // ordinary text paste
    const files = PasteDrop.filesFrom(dt, Date.now());
    if (!files.length) return;
    // Only now: preventing default on a text paste would break typing.
    e.preventDefault();
    // Keep the caret where it was — the message being typed is the caption.
    stageFiles(files, { keepFocus: document.activeElement === document.getElementById('msg-input') });
  });

  const zone = document.getElementById('chat-area') || document.body;
  let depth = 0;   // dragenter/dragleave fire for every child element crossed
  const overlay = () => document.getElementById('drop-overlay');
  const show = () => overlay()?.classList.remove('hidden');
  const hideOverlay = () => { depth = 0; overlay()?.classList.add('hidden'); };

  // A drop only happens where dragover was prevented, on EVERY event — the
  // browser re-asks continuously, and one unhandled frame is enough to lose
  // the drop.
  zone.addEventListener('dragover', (e) => {
    if (!PasteDrop.dragCarriesFiles([...(e.dataTransfer?.types || [])])) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragenter', (e) => {
    if (!PasteDrop.dragCarriesFiles([...(e.dataTransfer?.types || [])])) return;
    e.preventDefault();
    depth++;
    if (currentRoomId) show();
  });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) hideOverlay(); });
  zone.addEventListener('drop', (e) => {
    if (!PasteDrop.dragCarriesFiles([...(e.dataTransfer?.types || [])])) return;
    e.preventDefault();
    hideOverlay();
    if (!currentRoomId) return showToast('Open a chat first, then drop the files in.');
    stageFiles(PasteDrop.filesFrom(e.dataTransfer, Date.now()));
  });
  // Anywhere else in the window, a dropped file must NOT be opened by the
  // browser — that navigates away from the chat and loses whatever was typed.
  window.addEventListener('dragover', (e) => {
    if (PasteDrop.dragCarriesFiles([...(e.dataTransfer?.types || [])])) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!PasteDrop.dragCarriesFiles([...(e.dataTransfer?.types || [])])) return;
    e.preventDefault();
    hideOverlay();
  });
  // A drag that ends outside the window never fires dragleave on the zone.
  window.addEventListener('dragend', hideOverlay);
  window.addEventListener('blur', hideOverlay);
}

function stageFile() {
  const files = [...document.getElementById('file-input').files];
  if (!files.length || !currentRoomId) return;
  document.getElementById('file-input').value = '';
  stageFiles(files);
}

function renderPendingFiles() {
  const bar = document.getElementById('media-preview-bar');
  bar.innerHTML = '';
  if (!pendingFiles.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  pendingFiles.forEach((p, i) => {
    const item = document.createElement('div');
    item.className = 'pending-item';
    if (p.file.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = p.url;
      img.onclick = () => openLightbox(p.url); // preview before sending
      item.appendChild(img);
    } else {
      const box = document.createElement('div');
      box.className = 'pending-file-box';
      box.textContent = p.file.type.startsWith('video/') ? '🎥' : '📄';
      box.title = p.file.name;
      item.appendChild(box);
    }
    const x = document.createElement('button');
    x.className = 'pending-remove';
    x.textContent = '✕';
    x.onclick = () => { URL.revokeObjectURL(p.url); pendingFiles.splice(i, 1); renderPendingFiles(); };
    item.appendChild(x);
    bar.appendChild(item);
  });
  const add = document.createElement('button');
  add.className = 'pending-add';
  add.textContent = '＋';
  add.title = 'Add more';
  add.onclick = () => document.getElementById('file-input').click();
  bar.appendChild(add);

  // Only when there is a photo to apply it to: the toggle does nothing to a
  // PDF, and a control that does nothing is worse than no control.
  if (pendingFiles.some(p => window.ImageQuality.shouldCompress(p.file.type, 'standard'))) {
    const q = document.createElement('button');
    q.className = 'pending-quality' + (sendQuality === 'hd' ? ' on' : '');
    q.textContent = window.ImageQuality.qualityLabel(sendQuality);
    q.title = sendQuality === 'hd'
      ? 'Sending the original file. Tap for a smaller, faster upload.'
      : 'Resized for a faster upload. Tap to send the original.';
    q.onclick = toggleSendQuality;
    bar.appendChild(q);
  }
}

function sendPendingFiles() {
  if (!pendingFiles.length || !currentRoomId) return;
  const items = pendingFiles;
  pendingFiles = [];
  renderPendingFiles();
  const oneTimeSeconds = pendingOneTimeSeconds || undefined;
  clearOneTime();
  const inputEl = document.getElementById('msg-input');
  let caption = inputEl.value.trim() || null;
  if (caption) { inputEl.value = ''; updateComposerButtons(); stopTypingSignal(); }
  if (caption && currentRoomIsDM && currentDMPeerPk) {
    caption = E2E.encrypt(caption, currentDMPeerPk) || caption;
  }
  const roomId = currentRoomId, replyToId = replyTo?.id || null;

  // Re-encoded HERE, once, before anything is sent — not inside each upload,
  // so a gallery of ten photos is resized once each rather than a bubble at a
  // time while the user watches.
  const quality = sendQuality;
  const prepared = Promise.all(items.map(async p => (
    { ...p, file: await compressForSend(p.file, quality) }
  )));

  prepared.then(ready => sendPrepared(ready, caption, oneTimeSeconds, roomId, replyToId));
  cancelReply();
}

function sendPrepared(items, caption, oneTimeSeconds, roomId, replyToId) {
  const images = items.filter(p => p.file.type.startsWith('image/'));
  const others = items.filter(p => !p.file.type.startsWith('image/'));
  if (images.length > 1) {
    // Multiple images travel as ONE gallery message with the caption below.
    sendGallery(images, caption, oneTimeSeconds, roomId, replyToId);
    others.forEach(p => stagedSendOne(p, null, oneTimeSeconds, roomId, replyToId));
  } else {
    items.forEach((p, i) => stagedSendOne(p, i === 0 ? caption : null, oneTimeSeconds, roomId, replyToId));
  }
}

function stagedSendOne(p, caption, oneTimeSeconds, roomId, replyToId) {
  URL.revokeObjectURL(p.url);
  const file = p.file;
  const type = file.type.startsWith('image/') ? 'image'
    : file.type.startsWith('video/') ? 'video'
    : file.type.startsWith('audio/') ? 'music' : 'file';
  uploadAndSendMedia(file, type, file.name, file.name, roomId, replyToId, caption, oneTimeSeconds);
}

// Uploads several images and sends them as ONE gallery message.
async function sendGallery(images, caption, oneTimeSeconds, roomId, replyToId) {
  const clientId = 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const tempMsg = {
    id: clientId, username, avatar: localStorage.getItem('avatar') || '',
    type: 'gallery', content: caption,
    file_path: JSON.stringify(images.map(p => p.url)), file_name: null,
    created_at: new Date().toISOString(),
    reply_to_id: replyTo?.id || null, reply_username: replyTo?.username || null,
    _uploading: true, _progress: 0,
  };
  const wrapper = buildMessageElement(tempMsg);
  document.getElementById('messages').appendChild(wrapper);
  scrollBottom();
  pendingUploads[clientId] = { wrapper, previewUrl: null };

  try {
    // One bar for the whole album, and the same pause and cancel buttons: the
    // photo in flight owns them, and the next one takes them over.
    const progress = images.map(() => 0);
    const urls = [];
    for (let i = 0; i < images.length; i++) {
      const res = await resumableUpload(images[i].file, images[i].file.name, clientId, wrapper);
      if (!res) return;                    // cancelled: the bubble is gone
      if (res.error) throw new Error(res.error);
      progress[i] = 100;
      updateUploadProgress(wrapper, Math.round(progress.reduce((a, b) => a + b, 0) / images.length));
      urls.push(res.url);
    }
    if (!pendingUploads[clientId]) return;
    images.forEach(p => URL.revokeObjectURL(p.url));
    socket.emit('send_message', {
      roomId, type: 'gallery', content: caption, filePath: JSON.stringify(urls),
      fileName: null, replyToId, clientId, oneTimeSeconds,
    });
  } catch {
    if (pendingUploads[clientId]) {
      markUploadFailed(wrapper, clientId, () => sendGallery(images, caption, oneTimeSeconds, roomId, replyToId));
    }
  }
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
    socket?.emit('recording_start', { roomId: currentRoomId });

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
  socket?.emit('recording_stop', { roomId: currentRoomId });
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
  socket?.emit('recording_stop', { roomId: currentRoomId });
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
    previewAudio.currentTime = 0;
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
  if (previewAudio.paused) {
    if (previewAudio.ended || previewAudio.currentTime >= previewAudio.duration) previewAudio.currentTime = 0;
    previewAudio.play(); btn.textContent = '⏸';
  } else { previewAudio.pause(); btn.textContent = '▶'; }
}

function cancelPreview() {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  resetRecordingUI();
}

function sendRecording() {
  if (!recordedBlob || recordedBlob.size < 500) return;
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  const ext = recordedMime.includes('mp4') ? 'mp4' : recordedMime.includes('ogg') ? 'ogg' : 'webm';
  // Store normalized peaks in the filename slot for waveform rendering
  const peaks = normalizePeaks(previewWaveformPeaks, 50).map(v => Math.round(v * 100)).join(',');
  const roomId = currentRoomId, replyToId = replyTo?.id || null;
  const oneTimeSeconds = pendingOneTimeSeconds || undefined;
  clearOneTime();
  uploadAndSendMedia(recordedBlob, 'audio', `voice-${Date.now()}.${ext}`, peaks, roomId, replyToId, null, oneTimeSeconds);
  resetRecordingUI();
  cancelReply();
}

// ─── Links in messages ────────────────────────────────────────────────────────
// URLs (with or without protocol), card numbers, and phone numbers each get a
// small copy icon.
// Digits come in three flavours users type here: ASCII, Persian (۰-۹) and
// Arabic-Indic (٠-٩). All are recognised; tel: links need ASCII.
const DIGITS = '0-9۰-۹٠-٩';
const TOKEN_RE = new RegExp(
  '(https?:\\/\\/[^\\s]+|(?:[a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(?:\\/[^\\s]*)?' +
  `|\\+?[${DIGITS}](?:[ \\-()\\u200f\\u200e.]?[${DIGITS}]){7,17}` +
  `|[${DIGITS}]+(?:[.,\\u066B\\u066C][${DIGITS}]+)*)`, 'g');
const URLISH_RE = /^(https?:\/\/|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})/;

function toAsciiDigits(str) {
  return String(str).replace(/[۰-۹٠-٩]/g, ch => {
    const c = ch.charCodeAt(0);
    return String(c - (c >= 0x06F0 ? 0x06F0 : 0x0660));
  });
}
function countDigits(str) {
  return (String(str).match(new RegExp('[' + DIGITS + ']', 'g')) || []).length;
}
function isPhoneToken(t) {
  if (URLISH_RE.test(t)) return false;
  const d = countDigits(t);
  if (d < 8 || d > 15) return false;
  return !/[.,٫]\d{1,2}$/.test(t);
}

// Non-blocking "Copied" confirmation, so the user always knows it worked.
let toastTimer = null;
function showToast(message) {
  let el = document.getElementById('copy-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'copy-toast';
    el.className = 'copy-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1500);
}

function copyToClipboard(text, label) {
  const done = () => showToast(label ? 'Copied ' + label : 'Copied');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, done);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove(); done();
  }
}

// Tapping a link or phone number offers BOTH sensible actions rather than
// guessing which one was meant.
function openTokenMenu(kind, text) {
  const back = document.createElement('div');
  back.className = 'token-menu-backdrop';
  const card = document.createElement('div');
  card.className = 'token-menu';
  const preview = document.createElement('div');
  preview.className = 'token-menu-preview';
  preview.textContent = text;
  card.appendChild(preview);

  const addRow = (icon, label, fn) => {
    const b = document.createElement('button');
    b.className = 'token-menu-row';
    b.innerHTML = '<span>' + icon + '</span>';
    b.appendChild(document.createTextNode(' ' + label));
    b.onclick = (e) => { e.stopPropagation(); back.remove(); fn(); };
    card.appendChild(b);
  };
  addRow('📋', 'Copy', () => copyToClipboard(text, kind === 'phone' ? 'number' : 'link'));
  if (kind === 'phone') {
    const ascii = toAsciiDigits(text);
    const tel = 'tel:' + (ascii.trim().startsWith('+') ? '+' : '') + ascii.replace(/[^\d]/g, '');
    addRow('📞', 'Call ' + ascii, () => { location.href = tel; });
  } else {
    const href = /^https?:\/\//.test(text) ? text : 'https://' + text;
    addRow('🌐', 'Open link', () => {
      const joinMatch = /\/join\/(\d+)/.exec(href);
      if (joinMatch && href.startsWith(location.origin)) openRoomById(joinMatch[1]);
      else window.open(href, '_blank', 'noopener');
    });
  }
  const cancel = document.createElement('button');
  cancel.className = 'token-menu-cancel';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => back.remove();
  card.appendChild(cancel);

  back.appendChild(card);
  back.onclick = () => back.remove();
  document.body.appendChild(back);
}

function appendLinkifiedText(container, content) {
  let hasCopyable = false;
  let last = 0;
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m;
  const src = String(content ?? '');
  while ((m = re.exec(src))) {
    if (m.index > last) container.appendChild(document.createTextNode(src.slice(last, m.index)));
    const raw = m[0];
    const tok = raw.replace(/[\s.,\-()]+$/, '');
    const tail = raw.slice(tok.length);
    if (!tok) {
      container.appendChild(document.createTextNode(raw));
    } else if (URLISH_RE.test(tok)) {
      hasCopyable = true;
      const a = document.createElement('a');
      a.href = '#'; a.textContent = tok; a.className = 'msg-link';
      a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openTokenMenu('url', tok); };
      container.appendChild(a);
    } else if (isPhoneToken(tok)) {
      hasCopyable = true;
      const b = document.createElement('span');
      b.className = 'copyable-phone';
      b.textContent = tok;
      b.onclick = (e) => { e.stopPropagation(); openTokenMenu('phone', tok); };
      container.appendChild(b);
    } else if (countDigits(tok) > 0) {
      hasCopyable = true;
      const span = document.createElement('span');
      span.className = 'copyable-number';
      span.title = 'Tap to copy';
      span.textContent = tok;
      span.onclick = (e) => { e.stopPropagation(); copyToClipboard(tok, 'number'); };
      container.appendChild(span);
    } else {
      container.appendChild(document.createTextNode(raw));
    }
    if (tail) container.appendChild(document.createTextNode(tail));
    last = m.index + raw.length;
  }
  if (last < src.length) container.appendChild(document.createTextNode(src.slice(last)));
  return hasCopyable;
}

// Open a public room found by search or reached by link. This only OPENS it —
// joining is a deliberate act, done with the Join bar inside the room once the
// visitor has read it. (Following a link used to silently make you a member.)
async function openRoomById(roomId) {
  const info = await api('/room-info/' + roomId);
  if (info.error) return alert(info.error);
  let li = document.querySelector(`[data-room-id="${info.id}"]`);
  if (!li) { addRoomToList(info); li = document.querySelector(`[data-room-id="${info.id}"]`); }
  if (li) joinRoom(info.id, info.name, li, false);
}

function acceptInvite(roomId) {
  socket.emit('accept_invite', { roomId }, (res) => {
    if (res?.error) return alert(res.error);
    addRoomToList(res.room);
    const li = document.querySelector(`[data-room-id="${res.room.id}"]`);
    if (li) joinRoom(res.room.id, res.room.name, li, false);
  });
}

// ─── Global audio coordination ───────────────────────────────────────────────
// Only one piece of media plays at a time across the whole app.
let currentMedia = null; // { el, stop } — el is an Audio/video element
function claimPlayback(el, stopFn) {
  if (currentMedia && currentMedia.el !== el) {
    try { currentMedia.stop(); } catch {}
  }
  currentMedia = { el, stop: stopFn };
}

// Auto-play the next voice message in the chat after one finishes
function playNextVoiceAfter(wrapperEl) {
  let el = wrapperEl.nextElementSibling;
  while (el) {
    const btn = el.querySelector('.voice-play-btn');
    if (btn) { btn.click(); return; }
    el = el.nextElementSibling;
  }
}

// Starts a one-time message's destruction clock only once its content is
// actually available to the viewer: immediately for text/files, when loaded
// for images/videos, on first play for voice/music.
const oneTimeClockStarted = new Set();
function armOneTimeClock(msg, wrapperEl) {
  const start = () => {
    if (oneTimeClockStarted.has(msg.id)) return;
    oneTimeClockStarted.add(msg.id);
    socket.emit('view_one_time', { messageId: msg.id });
  };
  if (msg.type === 'image' || msg.type === 'gallery') {
    // Only a successful, complete load starts the clock — a failed download
    // must not consume the viewing window.
    const img = wrapperEl.querySelector('img');
    if (!img) return;
    if (img.complete && img.naturalWidth > 0) return start();
    img.addEventListener('load', start, { once: true });
  } else if (msg.type === 'video') {
    const video = wrapperEl.querySelector('video');
    if (!video) return;
    if (video.readyState >= 2) return start();
    video.addEventListener('loadeddata', start, { once: true });
  } else if (msg.type === 'audio') {
    const playBtn = wrapperEl.querySelector('.voice-play-btn');
    if (!playBtn) return start();
    playBtn.addEventListener('click', start, { once: true });
  } else if (msg.type === 'music') {
    const audio = wrapperEl.querySelector('audio');
    if (!audio) return start();
    audio.addEventListener('play', start, { once: true });
  } else {
    start();
  }
}

// Shows a spinner over an image/video bubble until the media finishes loading.
function attachDownloadSpinner(bubble, type) {
  const el = type === 'image' ? bubble.querySelector('img') : type === 'video' ? bubble.querySelector('video') : null;
  if (!el) return;
  const spinner = document.createElement('div');
  spinner.className = 'download-spinner';
  bubble.appendChild(spinner);
  const done = () => spinner.remove();
  if (type === 'image') {
    if (el.complete) return done();
    el.addEventListener('load', done, { once: true });
    el.addEventListener('error', done, { once: true });
  } else {
    if (el.readyState >= 2) return done();
    el.addEventListener('loadeddata', done, { once: true });
    el.addEventListener('error', done, { once: true });
  }
}

// ─── Render messages ──────────────────────────────────────────────────────────
const SENT_TICKS = '<svg viewBox="0 0 16 10" class="ticks"><path d="M1 5.5L4.5 9L10 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SEEN_TICKS = '<svg viewBox="0 0 16 10" class="ticks"><path d="M1 5.5L4.5 9L10 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 5.5L9.5 9L15 1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function updateSeenCheckmarks() {
  document.querySelectorAll('.msg-status').forEach(el => {
    const seen = Number(el.dataset.msgId) <= maxOtherReadMsgId;
    el.innerHTML = seen ? SEEN_TICKS : SENT_TICKS;
    el.classList.toggle('seen', seen);
  });
}

// A location message on the web: a static OpenStreetMap frame with the pin,
// plus a link out to a real map. Live shares keep re-rendering as the sender
// moves, because `location_updated` rewrites the message's content.
// A visibly different chat while messages are being destroyed. Forgetting the
// mode is on is exactly when it does damage, so the whole page says so.
// Report which disappearing messages are actually ON SCREEN, so their
// countdowns start when they are seen rather than when they were sent. Being
// scrolled up in a long chat is not reading the bottom of it.
const seenReported = new Set();
let seenObserver = null;
let seenPending = new Set();
let seenTimer = null;

function flushSeen() {
  const ids = [...seenPending];
  seenPending.clear();
  if (!ids.length || !socket || !currentRoomId) return;
  socket.emit('messages_seen', { roomId: currentRoomId, messageIds: ids });
}

function watchForSeen(el, msg) {
  if (!msg || !msg.disappear_seconds || msg.expires_at) return;
  if (msg.username === username) return;   // your own message proves nothing
  const key = String(msg.id);
  if (seenReported.has(key)) return;
  if (!('IntersectionObserver' in window)) {
    // No observer: treat rendering as seeing rather than never expiring.
    seenReported.add(key); seenPending.add(msg.id);
    clearTimeout(seenTimer); seenTimer = setTimeout(flushSeen, 400);
    return;
  }
  if (!seenObserver) {
    seenObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = e.target.dataset.msgId;
        if (!id || seenReported.has(String(id))) continue;
        seenReported.add(String(id));
        seenPending.add(parseInt(id, 10));
        seenObserver.unobserve(e.target);
      }
      if (seenPending.size) { clearTimeout(seenTimer); seenTimer = setTimeout(flushSeen, 400); }
    }, { threshold: 0.5 });
  }
  seenObserver.observe(el);
}

// /room-media returns objects now ({url, msgId, name}); it used to return bare
// strings. Both shapes are accepted so a browser talking to an older server
// does not render an empty gallery.
function mediaUrl(x) { return typeof x === 'string' ? x : (x && x.url) || ''; }
function mediaName(x) { return (x && x.name) || mediaUrl(x).split('/').pop() || 'file'; }

function applyDisappearingSkin(seconds) {
  document.body.classList.toggle('disappearing-on', seconds > 0);
  let bar = document.getElementById('disappearing-bar');
  if (!seconds) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'disappearing-bar';
    bar.className = 'disappearing-bar';
    const msgs = document.getElementById('messages');
    if (msgs && msgs.parentNode) msgs.parentNode.insertBefore(bar, msgs);
  }
  const label = seconds === 30 ? '30 seconds' : seconds === 300 ? '5 minutes'
    : seconds === 3600 ? '1 hour' : seconds === 86400 ? '24 hours'
    : seconds === 604800 ? '1 week' : `${seconds} seconds`;
  bar.textContent = `\u23F3  Disappearing messages on \u00B7 ${label} after reading`;
}

function buildLocationCard(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'loc-card';
  let p = null;
  try { p = JSON.parse(msg.content || ''); } catch {}
  if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') {
    wrap.textContent = '📍 Location (unreadable)';
    return wrap;
  }
  // Read back by the picker, so a browser that cannot find you still opens
  // somewhere near the conversation rather than in the middle of the ocean.
  wrap.dataset.lat = p.lat;
  wrap.dataset.lng = p.lng;
  const live = !!(p.liveUntil && p.liveUntil > Date.now());
  const url = `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=16/${p.lat}/${p.lng}`;

  // Tiles come from OUR server, not openstreetmap.org: foreign map services
  // are blocked for users in Iran, so the embedded OSM frame this used to
  // render just showed nothing. Three tiles wide is enough to give the pin
  // some context without needing a map library.
  const Z = 15, TILE = 256;
  const n = Math.pow(2, Z);
  const cx = ((p.lng + 180) / 360) * n;
  const latRad = (p.lat * Math.PI) / 180;
  const cy = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  const x0 = Math.floor(cx), y0 = Math.floor(cy);

  const map = document.createElement('a');
  map.className = 'loc-map';
  map.href = url; map.target = '_blank'; map.rel = 'noopener';
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tx = x0 + dx, ty = y0 + dy;
      if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
      const img = document.createElement('img');
      img.className = 'loc-tile';
      img.loading = 'lazy';
      img.src = `/tiles/${Z}/${tx}/${ty}.png`;
      // Positioned so the exact point sits in the middle of the frame.
      img.style.left = `${(tx - cx) * TILE + 130}px`;
      img.style.top = `${(ty - cy) * TILE + 75}px`;
      map.appendChild(img);
    }
  }
  const marker = document.createElement('div');
  marker.className = 'loc-pin';
  marker.textContent = live ? '🟢' : '📍';
  map.appendChild(marker);
  wrap.appendChild(map);

  const foot = document.createElement('a');
  foot.className = 'loc-foot';
  foot.href = url; foot.target = '_blank'; foot.rel = 'noopener';
  const title = document.createElement('div');
  title.className = 'loc-title';
  title.textContent = live ? '🟢 Live location' : '📍 Location';
  const sub = document.createElement('div');
  sub.className = 'loc-sub';
  sub.textContent = live
    ? `updating · until ${new Date(p.liveUntil).toLocaleTimeString()}`
    : `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  foot.appendChild(title); foot.appendChild(sub);
  wrap.appendChild(foot);
  return wrap;
}

function buildMessageElement(msg) {
  if (E2E.isEncrypted(msg.content) || E2E.isEncrypted(msg.reply_content)) {
    msg = { ...msg };
    if (E2E.isEncrypted(msg.content)) {
      const dec = E2E.decrypt(msg.content, currentDMPeerPk);
      msg.content = dec !== null ? dec : '🔒 Encrypted message (cannot decrypt on this device)';
    }
    if (E2E.isEncrypted(msg.reply_content)) {
      const decR = E2E.decrypt(msg.reply_content, currentDMPeerPk);
      msg.reply_content = decR !== null ? decR : '🔒 Encrypted';
    }
  }
  const isMine = msg.username === username;

  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper ' + (isMine ? 'mine' : 'theirs');
  wrapper.dataset.msgId = msg.id;
  // The deadline travels with the bubble, so the sweep below can find it
  // without keeping a parallel list of what is on screen.
  if (msg.expires_at) wrapper.dataset.expiresAt = String(msg.expires_at);
  if (!msg._uploading) addLongPress(wrapper, () => openCtxMenu(msg.id, msg.type, isMine, wrapper, msg));
  // Its disappearing clock starts when it is actually on screen.
  watchForSeen(wrapper, msg);

  // System notices carry their own centered text; they must not get a
  // clickable sender header above them.
  if (!isMine && msg.type !== 'system') {
    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    const senderAvatar = document.createElement('span');
    senderAvatar.className = 'msg-sender-avatar';
    senderAvatar.textContent = msg.avatar || '🙂';
    const senderName = document.createElement('span');
    senderName.textContent = msg.username;
    sender.appendChild(senderAvatar);
    sender.appendChild(senderName);
    if (!currentRoomIsDM) {
      sender.classList.add('clickable');
      sender.title = `Message ${msg.username}`;
      // The person's sheet, not straight into a DM. Mute, block and clear are
      // things you reach for ABOUT somebody, and jumping into a conversation
      // with them is the one thing you may not want.
      sender.onclick = (e) => { e.stopPropagation(); window.Peer.open(msg.username, { isDm: false }); };
    }
    wrapper.appendChild(sender);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msg.reply_to_id && msg.reply_username) {
    const quote = document.createElement('div');
    quote.className = 'reply-quote';
    quote.onclick = (e) => { e.stopPropagation(); jumpToMessage(msg.reply_to_id); };
    const quoteUser = document.createElement('span');
    quoteUser.className = 'reply-quote-user';
    quoteUser.textContent = msg.reply_username;
    const quoteText = document.createElement('span');
    quoteText.className = 'reply-quote-text';
    quoteText.textContent = msg.reply_type === 'text' ? (msg.reply_content || '').slice(0, 80)
      : msg.reply_type === 'audio' ? '🎙 Voice message'
      : msg.reply_type === 'image' ? '🖼 Image'
      : msg.reply_type === 'video' ? '🎥 Video'
      : msg.reply_type === 'location' ? '📍 Location'
      : msg.reply_type === 'music' ? '🎵 Audio file'
      : msg.reply_type === 'gallery' ? '🖼 Photos' : '📄 File';
    quote.appendChild(quoteUser);
    quote.appendChild(quoteText);
    bubble.appendChild(quote);
  }

  if (msg.forwarded_from) {
    const fwd = document.createElement('div');
    fwd.className = 'forwarded-label';
    fwd.textContent = '↪ Forwarded from ' + msg.forwarded_from;
    bubble.appendChild(fwd);
  }

  const oneTimeHidden = msg.one_time_seconds && !revealedOneTime.has(msg.id);
  if (oneTimeHidden) {
    bubble.classList.add('one-time-bubble');
    const btn = document.createElement('button');
    btn.className = 'one-time-reveal';
    btn.textContent = `🔥 One-time message — tap to view (${msg.one_time_seconds}s)`;
    btn.onclick = (e) => {
      e.stopPropagation();
      revealedOneTime.add(msg.id);
      const revealed = buildMessageElement(msg);
      wrapper.replaceWith(revealed);
      if (!isMine) armOneTimeClock(msg, revealed); // own views never start the clock
    };
    bubble.appendChild(btn);
  } else if (msg.type === 'text') {
    bubble.dataset.text = msg.content;
    const textSpan = document.createElement('span');
    if (appendLinkifiedText(textSpan, msg.content || '')) bubble.classList.add('has-copyable');
    bubble.appendChild(textSpan);
    if (msg.edited) { const tag = document.createElement('span'); tag.className = 'edited-tag'; tag.textContent = '(edited)'; bubble.appendChild(tag); }
    if (msg.one_time_seconds) { const ot = document.createElement('span'); ot.className = 'one-time-tag'; ot.textContent = ` 🔥${msg.one_time_seconds}s`; bubble.appendChild(ot); }
  } else if (msg.type === 'call') {
    let c = {};
    try { c = JSON.parse(msg.content || '{}'); } catch {}
    const el = document.createElement('div');
    el.className = 'call-log' + (c.outcome !== 'completed' ? ' call-log-bad' : '');
    const fmtDur = s => s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    const label = c.outcome === 'completed' ? `${c.kind === 'video' ? 'Video' : 'Voice'} call · ${fmtDur(c.duration || 0)}`
      : c.outcome === 'declined' ? 'Call declined'
      : c.outcome === 'missed' ? 'Missed call' : 'Call failed';
    el.textContent = `${c.kind === 'video' ? '🎥' : '📞'} ${label}`;
    bubble.appendChild(el);
  } else if (msg.type === 'system') {
    // Room notice: someone joined, left, or was removed. A centered line. The
    // name is NOT a link — these are announcements, not people to message, and
    // a stray tap opening a DM was surprising.
    let d = {};
    try { d = JSON.parse(msg.content || '{}'); } catch {}
    const who = d.username || msg.username;
    const isMe = who === username;
    const el = document.createElement('div');
    el.className = 'system-notice';
    const nameEl = document.createElement('span');
    nameEl.className = 'system-name';
    nameEl.textContent = (d.avatar ? d.avatar + ' ' : '') + (isMe ? 'You' : who);
    el.appendChild(nameEl);
    const rest = document.createElement('span');
    // Mirrors disappearingLabel() in the app — the same six choices.
    const durLabel = (secs) => secs === 30 ? '30 seconds' : secs === 300 ? '5 minutes'
      : secs === 3600 ? '1 hour' : secs === 86400 ? '24 hours' : secs === 604800 ? '1 week'
      : secs < 60 ? `${secs} seconds` : secs < 3600 ? `${Math.round(secs / 60)} minutes`
      : secs < 86400 ? `${Math.round(secs / 3600)} hours` : `${Math.round(secs / 86400)} days`;
    rest.textContent = d.kind === 'disappearing_on'
      ? ` turned on disappearing messages — new messages vanish ${durLabel(d.seconds || 0)} after they are read`
      : d.kind === 'disappearing_off'
      ? ' turned off disappearing messages'
      : d.kind === 'removed'
      ? ` ${isMe ? 'were' : 'was'} removed from the room${d.byUsername ? ' by ' + d.byUsername : ''}`
      : d.kind === 'left'
      ? ` left the room`
      : ' joined the room';
    el.appendChild(rest);
    bubble.appendChild(el);
  } else if (msg.type === 'invite') {
    let inv = null;
    try { inv = JSON.parse(msg.content || ''); } catch {}
    const card = document.createElement('div');
    card.className = 'invite-card';
    const title = document.createElement('div');
    title.className = 'invite-title'; title.textContent = '🔒 Room invitation';
    const text = document.createElement('div');
    text.className = 'invite-text';
    text.textContent = (msg.username === username ? 'You invited someone to' : `${msg.username} invited you to`) + ` “${inv?.roomName || 'a room'}”`;
    card.appendChild(title); card.appendChild(text);
    if (msg.username !== username && inv?.roomId) {
      const btn = document.createElement('button');
      btn.className = 'invite-join-btn'; btn.textContent = 'Join room';
      btn.onclick = (e) => { e.stopPropagation(); acceptInvite(inv.roomId); };
      card.appendChild(btn);
    }
    bubble.appendChild(card);
  } else if (msg.type === 'image') {
    const img = document.createElement('img');
    img.src = msg.file_path; img.onclick = () => openLightbox(msg.file_path);
    if (msg.one_time_seconds) { oneTimeMediaUrls.add(img.src); img.draggable = false; }
    bubble.appendChild(img);
  } else if (msg.type === 'gallery') {
    let urls = [];
    try { urls = JSON.parse(msg.file_path || '[]'); } catch {}
    const grid = document.createElement('div');
    grid.className = 'gallery-grid';
    urls.forEach(u => {
      const src = msg._uploading ? u : u; // object URLs while uploading, server paths after
      const img = document.createElement('img');
      img.src = src;
      img.onclick = () => openLightbox(src);
      if (msg.one_time_seconds) { oneTimeMediaUrls.add(img.src); img.draggable = false; }
      grid.appendChild(img);
    });
    bubble.appendChild(grid);
  } else if (msg.type === 'audio') {
    bubble.appendChild(buildVoicePlayer(msg));
  } else if (msg.type === 'video') {
    const video = document.createElement('video');
    video.src = msg.file_path; video.controls = true; video.className = 'msg-video';
    video.preload = 'metadata';
    video.onplay = () => claimPlayback(video, () => video.pause());
    bubble.appendChild(video);
  } else if (msg.type === 'location') {
    bubble.appendChild(buildLocationCard(msg));
  } else if (msg.type === 'music') {
    const wrap = document.createElement('div');
    wrap.className = 'music-player';
    const label = document.createElement('div');
    label.className = 'music-label'; label.textContent = '🎵 ' + (msg.file_name || 'Audio');
    const audio = document.createElement('audio');
    audio.src = msg.file_path; audio.controls = true; audio.className = 'music-audio';
    audio.onplay = () => claimPlayback(audio, () => audio.pause());
    wrap.appendChild(label); wrap.appendChild(audio);
    bubble.appendChild(wrap);
  } else {
    const a = document.createElement('a');
    a.className = 'file-link';
    if (msg.file_path) { a.href = msg.file_path; a.target = '_blank'; }
    else a.onclick = (e) => e.preventDefault();
    a.download = msg.file_name || 'file';
    a.innerHTML = '📄 ' + (msg.file_name || 'Download file');
    bubble.appendChild(a);
  }

  // Captions belong to media messages. Types whose content IS their payload
  // must be excluded — 'system' was missing, so every join/leave notice also
  // dumped its raw JSON underneath itself as a "caption".
  const CAPTIONLESS = ['text', 'invite', 'call', 'system', 'location'];
  if (!oneTimeHidden && !CAPTIONLESS.includes(msg.type) && msg.content) {
    const cap = document.createElement('div');
    cap.className = 'msg-caption';
    appendLinkifiedText(cap, msg.content);
    bubble.appendChild(cap);
  }

  if (msg.one_time_seconds && !oneTimeHidden) {
    const hideBtn = document.createElement('button');
    hideBtn.className = 'one-time-hide';
    hideBtn.textContent = '🙈 Hide';
    hideBtn.onclick = (e) => {
      e.stopPropagation();
      revealedOneTime.delete(msg.id);
      wrapper.replaceWith(buildMessageElement(msg));
    };
    bubble.appendChild(hideBtn);
  }

  if (msg._uploading) {
    wrapper.classList.add('msg-uploading');
    const overlay = document.createElement('div');
    overlay.className = 'upload-overlay';
    const bar = document.createElement('div');
    bar.className = 'upload-progress-bar';
    bar.style.width = (msg._progress || 0) + '%';
    overlay.appendChild(bar);
    bubble.appendChild(overlay);

    // A bar creeping along with no numbers and no way to stop it is the worst
    // version of a slow upload: you cannot tell whether it is moving, and you
    // cannot give up without closing the tab.
    const row = document.createElement('div');
    row.className = 'upload-row';
    const status = document.createElement('span');
    status.className = 'upload-status';
    status.dataset.msgId = msg.id;
    row.appendChild(status);
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'upload-btn';
    pauseBtn.dataset.role = 'pause';
    pauseBtn.textContent = '⏸';
    pauseBtn.title = 'Pause';
    pauseBtn.onclick = (e) => { e.stopPropagation(); togglePause(msg.id); };
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'upload-btn';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Cancel';
    cancelBtn.onclick = (e) => { e.stopPropagation(); cancelUpload(msg.id); };
    row.appendChild(pauseBtn);
    row.appendChild(cancelBtn);
    bubble.appendChild(row);
  }
  if (['image', 'video', 'audio', 'music'].includes(msg.type) && !msg._uploading) {
    attachDownloadSpinner(bubble, msg.type);
  }
  // Bubble sits in a row with the ⋮ actions button BESIDE it, not under it
  const bubbleRow = document.createElement('div');
  bubbleRow.className = 'bubble-row';
  bubbleRow.appendChild(bubble);
  if (!msg._uploading) {
    const menuBtn = document.createElement('button');
    menuBtn.className = 'msg-menu-btn'; menuBtn.textContent = '⋮'; menuBtn.title = 'Message actions';
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const menuEl = document.getElementById('ctx-menu');
      if (!menuEl.classList.contains('hidden')) { closeCtxMenu(); return; }
      openCtxMenu(msg.id, msg.type, isMine, menuBtn, msg);
    };
    bubbleRow.appendChild(menuBtn);
  }
  wrapper.appendChild(bubbleRow);

  const footer = document.createElement('div');
  footer.className = 'msg-footer';
  const time = document.createElement('span');
  time.className = 'msg-time';
  const created = msg.created_at.includes('T') ? msg.created_at : msg.created_at.replace(' ', 'T') + 'Z';
  time.textContent = new Date(created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  footer.appendChild(time);

  if (msg.one_time_seconds) {
    const ot = document.createElement('span');
    ot.className = 'one-time-tag one-time-countdown';
    ot.dataset.msgId = msg.id;
    const exp = oneTimeExpiry[msg.id] || (msg.viewed_at ? msg.viewed_at + msg.one_time_seconds * 1000 : 0);
    if (exp) { ot.dataset.expire = exp; ot.textContent = ` 🔥${Math.max(0, Math.ceil((exp - Date.now()) / 1000))}s`; }
    else ot.textContent = ` 🔥${msg.one_time_seconds}s`;
    footer.appendChild(ot);
  }

  // A message the server accepted and deliberately never delivered, because
  // the other person has blocked me. Drawn faded and dashed, with NO tick — a
  // ✓ claiming delivery would be the one outright lie in the design. Nothing
  // says "you have been blocked"; it is meant to feel wrong, not to announce
  // somebody else's decision.
  const vanished = window.PeerActions.vanishedStyle(msg.blocked_delivery);
  if (vanished.faded) wrapper.classList.add('msg-vanished');

  if (isMine && !msg._uploading && vanished.showTicks) {
    const status = document.createElement('span');
    status.className = 'msg-status';
    status.dataset.msgId = msg.id;
    status.innerHTML = msg.id <= maxOtherReadMsgId ? SEEN_TICKS : SENT_TICKS;
    if (msg.id <= maxOtherReadMsgId) status.classList.add('seen');
    footer.appendChild(status);
  }

  if (!msg._uploading) {
    const reactBtn = document.createElement('button');
    reactBtn.className = 'react-btn'; reactBtn.textContent = '😊'; reactBtn.title = 'React';
    reactBtn.onclick = (e) => { e.stopPropagation(); showEmojiPicker(msg.id, reactBtn, wrapper); };
    footer.appendChild(reactBtn);
  }

  wrapper.appendChild(footer);
  const reactionsRow = document.createElement('div');
  reactionsRow.className = 'reactions-row'; reactionsRow.id = 'reactions-' + msg.id;
  wrapper.appendChild(reactionsRow);
  return wrapper;
}

function appendMessage(msg) {
  const container = document.getElementById('messages');
  container.appendChild(buildMessageElement(msg));
  scrollBottom();
  // A message can arrive already counting down — the deadline is set when the
  // reader sees it, and a second device is a reader too.
  if (msg.expires_at) scheduleExpirySweep();
}

// Prepend a page of older messages (already in ascending/chronological order)
// while preserving the user's current scroll position.
function prependMessages(msgs) {
  if (!msgs.length) return;
  const container = document.getElementById('messages');
  const prevScrollHeight = container.scrollHeight;
  const prevScrollTop = container.scrollTop;
  const frag = document.createDocumentFragment();
  msgs.forEach(m => frag.appendChild(buildMessageElement(m)));
  container.insertBefore(frag, container.firstChild);
  container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
}

// ─── Context menu ─────────────────────────────────────────────────────────────
function openCtxMenu(messageId, type, isMine, wrapperEl, msg) {
  ctxTarget = { messageId, type, isMine, username: msg?.username, content: msg?.content, filePath: msg?.file_path, fileName: msg?.file_name };
  const menu = document.getElementById('ctx-menu');
  document.getElementById('ctx-edit-btn').style.display = (isMine && type === 'text') ? '' : 'none';
  document.getElementById('ctx-forward-btn').style.display = (type !== 'invite' && !msg?.one_time_seconds) ? '' : 'none';
  document.getElementById('ctx-download-btn').style.display = (msg?.file_path && !msg?.one_time_seconds) ? '' : 'none';
  menu.querySelector('button.danger').style.display = isMine ? '' : 'none';
  menu.querySelector('hr').style.display = isMine ? '' : 'none';
  menu.classList.remove('hidden');
  const rect = wrapperEl.getBoundingClientRect();
  // Measure the menu's real size now that it's visible, and keep it above the
  // composer/input bar so it never slides underneath that section.
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 160;
  const composer = document.getElementById('input-bar') || document.getElementById('composer-strip');
  const floorY = (composer ? composer.getBoundingClientRect().top : window.innerHeight) - 8;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + mw > window.innerWidth) left = window.innerWidth - mw - 8;
  // If opening downward would collide with the composer, open upward instead.
  if (top + mh > floorY) top = rect.top - mh - 4;
  if (top < 4) top = Math.max(4, floorY - mh); // still clamp within the viewport
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = top + 'px';
}
function closeCtxMenu() { document.getElementById('ctx-menu').classList.add('hidden'); ctxTarget = null; }
function ctxReply() {
  if (!ctxTarget) return;
  const t = ctxTarget;
  closeCtxMenu();
  setReply({ id: t.messageId, username: t.username, content: t.content, type: t.type });
}

function ctxDownload() {
  if (!ctxTarget?.filePath) return;
  let paths = [ctxTarget.filePath];
  if (ctxTarget.type === 'gallery') {
    try { paths = JSON.parse(ctxTarget.filePath); } catch {}
  }
  paths.forEach((pth, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = pth;
      a.download = (ctxTarget?.fileName && !ctxTarget.fileName.includes(',')) ? ctxTarget.fileName : '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 300);
  });
  closeCtxMenu();
}

function ctxCopy() {
  if (!ctxTarget) return;
  const t = ctxTarget;
  closeCtxMenu();
  const text = t.type === 'text' ? (t.content || '') : t.filePath ? location.origin + t.filePath : '';
  if (text) copyToClipboard(text, null);
}

function ctxForward() {
  if (!ctxTarget) return;
  const id = ctxTarget.messageId;
  closeCtxMenu();
  openForwardModal(id);
}

let forwardMsgId = null;
async function openForwardModal(messageId) {
  forwardMsgId = messageId;
  const list = document.getElementById('forward-list');
  list.innerHTML = '';
  const [rooms, dms] = await Promise.all([api('/rooms'), api('/dm-rooms')]);
  const targets = [
    ...(Array.isArray(rooms) ? rooms.map(r => ({ id: r.id, label: (r.is_private ? '🔒 ' : '# ') + r.name })) : []),
    ...(Array.isArray(dms) ? dms.map(d => ({ id: d.id, label: '💬 ' + d.other_username })) : []),
  ];
  targets.forEach(t => {
    const li = document.createElement('li');
    li.textContent = t.label;
    li.onclick = () => {
      socket.emit('forward_message', { messageId: forwardMsgId, toRoomId: t.id }, (res) => {
        if (res?.error) alert(res.error);
      });
      closeForwardModal();
    };
    list.appendChild(li);
  });
  show('forward-modal');
}
function closeForwardModal() { forwardMsgId = null; hide('forward-modal'); }
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

  // Opened indicator: bright dot until the receiving side has played it
  const dot = document.createElement('span');
  dot.className = 'voice-played-dot' + (msg.played ? ' played' : '');
  dot.dataset.msgId = msg.id;
  player.appendChild(dot);

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
  function stopThis() {
    audio.pause(); playing = false; playBtn.innerHTML = '▶';
    cancelAnimationFrame(rafId);
  }

  audio.onended = () => {
    playing = false; playBtn.innerHTML = '▶';
    cancelAnimationFrame(rafId);
    audio.currentTime = 0;
    updateBars();
    durEl.textContent = fmtTime(audio.duration);
    // Auto-play the next voice message in the chat
    const wrapper = player.closest('.msg-wrapper');
    if (wrapper) playNextVoiceAfter(wrapper);
  };

  let playedSent = false;
  function reallyPlay() {
    if (!playedSent && msg.username !== username) {
      playedSent = true;
      socket?.emit('voice_played', { messageId: msg.id });
    }
    claimPlayback(audio, stopThis); // pause whatever else is playing
    if (audio.ended || audio.currentTime >= audio.duration) audio.currentTime = 0;
    audio.play(); playBtn.innerHTML = '⏸'; playBtn.classList.remove('loading'); playing = true; startRAF();
  }

  playBtn.onclick = () => {
    if (playing) { stopThis(); return; }
    if (audio.readyState < 3) {
      // Still downloading — show a loading state and start as soon as enough is buffered.
      playBtn.innerHTML = ''; playBtn.classList.add('loading');
      const onReady = () => { audio.removeEventListener('canplay', onReady); if (!playing) reallyPlay(); };
      audio.addEventListener('canplay', onReady);
    } else {
      reallyPlay();
    }
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

// ─── Jump to replied message (multi-level back stack) ──────────────────────────
// More history exists AFTER what is loaded — true only while the window is
// parked in the middle of the chat by a jump.
let hasNewerMsgs = false;

function currentVisibleMsgMarker() {
  const container = document.getElementById('messages');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  if (nearBottom) return 'bottom';
  const visible = [...container.querySelectorAll('.msg-wrapper')].find(el => {
    const r = el.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    return r.top >= cr.top && r.top <= cr.bottom;
  });
  return visible ? visible.dataset.msgId : 'bottom';
}

/**
 * Go to one message, wherever it is in the history.
 *
 * If it is already on the page, scroll to it. Otherwise fetch the window
 * AROUND it in a single request and rebuild the list from that.
 *
 * It used to page backwards, a screenful at a time, until the message turned
 * up — which for a search result from six months ago is dozens of round trips
 * on a connection that cannot afford one. /message-context answers in one.
 */
async function jumpToMessage(messageId) {
  let target = document.querySelector(`[data-msg-id="${messageId}"]`);

  if (!target) {
    const ctx = await api(`/message-context/${currentRoomId}/${messageId}`);
    if (!ctx || ctx.error || !Array.isArray(ctx.messages) || !ctx.messages.length) {
      showToast('That message is no longer here');
      return;
    }
    const container = document.getElementById('messages');
    container.innerHTML = '';
    ctx.messages.forEach(m => container.appendChild(buildMessageElement(m)));
    oldestLoadedMsgId = ctx.messages[0].id;
    hasMoreOlderMsgs = !!ctx.hasOlder;
    // The window now sits in the middle of the chat, so the end of the list is
    // no longer the present. The button has to keep offering the way back.
    hasNewerMsgs = !!ctx.hasNewer;
    target = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (!target) return;
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('msg-highlight');
  setTimeout(() => target.classList.remove('msg-highlight'), 1500);
  updateScrollFab();
}

/**
 * One button, one job: go to the newest messages.
 *
 * It used to double as a back button that walked the trail of jumps in
 * reverse. Stepping through ten search results left ten jumps on that trail,
 * so leaving the search meant ten taps backwards through results already
 * looked at. Arriving at the message you asked for is the END of that errand.
 * The app dropped the trail for the same reason; this keeps the two in step.
 */
async function handleScrollFabClick() {
  if (hasNewerMsgs) {
    // The window is parked in the middle of the chat after a jump, so the end
    // of the list is not the present. Fetch the newest page directly rather
    // than paging forward through months of history.
    const msgs = await api('/messages/' + currentRoomId);
    if (Array.isArray(msgs) && msgs.length) {
      const container = document.getElementById('messages');
      container.innerHTML = '';
      msgs.forEach(m => container.appendChild(buildMessageElement(m)));
      oldestLoadedMsgId = msgs[0].id;
      hasMoreOlderMsgs = msgs.length >= MESSAGES_PAGE_SIZE;
      hasNewerMsgs = false;
    }
  }
  scrollBottom();
  updateScrollFab();
  // History can contain messages already past their deadline (the phone was
  // closed while they expired) and others still counting.
  scheduleExpirySweep();
}

function updateScrollFab() {
  const container = document.getElementById('messages');
  const fab = document.getElementById('scroll-fab');
  if (!container || !fab) return;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  fab.textContent = '↓';
  fab.title = 'Go to the newest messages';
  // "At the end of the list" is not "at the present": after a jump there is
  // more history beyond the end of what is loaded.
  if (nearBottom && !hasNewerMsgs) fab.classList.add('hidden');
  else fab.classList.remove('hidden');
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
let lightboxScale = 1, lightboxX = 0, lightboxY = 0;
let lightboxSrc = '';

let lightboxList = [];
let lightboxIdx = 0;

// Absolute URLs of one-time media — never downloadable from the lightbox
const oneTimeMediaUrls = new Set();

// Fetch the newest page and append any messages missing from the DOM —
// used after reconnects and when the tab becomes visible again.
async function refreshLatestMessages() {
  if (!currentRoomId) return;
  try {
    const msgs = await api('/messages/' + currentRoomId);
    if (!Array.isArray(msgs) || !msgs.length) return;
    const container = document.getElementById('messages');
    let appended = false;
    msgs.forEach(m => {
      if (!container.querySelector(`[data-msg-id="${m.id}"]`)) {
        container.appendChild(buildMessageElement(m));
        appended = true;
      }
    });
    if (appended) {
      scrollBottom();
      socket?.emit('mark_read', { roomId: currentRoomId, lastMsgId: msgs[msgs.length - 1].id });
    }
  } catch {}
}

function openLightbox(src) {
  // Prefer the full chat history's images (server-side list); fall back to
  // what is currently rendered.
  const absolute = src.startsWith('http') ? src : location.origin + src;
  if (allChatImages.includes(absolute)) {
    lightboxList = allChatImages;
    lightboxIdx = allChatImages.indexOf(absolute);
  } else {
    lightboxList = [...document.querySelectorAll('#messages .msg-bubble img')].map(i => i.src);
    lightboxIdx = Math.max(0, lightboxList.indexOf(absolute));
    if (!lightboxList.length) lightboxList = [absolute];
  }
  showLightboxAt(lightboxIdx);
  show('lightbox');
}

// ── (3) swipe left/right in the gallery ──
let lightboxSwipedAt = 0; // suppresses the tap-to-close click a swipe generates
(() => {
  let sx = null, sy = null;
  const lb = () => document.getElementById('lightbox');
  // Capture phase: no child handler (image pan/zoom) can swallow the swipe
  document.addEventListener('touchstart', (e) => {
    if (!lb().classList.contains('hidden')) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }
  }, { passive: true, capture: true });
  document.addEventListener('touchend', (e) => {
    if (sx === null || lb().classList.contains('hidden')) { sx = null; return; }
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    sx = null; sy = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) && lightboxScale <= 1.05) {
      lightboxSwipedAt = Date.now();
      lightboxNav(dx < 0 ? 1 : -1);
    }
  }, { passive: true, capture: true });
})();

function showLightboxAt(idx) {
  lightboxIdx = Math.max(0, Math.min(idx, lightboxList.length - 1));
  // Preload neighbours so swiping is instant
  [lightboxIdx - 1, lightboxIdx + 1].forEach(i => {
    const u = lightboxList[i];
    if (u) { const im = new Image(); im.src = u; }
  });
  lightboxSrc = lightboxList[lightboxIdx];
  lightboxScale = 1; lightboxX = 0; lightboxY = 0;
  document.getElementById('lightbox-img').src = lightboxSrc;
  const dlBtn = document.querySelector('.lightbox-download');
  if (dlBtn) dlBtn.classList.toggle('hidden', oneTimeMediaUrls.has(lightboxSrc));
  applyLightboxTransform();
  document.getElementById('lightbox-counter').textContent =
    lightboxList.length > 1 ? `${lightboxIdx + 1} / ${lightboxList.length}` : '';
  document.getElementById('lightbox-prev').classList.toggle('hidden', lightboxIdx === 0);
  document.getElementById('lightbox-next').classList.toggle('hidden', lightboxIdx >= lightboxList.length - 1);
}

function lightboxNav(dir) { showLightboxAt(lightboxIdx + dir); }

function closeLightbox(force) {
  // A horizontal swipe fires a synthetic click on the backdrop right after
  // touchend — don't let that click close the gallery the user is browsing.
  if (!force && Date.now() - lightboxSwipedAt < 500) return;
  hide('lightbox');
}
document.addEventListener('keydown', (e) => {
  if (document.getElementById('lightbox').classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') lightboxNav(-1);
  if (e.key === 'ArrowRight') lightboxNav(1);
});

function applyLightboxTransform() {
  const img = document.getElementById('lightbox-img');
  img.style.transform = `translate(${lightboxX}px, ${lightboxY}px) scale(${lightboxScale})`;
}

function lightboxZoom(delta, clientX, clientY) {
  const prevScale = lightboxScale;
  lightboxScale = Math.min(5, Math.max(1, lightboxScale + delta));
  if (lightboxScale === 1) { lightboxX = 0; lightboxY = 0; }
  applyLightboxTransform();
}

function downloadLightboxImage() {
  if (oneTimeMediaUrls.has(lightboxSrc)) return; // one-time media is view-only
  const a = document.createElement('a');
  a.href = lightboxSrc;
  a.download = lightboxSrc.split('/').pop() || 'image.jpg';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

(function setupLightboxGestures() {
  function init() {
    const img = document.getElementById('lightbox-img');
    if (!img) return;
    img.addEventListener('wheel', e => {
      e.preventDefault();
      lightboxZoom(e.deltaY < 0 ? 0.2 : -0.2);
    });
    let dragging = false, startX = 0, startY = 0;
    img.addEventListener('mousedown', e => {
      if (lightboxScale <= 1) return;
      dragging = true; startX = e.clientX - lightboxX; startY = e.clientY - lightboxY;
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      lightboxX = e.clientX - startX; lightboxY = e.clientY - startY;
      applyLightboxTransform();
    });
    window.addEventListener('mouseup', () => dragging = false);

    let lastDist = null, lastMidX = 0, lastMidY = 0;
    img.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        lastDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      } else if (e.touches.length === 1 && lightboxScale > 1) {
        lastMidX = e.touches[0].clientX - lightboxX; lastMidY = e.touches[0].clientY - lightboxY;
      }
    });
    img.addEventListener('touchmove', e => {
      if (e.touches.length === 2 && lastDist) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        lightboxZoom((dist - lastDist) * 0.01);
        lastDist = dist;
      } else if (e.touches.length === 1 && lightboxScale > 1) {
        lightboxX = e.touches[0].clientX - lastMidX; lightboxY = e.touches[0].clientY - lastMidY;
        applyLightboxTransform();
      }
    }, { passive: false });
    img.addEventListener('touchend', e => { if (e.touches.length < 2) lastDist = null; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

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
  // A token the server no longer accepts (signing secret rotated, account
  // removed) used to leave the page rendering empty, failing screens until the
  // user worked out they had to sign out by hand. Do it for them.
  if (res.status === 401 && token) sessionExpired();
  return res.json();
}

// Fires once per session — otherwise a burst of parallel 401s would stack a
// dozen alerts on top of each other.
let expiredFired = false;
function sessionExpired() {
  if (expiredFired) return;
  expiredFired = true;
  logout();
  showAuthError('Your session expired. Please sign in again.');
}
