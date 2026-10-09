// ── Voice & video calls (WebRTC) ──────────────────────────────────────────────
// Mirrors public/js/calls.js: DMs get 1:1 voice/video, rooms get voice-only
// mesh. A singleton so the call survives screen changes; CallOverlay renders
// its state app-wide.
import { PermissionsAndroid, Platform } from 'react-native';
import { Audio } from 'expo-av';
import { mediaDevices, RTCPeerConnection, MediaStream } from 'react-native-webrtc';
import { scaleFor, madeNoProgress, MAX_BITRATE, SAMPLE_AFTER_MS } from './screenShare';
import { apiFetch, getSocket } from './api';
import { stopRinging } from './incomingCall';
import { routeFor, outgoingStatus, endStopsCall, RING_TIMEOUT_MS, NO_ANSWER_MS, CallMode, CallPhase, OutgoingState } from './callAudio';
import { toneFor, toneVolume, toneLoops, toneStillWanted } from './callTones';
import { canMinimize, canSwapVideos, CallPhase as WindowPhase } from './callWindow';
import * as ongoing from './ongoingCall';
import { audioManager } from './audioManager';

// react-native-incall-manager routes call audio (earpiece/speaker/proximity)
// like a real phone. Loaded defensively so a missing native module never
// crashes the app in dev/Expo Go.
let InCallManager: any = null;
try { InCallManager = require('react-native-incall-manager').default; } catch {}

type Listener = () => void;
type Incoming = { fromUserId: number; fromUsername: string; kind: 'voice' | 'video'; sdp: any } | null;

class CallManager {
  mode: 'dm-voice' | 'dm-video' | 'room-voice' | null = null;
  title = '';
  status = '';
  incoming: Incoming = null;
  localStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null; // dm-video only
  muted = false;
  cameraOff = false;
  /** The OTHER side's camera, as last reported by them. */
  remoteCameraOff = false;
  speakerOn = false;    // voice calls: earpiece by default, toggle to speaker
  frontCamera = true;   // video calls: front/back camera
  // Screen sharing: the display track that replaced the camera, and what the
  // camera was doing before it did.
  sharingScreen = false;
  /** Why the last share attempt failed, for the overlay to say out loud. */
  shareFailed: string | null = null;
  // What happened the last time a video track was swapped, reported on the
  // health event so it can be read from the server log instead of guessed at.
  // Counts only: how many senders were found, and how many were actually
  // holding the new track afterwards.
  // STICKY. These describe the last share ATTEMPT and are never cleared.
  //
  // They were cleared when the call tore down, and the health event that
  // carries them is only sent when the app goes to the background — which
  // happens after the call has ended. So they were wiped before they were
  // ever reported, and "never tried" and "tried and failed" both arrived as
  // zero. The first reading of them said 0/0/0 and meant nothing at all.
  shareSenders = 0;
  shareSwitched = 0;
  /** Did the capture itself start, whatever the senders then did with it? */
  shareCaptured = false;
  /** How many share attempts this process has seen, so zero is unambiguous. */
  shareTries = 0;
  /** What the capture was scaled by, and what the encoder then produced. */
  shareScale = 1;
  shareEncoded = -1;
  private screenTrack: any = null;
  private screenStream: any = null;
  private cameraTrack: any = null;
  private cameraWasOff = false;
  /** Shrunk to a bubble, so the chat underneath can be used. */
  minimized = false;
  /** Video call: the user has put their own camera in the big pane. */
  videoSwapped = false;
  connectedAt: number | null = null; // for the in-call timer

  // Details needed to write the call into chat history when it ends.
  private peerId: number | null = null;
  private peerName = '';
  private outgoing = false; // did we initiate?
  private logged = false;

  // What is actually known about the far end, as opposed to what we hoped.
  private out: OutgoingState = {};

  private ringSound: Audio.Sound | null = null;

  /**
   * Open the call's audio session, and point the tones at the right speaker.
   *
   * Called when the call STARTS, not when it connects. Opening it on connect
   * was what made the ringback come out of the loudspeaker at media volume:
   * until InCallManager.start() runs there is no voice-call route, so anything
   * played is just media.
   */
  private applyRoute(phase: CallPhase) {
    if (!this.mode) return;
    const r = routeFor({ mode: this.mode as CallMode, phase, speakerOn: this.speakerOn });
    try {
      InCallManager?.start({ media: r.media });
      InCallManager?.setForceSpeakerphoneOn(r.speaker);
    } catch {}
    this.speakerOn = r.speaker;
    // Our own ringback is an expo-av sound, and expo-av has its own idea of
    // where to play. Without this it ignores the call route entirely.
    Audio.setAudioModeAsync({
      playThroughEarpieceAndroid: r.earpiece,
      staysActiveInBackground: true,
    }).catch(() => {});
  }

