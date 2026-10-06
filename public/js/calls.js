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
  // Which way the camera faces, for the mirror. The web has no notion of a
  // front lens, so it is inferred once when the stream is taken and kept:
  // only a front camera is mirrored, and asking the track every frame would
  // be a lot of work for an answer that cannot change without a flip.
  let frontCamera = true;
  // The camera track that a screen share replaced, so it can be put back.
  let sharedScreen = null;
  let cameraBeforeShare = null;

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
  function callSize() {
    const v = localStorage.getItem('callSize');
    // An older build stored a minimize flag; honour it once rather than
    // throwing away a preference somebody set.
    if (!v) return localStorage.getItem('callMinimized') === '1' ? 'minimized' : 'half';
    return CallStatus.SIZES.indexOf(v) >= 0 ? v : 'half';
  }

  function applyMinimized() {
    const el = $('call-overlay');
    if (!el) return;
    const phase = !mode ? 'idle' : (connectedAt ? 'connected' : 'outgoing');
    let size = callSize();
    // A call that has not connected yet cannot be shrunk to a bar — there is
    // nothing in the bar worth looking at and no way back to the controls.
    if (size === 'minimized' && !CallStatus.canMinimize(phase)) size = 'half';
    CallStatus.SIZES.forEach(sz => el.classList.toggle(CallStatus.callSizeClass(sz), sz === size));
    // Kept so the old stylesheet rule still matches while both exist.
    el.classList.toggle('minimized', size === 'minimized');
    const btn = $('call-size-btn');
    if (btn) {
      btn.textContent = size === 'full' ? '⤡' : size === 'half' ? '⤢' : '▴';
      btn.title = CallStatus.sizeButtonTitle(size);
    }
  }

  function cycleSize() {
    localStorage.setItem('callSize', CallStatus.nextCallSize(callSize()));
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
    // `swapped` means the OTHER side is the big pane, which is the same thing
    // it means in js/callStatus.js. Without the class you are the big one.
    el.classList.toggle('swapped', panes.big === 'remote');
    // Whichever pane the rule did not name has no stream in it. Left on screen
    // it is a black rectangle in the corner of a live call — and before the
    // other side's video arrived, that is what the corner was.
    const used = { remote: false, local: false };
    if (panes.big) used[panes.big] = true;
    if (panes.small) used[panes.small] = true;
    // Nothing to swap with: the class would put a live video in the corner of
    // an empty box.
    const swappable = CallStatus.canSwapVideos(st);
    el.classList.toggle('swappable', swappable);
    [['call-remote-video', 'remote'], ['call-local-video', 'local']].forEach(([id, pane]) => {
      const v = $(id);
      if (!v) return;
      v.classList.toggle('pane-empty', !used[pane]);
      v.title = swappable ? 'Tap to swap the videos' : '';
      // The mirror follows the STREAM, not the pane. The web had none at all,
      // so your own face came back the wrong way round while the app showed
      // it correctly. See CallStatus.mirrors.
      v.classList.toggle('mirrored', CallStatus.mirrors(pane, frontCamera) && !sharedScreen);
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
    // Each shown only where it does something: a flip button on a device with
    // one camera, or a share button in a browser without getDisplayMedia, is
    // a control that teaches people the app is broken.
    $('call-share-btn').classList.toggle('hidden', !(video && canShareScreen()));
    const flip = $('call-flip-btn');
    if (flip) flip.classList.add('hidden');
    if (video) refreshFlipButton();
    muted = false;
    $('call-mute-btn').textContent = '🎙';
    $('call-share-btn').textContent = '🖥';
    applyMinimized();
    applyVideoPanes();
  }

  function setStatus(text) { const el = $('call-status'); if (el) el.textContent = text; }

  // ── Ring sound + connected timer ──
  let ringAudio = null;
  /** Bumped by every stop, so a tone still starting knows it is obsolete. */
  let ringGeneration = 0;
  /**
   * Make the noise this END of the call should make.
   *
   * Reported as: the ringtone plays on the caller's device instead of the
   * receiver's. Both ends played ring.wav — a RINGTONE, written to be heard
   * across a room through a pocket, which is right for the phone being called
   * and wrong for the one held to an ear. The caller gets a ringback: quiet,
   * dull, and noticeable only when it stops. See js/callTones.js.
   */
  function startTone(role) {
    stopRing();
    // `connected` is passed, and it was the missing half of the rule: toneFor
    // was being asked which tone a caller gets rather than whether this device
    // should be making a noise at all, so a call that was already up could
    // still start ringing.
    const tone = CallTones.toneFor({ role, connected: !!connectedAt });
    if (!tone) return;
    // The ring this sound belongs to, captured before play() is called.
    // play() resolves asynchronously; a stop in that window leaves a promise
    // still in flight, and acting on it afterwards is what puts a ringtone
    // over a connected call. See toneStillWanted in js/callTones.js.
    const generation = ringGeneration;
    try {
      const el = new Audio('/' + CallTones.toneFile(tone));
      el.loop = CallTones.toneLoops(tone);
      el.volume = CallTones.toneVolume(tone);
      ringAudio = el;
      el.play().then(() => {
        if (CallTones.toneStillWanted(generation, ringGeneration)) return;
        // Stopped while it was starting: silence it now, because the stop that
        // would have done it has already run.
        try { el.pause(); } catch {}
      }).catch(() => {});
    } catch {}
  }
  function stopRing() {
    ringGeneration++;
    if (ringAudio) { try { ringAudio.pause(); } catch {} ringAudio = null; }
  }
  let connectedAt = null, timerInterval = null;
  // Which end of the call this is, and who it is with — for the log entry.
  // Held separately from `mode` and `dmPeer` because teardown clears those,
  // and because a declined call never sets `mode` at all.
  let outgoingCall = false;
  let callPeerId = null;
  let callKind = 'voice';
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

  // ── Recording the call in the chat ────────────────────────────────────────
  //
  // The web never did this at all. The app reports every finished call and the
  // server writes one entry into the conversation; calling from a browser left
  // no trace of it anywhere, so a call made from a laptop simply never
  // happened as far as the chat was concerned.
  //
  // Mirrors logCall in native-app/src/callManager.ts, including the once-only
  // guard: both ends report, and the server keeps the first. Reported BEFORE
  // teardown clears everything it needs to describe the call.
  let logged = false;
  function logCall(outcome, peerId) {
    // The call's OWN peer, not dmPeer: dmPeer is whichever conversation
    // happens to be open, and on an incoming call that is often not the person
    // calling. Logging against it would file the call under the wrong chat.
    const peer = peerId != null ? peerId : callPeerId;
    if (logged || peer == null) return;
    logged = true;
    const duration = connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : 0;
    try {
      sock.emit('call_log', {
        peerId: peer,
        kind: callKind === 'video' ? 'video' : 'voice',
        outcome, duration, outgoing: !!outgoingCall,
      });
    } catch {}
  }

  function teardown() {
    // A DM call that is ending: say what became of it. A call that connected
    // is 'completed' however it ended; one that never did was missed. Room
    // voice chat is not a call and is not logged.
    if (mode && mode.indexOf('dm') === 0) logCall(connectedAt ? 'completed' : 'missed');
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
    logged = false;
    outgoingCall = false;
    callPeerId = null;
    callKind = 'voice';
    frontCamera = true;
    sharedScreen = null;
    cameraBeforeShare = null;
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
    callPeerId = dmPeer.userId;
    callKind = kind === 'video' ? 'video' : 'voice';
    outgoingCall = true;
    frontCamera = true;
    showOverlay((kind === 'video' ? '🎥 ' : '📞 ') + dmPeer.username, kind === 'video');
    out = {};
    setStatus(CallStatus.outgoingStatus(out));
    startTone('caller');
    if (kind === 'video') {
      $('call-local-video').srcObject = localStream; $('call-local-video').muted = true;
      // Re-laid now the local stream is really attached: you are the big
      // pane, so an overlay drawn before it arrived had nothing in it.
      applyVideoPanes();
    }
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
    startTone('callee');
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
    callPeerId = offer.fromUserId;
    callKind = offer.kind === 'video' ? 'video' : 'voice';
    outgoingCall = false;
    frontCamera = true;
    showOverlay((offer.kind === 'video' ? '🎥 ' : '📞 ') + offer.fromUsername, offer.kind === 'video');
    setStatus('Connecting…');
    if (offer.kind === 'video') {
      $('call-local-video').srcObject = localStream; $('call-local-video').muted = true;
      applyVideoPanes();
    }
    const pc = newPc(offer.fromUserId);
    await pc.setRemoteDescription(offer.sdp);
    flushIce(offer.fromUserId);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    sock.emit('call_answer', { toUserId: offer.fromUserId, sdp: pc.localDescription });
  }

  function decline() {
    if (incoming) {
      // Declining never reaches teardown, because `mode` was never set — so
      // without this a refused call left no entry either.
      callKind = incoming.kind === 'video' ? 'video' : 'voice';
      outgoingCall = false;
      logCall('declined', incoming.fromUserId);
      sock.emit('call_end', { toUserId: incoming.fromUserId });
      logged = false;          // the next call is a new call
      callKind = 'voice';
    }
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

  // ── Which camera, and what is in the sender ───────────────────────────────

  /** The one sender carrying video, if there is one. */
  function videoSender() {
    for (const pc of pcs.values()) {
      const s = pc.getSenders().find(x => x.track && x.track.kind === 'video');
      if (s) return s;
    }
    // Before any track has been added, fall back to the transceiver's sender
    // so a flip taken very early still lands somewhere.
    for (const pc of pcs.values()) {
      const s = pc.getSenders().find(x => !x.track);
      if (s) return s;
    }
    return null;
  }

  /** Replace the outgoing video track everywhere, without renegotiating. */
  async function useVideoTrack(track) {
    const jobs = [];
    pcs.forEach(pc => {
      pc.getSenders().forEach(sn => {
        if (sn.track && sn.track.kind === 'video') jobs.push(sn.replaceTrack(track));
      });
    });
    await Promise.all(jobs).catch(() => {});
    // The local preview shows whatever is actually being sent.
    const old = localStream ? localStream.getVideoTracks()[0] : null;
    if (localStream && old && old !== track) localStream.removeTrack(old);
    if (localStream && track) localStream.addTrack(track);
    const v = $('call-local-video');
    if (v) v.srcObject = localStream;
  }

  /** Show the flip button only where there is a second camera to flip to. */
  async function refreshFlipButton() {
    const btn = $('call-flip-btn');
    if (!btn) return;
    let count = 0;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      count = devices.filter(d => d.kind === 'videoinput').length;
    } catch { count = 0; }
    btn.classList.toggle('hidden', !(mode === 'dm-video' && CallStatus.canFlipCamera(count)));
  }

  /**
   * Swap between the front and back camera.
   *
   * The track is replaced inside the existing sender rather than renegotiated:
   * a fresh offer mid-call is a chance for the call to drop, and on these
   * networks that is not a small risk.
   */
  async function flipCamera() {
    if (mode !== 'dm-video' || sharedScreen) return;
    const want = frontCamera ? 'environment' : 'user';
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: want } }, audio: false,
      });
    } catch { return; }
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const wasOff = localStream && !localStream.getVideoTracks().some(t => t.enabled);
    // A camera that was off stays off. Flipping is not a request to be seen.
    track.enabled = !wasOff;
    const old = localStream ? localStream.getVideoTracks()[0] : null;
    await useVideoTrack(track);
    if (old) old.stop();
    frontCamera = !frontCamera;
    applyVideoPanes();
  }

  // ── Sharing the screen ────────────────────────────────────────────────────
  //
  // Asked for on both the app and the web. On the web it is one browser call;
  // the track then goes into the SAME sender the camera was using, so the far
  // end needs no renegotiation and no way of telling which video is which.
  //
  // The browser's own "stop sharing" bar is the one most people will use, so
  // the track's `ended` event has to put the camera back too — not just our
  // button.
  function canShareScreen() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  async function toggleShareScreen() {
    if (!canShareScreen() || mode !== 'dm-video') return;
    if (sharedScreen) return stopShareScreen();
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch { return; }           // the picker was dismissed; not an error
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const cam = localStream ? localStream.getVideoTracks()[0] : null;
    cameraBeforeShare = { track: cam, wasOff: !!cam && !cam.enabled };
    sharedScreen = track;
    // Stopped from the browser's own bar, which is where most people will
    // stop it. Without this the call keeps sending a dead track.
    track.onended = () => stopShareScreen();
    await useVideoTrack(track);
    const btn = $('call-share-btn');
    if (btn) { btn.textContent = '🛑'; btn.title = 'Stop sharing'; }
    applyVideoPanes();
  }

  async function stopShareScreen() {
    if (!sharedScreen) return;
    const screen = sharedScreen;
    sharedScreen = null;
    screen.onended = null;
    const back = cameraBeforeShare || {};
    cameraBeforeShare = null;
    let cam = back.track;
    // The camera track may have been stopped by the browser while sharing.
    if (!cam || cam.readyState === 'ended') {
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        cam = fresh.getVideoTracks()[0];
      } catch { cam = null; }
    }
    // A camera that was off before the share goes back to being off, rather
    // than surprising somebody with their own face. See screenShareRestore.
    if (cam) cam.enabled = CallStatus.screenShareRestore({ cameraWasOff: back.wasOff }).enabled;
    if (cam) await useVideoTrack(cam);
    try { screen.stop(); } catch {}
    const btn = $('call-share-btn');
    if (btn) { btn.textContent = '🖥'; btn.title = 'Share screen'; }
    applyVideoPanes();
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

  /**
   * Is a call happening right now?
   *
   * Asked by the update prompt: reloading the page ends a call outright, and
   * doing that to somebody mid-sentence is not an update, it is a hang-up.
   */
  function inCall() { return !!mode; }

  return {
    bindSocket, setDMPeer, startDM, toggleRoomVoice, accept, decline, end,
    toggleMute, toggleCam, swapVideos, inCall,
    cycleSize, flipCamera, toggleShareScreen,
    // Kept so an onclick in a cached page from an older build still works
    // rather than throwing: the stylesheet and the markup update together,
    // but a browser may hold the old HTML.
    toggleMinimize: cycleSize,
  };
})();
