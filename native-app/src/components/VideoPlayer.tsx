// ── Video player ─────────────────────────────────────────────────────────────
//
// Deliberately NOT inside a <Modal>. Minimising has to keep playback running,
// and a Modal unmounts its children when it closes — the <Video> would be torn
// down and restart from zero. So this is an in-tree overlay that morphs between
// fullscreen and a small floating window, keeping the same element alive.
// Living in the tree also means it sits inside the app's GestureHandlerRootView,
// which is what makes pinch-to-zoom work.
//
// It streams: playback starts as soon as enough has arrived rather than waiting
// for the whole file. The byte counter is derived — expo-av reports how many
// SECONDS are buffered, not bytes, so downloaded bytes are that fraction of the
// total size (fetched once with a HEAD request). It is an estimate, and the
// code says so rather than pretending to precision it doesn't have.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Animated, PanResponder, Dimensions, Pressable,
} from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { fmtBytes } from '../download';
import {
  msFromTouch, fraction, clampSeek, nextSpeed, speedLabel, canChangeSpeed,
} from '../videoControls';
import { mediaSource } from '../mediaSource';

export type VideoItem = { id: number | string; url: string; name: string };

type Props = {
  item: VideoItem | null;
  playlist: VideoItem[];
  minimized: boolean;
  onMinimize: () => void;
  onExpand: () => void;
  onClose: () => void;
  onSelect: (item: VideoItem) => void;
};

const MINI_W = 190;
const MINI_H = 112;

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = h ? String(m % 60).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
}