  /**
   * Make the noise this END of the call should make.
   *
   * Reported as: the ringtone plays on the caller's device instead of the
   * receiver's. Both ends were playing ring.wav — a RINGTONE, written to be
   * heard across a room through a pocket, which is right for the phone being
   * called and wrong for the one held to an ear. The caller gets a ringback:
   * quiet, dull, and noticeable only when it stops. See src/callTones.ts.
   */
  private async startTone(role: 'caller' | 'callee') {
    this.stopRing();
    // `connected` is passed, and it was the missing half of the rule: without
    // it toneFor was being asked "which tone does a caller get" rather than
    // "should this device be making a noise at all", and a call that was
    // already up could still start ringing.
    const tone = toneFor({ role, connected: !!this.connectedAt });
    if (!tone) return;
    // The ring this sound belongs to, captured BEFORE the load. Loading is
    // asynchronous and the sound comes back already playing, so a stop that
    // happens while it loads cannot silence it — there is nothing loaded yet
    // to silence. Storing it afterwards is what left a ringtone looping over a
    // connected call. See toneStillWanted in callTones.ts.
    const generation = this.ringGeneration;
    try {
      const { sound } = await Audio.Sound.createAsync(
        tone === 'ringtone'
          ? require('../assets/ring.wav')
          : require('../assets/ringback.wav'),
        { isLooping: toneLoops(tone), shouldPlay: true, volume: toneVolume(tone) },
      );
      if (!toneStillWanted(generation, this.ringGeneration)) {
        // Stopped while it was loading. This is the only moment anything can
        // still silence it, because stopRing has already been and gone.
        sound.unloadAsync().catch(() => {});
        return;
      }
      this.ringSound = sound;
    } catch {}
  }
  /** Bumped by every stop, so a tone still loading knows it is obsolete. */
  private ringGeneration = 0;
  private stopRing() {
    this.ringGeneration++;
    const snd = this.ringSound;
    this.ringSound = null;
    if (snd) snd.unloadAsync().catch(() => {});
    // Also silence the notification ringer, which may have been started by the
    // background task before the app was opened. Without this, answering in
    // the app leaves the phone still ringing in the shade.
    stopRinging().catch(() => {});
  }
  // Room voice chat connected its first peer. This does NOT go through
  // markConnected(): that one owns the DM call's "Connected" status, its
  // duration timer and its call-log entry, none of which apply to a room mesh
  // whose status line is "Voice chat · N in". What a room call DOES need is the
  // audio session — without InCallManager.start() the WebRTC audio route is
  // never set up, so a room call connected but nobody could hear anything.
  private markRoomAudioStarted() {
    if (this.roomAudioStarted) return;
    this.roomAudioStarted = true;
    this.syncOngoing();
    // Group calls are hands-free by nature — routeFor says so, like every
    // other app's group voice chat.
    this.applyRoute('connected');
    this.emit();
  }
  private roomAudioStarted = false;

  private markConnected() {
    clearTimeout(this.noAnswerTimer);
    this.stopRing();
    // Stop every ring source: the expo-av loop AND InCallManager's ringback/
    // ringtone — otherwise ringing keeps playing over a connected call.
    try { InCallManager?.stopRingback?.(); InCallManager?.stopRingtone?.(); } catch {}
    if (!this.connectedAt) {
      this.connectedAt = Date.now();
      // The session is already open (it was opened when the call started, so
      // the ringback would route properly); this settles the final speaker
      // choice for the conversation itself.
      this.applyRoute('connected');
    }
    this.out = { ...this.out, connected: true };
    this.status = 'Connected';
    this.syncOngoing();
    this.emit();
  }

  /** Which of the four states this call is in, for the rules that care. */
  get windowPhase(): WindowPhase {
    if (this.incoming) return 'incoming';
    if (!this.mode) return 'idle';
    return this.connectedAt || this.mode === 'room-voice' ? 'connected' : 'outgoing';
  }

  minimize() {
    // An incoming call is a question that wants an answer now; shrinking it is
    // how a call ends up ringing in the corner while somebody keeps scrolling.
    if (!canMinimize(this.windowPhase)) return;
    this.minimized = true;
    this.emit();
  }

  expand() {
    this.minimized = false;
    this.emit();
  }

  /**
   * Swap the big and small video panes.
   *
   * Refused when there is nothing to swap with — one video belongs on the
   * screen, not in the corner of a black rectangle. The choice itself is kept
   * here rather than in the overlay so it survives minimising, rotating, and
   * the overlay re-rendering on every timer tick.
   */
  swapVideos() {
    if (!canSwapVideos({
      hasRemote: !!this.remoteStream, hasLocal: !!this.localStream, cameraOff: this.cameraOff,
    })) return;
    this.videoSwapped = !this.videoSwapped;
    this.emit();
  }

  /**
   * Tell the shade where the call is up to.
   *
   * Also what keeps the process alive: without a foreground service Android is
   * free to freeze a backgrounded app, and a frozen app is a call whose audio
   * stops and whose socket dies with nobody told.
   */
  private syncOngoing() {
    const phase = this.windowPhase;
    if (phase === 'idle') { ongoing.stopOngoing(); return; }
    ongoing.startOngoing({
      title: this.incoming ? this.incoming.fromUsername : this.title.replace(/^[^ ]+ /, ''),
      kind: (this.incoming?.kind === 'video' || this.mode === 'dm-video') ? 'video' : 'voice',
      phase,
      connected: !!this.connectedAt || this.mode === 'room-voice',
      connectedAt: this.connectedAt,
    });
  }

  toggleSpeaker() {
    this.speakerOn = !this.speakerOn;
    try { InCallManager?.setForceSpeakerphoneOn(this.speakerOn); } catch {}
    this.emit();
  }

  // Flip between front and back camera on a video call.
  async switchCamera() {
    if (this.mode !== 'dm-video' || !this.localStream) return;
    const track: any = this.localStream.getVideoTracks()[0];
    try {
      if (track?._switchCamera) track._switchCamera();
      this.frontCamera = !this.frontCamera;
      this.emit();
    } catch {}
  }

