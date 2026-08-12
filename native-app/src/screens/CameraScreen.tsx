// ── In-app camera ────────────────────────────────────────────────────────────
//
// Replaces expo-image-picker's launchCameraAsync, which fires an intent into
// the phone's system camera app. That meant a cold app start on every "open
// camera" and a shutter round-trip through another process — the latency the
// picker's `quality` option can't touch, because it isn't where the time goes.
//
// This owns the preview surface, so opening is a mount and the shutter is a
// direct call. It also lets several shots be taken in a row and sent together,
// instead of one round trip through the system camera per photo.
//
// Capture returns immediately via `onPictureSaved`: takePictureAsync's promise
// resolves as soon as the frame is captured, and the file lands a moment later.
// That is what makes the shutter feel instant rather than "tap, wait, hear the
// sound, wait".
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Image,
  Animated, Pressable, ScrollView, Platform,
} from 'react-native';
import {
  CameraView, CameraType, FlashMode, CameraMode, CameraRatio,
  useCameraPermissions, useMicrophonePermissions,
} from 'expo-camera';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';

export type Shot = { uri: string; name: string; mime: string };

type Props = {
  onClose: () => void;
  onDone: (shots: Shot[]) => void;
  // 'photo' | 'video' — which mode to open in.
  initialMode?: 'photo' | 'video';
};

const TIMERS = [0, 3, 10] as const;
const MAX_VIDEO_SECONDS = 60;