export default function VideoPlayer({
  item, playlist, minimized, onMinimize, onExpand, onClose, onSelect,
}: Props) {
  const videoRef = useRef<Video>(null);
  const win = Dimensions.get('window');

  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playableMs, setPlayableMs] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [fit, setFit] = useState<ResizeMode>(ResizeMode.CONTAIN);
  const [controls, setControls] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubMs, setScrubMs] = useState(0);

  const index = item ? playlist.findIndex(p => String(p.id) === String(item.id)) : -1;
  const hasNext = index >= 0 && index < playlist.length - 1;
  const hasPrev = index > 0;

  // ── Total size, once per video ────────────────────────────────────────────
  const isLocal = !!item?.url?.startsWith('file://');
  useEffect(() => {
    if (!item?.url) return;
    let alive = true;
    setTotalBytes(0);
    // A downloaded copy is already whole — HEAD on a file:// URL means nothing.
    if (isLocal) return () => { alive = false; };
    fetch(item.url, { method: 'HEAD' })
      .then(r => {
        const len = parseInt(r.headers.get('content-length') || '0', 10);
        if (alive && len > 0) setTotalBytes(len);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [item?.url]);

  // A different video starts over.
  useEffect(() => {
    setReady(false); setFailed(false); setBuffering(true);
    setPosition(0); setDuration(0); setPlayableMs(0); setAttempt(0);
  }, [item?.url]);

  // Auto-hide the controls while playing, so they don't sit over the picture.
  useEffect(() => {
    if (!controls || !playing || minimized) return;
    const t = setTimeout(() => setControls(false), 3200);
    return () => clearTimeout(t);
  }, [controls, playing, minimized]);

  const onStatus = useCallback((st: AVPlaybackStatus) => {
    if (!st.isLoaded) {
      if ((st as any).error) setFailed(true);
      return;
    }
    setFailed(false);
    setBuffering(!!st.isBuffering);
    setPlaying(!!st.isPlaying);
    if (!scrubbing) setPosition(st.positionMillis || 0);
    setDuration(st.durationMillis || 0);
    setPlayableMs((st as any).playableDurationMillis ?? 0);
    if ((st.positionMillis || 0) > 0 || st.isPlaying) setReady(true);
    if (st.didJustFinish && hasNext) onSelect(playlist[index + 1]);
  }, [scrubbing, hasNext, index, playlist, onSelect]);

  const togglePlay = useCallback(() => {
    if (playing) videoRef.current?.pauseAsync().catch(() => {});
    else videoRef.current?.playAsync().catch(() => {});
  }, [playing]);

  // Read through a ref, never from the closure. Everything below that touches
  // the duration runs inside a PanResponder built once on the first render,
  // where the video has not loaded and the duration is 0 — see
  // src/videoControls.ts for why that made the bar do nothing.
  const durationRef = useRef(0);
  durationRef.current = duration;

  function seekTo(ms: number) {
    videoRef.current?.setPositionAsync(clampSeek(ms, durationRef.current)).catch(() => {});
  }

  // ── Playback speed ────────────────────────────────────────────────────────
  const [rate, setRate] = useState(1);
  const cycleSpeed = useCallback(() => {
    const next = nextSpeed(rate);
    setRate(next);
    // `true` keeps the pitch corrected: at 1.5x without it everybody sounds
    // like a chipmunk, which is not what a speed control is for.
    videoRef.current?.setRateAsync(next, true).catch(() => {});
  }, [rate]);

  // ── Pinch zoom (fullscreen only) ──────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const zoomStart = useRef(1);
  const pinch = Gesture.Pinch()
    .onStart(() => { zoomStart.current = zoom; })
    .onUpdate(e => setZoom(Math.min(4, Math.max(1, zoomStart.current * e.scale))))
    .enabled(!minimized)
    .runOnJS(true);

  // ── Draggable floating window ─────────────────────────────────────────────
  const pos = useRef(new Animated.ValueXY({ x: win.width - MINI_W - 12, y: 90 })).current;
  const dragResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 4 || Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        pos.extractOffset();
      },
      onPanResponderMove: Animated.event([null, { dx: pos.x, dy: pos.y }], { useNativeDriver: false }),
      onPanResponderRelease: () => { pos.flattenOffset(); },
    }),
  ).current;

  const progressFrac = fraction(scrubbing ? scrubMs : position, duration);
  const bufferedFrac = fraction(playableMs, duration);
  // Bytes are inferred from how much of the DURATION is buffered — expo-av
  // does not report bytes. Honest approximation, not a real byte counter.
  const downloadedBytes = totalBytes ? Math.round(totalBytes * bufferedFrac) : 0;

  // ── Seek bar ──────────────────────────────────────────────────────────────
  const barW = useRef(0);
  // Declared before the PanResponder: its release handler reads the live value,
  // since the responder closes over the first render's state.
  const scrubMsRef = useRef(0);
  scrubMsRef.current = scrubMs;
  const seekResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        setScrubbing(true);
        setControls(true);
        setScrubMs(msFromTouch(e.nativeEvent.locationX, barW.current, durationRef.current));
      },
      onPanResponderMove: (e, g) => {
        const x = e.nativeEvent.locationX ?? g.moveX;
        setScrubMs(msFromTouch(x, barW.current, durationRef.current));
      },
      onPanResponderRelease: () => {
        seekTo(scrubMsRef.current);
        setScrubbing(false);
      },
    }),
  ).current;
  // Every hook above must run on every render. The early return used to sit
  // in the middle of them, so opening a video (item: null -> set) changed the
  // hook count between renders and React threw — which is the crash on tapping
  // a video in the chat.
  if (!item) return null;

  const videoEl = (
    <Video
      key={`${item.url}#${attempt}`}
      ref={videoRef}
      source={mediaSource(item.url)}
      style={StyleSheet.absoluteFill}
      resizeMode={fit}
      shouldPlay
      isLooping={false}
      progressUpdateIntervalMillis={300}
      onPlaybackStatusUpdate={onStatus}
      onError={() => setFailed(true)}
    />
  );

  // ── Minimised: a small draggable window that keeps playing ────────────────
  if (minimized) {
    return (
      <Animated.View
        style={[s.mini, { transform: pos.getTranslateTransform() }]}
        {...dragResponder.panHandlers}
      >
        <View style={s.miniInner}>
          {videoEl}
          <Pressable style={StyleSheet.absoluteFill} onPress={onExpand} />
          <View style={s.miniBar}>
            <TouchableOpacity onPress={togglePlay} hitSlop={hit8}>
              <Ionicons name={playing ? 'pause' : 'play'} size={16} color="#fff" />
            </TouchableOpacity>
            <View style={s.miniTrack}>
              <View style={[s.miniFill, { width: `${Math.round(progressFrac * 100)}%` }]} />
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={hit8}>
              <Ionicons name="close" size={16} color="#fff" />
            </TouchableOpacity>
          </View>
          {buffering && !failed && (
            <View style={s.centre} pointerEvents="none">
              <ActivityIndicator color="#fff" />
            </View>
          )}
        </View>
      </Animated.View>
    );
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────
  return (
    <View style={s.full}>
      <GestureDetector gesture={pinch}>
        <View style={StyleSheet.absoluteFill}>
          <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ scale: zoom }] }]}>
            {videoEl}
          </Animated.View>
          {/* Tap toggles the controls; double tap switches fit-to-screen. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setControls(c => !c)}
            onLongPress={() => setFit(f => (f === ResizeMode.CONTAIN ? ResizeMode.COVER : ResizeMode.CONTAIN))}
          />
        </View>
      </GestureDetector>

      {(buffering || !ready) && !failed && (
        <View style={s.centre} pointerEvents="none">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={s.centreText}>
            {isLocal
              ? 'Opening…'
              : totalBytes
              ? `${fmtBytes(downloadedBytes)} of ${fmtBytes(totalBytes)}`
              : ready ? 'Buffering…' : 'Loading…'}
          </Text>
        </View>
      )}

      {failed && (
        <View style={s.centre}>
          <Ionicons name="alert-circle-outline" size={46} color="#94a3b8" />
          <Text style={s.centreText}>Couldn’t play this video</Text>
          <TouchableOpacity
            style={s.retry}
            onPress={() => { setFailed(false); setReady(false); setBuffering(true); setAttempt(a => a + 1); }}
          >
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {controls && (
        <>
          {/* Top bar: name, size, minimise, close */}
          <View style={s.topBar}>
            <TouchableOpacity onPress={onMinimize} style={s.iconBtn} hitSlop={hit8}>
              <Ionicons name="contract-outline" size={22} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.title} numberOfLines={1}>{item.name}</Text>
              <Text style={s.sub} numberOfLines={1}>
                {isLocal ? 'Saved on this device' : totalBytes ? fmtBytes(totalBytes) : '…'}
                {!isLocal && totalBytes && bufferedFrac < 0.999
                  ? `  ·  ${fmtBytes(downloadedBytes)} downloaded`
                  : !isLocal && totalBytes ? '  ·  downloaded' : ''}
                {zoom > 1.01 ? `  ·  ${zoom.toFixed(1)}x` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setZoom(z => (z > 1.01 ? 1 : 2))} style={s.iconBtn} hitSlop={hit8}>
              <Ionicons name={zoom > 1.01 ? 'search-outline' : 'search'} size={21} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={s.iconBtn} hitSlop={hit8}>
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
          </View>

          {/* Bottom: seek bar with buffered-ahead, times, transport */}
          <View style={s.bottom}>
            <View
              style={s.trackWrap}
              onLayout={(e) => { barW.current = e.nativeEvent.layout.width; }}
              {...seekResponder.panHandlers}
            >
              <View style={s.track} />
              <View style={[s.buffered, { width: `${Math.round(bufferedFrac * 100)}%` }]} />
              <View style={[s.played, { width: `${Math.round(progressFrac * 100)}%` }]} />
              <View style={[s.knob, { left: `${Math.round(progressFrac * 100)}%` }]} />
            </View>

            <View style={s.timeRow}>
              <Text style={s.time}>{fmtTime(scrubbing ? scrubMs : position)}</Text>
              {/* Asked for: the video player should have speed control. On the
                  time row rather than in the transport, which is already five
                  buttons wide — and beside the duration, which is what the
                  speed is changing. Hidden until the video has a duration: a
                  rate cannot be applied to something still loading, and a
                  control that does nothing teaches people it does nothing. */}
              {canChangeSpeed(duration) && (
                <TouchableOpacity onPress={cycleSpeed} style={s.speedBtn} hitSlop={hit8}>
                  <Text style={[s.time, rate !== 1 && s.speedOn]}>{speedLabel(rate)}</Text>
                </TouchableOpacity>
              )}
              <Text style={s.time}>{fmtTime(duration)}</Text>
            </View>

            <View style={s.transport}>
              <TouchableOpacity
                onPress={() => hasPrev && onSelect(playlist[index - 1])}
                disabled={!hasPrev}
                style={s.iconBtn}
                hitSlop={hit8}
              >
                <Ionicons name="play-skip-back" size={24} color={hasPrev ? '#fff' : '#475569'} />
              </TouchableOpacity>

              <TouchableOpacity onPress={() => seekTo(position - 10000)} style={s.iconBtn} hitSlop={hit8}>
                <Ionicons name="play-back" size={24} color="#fff" />
              </TouchableOpacity>

              <TouchableOpacity onPress={togglePlay} style={s.playBtn}>
                <Ionicons name={playing ? 'pause' : 'play'} size={30} color="#0f172a" />
              </TouchableOpacity>

              <TouchableOpacity onPress={() => seekTo(position + 10000)} style={s.iconBtn} hitSlop={hit8}>
                <Ionicons name="play-forward" size={24} color="#fff" />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => hasNext && onSelect(playlist[index + 1])}
                disabled={!hasNext}
                style={s.iconBtn}
                hitSlop={hit8}
              >
                <Ionicons name="play-skip-forward" size={24} color={hasNext ? '#fff' : '#475569'} />
              </TouchableOpacity>
            </View>

            {playlist.length > 1 && (
              <Text style={s.count}>{index + 1} / {playlist.length}</Text>
            )}
          </View>
        </>
      )}
    </View>
  );
}