  /**
   * Put a different video track into the senders that already exist.
   *
   * Nothing is renegotiated. A fresh offer mid-call is a chance for the call
   * to drop, and on these networks that is not a small risk — and the far end
   * would then have to work out which of two videos is which.
   */
  private async useVideoTrack(track: any): Promise<number> {
    const jobs: Promise<any>[] = [];
    let senders = 0;
    this.pcs.forEach((pc: any) => {
      pc.getSenders().forEach((sn: any) => {
        if (sn.track && sn.track.kind === 'video') { senders++; jobs.push(sn.replaceTrack(track)); }
      });
    });
    // Counting resolved promises is NOT good enough here, and I shipped that
    // once. react-native-webrtc's replaceTrack swallows the native error and
    // resolves anyway:
    //
    //     async replaceTrack(track) {
    //       try { await WebRTCModule.senderReplaceTrack(...); }
    //       catch (e) { return; }        // <- resolves, having done nothing
    //       this._track = track;         // <- only on success
    //     }
    //
    // So a failure is indistinguishable from a success by the promise, and the
    // only honest test on this platform is whether the sender is actually
    // holding the new track afterwards. That is what the last line sets, and
    // it is the one thing the failure path does not touch.
    await Promise.allSettled(jobs);
    let replaced = 0;
    this.pcs.forEach((pc: any) => {
      pc.getSenders().forEach((sn: any) => {
        if (sn.track && track && sn.track.id === track.id) replaced++;
      });
    });
    this.shareSenders = senders;
    this.shareSwitched = replaced;
    const old = this.localStream?.getVideoTracks()[0];
    if (this.localStream && old && old !== track) this.localStream.removeTrack(old);
    if (this.localStream && track) this.localStream.addTrack(track);
    this.emit();
    return replaced;
  }

  /**
   * Share this phone's screen instead of its camera.
   *
   * Asked for on both the app and the web, and done the same way on each: the
   * display track goes into the SAME sender the camera was using, so the far
   * end sees one video throughout and needs to be told nothing.
   *
   * Android shows its own permission sheet and its own recording indicator,
   * and the user can stop it from the system bar — so the track's end has to
   * put the camera back as well as our own button, or the call carries on
   * sending a dead track.
   */
  /**
   * Say what a share attempt did, the moment it does it.
   *
   * Not left for the health event the app sends when it next goes to the
   * background: by then the call has ended, and the first version of this
   * cleared these numbers on teardown — so the only report I ever got was
   * zeros, which could mean "never tried" or "tried and failed" and therefore
   * meant nothing. Sent on its own, immediately, while the facts still exist.
   *
   * Counts and one word. No screen contents, no names, nothing about what was
   * being shared — this goes into a log read into a repository that has been
   * public.
   */
  private reportShare(outcome: string, extra?: Record<string, number>) {
    try {
      this.sock?.emit('call_diag', {
        what: 'share',
        outcome,
        tries: this.shareTries,
        captured: this.shareCaptured ? 1 : 0,
        senders: this.shareSenders,
        switched: this.shareSwitched,
        scale: this.shareScale,
        ...(extra || {}),
      });
    } catch {}
  }

  /**
   * Tell the encoder to send the screen at a size the call can carry.
   *
   * A camera call negotiates something like 640x480; a phone screen is about
   * 1080x2400. WebRTC adapts a CAMERA source down to fit, but the library
   * creates a screencast source with adaptation deliberately off so that text
   * stays sharp — so nothing brings the frame size down, and the encoder is
   * handed something it will not produce output for. The far end then freezes
   * on the last camera frame, which is exactly what was reported.
   *
   * Done with setParameters rather than by renegotiating the call. A second
   * offer mid-call is treated by the web client as a NEW INCOMING CALL and
   * hangs up, so renegotiation means changing the signalling at both ends —
   * which is the next thing to try, not the first.
   */
  private async fitScreenToCall(track: any) {
    const scale = scaleFor({
      width: track?.getSettings?.()?.width,
      height: track?.getSettings?.()?.height,
    });
    this.shareScale = scale;
    const jobs: Promise<any>[] = [];
    this.pcs.forEach((pc: any) => {
      pc.getSenders().forEach((sn: any) => {
        if (!sn.track || sn.track.kind !== 'video') return;
        try {
          const params: any = sn.getParameters();
          if (!params.encodings || !params.encodings.length) params.encodings = [{}];
          params.encodings.forEach((enc: any) => {
            enc.scaleResolutionDownBy = scale;
            enc.maxBitrate = MAX_BITRATE;
          });
          jobs.push(sn.setParameters(params).catch(() => {}));
        } catch {}
      });
    });
    await Promise.allSettled(jobs);
  }

  /**
   * Ask the encoder, a few seconds in, whether anything is coming out.
   *
   * The one fact that cannot be learned from this side of the code: frames
   * encoded is a counter inside WebRTC. Zero while the track is live means
   * the encoder is refusing the source; climbing means the picture is going
   * out and whatever is wrong is further along.
   */
  /** The outgoing video sender, whichever connection it is on. */
  private videoSender(): any {
    let sender: any = null;
    this.pcs.forEach((pc: any) => {
      pc.getSenders().forEach((sn: any) => {
        if (!sender && sn.track && sn.track.kind === 'video') sender = sn;
      });
    });
    return sender;
  }

