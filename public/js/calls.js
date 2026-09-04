// ── Voice & video calls (WebRTC) ──────────────────────────────────────────────
// DMs: 1:1 voice or video. Rooms: voice-only mesh (each participant holds a
// peer connection to every other). The server only relays signaling.

const Calls = (() => {
  let sock = null;
  let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const pcs = new Map(); // userId -> RTCPeerConnection
  const pendingIce = new Map(); // userId -> candidates that arrived before the pc was ready
  let localStream = null;
  let mode = null; // 'dm-voice' | 'dm-video' | 'room-voice'
  let dmPeer = null; // { userId, username }
  let roomVoiceId = null;
  let incoming = null; // pending DM offer
  // What is actually known about the far end, as opposed to what we hoped.
  let out = {};
  // Video call: the user has put their own camera in the big pane.
  let videoSwapped = false;
  let muted = false;

  const $ = (id) => document.getElementById(id);

  async function loadIce() {
    try {
      const cfg = await api('/ice-config');
      if (cfg?.iceServers) iceServers = cfg.iceServers;
    } catch {}
  }

  function bindSocket(s) {
    sock = s;
    loadIce();
    s.on('call_offer', onOffer);
    s.on('call_answer', async ({ fromUserId, sdp }) => {
      const pc = pcs.get(fromUserId);
      if (pc) await pc.setRemoteDescription(sdp).catch(() => {});
      flushIce(fromUserId);
      stopRing();
      out = Object.assign({}, out, { answered: true });
      setStatus(CallStatus.outgoingStatus(out));
    });
    // The callee's page confirming it is actually alerting — the only thing
    // that entitles this screen to say "Ringing…".
    s.on('call_ringing', ({ fromUserId }) => {
      if (!dmPeer || dmPeer.userId !== fromUserId) return;
      out = Object.assign({}, out, { ringing: true });
      setStatus(CallStatus.outgoingStatus(out));
    });
    s.on('call_ice', ({ fromUserId, candidate }) => {
      const pc = pcs.get(fromUserId);
      // Candidates often arrive before the callee accepts (no pc yet) or
      // before setRemoteDescription — buffer them or the call dies mid-setup.
      if (!pc || !pc.remoteDescription) {
        if (!pendingIce.has(fromUserId)) pendingIce.set(fromUserId, []);
        pendingIce.get(fromUserId).push(candidate);
        return;
      }
      pc.addIceCandidate(candidate).catch(() => {});
    });
    s.on('call_end', ({ fromUserId }) => {
      dropPeer(fromUserId);
      if (mode?.startsWith('dm')) teardown();
    });
    s.on('voice_peer_joined', async ({ roomId, userId }) => {
      // I'm already in this room's voice chat: send the newcomer an offer
      if (mode === 'room-voice' && String(roomId) === String(roomVoiceId)) {
        await makeOffer(userId, { roomId });
      }
    });
    s.on('voice_peer_left', ({ roomId, userId }) => {
      if (mode === 'room-voice' && String(roomId) === String(roomVoiceId)) dropPeer(userId);
    });
    s.on('voice_count', ({ roomId, count }) => {
      const btn = $('room-voice-btn');
      if (btn && String(roomId) === String(currentRoomId)) {
        btn.textContent = count > 0 ? `📞 ${count}` : '📞';
      }
      if (mode === 'room-voice' && String(roomId) === String(roomVoiceId)) {
        setStatus(`Voice chat · ${count} in`);
      }
    });
  }

  function setDMPeer(userId, name) { dmPeer = userId ? { userId, username: name } : null; }

  // Deliberately NOT async, and deliberately called before any await.
  //
  // Safari discards the user gesture as soon as the task handling the tap
  // yields, so a single `await` before this — loading the ICE config, say —
  // makes getUserMedia reject with NotAllowedError and show no prompt at all.
  // From the user's side that is indistinguishable from having refused, and
  // there is no way to recover because Safari does not ask twice.
  function getMedia(video) {
    return window.CallMedia.requestMedia(video);
  }

  /** Say what actually went wrong, and what to do about it. */
  function mediaFailed(err) {
    alert(window.CallMedia.mediaErrorMessage(err, {
      secure: window.CallMedia.isSecure(),
      isApple: window.CallMedia.isApple(),
    }));
  }

  function newPc(userId) {
    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate) sock.emit('call_ice', { toUserId: userId, candidate: e.candidate });
    };
    pc.ontrack = (e) => attachRemote(userId, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && mode?.startsWith('dm')) {
        setStatus('Connection failed');
        setTimeout(() => end(), 2500);
        return;
      }
      if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(userId);
      if (pc.connectionState === 'connected') mode === 'room-voice' ? setStatus('Voice chat') : markConnected();
    };
    pc.oniceconnectionstatechange = () => {
      if ((pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') && mode !== 'room-voice') markConnected();
    };
    localStream?.getTracks().forEach(t => pc.addTrack(t, localStream));
    pcs.set(userId, pc);
    return pc;
  }

  async function makeOffer(userId, extra = {}) {
    const pc = newPc(userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // The ack says whether the server had a live socket to hand this to — the
    // difference between "their device has the call" and "a push has been sent
    // to a phone that may be face down in a drawer".
    sock.emit('call_offer', {
      toUserId: userId, kind: mode === 'dm-video' ? 'video' : 'voice',
      sdp: pc.localDescription, ...extra,
    }, (res) => {
      if (out.ringing || out.answered || out.connected) return;
      out = Object.assign({}, out, { delivered: !!(res && res.delivered), pushed: !!(res && res.pushed) });
      setStatus(CallStatus.outgoingStatus(out));
    });
  }

  function attachRemote(userId, stream) {
    if (mode === 'dm-video') {
      const v = $('call-remote-video');
      v.srcObject = stream;
      v.classList.remove('hidden');
      // Until now there was only one video and it belonged full-width.
      applyVideoPanes();
    } else {
      let a = $('call-audio-' + userId);
      if (!a) {
        a = document.createElement('audio');
        a.id = 'call-audio-' + userId;
        a.autoplay = true;
        $('call-audios').appendChild(a);
      }
      a.srcObject = stream;
    }
  }

  function flushIce(userId) {
    const pc = pcs.get(userId);
    const queued = pendingIce.get(userId) || [];
    pendingIce.delete(userId);
    if (pc) queued.forEach(c => pc.addIceCandidate(c).catch(() => {}));
  }

  function dropPeer(userId) {
    pcs.get(userId)?.close();
    pcs.delete(userId);
    pendingIce.delete(userId);
    $('call-audio-' + userId)?.remove();
    if (mode === 'room-voice' && !pcs.size) setStatus('Voice chat · waiting for others…');
  }

  // ── Putting the call down without hanging up ───────────────────────────────
  //
  // The panel sits over the corner of the chat, which is exactly where the
  // newest messages are. Collapsing it to a bar leaves the call running and
  // the conversation readable; the choice is remembered, because somebody who
  // wants calls out of the way wants that every time.
  function minimized() { return localStorage.getItem('callMinimized') === '1'; }

  function applyMinimized() {
    const el = $('call-overlay');
    if (!el) return;
    const phase = !mode ? 'idle' : (connectedAt ? 'connected' : 'outgoing');
    const on = minimized() && CallStatus.canMinimize(phase);
    el.classList.toggle('minimized', on);
    const btn = $('call-min-btn');
    if (btn) {
      btn.textContent = on ? '▴' : '▾';
      btn.title = on ? 'Expand call' : 'Minimize call';
    }
  }

  function toggleMinimize() {
    localStorage.setItem('callMinimized', minimized() ? '0' : '1');
    applyMinimized();
  }

  /** Is anybody's camera actually producing a picture? */
  function videoState() {
    const camOn = !!localStream && localStream.getVideoTracks().some(t => t.enabled);
    return {
      swapped: videoSwapped,
      hasRemote: !!$('call-remote-video').srcObject,
      hasLocal: !!localStream && localStream.getVideoTracks().length > 0,
      cameraOff: !camOn,
    };
  }

  /**
   * Put the two videos where the rule says they go.
   *
   * The panel's layout is CSS, so this is one class: `swapped` exchanges which
   * element is the full-width one and which is the corner. Called after
   * anything that changes the answer — the remote stream arriving, the camera
   * being turned off, the user asking.
   */
  function applyVideoPanes() {
    const el = $('call-overlay');
    if (!el) return;
    const st = videoState();
    const panes = CallStatus.videoPanes(st);
    el.classList.toggle('swapped', panes.big === 'local' && panes.small === 'remote');
    // Nothing to swap with: the class would put a live video in the corner of
    // an empty box.
    const swappable = CallStatus.canSwapVideos(st);
    el.classList.toggle('swappable', swappable);
    ['call-remote-video', 'call-local-video'].forEach(id => {
      const v = $(id);
      if (v) v.title = swappable ? 'Tap to swap the videos' : '';
    });
  }

  function swapVideos() {
    if (!CallStatus.canSwapVideos(videoState())) return;
    videoSwapped = !videoSwapped;
    applyVideoPanes();
  }

  function showOverlay(title, video) {
    $('call-overlay').classList.remove('hidden');
    $('call-title').textContent = title;
    $('call-remote-video').classList.toggle('hidden', !video);
    $('call-local-video').classList.toggle('hidden', !video);
    $('call-cam-btn').classList.toggle('hidden', !video);
    muted = false;
    $('call-mute-btn').textContent = '🎙';
    applyMinimized();
    applyVideoPanes();
  }

  function setStatus(text) { const el = $('call-status'); if (el) el.textContent = text; }

  // ── Ring sound + connected timer ──
  let ringAudio = null;
  function startRing() {
    stopRing();
    try {
      ringAudio = new Audio('/ring.wav');
      ringAudio.loop = true;
      ringAudio.play().catch(() => {});
    } catch {}
  }
  function stopRing() {
    if (ringAudio) { try { ringAudio.pause(); } catch {} ringAudio = null; }
  }
  let connectedAt = null, timerInterval = null;
  function markConnected() {
    stopRing();
    out = Object.assign({}, out, { connected: true });
    if (!connectedAt) {
      connectedAt = Date.now();
      // "Connected" until the timer's first tick a second later. This line
      // used to read `markConnected()` — the function calling itself,
      // unconditionally, forever: every connected call on the web blew the
      // stack here, so the status never left "Connecting…" and the timer never
      // appeared.
      setStatus(CallStatus.outgoingStatus(out));
      applyMinimized();
      clearInterval(timerInterval);
      timerInterval = setInterval(() => {
        const sec = Math.floor((Date.now() - connectedAt) / 1000);
        const m = Math.floor(sec / 60), ss = String(sec % 60).padStart(2, '0');
        setStatus(`${m}:${ss}`);
      }, 1000);
    }
  }

  function teardown() {
    pcs.forEach(pc => pc.close());
    pcs.clear();
    localStream?.getTracks().forEach(t => t.stop());
    localStream = null;
    $('call-audios').innerHTML = '';
    $('call-remote-video').srcObject = null;
    $('call-local-video').srcObject = null;
    $('call-overlay').classList.add('hidden');
    $('incoming-call').classList.add('hidden');
    if (mode === 'room-voice' && roomVoiceId) sock.emit('voice_leave', { roomId: roomVoiceId });
    mode = null;
    roomVoiceId = null;
    incoming = null;
    out = {};
    videoSwapped = false;
    stopRing();
    connectedAt = null;
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // ── DM calls ────────────────────────────────────────────────────────────────
  async function startDM(kind) {
    if (mode) return alert('You are already in a call.');
    if (!dmPeer) return;
    // The microphone is asked for FIRST, in the same task as the tap, and the
    // ICE config is fetched alongside it. Awaiting the config first is what
    // made an iPhone refuse without asking.
    const media = getMedia(kind === 'video');
    const ice = loadIce();
    try {
      localStream = await media;
    } catch (err) { ice.catch(() => {}); return mediaFailed(err); }
    await ice;
    mode = kind === 'video' ? 'dm-video' : 'dm-voice';
    showOverlay((kind === 'video' ? '🎥 ' : '📞 ') + dmPeer.username, kind === 'video');
    out = {};
    setStatus(CallStatus.outgoingStatus(out));
    startRing();
    if (kind === 'video') { $('call-local-video').srcObject = localStream; $('call-local-video').muted = true; }
    await makeOffer(dmPeer.userId);
  }

  async function onOffer(offer) {
    // Room-voice mesh offers are auto-accepted while in that room's voice chat
    if (offer.roomId != null) {
      if (mode === 'room-voice' && String(offer.roomId) === String(roomVoiceId)) {
        const pc = newPc(offer.fromUserId);
        await pc.setRemoteDescription(offer.sdp);
        flushIce(offer.fromUserId);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        sock.emit('call_answer', { toUserId: offer.fromUserId, sdp: pc.localDescription });
      }
      return;
    }
    if (mode) { sock.emit('call_end', { toUserId: offer.fromUserId }); return; } // busy
    incoming = offer;
    startRing();
    // Tell the caller their call is really ringing here.
    sock.emit('call_ringing', { toUserId: offer.fromUserId });
    $('incoming-call-text').textContent =
      `${offer.kind === 'video' ? '🎥' : '📞'} ${offer.fromUsername} is calling…`;
    $('incoming-call').classList.remove('hidden');
  }

  async function accept() {
    const offer = incoming;
    incoming = null;
    stopRing();
    $('incoming-call').classList.add('hidden');
    if (!offer) return;
    // Accepting is a tap too, and the same rule applies to it.
    const media = getMedia(offer.kind === 'video');
    const ice = loadIce();
    try {
      localStream = await media;
    } catch (err) {
      ice.catch(() => {});
      sock.emit('call_end', { toUserId: offer.fromUserId });
      return mediaFailed(err);
    }
    await ice;
    mode = offer.kind === 'video' ? 'dm-video' : 'dm-voice';
    showOverlay((offer.kind === 'video' ? '🎥 ' : '📞 ') + offer.fromUsername, offer.kind === 'video');
    setStatus('Connecting…');
    if (offer.kind === 'video') { $('call-local-video').srcObject = localStream; $('call-local-video').muted = true; }
    const pc = newPc(offer.fromUserId);
    await pc.setRemoteDescription(offer.sdp);
    flushIce(offer.fromUserId);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    sock.emit('call_answer', { toUserId: offer.fromUserId, sdp: pc.localDescription });
  }

  function decline() {
    if (incoming) sock.emit('call_end', { toUserId: incoming.fromUserId });
    incoming = null;
    stopRing();
    $('incoming-call').classList.add('hidden');
  }

  function end() {
    pcs.forEach((_pc, userId) => sock.emit('call_end', { toUserId: userId }));
    teardown();
  }

  // ── Room voice chat ─────────────────────────────────────────────────────────
  async function toggleRoomVoice() {
    if (mode === 'room-voice') return end();
    if (mode) return alert('You are already in a call.');
    const media = getMedia(false);
    const ice = loadIce();
    try {
      localStream = await media;
    } catch (err) { ice.catch(() => {}); return mediaFailed(err); }
    await ice;
    mode = 'room-voice';
    roomVoiceId = currentRoomId;
    showOverlay('📞 ' + document.getElementById('room-title').textContent.replace(/^[#💬🔒 ]+/, ''), false);
    setStatus('Voice chat · joining…');
    sock.emit('voice_join', { roomId: roomVoiceId });
  }

  function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    $('call-mute-btn').textContent = muted ? '🔇' : '🎙';
  }

  function toggleCam() {
    if (!localStream) return;
    const on = localStream.getVideoTracks().some(t => t.enabled);
    localStream.getVideoTracks().forEach(t => { t.enabled = !on; });
    $('call-cam-btn').textContent = on ? '🚫🎥' : '🎥';
    // Turning your own camera off while you are the big pane must put the
    // other person back, rather than filling the panel with black.
    applyVideoPanes();
  }

  return {
    bindSocket, setDMPeer, startDM, toggleRoomVoice, accept, decline, end,
    toggleMute, toggleCam, toggleMinimize, swapVideos,
  };
})();
