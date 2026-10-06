// App-wide call UI: full-screen incoming-call screen and full-screen active
// call, in the spirit of Telegram/WhatsApp — big avatar, name, live timer,
// round controls at the bottom.
import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions, PanResponder, Keyboard } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RTCView } from 'react-native-webrtc';
import { C } from '../theme';
import { callManager } from '../callManager';
import {
  canMinimize, clampToScreen, snapToEdge, defaultPosition, isDrag,
  videoPanes, canSwapVideos, mirrors, shareFailureText,
  showBigPlaceholder, cameraOffFor,
} from '../callWindow';

/** The bubble a minimized call shrinks to. */
const PILL = { w: 168, h: 56 };

function fmtElapsed(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m % 60)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

function initialsOf(title: string) {
  const name = title.replace(/^[^A-Za-z0-9؀-ۿ]+/, '').trim();
  return (name || '?').slice(0, 2).toUpperCase();
}

export default function CallOverlay() {
  const [, forceUpdate] = useReducer(x => x + 1, 0);
  useEffect(() => callManager.subscribe(forceUpdate), []);

  const cm = callManager;

  // A call arriving over an open keyboard leaves it sitting across the bottom
  // of the screen with Accept and Decline behind it. Dismissed whenever a call
  // starts or arrives — nobody is typing into a chat they are about to answer
  // a call from, and it costs nothing when there is no keyboard up.
  const callUp = !!cm.mode || !!cm.incoming;
  useEffect(() => {
    if (callUp) Keyboard.dismiss();
  }, [callUp]);

  // Which video goes in which pane. Computed here rather than inside the
  // video branch because the placeholder below needs to know which side the
  // big pane is showing before it can say whose camera is off.
  const panesFor = videoPanes({
    swapped: cm.videoSwapped,
    hasRemote: !!cm.remoteStream,
    hasLocal: !!cm.localStream,
    cameraOff: cm.cameraOff,
  });


  // Tick the timer once a second while connected
  useEffect(() => {
    if (!cm.connectedAt) return;
    const t = setInterval(forceUpdate, 1000);
    return () => clearInterval(t);
  }, [cm.connectedAt]);

  const screen = Dimensions.get('window');
  const { height: H } = screen;

  // Hooks cannot live behind the early return below, so the bubble's position
  // is set up whether or not there is a call to draw.
  const [pos, setPos] = useState(() => defaultPosition(PILL, { w: screen.width, h: screen.height }));
  const posRef = useRef(pos);
  posRef.current = pos;
  const draggedRef = useRef(false);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    // Claim the gesture only once it is a drag, so a tap still reaches the
    // buttons inside the bubble.
    onMoveShouldSetPanResponder: (_e, g) => isDrag(g.dx, g.dy),
    onPanResponderGrant: () => { draggedRef.current = false; },
    onPanResponderMove: (_e, g) => {
      draggedRef.current = draggedRef.current || isDrag(g.dx, g.dy);
      setPos(clampToScreen(
        { x: posRef.current.x + g.dx, y: posRef.current.y + g.dy },
        PILL, { w: screen.width, h: screen.height }));
      posRef.current = { x: posRef.current.x + g.dx, y: posRef.current.y + g.dy };
    },
    onPanResponderRelease: () => {
      // Snap to the nearer edge: a bubble left floating in the middle sits on
      // top of the message you are trying to read.
      setPos(p => snapToEdge(p, PILL, { w: screen.width, h: screen.height }));
    },
  }), [screen.width, screen.height]);

  if (!cm.mode && !cm.incoming) return null;

  // ── Minimized: a bubble over the chat, which stays usable ──
  if (cm.minimized && cm.mode && !cm.incoming) {
    const mini = cm.connectedAt ? fmtElapsed(Date.now() - cm.connectedAt) : cm.status;
    return (
      <View style={[s.pill, { left: pos.x, top: pos.y, width: PILL.w, height: PILL.h }]}
        {...pan.panHandlers}>
        <TouchableOpacity style={s.pillBody} activeOpacity={0.8}
          onPress={() => { if (!draggedRef.current) cm.expand(); }}
          accessibilityLabel="Return to call">
          <Ionicons name={cm.mode === 'dm-video' ? 'videocam' : 'call'} size={16} color="#fff" />
          <View style={s.pillText}>
            <Text style={s.pillName} numberOfLines={1}>{cm.title.replace(/^[^ ]+ /, '')}</Text>
            <Text style={s.pillTime} numberOfLines={1}>{mini}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={s.pillBtn} onPress={() => cm.toggleMute()} hitSlop={hit8}
          accessibilityLabel={cm.muted ? 'Unmute' : 'Mute'}>
          <Ionicons name={cm.muted ? 'mic-off' : 'mic'} size={16} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={[s.pillBtn, s.pillEnd]} onPress={() => cm.end()} hitSlop={hit8}
          accessibilityLabel="End call">
          <Ionicons name="call" size={15} color="#fff" style={s.endIcon} />
        </TouchableOpacity>
      </View>
    );
  }

  // ── Incoming call: full-screen like a real phone call ──
  if (cm.incoming) {
    const inc = cm.incoming;
    return (
      <View style={s.fullscreen}>
        <View style={s.incomingKindRow}>
          <Ionicons name={inc.kind === 'video' ? 'videocam' : 'call'} size={16} color="rgba(255,255,255,0.75)" />
          <Text style={s.incomingKind}>{inc.kind === 'video' ? 'Incoming video call' : 'Incoming voice call'}</Text>
        </View>
        <View style={[s.bigAvatar, { marginTop: H * 0.12 }]}>
          <Text style={s.bigAvatarText}>{initialsOf(inc.fromUsername)}</Text>
        </View>
        <Text style={s.callerName}>{inc.fromUsername}</Text>
        <Text style={s.callState}>is calling you…</Text>
        <View style={s.incomingActions}>
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.callBtn, s.declineBtn]} onPress={() => cm.decline()}>
              <Ionicons name="call" size={30} color="#fff" style={s.endIcon} />
            </TouchableOpacity>
            <Text style={s.actionLabel}>Decline</Text>
          </View>
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.callBtn, s.acceptBtn]} onPress={() => cm.accept()}>
              <Ionicons name="call" size={30} color="#fff" />
            </TouchableOpacity>
            <Text style={s.actionLabel}>Accept</Text>
          </View>
        </View>
      </View>
    );
  }

  // ── Active call: full-screen ──
  const isVideo = cm.mode === 'dm-video';
  const elapsed = cm.connectedAt ? fmtElapsed(Date.now() - cm.connectedAt) : null;
  return (
    <View style={s.fullscreen}>
      {/* Put the call down without hanging up. Not offered on an incoming
          call, which is a question that wants an answer now. */}
      {canMinimize(cm.windowPhase) && (
        <TouchableOpacity style={s.minimizeBtn} onPress={() => cm.minimize()} hitSlop={hit8}
          accessibilityLabel="Minimize call">
          <Ionicons name="chevron-down" size={26} color="#fff" />
        </TouchableOpacity>
      )}
      {/* Which video fills the screen is the user's choice: tap the small one
          to swap. The rule lives in callWindow so the two cases that would
          otherwise strand somebody looking at black — no remote stream yet,
          and your own camera turned off while you are the big pane — are
          decided in one place rather than in three conditions here. */}
      {isVideo && (() => {
        const panes = panesFor;
        const streamOf = (p: 'remote' | 'local') => (p === 'remote' ? cm.remoteStream : cm.localStream);
        const bigStream = streamOf(panes.big);
        const wantSmall = panes.small ? streamOf(panes.small) : null;
        // Reported as: sometimes both windows show one side's video. Whatever
        // lets the two panes resolve to the same stream — a renegotiation
        // handing back the local stream as the remote one, the same object
        // arriving on both — the corner is the one to drop. Two copies of one
        // person is strictly worse than one, and it hides that the other side
        // has not actually arrived yet.
        const smallStream = wantSmall && wantSmall !== bigStream ? wantSmall : null;
        const swappable = canSwapVideos({
          hasRemote: !!cm.remoteStream, hasLocal: !!cm.localStream, cameraOff: cm.cameraOff,
        });
        return (
          <>
            {bigStream && (
              <RTCView
                streamURL={bigStream.toURL()}
                style={StyleSheet.absoluteFill as any}
                objectFit="cover"
                // The mirror follows the STREAM, not the pane: your own front
                // camera is mirrored wherever it is shown, and the other
                // person never is — mirroring them shows their text backwards.
                mirror={mirrors(panes.big, cm.frontCamera)}
              />
            )}
            {smallStream && panes.small && (
              <TouchableOpacity
                style={s.localVideo}
                activeOpacity={swappable ? 0.85 : 1}
                onPress={() => cm.swapVideos()}
                disabled={!swappable}
                accessibilityLabel={panes.small === 'local'
                  ? 'Show my video full screen' : "Show the other person's video full screen"}
              >
                <RTCView
                  streamURL={smallStream.toURL()}
                  style={StyleSheet.absoluteFill as any}
                  objectFit="cover"
                  zOrder={1}
                  mirror={mirrors(panes.small, cm.frontCamera)}
                />
                {/* Says the corner is a control, not a decoration. */}
                {swappable && (
                  <View style={s.swapHint}>
                    <Ionicons name="swap-horizontal" size={13} color="#fff" />
                  </View>
                )}
              </TouchableOpacity>
            )}
          </>
        );
      })()}

      {/* A camera that is OFF is not the same as a call with no video, but it
          looked the same: the stream is still there (the audio track keeps it
          alive), so an RTCView was drawn over a track with nothing in it and
          the screen went black. Black is also what a dead connection looks
          like, which is the part that matters. */}
      {showBigPlaceholder({
        isVideo, hasRemote: !!cm.remoteStream, bigPane: panesFor.big,
        cameraOff: cm.cameraOff, remoteCameraOff: cm.remoteCameraOff,
      }) && (
        cameraOffFor(panesFor.big, { cameraOff: cm.cameraOff, remoteCameraOff: cm.remoteCameraOff })
          ? (
            <View style={s.cameraOffPane}>
              <Text style={s.cameraOffEmoji}>🙈</Text>
              <Text style={s.cameraOffText}>
                {panesFor.big === 'local' ? 'Your camera is off' : 'Camera is off'}
              </Text>
            </View>
          )
          : (
            <View style={[s.bigAvatar, { marginTop: H * 0.16 }]}>
              <Text style={s.bigAvatarText}>{initialsOf(cm.title)}</Text>
            </View>
          )
      )}
      <View style={isVideo && cm.remoteStream ? s.infoOnVideo : s.info}>
        <Text style={s.callerName} numberOfLines={1}>{cm.title.replace(/^[^ ]+ /, '')}</Text>
        <Text style={s.callState}>{elapsed ?? cm.status}</Text>
      </View>

      <View style={s.controls}>
        <View style={s.actionCol}>
          <TouchableOpacity style={[s.roundBtn, s.ctrlBtn, cm.muted && s.ctrlActive]} onPress={() => cm.toggleMute()}>
            <Ionicons name={cm.muted ? 'mic-off' : 'mic'} size={25} color={cm.muted ? '#111827' : '#fff'} />
          </TouchableOpacity>
          <Text style={s.actionLabel}>{cm.muted ? 'Unmute' : 'Mute'}</Text>
        </View>
        {/* Voice: speaker/earpiece toggle like a real phone call */}
        {!isVideo && (
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.ctrlBtn, cm.speakerOn && s.ctrlActive]} onPress={() => cm.toggleSpeaker()}>
              <Ionicons name={cm.speakerOn ? 'volume-high' : 'ear'} size={25} color={cm.speakerOn ? '#111827' : '#fff'} />
            </TouchableOpacity>
            <Text style={s.actionLabel}>{cm.speakerOn ? 'Speaker' : 'Earpiece'}</Text>
          </View>
        )}
        {isVideo && (
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.ctrlBtn, cm.cameraOff && s.ctrlActive]} onPress={() => cm.toggleCamera()}>
              <Ionicons name={cm.cameraOff ? 'videocam-off' : 'videocam'} size={25} color={cm.cameraOff ? '#111827' : '#fff'} />
            </TouchableOpacity>
            <Text style={s.actionLabel}>Camera</Text>
          </View>
        )}
        {/* Video: flip front/back camera. Not while the screen is being
            shared — there is no camera in the call to flip. */}
        {isVideo && !cm.sharingScreen && (
          <View style={s.actionCol}>
            <TouchableOpacity style={[s.roundBtn, s.ctrlBtn]} onPress={() => cm.switchCamera()}>
              <Ionicons name="camera-reverse" size={25} color="#fff" />
            </TouchableOpacity>
            <Text style={s.actionLabel}>Flip</Text>
          </View>
        )}
        {/* Video: share this screen instead of the camera. The display track
            goes into the sender the camera was using, so the other end sees
            one video throughout.

            A failure says so. Every one of them used to be swallowed, so a
            share that never started and a share that was working looked
            exactly alike — which is what "it does not share anything" was. */}
        {isVideo && !!cm.shareFailed && (
          <Text style={s.shareError} numberOfLines={2}>
            {shareFailureText(cm.shareFailed)}
          </Text>
        )}
        {isVideo && (
          <View style={s.actionCol}>
            <TouchableOpacity
              style={[s.roundBtn, s.ctrlBtn, cm.sharingScreen && s.ctrlActive]}
              onPress={() => cm.toggleScreenShare()}>
              <Ionicons name={cm.sharingScreen ? 'stop-circle' : 'phone-portrait'} size={25} color={cm.sharingScreen ? '#111827' : '#fff'} />
            </TouchableOpacity>
            <Text style={s.actionLabel}>{cm.sharingScreen ? 'Stop' : 'Share'}</Text>
          </View>
        )}
        <View style={s.actionCol}>
          <TouchableOpacity style={[s.roundBtn, s.callBtn, s.declineBtn]} onPress={() => cm.end()}>
            <Ionicons name="call" size={28} color="#fff" style={s.endIcon} />
          </TouchableOpacity>
          <Text style={s.actionLabel}>End</Text>
        </View>
      </View>
    </View>
  );
}