  /**
   * What the outgoing video has done so far.
   *
   * -1 for a number the platform does not expose, which must stay distinct
   * from zero: one is a missing answer and the other is an answer.
   */
  private async videoStats(): Promise<{ encoded: number; sent: number; w: number; h: number }> {
    const out = { encoded: -1, sent: -1, w: 0, h: 0 };
    const sender = this.videoSender();
    if (!sender) return out;
    try {
      const stats = await sender.getStats();
      stats.forEach((r: any) => {
        if (r && r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
          if (typeof r.framesEncoded === 'number') out.encoded = r.framesEncoded;
          if (typeof r.framesSent === 'number') out.sent = r.framesSent;
          if (typeof r.frameWidth === 'number') out.w = r.frameWidth;
          if (typeof r.frameHeight === 'number') out.h = r.frameHeight;
        }
      });
    } catch {}
    return out;
  }

  /** Whether the call itself is up, which decides what the numbers mean. */
  private connState(): number {
    let up = 0;
    this.pcs.forEach((pc: any) => {
      const st = String(pc?.connectionState || pc?.iceConnectionState || '');
      if (st === 'connected' || st === 'completed') up = 1;
    });
    return up;
  }

  /**
   * Ask the encoder, a few seconds in, what the SCREEN contributed.
   *
   * The difference across the swap, not the total. framesEncoded is
   * cumulative for the whole outgoing stream, so the total carries whatever
   * the camera had already encoded — on a working call a dead share hides
   * inside a large number, and on a call that never connected the total is
   * zero whatever the screen does. The first version measured the total, and
   * the first report it produced could not be interpreted: encoded=0 on its
   * own does not say whether the screen failed or the call was idle.
   */
  private async sampleShare(startedAt: number, before: number) {
    if (!this.videoSender() || !this.sharingScreen) return;
    const { encoded, sent, w, h } = await this.videoStats();
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    this.shareEncoded = encoded;
    if (madeNoProgress({ before, after: encoded, seconds })) {
      this.shareFailed = 'no-frames';
      this.emit();
    }
    this.reportShare('stats', { encoded, sent, w, h, seconds, before, up: this.connState() });
  }

  async toggleScreenShare() {
    if (this.mode !== 'dm-video') return;
    if (this.sharingScreen) return this.stopScreenShare();
    let stream: any;
    try {
      stream = await (mediaDevices as any).getDisplayMedia();
    } catch (err: any) {
      // Refusing at the system sheet is a decision and says nothing. Anything
      // else is a failure, and a silent return is exactly how this looked like
      // it was working while doing nothing at all.
      const name = String(err?.name || err?.message || '');
      this.shareTries++;
      if (!/NotAllowed|Abort|cancel/i.test(name)) this.shareFailed = name || 'failed';
      this.reportShare(/NotAllowed|Abort|cancel/i.test(name) ? 'refused' : 'capture-failed');
      this.emit();
      return;
    }
    const track = stream?.getVideoTracks?.()[0];
    if (!track) {
      this.shareTries++;
      this.shareFailed = 'no-video-track';
      this.reportShare('no-track');
      this.emit();
      return;
    }
    this.shareCaptured = true;
    this.shareTries++;
    // Held, not just the track. A MediaStream this side forgets about is one
    // nothing is keeping alive, and the capturer belongs to it.
    this.screenStream = stream;
    this.cameraTrack = this.localStream?.getVideoTracks()[0] || null;
    this.cameraWasOff = this.cameraOff;
    this.screenTrack = track;
    this.sharingScreen = true;
    track.onended = () => { this.stopScreenShare(); };
    const replaced = await this.useVideoTrack(track);
    // Nothing took it. Claiming to share now would be a lie, and the call
    // would carry on sending the camera while the button said otherwise.
    if (!replaced) {
      this.sharingScreen = false;
      this.screenTrack = null;
      track.onended = null;
      try { track.stop(); } catch {}
      if (this.cameraTrack) await this.useVideoTrack(this.cameraTrack);
      this.cameraTrack = null;
      this.shareFailed = 'no-sender';
      this.reportShare('no-sender');
      this.emit();
      return;
    }
    this.shareFailed = null;
    // Before the first report, so the numbers describe the stream that is
    // actually going out rather than the one before it was sized.
    await this.fitScreenToCall(track);
    this.reportShare('ok', { up: this.connState() });
    const startedAt = Date.now();
    // Read AFTER the swap. The counter belongs to the outgoing stream rather
    // than to the track, so swapping does not reset it — and a reading taken
    // before the system's capture sheet would be however long the person
    // spent looking at that sheet out of date.
    const baseline = (await this.videoStats()).encoded;
    setTimeout(() => { this.sampleShare(startedAt, baseline).catch(() => {}); }, SAMPLE_AFTER_MS);
    // A camera that was off has a picture going out again, and the other end
    // is told so — it has been looking at the "camera off" placeholder.
    if (this.cameraOff && this.peerId != null) {
      this.cameraOff = false;
      this.sock?.emit('call_camera', { toUserId: this.peerId, off: false });
    }
    this.emit();
  }

