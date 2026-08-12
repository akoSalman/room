// Fullscreen video player.
//
// The previous version was a bare <Video useNativeControls shouldPlay/>: while
// it buffered you got a black rectangle with no indication anything was
// happening, and if the load failed you got that same black rectangle forever.
// That is what "it hangs or does not play" looks like from the outside, even
// when the download is simply still in progress.
//
// This keeps the streaming behaviour — playback starts as soon as enough has
// arrived, it does not wait for the whole file — but actually reports what is
// going on: a spinner and a buffered percentage until the first frame, a thin
// buffered-ahead bar during playback, and a real error state with Retry.
import React, { useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';

export default function VideoPlayerModal({ url, onClose }: { url: string | null; onClose: () => void }) {
  const videoRef = useRef<Video>(null);
  const [ready, setReady] = useState(false);      // first frame rendered
  const [buffering, setBuffering] = useState(true);
  const [buffered, setBuffered] = useState(0);    // 0..1 of the file downloaded
  const [failed, setFailed] = useState(false);
  // Remounts the <Video> so Retry genuinely re-requests rather than reusing a
  // player that has already given up.
  const [attempt, setAttempt] = useState(0);

  function reset() {
    setReady(false);
    setBuffering(true);
    setBuffered(0);
    setFailed(false);
  }

  function onStatus(st: AVPlaybackStatus) {
    if (!st.isLoaded) {
      if ((st as any).error) setFailed(true);
      return;
    }
    setFailed(false);
    setBuffering(!!st.isBuffering);
    if (st.durationMillis) {
      // playableDurationMillis is how much has been downloaded and is ready to
      // play — i.e. the download progress, which is exactly what to show while
      // the video is streaming in.
      const playable = (st as any).playableDurationMillis ?? 0;
      setBuffered(Math.max(0, Math.min(1, playable / st.durationMillis)));
    }
    // Once anything has actually played, the first frame is up.
    if (st.positionMillis > 0 || st.isPlaying) setReady(true);
  }

  return (
    <Modal visible={!!url} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.overlay}>
        <TouchableOpacity
          onPress={onClose}
          style={s.close}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={26} color="#fff" />
        </TouchableOpacity>

        {url && !failed && (
          <Video
            key={`${url}#${attempt}`}
            ref={videoRef}
            source={{ uri: url }}
            style={s.video}
            useNativeControls
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay
            progressUpdateIntervalMillis={400}
            onPlaybackStatusUpdate={onStatus}
            onError={() => setFailed(true)}
          />
        )}

        {/* Loading / buffering. Shown until the first frame is up, and again
            whenever playback stalls waiting for more data. */}
        {url && !failed && (!ready || buffering) && (
          <View style={s.centre} pointerEvents="none">
            <ActivityIndicator size="large" color="#fff" />
            <Text style={s.centreText}>
              {buffered > 0
                ? `${ready ? 'Buffering' : 'Loading'} — ${Math.round(buffered * 100)}% downloaded`
                : 'Loading…'}
            </Text>
          </View>
        )}

        {/* How much of the file has arrived, along the bottom. */}
        {url && !failed && buffered > 0 && buffered < 1 && (
          <View style={s.bufferTrack} pointerEvents="none">
            <View style={[s.bufferFill, { width: `${Math.round(buffered * 100)}%` }]} />
          </View>
        )}

        {failed && (
          <View style={s.centre}>
            <Ionicons name="alert-circle-outline" size={46} color="#94a3b8" />
            <Text style={s.centreText}>Couldn’t play this video</Text>
            <TouchableOpacity
              style={s.retry}
              onPress={() => { reset(); setAttempt(a => a + 1); }}
            >
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  video: { width: '100%', height: '80%' },
  close: {
    position: 'absolute', top: 44, right: 18, zIndex: 10,
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  centre: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 12 },
  centreText: { color: '#e2e8f0', fontSize: 14 },
  bufferTrack: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: 3,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  bufferFill: { height: 3, backgroundColor: C.accent },
  retry: {
    marginTop: 4, paddingHorizontal: 24, paddingVertical: 9, borderRadius: 18,
    borderWidth: 1, borderColor: '#e2e8f0',
  },
  retryText: { color: '#e2e8f0', fontSize: 14, fontWeight: '700' },
});
