import React, { useEffect, useReducer, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, PanResponder, Pressable } from 'react-native';
import { C } from '../theme';
import { audioManager } from '../audioManager';
import { tapAction, seekFraction } from '../voiceTap';

const SPEEDS = [1, 1.5, 2];

function fmtTime(s: number) {
  if (!isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function parsePeaks(raw: string, count = 40): number[] {
  const nums = raw.split(',').map(Number).filter(n => !isNaN(n) && n >= 0);
  if (nums.length < 5) return Array.from({ length: count }, () => 0.2 + Math.random() * 0.6);
  const step = nums.length / count;
  return Array.from({ length: count }, (_, i) => {
    const slice = nums.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    return (slice.length ? Math.max(...slice) : 0) / 100;
  });
}

export default function VoicePlayer({ url, peaks: rawPeaks, mine, msgId, roomId, label, roomMeta, onPlayStart, played, cache, onLongPress, selectMode, onSelect }: {
  url: string; peaks: string; mine: boolean;
  msgId: number | string; roomId: number; label: string; roomMeta?: any;
  onPlayStart?: () => void;
  played?: boolean;
  /** False for a voice message that must not be kept on the device. */
  cache?: boolean;
  /** The message menu, which must stay reachable from every part of the row. */
  onLongPress?: () => void;
  /** While the chat is picking messages, a tap picks rather than plays. */
  selectMode?: boolean;
  onSelect?: () => void;
}) {
  const [, forceUpdate] = useReducer(x => x + 1, 0);
  const peaks = parsePeaks(rawPeaks);

  useEffect(() => audioManager.subscribe(forceUpdate), []);

  const isCurrent = String(audioManager.currentId) === String(msgId);
  const playing = isCurrent && audioManager.playing;
  const loading = isCurrent && audioManager.loading;
  const progress = isCurrent ? audioManager.progress : 0;
  const duration = isCurrent ? audioManager.duration : 0;
  const speedIdx = Math.max(0, SPEEDS.indexOf(audioManager.rate));

  // Drag across the waveform to scrub through the voice message.
  const waveWidth = useRef(0);
  const seekAtX = (x: number) => {
    if (!isCurrent || !waveWidth.current) return;
    audioManager.seek(seekFraction(x, waveWidth.current));
  };
  // The waveform claims the touch only when it is a TIMELINE — that is, while
  // this is the message the player has loaded. Before that it is a picture,
  // and the tap belongs to the bubble, which starts playing.
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => wantsSeek(),
    onMoveShouldSetPanResponder: () => wantsSeek(),
    onPanResponderGrant: (e) => seekAtX(e.nativeEvent.locationX),
    onPanResponderMove: (e) => seekAtX(e.nativeEvent.locationX),
  })).current;
  function wantsSeek() {
    return tapAction({
      region: 'waveform', isCurrent: isCurrentRef.current, selectMode: selectModeRef.current,
    }) === 'seek';
  }
  const selectModeRef = useRef(false);
  selectModeRef.current = !!selectMode;
  const isCurrentRef = useRef(false);
  isCurrentRef.current = isCurrent;

  /**
   * A tap anywhere on the message.
   *
   * The rule decides what it means, so the container, the button and the
   * waveform cannot disagree about it.
   */
  function onTap(region: 'button' | 'elsewhere') {
    const action = tapAction({ region, isCurrent, selectMode });
    if (action === 'select') { onSelect?.(); return; }
    toggle();
  }

  function toggle() {
    if (isCurrent) audioManager.toggle();
    else {
      onPlayStart?.();
      audioManager.play(msgId, url, label, roomId, roomMeta, false, cache !== false);
    }
  }

  function cycleSpeed() {
    audioManager.setRate(SPEEDS[(speedIdx + 1) % SPEEDS.length]);
  }

  const barColor = C.accent;
  const barUnplayed = mine ? 'rgba(59,125,216,0.3)' : 'rgba(31,41,55,0.25)';

  return (
    // The whole row is the play/pause target. The long press is passed
    // straight through, because a voice message you can play but cannot reply
    // to, forward or delete is worse than one you have to aim at.
    <Pressable
      style={s.container}
      onPress={() => onTap('elsewhere')}
      onLongPress={onLongPress}
      delayLongPress={350}
    >
      <TouchableOpacity style={s.playBtn} onPress={() => onTap('button')} disabled={loading}>
        {loading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={s.playIcon}>{playing ? '⏸' : '▶'}</Text>}
      </TouchableOpacity>

      <View
        style={s.waveform}
        onLayout={(e) => { waveWidth.current = e.nativeEvent.layout.width; }}
        {...pan.panHandlers}
      >
        {peaks.map((h, i) => (
          <View key={i} style={[s.bar, {
            height: Math.max(3, h * 28),
            backgroundColor: i / peaks.length < progress ? barColor : barUnplayed,
          }]} />
        ))}
      </View>

      <View style={s.meta} pointerEvents="box-none">
        {/* Opened indicator: bright dot until the other side has played it */}
        <View style={[s.playedDot, played ? s.playedDotDone : null]} />
        <Text style={s.duration}>{fmtTime(duration * progress || 0)}</Text>
        <TouchableOpacity onPress={cycleSpeed} style={s.speedBtn}>
          <Text style={s.speedText}>{SPEEDS[speedIdx]}×</Text>
        </TouchableOpacity>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 8, width: 200, maxWidth: '100%', paddingVertical: 2 },
  playBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  playIcon: { color: '#fff', fontSize: 14 },
  waveform: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 1, height: 32, overflow: 'hidden' },
  bar: { flex: 1, minWidth: 1, maxWidth: 3, borderRadius: 2 },
  meta: { alignItems: 'flex-end', gap: 3, flexShrink: 0 },
  duration: { color: C.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  playedDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.accent },
  playedDotDone: { backgroundColor: 'rgba(128,128,128,0.45)' },
  speedBtn: { backgroundColor: 'rgba(82,136,193,0.2)', borderWidth: 1, borderColor: C.accent, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  speedText: { color: C.accent, fontSize: 10, fontWeight: '700' },
});