  async stopScreenShare() {
    if (!this.sharingScreen) return;
    const screen = this.screenTrack;
    this.screenTrack = null;
    this.sharingScreen = false;
    if (screen) screen.onended = null;
    let cam = this.cameraTrack;
    this.cameraTrack = null;
    if (!cam || cam.readyState === 'ended') {
      try {
        const fresh: any = await (mediaDevices as any).getUserMedia({
          video: { facingMode: this.frontCamera ? 'user' : 'environment' }, audio: false,
        });
        cam = fresh?.getVideoTracks?.()[0] || null;
      } catch { cam = null; }
    }
    // A camera that was off before the share goes back to being off, rather
    // than surprising somebody with their own face.
    if (cam) cam.enabled = !this.cameraWasOff;
    if (cam) await this.useVideoTrack(cam);
    if (this.cameraWasOff !== this.cameraOff && this.peerId != null) {
      this.cameraOff = this.cameraWasOff;
      this.sock?.emit('call_camera', { toUserId: this.peerId, off: this.cameraOff });
    }
    try { screen?.stop(); } catch {}
    try { this.screenStream?.release?.(); } catch {}
    this.screenStream = null;
    this.emit();
  }

  // Record the finished call in the DM's chat history (server inserts a
  // 'call' message both users receive). Outcome: 'completed' | 'missed' |
  // 'failed' | 'declined'.
  private logCall(outcome: string) {
    if (this.logged || !this.peerId) return;
    this.logged = true;
    const duration = this.connectedAt ? Math.round((Date.now() - this.connectedAt) / 1000) : 0;
    try {
      this.sock?.emit('call_log', {
        peerId: this.peerId,
        kind: this.mode === 'dm-video' ? 'video' : 'voice',
        outcome, duration, outgoing: this.outgoing,
      });
    } catch {}
  }

  private sock: any = null;
  private pcs = new Map<number, RTCPeerConnection>();
  private pendingIce = new Map<number, any[]>(); // candidates that arrived before the pc was ready
  private iceServers: any[] = [{ urls: ['stun:stun.l.google.com:19302'] }];
  private roomVoiceId: number | null = null;
  private listeners = new Set<Listener>();
  private initPromise: Promise<void> | null = null;
  private noAnswerTimer: any = null;
  /** Backstop for an incoming ring nobody ever cancels. See onOffer. */
  private ringTimeout: any = null;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { this.listeners.forEach(f => f()); }

  // Fetch TURN/STUN servers fresh — stale or missing TURN credentials are
  // the #1 reason calls never connect across mobile networks.
  private async refreshIce() {
    try {
      const cfg = await apiFetch('/ice-config');
      if (cfg?.iceServers?.length) this.iceServers = cfg.iceServers;
    } catch {}
  }

  async init() {
    // A single shared promise: concurrent callers WAIT for the socket to be
    // bound instead of racing ahead with this.sock still null (which made
    // the call window flash and immediately die).
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit() {
    await this.refreshIce();
    const s = await getSocket();
    this.sock = s;
    s.on('call_offer', (offer: any) => this.onOffer(offer));
    s.on('call_answer', async ({ fromUserId, sdp }: any) => {
      const pc = this.pcs.get(fromUserId);
      if (pc) await pc.setRemoteDescription(sdp).catch(() => {});
      this.flushIce(fromUserId);
      // Answer received = signaling done; real "Connected" comes from ICE
      if (this.mode !== 'room-voice') {
        this.stopRing();
        try { InCallManager?.stopRingback?.(); } catch {}
        this.out = { ...this.out, answered: true };
        this.status = outgoingStatus(this.out); this.emit();
      }
    });
    // The callee's app confirming it is actually alerting. Until this lands,
    // "Ringing…" would be a guess about a phone we have not heard from.
    s.on('call_ringing', ({ fromUserId }: any) => {
      if (!this.mode?.startsWith('dm') || this.peerId !== fromUserId) return;
      this.out = { ...this.out, ringing: true };
      this.status = outgoingStatus(this.out);
      this.emit();
    });
    s.on('call_ice', ({ fromUserId, candidate }: any) => {
      const pc = this.pcs.get(fromUserId);
      // Candidates often arrive before the callee accepts (no pc yet) or
      // before setRemoteDescription — buffer them or the call dies mid-setup.
      if (!pc || !(pc as any).remoteDescription) {
        if (!this.pendingIce.has(fromUserId)) this.pendingIce.set(fromUserId, []);
        this.pendingIce.get(fromUserId)!.push(candidate);
        return;
      }
      pc.addIceCandidate(candidate).catch(() => {});
    });
    s.on('call_camera', ({ fromUserId, off }: any) => {
      // Only about the person we are actually in a call with; a stale event
      // from a previous call must not black out this one's picture.
      if (this.peerId == null || String(this.peerId) !== String(fromUserId)) return;
      this.remoteCameraOff = !!off;
      this.emit();
    });
    s.on('call_end', ({ fromUserId }: any) => {
      this.dropPeer(fromUserId);
      // `mode` is only set once a call is ACCEPTED, so asking whether it
      // starts with 'dm' missed the case that matters most: a phone that is
      // merely RINGING. There is no peer connection to drop and no mode to
      // match, so the caller hanging up did nothing at all here and the ring
      // went on for ever. See endStopsCall.
      if (endStopsCall({
        fromUserId,
        mode: this.mode,
        peerId: this.peerId,
        incomingFrom: this.incoming?.fromUserId,
      })) {
        this.teardown();
      }
    });
    s.on('voice_peer_joined', async ({ roomId, userId }: any) => {
      if (this.mode === 'room-voice' && String(roomId) === String(this.roomVoiceId)) {
        try { await this.makeOffer(userId, { roomId }); } catch { this.dropPeer(userId); }
      }
    });
    s.on('voice_peer_left', ({ roomId, userId }: any) => {
      if (this.mode === 'room-voice' && String(roomId) === String(this.roomVoiceId)) this.dropPeer(userId);
    });
    s.on('voice_count', ({ roomId, count, usernames }: any) => {
      // ── Recorded for EVERY room, not only the one you are calling in ────
      //
      // This handler used to begin with `if (this.mode === 'room-voice')`,
      // so the count was visible only to somebody already in the call. That
      // is the whole reason room calls "didn't work at all": the first person
      // to tap the button waited alone, because nothing on any other member's
      // phone changed in any way. A room call cannot connect until a second
      // person joins, and nobody had been given a reason to.
      const key = String(roomId);
      const n = Number(count) || 0;
      if (n > 0) this.roomVoice.set(key, { count: n, usernames: usernames || [] });
      else this.roomVoice.delete(key);
      this.roomVoiceListeners.forEach(fn => { try { fn(); } catch {} });
      if (this.mode === 'room-voice' && key === String(this.roomVoiceId)) {
        this.status = `Voice chat · ${n} in`;
        this.emit();
      }
    });
  }

  // getUserMedia without granted runtime permissions hard-crashes the app on
  // some Android builds instead of rejecting — ask explicitly first, and stop
  // any expo-av playback/recording that holds the audio session.
  private async ensurePermissions(video: boolean): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    try {
      const wanted = [
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ...(video ? [PermissionsAndroid.PERMISSIONS.CAMERA] : []),
      ];
      const res = await PermissionsAndroid.requestMultiple(wanted);
      return wanted.every(w => res[w] === PermissionsAndroid.RESULTS.GRANTED);
    } catch {
      return true; // fall through and let getUserMedia decide
    }
  }