const hit8 = { top: 8, bottom: 8, left: 8, right: 8 };

const s = StyleSheet.create({
  shareError: {
    color: '#fca5a5', fontSize: 12, textAlign: 'center',
    paddingHorizontal: 16, marginBottom: 6,
  },

  minimizeBtn: {
    position: 'absolute', top: 44, left: 14, zIndex: 10,
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  pill: {
    position: 'absolute', zIndex: 400,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, borderRadius: 28,
    backgroundColor: '#0c1220',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 12,
  },
  pillBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7, minWidth: 0 },
  pillText: { flex: 1, minWidth: 0 },
  pillName: { color: '#fff', fontSize: 12.5, fontWeight: '700' },
  pillTime: { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontVariant: ['tabular-nums'] },
  pillBtn: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  pillEnd: { backgroundColor: '#e5484d' },
  fullscreen: {
    ...StyleSheet.absoluteFillObject, zIndex: 400,
    backgroundColor: '#0c1220', alignItems: 'center',
  },
  incomingKindRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 64 },
  incomingKind: { color: 'rgba(255,255,255,0.75)', fontSize: 14, fontWeight: '600' },
  endIcon: { transform: [{ rotate: '135deg' }] },
  // Light, not black: a dark rectangle is indistinguishable from a call that
  // has died, and this is the opposite — everything is fine, there is just
  // nothing to look at.
  cameraOffPane: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#f1f5f9',
    alignItems: 'center', justifyContent: 'center',
  },
  cameraOffEmoji: { fontSize: 64 },
  cameraOffText: { marginTop: 10, color: '#475569', fontSize: 15, fontWeight: '600' },
  bigAvatar: {
    width: 128, height: 128, borderRadius: 64, backgroundColor: C.accent,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: C.accent, shadowOpacity: 0.5, shadowRadius: 30, shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  bigAvatarText: { color: '#fff', fontSize: 44, fontWeight: '800' },
  callerName: { color: '#fff', fontSize: 26, fontWeight: '800', marginTop: 22, paddingHorizontal: 24, textAlign: 'center' },
  callState: { color: 'rgba(255,255,255,0.65)', fontSize: 16, marginTop: 8, fontVariant: ['tabular-nums'] },
  info: { alignItems: 'center' },
  infoOnVideo: {
    position: 'absolute', top: 54, left: 0, right: 0, alignItems: 'center',
  },
  localVideo: {
    position: 'absolute', top: 48, right: 16, width: 104, height: 148,
    borderRadius: 12, backgroundColor: '#000', zIndex: 5,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
  },
  swapHint: {
    position: 'absolute', bottom: 5, right: 5,
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  incomingActions: {
    position: 'absolute', bottom: 70, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-evenly',
  },
  controls: {
    position: 'absolute', bottom: 60, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-evenly',
  },
  actionCol: { alignItems: 'center', gap: 8 },
  // No shadow here. It used to be on EVERY button, including the translucent
  // ones, and on Android `elevation` paints a grey halo around a semi
  // transparent circle — which is the "shade" these were reported for. The
  // lift now belongs only to the two solid buttons that answer and end a
  // call, where it means something: they are the primary actions and they are
  // opaque, so a shadow reads as a raised button rather than as dirt.
  roundBtn: {
    width: 62, height: 62, borderRadius: 31,
    alignItems: 'center', justifyContent: 'center',
  },
  roundBtnIcon: { fontSize: 26, color: '#fff' },
  // The two that act on the call itself: solid, slightly larger, and lifted.
  callBtn: {
    width: 68, height: 68, borderRadius: 34,
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.35,
    shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
  },
  acceptBtn: { backgroundColor: '#22c55e' },
  declineBtn: { backgroundColor: '#ef4444' },
  // The toggles: flat, with a hairline instead of a shadow. Same treatment as
  // the rest of the app's controls, which are an icon font on a plain surface.
  ctrlBtn: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)',
  },
  // On, not merely pressed: filled rather than brightened, so "my microphone
  // is off" is legible at a glance instead of being a shade of grey.
  ctrlActive: { backgroundColor: '#fff', borderColor: '#fff' },
  actionLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' },
});
