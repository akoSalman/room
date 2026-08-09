import React, { useEffect, useReducer, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, FlatList,
  PanResponder, ActivityIndicator, Pressable,
} from 'react-native';
import { C } from '../theme';
import { audioManager, Track } from '../audioManager';
import { trackTitle } from './MusicPlayer';

function fmtTime(s: number) {
  if (!isFinite(s) || s < 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

const RATES = [1, 1.5, 2];

// Full-screen music player: transport controls, a scrubbable progress bar and
// the list of every audio file in the chat, so the user can jump between
// tracks the way a real music player works.
export default function FullMusicPlayer({ visible, onClose, tracks, roomId, roomMeta }: {
  visible: boolean;
  onClose: () => void;
  tracks: Track[];
  roomId: number;
  roomMeta?: any;
}) {
  const [, forceUpdate] = useReducer(x => x + 1, 0);
  useEffect(() => audioManager.subscribe(forceUpdate), []);

  const { currentId, playing, loading, progress, duration, rate } = audioManager;
  const current = tracks.find(t => String(t.id) === String(currentId));
  const meta = current ? trackTitle(current.title.replace(/^🎵\s*/, '')) : null;

  const barWidth = useRef(0);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: e => scrub(e.nativeEvent.locationX),
      onPanResponderMove: e => scrub(e.nativeEvent.locationX),
    })
  ).current;
  function scrub(x: number) {
    if (!barWidth.current) return;
    audioManager.seek(x / barWidth.current);
  }

  function playAt(i: number) {
    audioManager.playQueue(tracks, i, roomId, roomMeta);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={s.sheet}>
          <View style={s.handle} />

          {/* Now playing */}
          <View style={s.nowWrap}>
            <View style={s.art}><Text style={s.artIcon}>🎵</Text></View>
            <Text style={s.nowTitle} numberOfLines={1}>{meta?.title || 'Nothing playing'}</Text>
            <Text style={s.nowArtist} numberOfLines={1}>{meta?.artist || (current ? 'Audio file' : 'Pick a track below')}</Text>
          </View>

          {/* Scrubber */}
          <View
            style={s.barTrack}
            onLayout={e => { barWidth.current = e.nativeEvent.layout.width; }}
            {...(current ? pan.panHandlers : {})}
          >
            <View style={[s.barFill, { width: `${Math.min(100, progress * 100)}%` }]} />
            {!!current && <View style={[s.barKnob, { left: `${Math.min(100, progress * 100)}%` }]} />}
          </View>
          <View style={s.timeRow}>
            <Text style={s.time}>{fmtTime(duration * progress)}</Text>
            <Text style={s.time}>{fmtTime(duration)}</Text>
          </View>

          {/* Transport */}
          <View style={s.controls}>
            <TouchableOpacity onPress={() => audioManager.setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length])} style={s.sideBtn}>
              <Text style={s.rateText}>{rate}×</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => audioManager.prev()} style={s.ctrlBtn} disabled={!current}>
              <Text style={[s.ctrlIcon, !current && s.dim]}>⏮</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => audioManager.toggle()} style={s.bigBtn} disabled={!current || loading}>
              {loading
                ? <ActivityIndicator color="#fff" />
                : <Text style={s.bigIcon}>{playing ? '❚❚' : '▶'}</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => audioManager.next()} style={s.ctrlBtn} disabled={!audioManager.hasNext()}>
              <Text style={[s.ctrlIcon, !audioManager.hasNext() && s.dim]}>⏭</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { audioManager.stop(); onClose(); }} style={s.sideBtn}>
              <Text style={s.stopText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Playlist */}
          <Text style={s.listLabel}>IN THIS CHAT ({tracks.length})</Text>
          <FlatList
            data={tracks}
            style={{ maxHeight: 260 }}
            keyExtractor={t => String(t.id)}
            renderItem={({ item, index }) => {
              const active = String(item.id) === String(currentId);
              const m = trackTitle(item.title.replace(/^🎵\s*/, ''));
              return (
                <TouchableOpacity style={[s.row, active && s.rowActive]} onPress={() => playAt(index)}>
                  <Text style={s.rowIcon}>{active && playing ? '❚❚' : '▶'}</Text>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[s.rowTitle, active && s.rowTitleActive]} numberOfLines={1}>{m.title}</Text>
                    {!!m.artist && <Text style={s.rowArtist} numberOfLines={1}>{m.artist}</Text>}
                  </View>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={<Text style={s.empty}>No audio files in this chat yet</Text>}
          />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingBottom: 26, maxHeight: '88%',
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginTop: 10, marginBottom: 10 },
  nowWrap: { alignItems: 'center', paddingVertical: 10, gap: 3 },
  art: {
    width: 96, height: 96, borderRadius: 14, backgroundColor: 'rgba(59,125,216,0.15)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
  },
  artIcon: { fontSize: 44 },
  nowTitle: { color: C.text, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  nowArtist: { color: C.muted, fontSize: 13, textAlign: 'center' },
  barTrack: {
    height: 5, borderRadius: 3, backgroundColor: 'rgba(128,128,128,0.28)',
    marginTop: 16, justifyContent: 'center',
  },
  barFill: { height: 5, borderRadius: 3, backgroundColor: C.accent },
  barKnob: { position: 'absolute', width: 13, height: 13, borderRadius: 7, backgroundColor: C.accent, marginLeft: -6.5 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  time: { color: C.muted, fontSize: 11.5, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 14, marginBottom: 6 },
  ctrlBtn: { padding: 8 },
  ctrlIcon: { color: C.text, fontSize: 26 },
  dim: { opacity: 0.3 },
  bigBtn: { width: 62, height: 62, borderRadius: 31, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  bigIcon: { color: '#fff', fontSize: 20, fontWeight: '900', marginLeft: 2 },
  sideBtn: { padding: 8, minWidth: 40, alignItems: 'center' },
  rateText: { color: C.accent, fontSize: 14, fontWeight: '800' },
  stopText: { color: '#f87171', fontSize: 18, fontWeight: '800' },
  listLabel: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginTop: 12, marginBottom: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  rowActive: { backgroundColor: 'rgba(59,125,216,0.08)' },
  rowIcon: { color: C.accent, fontSize: 13, width: 20, textAlign: 'center' },
  rowTitle: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  rowTitleActive: { color: C.accent, fontWeight: '800' },
  rowArtist: { color: C.muted, fontSize: 11.5, marginTop: 1 },
  empty: { color: C.muted, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
});