  private async getMedia(video: boolean): Promise<MediaStream | null> {
    try { audioManager.stop(); } catch {}
    if (!(await this.ensurePermissions(video))) return null;
    try {
      return await (mediaDevices.getUserMedia({
        audio: true,
        video: video ? { facingMode: 'user', width: 640, height: 480 } : false,
      }) as Promise<MediaStream>);
    } catch {
      return null;
    }
  }

  private newPc(userId: number): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    (pc as any).onicecandidate = (e: any) => {
      if (e.candidate) this.sock.emit('call_ice', { toUserId: userId, candidate: e.candidate });
    };
    (pc as any).ontrack = (e: any) => {
      if (this.mode === 'dm-video') {
        this.remoteStream = e.streams[0];
      }
      // Voice: react-native-webrtc routes received audio to the speaker
      // automatically once the track is added to a connection.
      this.emit();
    };
    (pc as any).onconnectionstatechange = () => {
      const st = (pc as any).connectionState;
      if (st === 'failed') {
        if (this.mode?.startsWith('dm')) {
          this.status = 'Connection failed';
          this.emit();
          setTimeout(() => this.end(), 2500);
          return;
        }
        this.dropPeer(userId);
      }
      if (st === 'closed') this.dropPeer(userId);
      if (st === 'connected') {
        if (this.mode === 'room-voice') this.markRoomAudioStarted();
        else this.markConnected();
      }
    };
    (pc as any).oniceconnectionstatechange = () => {
      const st = (pc as any).iceConnectionState;
      if (this.mode?.startsWith('dm') && !this.connectedAt) {
        if (st === 'checking') { this.status = 'Connecting…'; this.emit(); }
      }
      if (st === 'disconnected' && this.mode?.startsWith('dm') && this.connectedAt) {
        this.status = 'Reconnecting…'; this.emit();
      }
      if (st === 'connected' || st === 'completed') {
        if (this.mode === 'room-voice') this.markRoomAudioStarted();
        else this.markConnected();
      }
    };
    this.localStream?.getTracks().forEach(t => (pc as any).addTrack(t, this.localStream));
    this.pcs.set(userId, pc);
    return pc;
  }

  private async makeOffer(userId: number, extra: any = {}) {
    const pc = this.newPc(userId);
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    // The ack says whether the server had a live socket to hand this to. It
    // is the difference between "their phone has the call" and "a push has
    // been sent to a phone that may be face down in a drawer", and the caller
    // is entitled to know which one they are waiting on.
    this.sock.emit('call_offer', {
      toUserId: userId, kind: this.mode === 'dm-video' ? 'video' : 'voice',
      sdp: (pc as any).localDescription, ...extra,
    }, (res: any) => {
      if (!this.mode?.startsWith('dm') || this.peerId !== userId) return;
      if (this.out.ringing || this.out.answered || this.out.connected) return;
      this.out = { ...this.out, delivered: !!res?.delivered, pushed: !!res?.pushed };
      this.status = outgoingStatus(this.out);
      this.emit();
    });
  }

  private flushIce(userId: number) {
    const pc = this.pcs.get(userId);
    const queued = this.pendingIce.get(userId) || [];
    this.pendingIce.delete(userId);
    if (pc) queued.forEach(c => pc.addIceCandidate(c).catch(() => {}));
  }

  private dropPeer(userId: number) {
    this.pcs.get(userId)?.close();
    this.pcs.delete(userId);
    this.pendingIce.delete(userId);
    if (this.mode === 'room-voice' && !this.pcs.size) {
      this.status = 'Voice chat · waiting for others…';
    }
    this.emit();
  }

  private teardown() {
    // Log the DM call outcome before clearing state (rooms aren't logged).
    if (this.mode?.startsWith('dm')) {
      this.logCall(this.connectedAt ? 'completed' : 'missed');
    }
    this.pcs.forEach(pc => pc.close());
    this.pcs.clear();
    this.pendingIce.clear();
    this.localStream?.getTracks().forEach(t => t.stop());
    if (this.mode === 'room-voice' && this.roomVoiceId != null) {
      this.sock?.emit('voice_leave', { roomId: this.roomVoiceId });
    }
    try { InCallManager?.stop(); InCallManager?.stopRingback?.(); } catch {}
    this.localStream = null;
    this.remoteStream = null;
    this.mode = null;
    this.roomVoiceId = null;
    this.incoming = null;
    this.muted = false;
    this.cameraOff = false;
    this.remoteCameraOff = false;
    this.speakerOn = false;
    this.minimized = false;
    this.videoSwapped = false;
    this.out = {};
    ongoing.stopOngoing();
    // Hand the earpiece routing back, or every voice note played afterwards
    // comes out of it too — silent, as far as anyone holding the phone
    // normally can tell.
    Audio.setAudioModeAsync({ playThroughEarpieceAndroid: false, staysActiveInBackground: true })
      .catch(() => {});
    this.frontCamera = true;
    this.sharingScreen = false;
    this.screenTrack = null;
    this.cameraTrack = null;
    this.cameraWasOff = false;
    // shareFailed/shareCaptured/shareSenders/shareSwitched are NOT cleared
    // here: they are the record of what the last attempt did, and clearing
    // them on teardown is what made the first report unreadable.
    this.roomAudioStarted = false;
    this.connectedAt = null;
    this.peerId = null;
    clearTimeout(this.noAnswerTimer);
    clearTimeout(this.ringTimeout);
    this.stopRing();
    this.emit();
  }

  private async onOffer(offer: any) {
    if (offer.roomId != null) {
      if (this.mode === 'room-voice' && String(offer.roomId) === String(this.roomVoiceId)) {
        try {
          const pc = this.newPc(offer.fromUserId);
          await pc.setRemoteDescription(offer.sdp);
          this.flushIce(offer.fromUserId);
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          this.sock.emit('call_answer', { toUserId: offer.fromUserId, sdp: (pc as any).localDescription });
        } catch {
          this.dropPeer(offer.fromUserId);
        }
      }
      return;
    }
    if (this.mode) { this.sock.emit('call_end', { toUserId: offer.fromUserId }); return; } // busy
    this.incoming = offer;
    // Auto-accept if the user already tapped "Accept" on the notification.
    if (this.autoAcceptFrom && this.autoAcceptFrom === offer.fromUserId) {
      this.autoAcceptFrom = null;
      this.emit();
      this.accept();
      return;
    }
    // An incoming ring is the phone ringing at somebody who is not holding it,
    // so it goes to the loudspeaker — the one tone routeFor deliberately keeps
    // off the earpiece.
    Audio.setAudioModeAsync({ playThroughEarpieceAndroid: false, staysActiveInBackground: true })
      .catch(() => {});
    this.startTone('callee');
    // A deadline on the ring itself.
    //
    // The caller gives up after 45s and sends call_end, and that is the
    // ordinary ending. But if their app is killed or their network drops, no
    // such event is ever sent — and with nothing here to stop it the phone
    // rang until somebody noticed. Longer than their 45s so the ordinary path
    // still wins and this only fires when something has gone wrong.
    clearTimeout(this.ringTimeout);
    this.ringTimeout = setTimeout(() => {
      if (this.incoming && String(this.incoming.fromUserId) === String(offer.fromUserId)) {
        this.teardown();
      }
    }, RING_TIMEOUT_MS);
    this.syncOngoing();
    // Tell the caller their phone is actually ringing here. Without this the
    // caller's screen has nothing to go on but hope.
    try { this.sock.emit('call_ringing', { toUserId: offer.fromUserId }); } catch {}
    this.emit();
  }

  // ── Answering from the notification shade ──
  private autoAcceptFrom: number | null = null;

  // Called when the user taps "Accept" on the call notification: accept the
  // incoming offer as soon as it's (re)delivered over the reconnected socket.
  armAutoAccept(fromUserId: number) {
    if (!fromUserId) return;
    this.autoAcceptFrom = fromUserId;
    // Already ringing? accept right now.
    if (this.incoming && this.incoming.fromUserId === fromUserId) {
      this.autoAcceptFrom = null;
      this.accept();
    } else {
      // Give the server a moment to re-deliver, then give up arming.
      setTimeout(() => { this.autoAcceptFrom = null; }, 15000);
    }
  }

  // Called when the user taps "Decline" on the call notification.
  declineIncomingFrom(fromUserId: number) {
    getSocket().then(s => {
      if (this.incoming && this.incoming.fromUserId === fromUserId) {
        this.decline();
      } else if (fromUserId) {
        s.emit('call_end', { toUserId: fromUserId });
      }
    }).catch(() => {});
  }

  async startDM(peerId: number | null, peerName: string, kind: 'voice' | 'video') {
    if (this.mode || !peerId) return;
    await this.init();
    await this.refreshIce();
    const stream = await this.getMedia(kind === 'video');
    if (!stream) return;
    this.localStream = stream;
    this.peerId = peerId; this.peerName = peerName; this.outgoing = true; this.logged = false;
    this.mode = kind === 'video' ? 'dm-video' : 'dm-voice';
    this.title = (kind === 'video' ? '🎥 ' : '📞 ') + peerName;
    // Route first, THEN make a noise: the order is the whole fix for a
    // ringback that came out of the loudspeaker.
    this.applyRoute('outgoing');
    this.out = {};
    this.minimized = false;
    this.status = outgoingStatus(this.out);
    // Our own ringback, and ONLY ours: InCallManager's was started here too,
    // so two tones played over each other and the loud one won.
    this.startTone('caller');
    this.syncOngoing();
    this.emit();
    // Give up after NO_ANSWER_MS of no answer (logged as a missed call)
    clearTimeout(this.noAnswerTimer);
    this.noAnswerTimer = setTimeout(() => {
      if (this.mode?.startsWith('dm') && !this.connectedAt) {
        this.status = 'No answer';
        this.emit();
        setTimeout(() => this.end(), 1200);
      }
    }, NO_ANSWER_MS);
    try { await this.makeOffer(peerId); } catch { this.end(); }
  }

  async accept() {
    const offer = this.incoming;
    this.incoming = null;
    this.stopRing();
    if (!offer) return;
    await this.refreshIce();
    const stream = await this.getMedia(offer.kind === 'video');
    if (!stream) {
      this.sock.emit('call_end', { toUserId: offer.fromUserId });
      this.emit();
      return;
    }
    this.localStream = stream;
    this.peerId = offer.fromUserId; this.peerName = offer.fromUsername; this.outgoing = false; this.logged = false;
    try { InCallManager?.stopRingtone?.(); } catch {}
    this.mode = offer.kind === 'video' ? 'dm-video' : 'dm-voice';
    this.title = (offer.kind === 'video' ? '🎥 ' : '📞 ') + offer.fromUsername;
    this.status = 'Connecting…';
    this.minimized = false;
    this.syncOngoing();
    this.emit();
    try {
      const pc = this.newPc(offer.fromUserId);
      await pc.setRemoteDescription(offer.sdp);
      this.flushIce(offer.fromUserId);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      this.sock.emit('call_answer', { toUserId: offer.fromUserId, sdp: (pc as any).localDescription });
    } catch {
      this.end();
    }
  }

  decline() {
    if (this.incoming) {
      this.sock.emit('call_end', { toUserId: this.incoming.fromUserId });
      // Log the declined incoming call so it shows in history for both sides.
      this.peerId = this.incoming.fromUserId; this.peerName = this.incoming.fromUsername;
      this.outgoing = false; this.mode = this.incoming.kind === 'video' ? 'dm-video' : 'dm-voice';
      this.logCall('declined');
      this.mode = null;
    }
    this.incoming = null;
    this.stopRing();
    this.emit();
  }

  async toggleRoomVoice(roomId: number, roomName: string) {
    if (this.mode === 'room-voice') return this.end();
    if (this.mode) return;
    await this.init();
    await this.refreshIce();
    const stream = await this.getMedia(false);
    if (!stream) return;
    this.localStream = stream;
    this.mode = 'room-voice';
    this.roomVoiceId = roomId;
    this.title = '📞 ' + roomName;
    this.status = 'Voice chat · joining…';
    this.emit();
    this.sock.emit('voice_join', { roomId });
  }

  // ── Who is in each room's voice chat, for the rooms you are NOT in ──────
  //
  // Kept here rather than in a screen because it must survive a screen being
  // unmounted: the point of it is to be true on a phone whose owner is
  // reading something else entirely.
  private roomVoice = new Map<string, { count: number; usernames: string[] }>();
  private roomVoiceListeners = new Set<() => void>();

  /** Am I currently in THIS room's voice chat? */
  inRoomVoice(roomId: number | string | null | undefined): boolean {
    if (roomId == null) return false;
    return this.mode === 'room-voice' && String(this.roomVoiceId) === String(roomId);
  }

  /** Who is in this room's voice chat right now, or null if nobody is. */
  voiceIn(roomId: number | string | null | undefined):
    { count: number; usernames: string[] } | null {
    if (roomId == null) return null;
    return this.roomVoice.get(String(roomId)) || null;
  }

  /** Re-render when any room's voice chat changes. Returns an unsubscribe. */
  onRoomVoice(fn: () => void): () => void {
    this.roomVoiceListeners.add(fn);
    return () => { this.roomVoiceListeners.delete(fn); };
  }

  end() {
    this.pcs.forEach((_pc, userId) => this.sock?.emit('call_end', { toUserId: userId }));
    this.teardown();
  }

  toggleMute() {
    if (!this.localStream) return;
    this.muted = !this.muted;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = !this.muted; });
    this.emit();
  }

  toggleCamera() {
    if (!this.localStream) return;
    this.cameraOff = !this.cameraOff;
    this.localStream.getVideoTracks().forEach(t => { t.enabled = !this.cameraOff; });
    // Say so. Disabling a track is a LOCAL act — nothing about it reaches the
    // peer, who just sees black and cannot tell it from a broken connection.
    if (this.peerId != null) {
      this.sock?.emit('call_camera', { toUserId: this.peerId, off: this.cameraOff });
    }
    this.emit();
  }
}

export const callManager = new CallManager();


/**
 * Decline from the ringing notification while the app is in the background.
 *
 * A background process may have no live socket, so this opens a short-lived
 * one purely to deliver the hang-up. Best effort by design: if it fails, the
 * caller simply sees the call ring out — the same as a missed call.
 */
export async function declineCallInBackground(fromUserId: any): Promise<void> {
  if (!fromUserId) return;
  try {
    const sock = await getSocket();
    sock?.emit('call_end', { toUserId: parseInt(String(fromUserId), 10) });
  } catch {}
}
