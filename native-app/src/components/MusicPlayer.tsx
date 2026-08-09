import React, { useEffect, useReducer, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, PanResponder,
} from 'react-native';
import { C } from '../theme';
import { audioManager, Track } from '../audioManager';

function fmtTime(s: number) {
  if (!isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// Strip the extension and tidy separators so "01_Some-Song.mp3" reads as a
// title, and split a leading "Artist - Title" the way music players do.
export function trackTitle(fileName: string): { title: string; artist: string | null } {
  const base = String(fileName || 'Audio').replace(/\.[a-z0-9]{1,5}$/i, '');
  const clean = base.replace(/[_]+/g, ' ').trim();
  const m = /^(.{1,40}?)\s+-\s+(.+)$/.exec(clean);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: clean || 'Audio', artist: null };
}

// A Telegram-style music row: round play/pause disc, title + artist, a
// draggable progress bar and the elapsed/total time. Tapping the disc plays
// within the chat's whole audio playlist so it continues to the next track.
export default function MusicPlayer({
  url, fileName, mine, msgId, roomId, roomMeta, onPlayStart, playlist, onOpenPlayer,
}: {
  url: string; fileName: string; mine: boolean; msgId: number | string; roomId: number; roomMeta?: any;
  onPlayStart?: () => void;
  playlist?: () => Track[];      // every audio file in this chat, in order
  onOpenPlayer?: () => void;     // opens the full-screen player
}) {
  const [, forceUpdate] = useReducer(x => x + 1, 0);
  useEffect(() => audioManager.subscribe(forceUpdate), []);

  const isCurrent = audioManager.currentId === msgId;
  const playing = isCurrent && audioManager.playing;
  const loading = isCurrent && audioManager.loading;
  const progress = isCurrent ? audioManager.progress : 0;
  const duration = isCurrent ? audioManager.duration : 0;
  const { title, artist } = trackTitle(fileName);

  const barRef = useRef<View>(null);
  const barWidth = useRef(0);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: e => seekTo(e.nativeEvent.locationX),
      onPanResponderMove: e => seekTo(e.nativeEvent.locationX),
    })
  ).current;
  function seekTo(x: number) {
    if (audioManager.currentId !== msgId || !barWidth.current) return;
    audioManager.seek(x / barWidth.current);
  }

  function toggle() {
    if (isCurrent) { audioManager.toggle(); return; }
    onPlayStart?.();
    const list = playlist?.() || [];
    const idx = list.findIndex(t => String(t.id) === String(msgId));
    if (list.length && idx >= 0) {
      // Play as part of the chat's playlist so it rolls on to the next track.
      audioManager.playQueue(list, idx, roomId, roomMeta);
    } else {
      audioManager.play(msgId, url, `🎵 ${title}`, roomId, roomMeta);
    }
  }

  return (
    <View style={s.container}>
      <TouchableOpacity style={s.playBtn} onPress={toggle} disabled={loading} activeOpacity={0.75}>
        {loading
          ? <ActivityIndicator size="small" color="#fff" />
          : <Text style={s.playIcon}>{playing ? '❚❚' : '▶'}</Text>}
      </TouchableOpacity>
      <TouchableOpacity style={s.info} activeOpacity={0.7} onPress={onOpenPlayer} disabled={!onOpenPlayer}>
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        <Text style={s.artist} numberOfLines={1}>{artist || 'Audio file'}</Text>
        <View
          ref={barRef}
          style={s.progressTrack}
          onLayout={e => { barWidth.current = e.nativeEvent.layout.width; }}
          {...(isCurrent ? pan.panHandlers : {})}
        >
          <View style={[s.progressFill, { width: `${Math.min(100, progress * 100)}%` }]} />
          {isCurrent && (
            <View style={[s.progressKnob, { left: `${Math.min(100, progress * 100)}%` }]} />
          )}
        </View>
        <Text style={s.duration}>
          {isCurrent ? `${fmtTime(duration * progress)} / ${fmtTime(duration)}` : fmtTime(duration) === '0:00' ? 'Tap to play' : fmtTime(duration)}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 10, width: 236, maxWidth: '100%', paddingVertical: 2 },
  playBtn: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: C.accent,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  playIcon: { color: '#fff', fontSize: 13, fontWeight: '900', marginLeft: 1 },
  info: { flex: 1, gap: 2 },
  title: { color: C.text, fontSize: 13.5, fontWeight: '700' },
  artist: { color: C.muted, fontSize: 11.5 },
  progressTrack: {
    height: 4, borderRadius: 2, backgroundColor: 'rgba(128,128,128,0.28)',
    marginTop: 5, marginBottom: 2, justifyContent: 'center',
  },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: C.accent },
  progressKnob: {
    position: 'absolute', width: 10, height: 10, borderRadius: 5,
    backgroundColor: C.accent, marginLeft: -5,
  },
  duration: { color: C.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
});
