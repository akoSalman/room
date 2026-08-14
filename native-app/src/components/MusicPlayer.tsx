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
  const pendingSeek = useRef<number | null>(null);
  useEffect(() => audioManager.subscribe(() => {
    if (pendingSeek.current != null
        && String(audioManager.currentId) === String(msgId) && audioManager.duration > 0) {
      const f = pendingSeek.current;
      pendingSeek.current = null;
      audioManager.seek(f);
    }
    forceUpdate();
  }), [msgId]);

  const isCurrent = String(audioManager.currentId) === String(msgId);
  const playing = isCurrent && audioManager.playing;
  const loading = isCurrent && audioManager.loading;
  const progress = isCurrent ? audioManager.progress : 0;
  const duration = isCurrent ? audioManager.duration : 0;
  const { title, artist } = trackTitle(fileName);

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
    if (!barWidth.current) return;
    const f = Math.max(0, Math.min(1, x / barWidth.current));
    if (String(audioManager.currentId) === String(msgId)) { audioManager.seek(f); return; }
    // Dragging the bar of a track that isn't playing starts it, then seeks
    // once it has loaded enough to know its duration.
    pendingSeek.current = f;
    toggle();
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
      {/* The title/duration open the full player, but the progress bar must NOT
          sit inside that touchable — a parent TouchableOpacity swallows the
          touches before the PanResponder ever sees them, which is why dragging
          the bar did nothing. It's a sibling with its own gesture handling. */}
      <View style={s.info}>
        <TouchableOpacity activeOpacity={0.7} onPress={onOpenPlayer} disabled={!onOpenPlayer}>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
          <Text style={s.artist} numberOfLines={1}>{artist || 'Audio file'}</Text>
        </TouchableOpacity>
        <View
          style={s.progressHit}
          onLayout={e => { barWidth.current = e.nativeEvent.layout.width; }}
          {...pan.panHandlers}
        >
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${Math.min(100, progress * 100)}%` }]} />
          </View>
          {isCurrent && (
            <View style={[s.progressKnob, { left: `${Math.min(100, progress * 100)}%` }]} />
          )}
        </View>
        <Text style={s.duration}>
          {isCurrent ? `${fmtTime(duration * progress)} / ${fmtTime(duration)}` : fmtTime(duration) === '0:00' ? 'Tap to play' : fmtTime(duration)}
        </Text>
      </View>
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
  // A 22px-tall transparent strip around the 4px bar: a 4px target is far too
  // small to hit with a finger.
  progressHit: { height: 22, justifyContent: 'center', marginTop: 2, marginBottom: -2 },
  progressTrack: {
    height: 4, borderRadius: 2, backgroundColor: 'rgba(128,128,128,0.28)',
    justifyContent: 'center',
  },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: C.accent },
  progressKnob: {
    position: 'absolute', width: 10, height: 10, borderRadius: 5,
    backgroundColor: C.accent, marginLeft: -5,
  },
  duration: { color: C.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
});