export default function CameraScreen({ onClose, onDone, initialMode = 'photo' }: Props) {
  const camRef = useRef<CameraView>(null);

  const [perm, requestPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();

  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [torch, setTorch] = useState(false);
  const [mode, setMode] = useState<CameraMode>(initialMode === 'video' ? 'video' : 'picture');
  const [ratio, setRatio] = useState<CameraRatio>('4:3');
  const [zoom, setZoom] = useState(0);
  const [grid, setGrid] = useState(false);
  const [timer, setTimer] = useState<number>(0);
  const [countdown, setCountdown] = useState(0);

  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [shots, setShots] = useState<Shot[]>([]);

  // Shutter flash + capture-button press feedback.
  const flashAnim = useRef(new Animated.Value(0)).current;
  const shutterScale = useRef(new Animated.Value(1)).current;

  // Timers are cleared on unmount so a pending countdown can't fire into a
  // torn-down component.
  const countdownRef = useRef<any>(null);
  const elapsedRef = useRef<any>(null);
  useEffect(() => () => {
    clearInterval(countdownRef.current);
    clearInterval(elapsedRef.current);
  }, []);

  // Ask once, on mount. Video also needs the mic, but only when that mode is
  // actually used — no point demanding it from someone taking a photo.
  useEffect(() => { if (!perm?.granted) requestPerm(); }, [perm?.granted]);
  useEffect(() => {
    if (mode === 'video' && !micPerm?.granted) requestMicPerm();
  }, [mode, micPerm?.granted]);

  // Zoom at the moment the current pinch began. e.scale is relative to that
  // same instant, so the two belong together — deriving the new zoom from the
  // live `zoom` state instead made a single pinch fight its own updates.
  const zoomStart = useRef(0);
  const pinch = Gesture.Pinch()
    .onStart(() => { zoomStart.current = zoom; })
    .onUpdate(e => {
      // Damped so a normal pinch travels the range smoothly rather than
      // slamming to maximum.
      const next = zoomStart.current + (e.scale - 1) * 0.35;
      setZoom(Math.min(1, Math.max(0, next)));
    })
    .runOnJS(true);

  function playShutterFlash() {
    flashAnim.setValue(0.85);
    Animated.timing(flashAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start();
  }

  function bumpShutter() {
    Animated.sequence([
      Animated.timing(shutterScale, { toValue: 0.86, duration: 70, useNativeDriver: true }),
      Animated.spring(shutterScale, { toValue: 1, useNativeDriver: true }),
    ]).start();
  }

  const capturePhoto = useCallback(async () => {
    if (!ready || busy) return;
    setBusy(true);
    bumpShutter();
    playShutterFlash();
    try {
      await camRef.current?.takePictureAsync({
        quality: 0.7,
        exif: false,
        // Resolves the call as soon as the frame is grabbed; the saved file
        // arrives here a beat later. The user is never waiting on the write.
        onPictureSaved: (pic) => {
          setShots(prev => [...prev, {
            uri: pic.uri,
            name: `photo-${Date.now()}.jpg`,
            mime: 'image/jpeg',
          }]);
        },
      });
    } catch {}
    setBusy(false);
  }, [ready, busy]);

  function runTimerThen(fn: () => void) {
    if (!timer) { fn(); return; }
    setCountdown(timer);
    clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countdownRef.current);
          fn();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  async function startRecording() {
    if (!ready || recording) return;
    setRecording(true);
    setElapsed(0);
    clearInterval(elapsedRef.current);
    elapsedRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    try {
      const res = await camRef.current?.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });
      if (res?.uri) {
        setShots(prev => [...prev, {
          uri: res.uri,
          name: `video-${Date.now()}.mp4`,
          mime: 'video/mp4',
        }]);
      }
    } catch {}
    clearInterval(elapsedRef.current);
    setRecording(false);
    setElapsed(0);
  }

  function stopRecording() {
    camRef.current?.stopRecording();
  }

  function onShutter() {
    if (mode === 'video') {
      if (recording) stopRecording();
      else runTimerThen(startRecording);
      return;
    }
    runTimerThen(capturePhoto);
  }

  function cycleFlash() {
    setFlash(f => (f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'));
  }

  function cycleTimer() {
    setTimer(t => TIMERS[(TIMERS.indexOf(t as any) + 1) % TIMERS.length]);
  }

  function removeShot(i: number) {
    setShots(prev => prev.filter((_, j) => j !== i));
  }

  const fmt = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  const flashIcon = flash === 'on' ? 'flash' : flash === 'auto' ? 'flash-outline' : 'flash-off';
  const zoomLabel = `${(1 + zoom * 4).toFixed(1)}x`;

  // ── Permission states ──────────────────────────────────────────────────────
  if (!perm) {
    return (
      <View style={s.fill}>
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  }
  if (!perm.granted) {
    return (
      <View style={[s.fill, s.permBox]}>
        <Ionicons name="camera-outline" size={54} color="#94a3b8" />
        <Text style={s.permTitle}>Camera access needed</Text>
        <Text style={s.permText}>
          {perm.canAskAgain
            ? 'Allow camera access to take photos and videos.'
            : 'Camera access is turned off. Enable it for ChatRoom in your device settings.'}
        </Text>
        {perm.canAskAgain && (
          <TouchableOpacity style={s.permBtn} onPress={() => requestPerm()}>
            <Text style={s.permBtnText}>Allow camera</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={s.permCancel} onPress={onClose}>
          <Text style={s.permCancelText}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={s.fill}>
      <GestureDetector gesture={pinch}>
        <View style={s.previewWrap}>
          <CameraView
            ref={camRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            flash={flash}
            enableTorch={torch}
            zoom={zoom}
            mode={mode}
            ratio={ratio}
            // The system shutter animation would double up with ours.
            animateShutter={false}
            // Counter-intuitive but correct: in expo-camera 'on' autofocuses
            // once and then LOCKS focus, while 'off' keeps refocusing as the
            // scene changes — which is what a camera should do.
            autofocus="off"
            onCameraReady={() => setReady(true)}
          />

          {/* Rule-of-thirds grid */}
          {grid && (
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <View style={[s.gridLine, { top: '33.33%', left: 0, right: 0, height: 1 }]} />
              <View style={[s.gridLine, { top: '66.66%', left: 0, right: 0, height: 1 }]} />
              <View style={[s.gridLine, { left: '33.33%', top: 0, bottom: 0, width: 1 }]} />
              <View style={[s.gridLine, { left: '66.66%', top: 0, bottom: 0, width: 1 }]} />
            </View>
          )}

          {/* Shutter flash */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: '#fff', opacity: flashAnim }]}
          />

          {/* Countdown */}
          {countdown > 0 && (
            <View style={s.countdownWrap} pointerEvents="none">
              <Text style={s.countdownText}>{countdown}</Text>
            </View>
          )}

          {!ready && (
            <View style={s.loadingWrap} pointerEvents="none">
              <ActivityIndicator color="#fff" size="large" />
            </View>
          )}
        </View>
      </GestureDetector>

      {/* ── Top controls ─────────────────────────────────────────────────── */}
      <View style={s.topBar}>
        <TouchableOpacity style={s.topBtn} onPress={onClose} hitSlop={hit}>
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>

        <View style={s.topRight}>
          {mode === 'picture' ? (
            <TouchableOpacity style={s.topBtn} onPress={cycleFlash} hitSlop={hit}>
              <Ionicons name={flashIcon as any} size={22} color={flash === 'off' ? '#fff' : C.accent} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={s.topBtn} onPress={() => setTorch(t => !t)} hitSlop={hit}>
              <Ionicons name={torch ? 'flashlight' : 'flashlight-outline'} size={22} color={torch ? C.accent : '#fff'} />
            </TouchableOpacity>
          )}

          <TouchableOpacity style={s.topBtn} onPress={cycleTimer} hitSlop={hit}>
            <Ionicons name="timer-outline" size={22} color={timer ? C.accent : '#fff'} />
            {!!timer && <Text style={s.topBadge}>{timer}</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={s.topBtn} onPress={() => setGrid(g => !g)} hitSlop={hit}>
            <Ionicons name="grid-outline" size={21} color={grid ? C.accent : '#fff'} />
          </TouchableOpacity>

          {Platform.OS === 'android' && (
            <TouchableOpacity style={s.topBtn} onPress={() => setRatio(r => (r === '4:3' ? '16:9' : r === '16:9' ? '1:1' : '4:3'))} hitSlop={hit}>
              <Text style={s.ratioText}>{ratio}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Recording pill */}
      {recording && (
        <View style={s.recPill}>
          <View style={s.recDot} />
          <Text style={s.recText}>{fmt(elapsed)}</Text>
        </View>
      )}

      {/* Zoom readout — tap to reset to 1x */}
      {zoom > 0.001 && !recording && (
        <TouchableOpacity style={s.zoomPill} onPress={() => setZoom(0)}>
          <Text style={s.zoomText}>{zoomLabel}</Text>
        </TouchableOpacity>
      )}

      {/* ── Bottom controls ──────────────────────────────────────────────── */}
      <View style={s.bottom}>
        {/* Shots taken so far, removable before sending */}
        {shots.length > 0 && !recording && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.strip}
          >
            {shots.map((sh, i) => (
              <View key={`${sh.uri}-${i}`} style={s.stripItem}>
                {sh.mime.startsWith('video')
                  ? <View style={[s.stripThumb, s.stripVideo]}><Ionicons name="videocam" size={18} color="#fff" /></View>
                  : <Image source={{ uri: sh.uri }} style={s.stripThumb} />}
                <TouchableOpacity style={s.stripRemove} onPress={() => removeShot(i)} hitSlop={hit}>
                  <Ionicons name="close" size={12} color="#fff" />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}

        {/* Photo / Video switch */}
        {!recording && (
          <View style={s.modeRow}>
            {(['picture', 'video'] as CameraMode[]).map(m => (
              <TouchableOpacity
                key={m}
                style={[s.modeBtn, mode === m && s.modeBtnActive]}
                onPress={() => setMode(m)}
              >
                <Text style={[s.modeText, mode === m && s.modeTextActive]}>
                  {m === 'picture' ? 'Photo' : 'Video'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={s.actionRow}>
          {/* Flip */}
          <TouchableOpacity
            style={s.sideBtn}
            onPress={() => setFacing(f => (f === 'back' ? 'front' : 'back'))}
            disabled={recording}
            hitSlop={hit}
          >
            <Ionicons name="camera-reverse-outline" size={28} color={recording ? '#475569' : '#fff'} />
          </TouchableOpacity>

          {/* Shutter */}
          <Animated.View style={{ transform: [{ scale: shutterScale }] }}>
            <Pressable
              onPress={onShutter}
              disabled={!ready || countdown > 0}
              style={({ pressed }) => [
                s.shutter,
                recording && s.shutterRecording,
                pressed && { opacity: 0.85 },
                (!ready || countdown > 0) && { opacity: 0.5 },
              ]}
            >
              {recording
                ? <View style={s.shutterStop} />
                : <View style={[s.shutterInner, mode === 'video' && s.shutterInnerVideo]} />}
            </Pressable>
          </Animated.View>

          {/* Send */}
          <TouchableOpacity
            style={[s.sideBtn, shots.length > 0 && s.sendBtn]}
            onPress={() => shots.length && onDone(shots)}
            disabled={!shots.length || recording}
            hitSlop={hit}
          >
            {shots.length > 0 ? (
              <>
                <Ionicons name="arrow-forward" size={24} color="#fff" />
                <View style={s.sendCount}><Text style={s.sendCountText}>{shots.length}</Text></View>
              </>
            ) : (
              <Ionicons name="arrow-forward" size={26} color="#475569" />
            )}
          </TouchableOpacity>
        </View>
      </View>
    </GestureHandlerRootView>
  );
}

const hit = { top: 10, bottom: 10, left: 10, right: 10 };

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  previewWrap: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  loadingWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },

  gridLine: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.28)' },

  countdownWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  countdownText: { color: '#fff', fontSize: 96, fontWeight: '200' },

  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 46, paddingHorizontal: 16, paddingBottom: 12,
  },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  topBtn: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  topBadge: {
    position: 'absolute', bottom: 3, right: 6,
    color: C.accent, fontSize: 10, fontWeight: '800',
  },
  ratioText: { color: '#fff', fontSize: 12, fontWeight: '800' },

  recPill: {
    position: 'absolute', top: 100, alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 14,
    paddingHorizontal: 12, paddingVertical: 5,
  },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444' },
  recText: { color: '#fff', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },

  zoomPill: {
    position: 'absolute', bottom: 210, alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 16,
    paddingHorizontal: 13, paddingVertical: 5,
  },
  zoomText: { color: '#fff', fontSize: 12.5, fontWeight: '700' },

  bottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingBottom: 30, paddingTop: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  strip: { paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
  stripItem: { width: 52, height: 52 },
  stripThumb: {
    width: 52, height: 52, borderRadius: 8,
    backgroundColor: '#1e293b', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
  },
  stripVideo: { alignItems: 'center', justifyContent: 'center' },
  stripRemove: {
    position: 'absolute', top: -5, right: -5,
    width: 19, height: 19, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center',
  },

  modeRow: { flexDirection: 'row', alignSelf: 'center', gap: 6, marginBottom: 12 },
  modeBtn: { paddingHorizontal: 18, paddingVertical: 6, borderRadius: 15 },
  modeBtnActive: { backgroundColor: 'rgba(255,255,255,0.16)' },
  modeText: { color: '#94a3b8', fontSize: 13.5, fontWeight: '700' },
  modeTextActive: { color: '#fff' },

  actionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 34,
  },
  sideBtn: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
  sendBtn: { backgroundColor: C.accent },
  sendCount: {
    position: 'absolute', top: 2, right: 2,
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center',
  },
  sendCountText: { color: '#fff', fontSize: 10.5, fontWeight: '800' },

  shutter: {
    width: 74, height: 74, borderRadius: 37,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  shutterRecording: { borderColor: '#ef4444' },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
  shutterInnerVideo: { backgroundColor: '#ef4444' },
  shutterStop: { width: 26, height: 26, borderRadius: 5, backgroundColor: '#ef4444' },

  permBox: { padding: 32, gap: 12 },
  permTitle: { color: '#fff', fontSize: 18, fontWeight: '800', marginTop: 6 },
  permText: { color: '#94a3b8', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  permBtn: {
    marginTop: 10, backgroundColor: C.accent, borderRadius: 12,
    paddingHorizontal: 26, paddingVertical: 12,
  },
  permBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  permCancel: { paddingVertical: 10 },
  permCancelText: { color: '#94a3b8', fontSize: 14, fontWeight: '600' },
});