const hit8 = { top: 8, bottom: 8, left: 8, right: 8 };

const s = StyleSheet.create({
  full: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000', zIndex: 60 },
  centre: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 10 },
  centreText: { color: '#e2e8f0', fontSize: 13.5 },
  retry: {
    marginTop: 4, paddingHorizontal: 24, paddingVertical: 9, borderRadius: 18,
    borderWidth: 1, borderColor: '#e2e8f0',
  },
  retryText: { color: '#e2e8f0', fontSize: 14, fontWeight: '700' },

  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingTop: 44, paddingHorizontal: 10, paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  title: { color: '#fff', fontSize: 14.5, fontWeight: '700' },
  sub: { color: '#94a3b8', fontSize: 11.5, marginTop: 2 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },

  bottom: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 16, paddingBottom: 26, paddingTop: 10,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  trackWrap: { height: 26, justifyContent: 'center' },
  track: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)' },
  buffered: {
    position: 'absolute', height: 3, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.42)',
  },
  played: { position: 'absolute', height: 3, borderRadius: 2, backgroundColor: C.accent },
  knob: {
    position: 'absolute', width: 13, height: 13, borderRadius: 7,
    backgroundColor: '#fff', marginLeft: -6,
  },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  // Padded rather than sized: the label swaps between "1×" and "1.25×", and a
  // fixed width would either clip the long one or leave a hole beside the short.
  speedBtn: { paddingHorizontal: 10, paddingVertical: 2 },
  speedOn: { color: C.accent ?? '#38bdf8', fontWeight: '700' },
  time: { color: '#cbd5e1', fontSize: 11.5, fontVariant: ['tabular-nums'] },
  transport: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 14, marginTop: 8,
  },
  playBtn: {
    width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  count: { color: '#94a3b8', fontSize: 11.5, textAlign: 'center', marginTop: 8 },

  mini: {
    position: 'absolute', top: 0, left: 0, width: MINI_W, height: MINI_H, zIndex: 60,
  },
  miniInner: {
    flex: 1, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
  },
  miniBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 8, paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  miniTrack: { flex: 1, height: 2.5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)' },
  miniFill: { height: 2.5, borderRadius: 2, backgroundColor: C.accent },
});
