// Choose how a video is sent: resolution, and how much of it.
//
// The preview plays the actual clip, and each option shows what it will cost
// to send, recalculated as the trim changes — the point of the screen is that
// nobody has to guess.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator, Pressable,
} from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { fmtBytes } from '../download';
import {
  VideoQuality, VIDEO_PRESETS, videoTarget, trimmedDuration, estimateBytes, fmtDuration,
  shouldTranscode, presetFor,
} from '../videoQuality';
import { trimVideo } from '../compressVideo';

export type VideoChoice = {
  quality: VideoQuality;
  /** The file to send — the trimmed copy when the user trimmed it. */
  uri: string;
  size: { width: number; height: number } | null;
  /** Length of what is being sent, so a pointless re-encode can be skipped. */
  seconds: number;
};

export default function VideoSendSheet({
  visible, uri, originalBytes, onCancel, onConfirm,
}: {
  visible: boolean;
  uri: string;
  originalBytes: number;
  onCancel: () => void;
  onConfirm: (choice: VideoChoice) => void;
}) {
  const [quality, setQuality] = useState<VideoQuality>('medium');
  // The working file: swapped for the trimmed copy once the user trims.
  const [workUri, setWorkUri] = useState(uri);
  const [duration, setDuration] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [trimming, setTrimming] = useState(false);
  const [trimmed, setTrimmed] = useState(false);
  const player = useRef<Video>(null);

  useEffect(() => {
    if (!visible) return;
    // A fresh video: forget everything about the last one.
    setWorkUri(uri); setDuration(0); setSize(null); setTrimmed(false);
  }, [visible, uri]);

  function onStatus(st: AVPlaybackStatus) {
    if (!st.isLoaded) return;
    if (st.durationMillis) setDuration(st.durationMillis / 1000);
  }

  async function doTrim() {
    setTrimming(true);
    const out = await trimVideo(workUri);
    setTrimming(false);
    if (!out) return;              // cancelled, or unavailable
    setWorkUri(out);
    setTrimmed(true);
    setDuration(0);                // re-measured from the trimmed file
  }

  // Everything that survives the trim is simply the working file's length —
  // the native trimmer has already cut it.
  const seconds = trimmedDuration(duration, 0, duration);
  const originalSeconds = seconds;

  // The currently selected option, resolved once so the badge over the preview
  // and the row in the list cannot disagree.
  const selectedTarget = size ? videoTarget(size.width, size.height, quality) : null;
  const selectedNoChange = quality !== 'original'
    && !shouldTranscode(quality, originalBytes, seconds, size);
  const selectedBytes = estimateBytes(
    selectedNoChange ? 'original' : quality, seconds, originalBytes, originalSeconds,
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={s.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={s.sheet}>
          <View style={s.handle} />
          <Text style={s.title}>Send video</Text>

          <View style={s.preview}>
            <Video
              ref={player}
              source={{ uri: workUri }}
              style={StyleSheet.absoluteFill}
              resizeMode={ResizeMode.CONTAIN}
              useNativeControls
              isLooping
              onPlaybackStatusUpdate={onStatus}
              onReadyForDisplay={(e: any) => {
                const ns = e?.naturalSize;
                if (ns?.width && ns?.height) setSize({ width: ns.width, height: ns.height });
              }}
            />
            {trimming && (
              <View style={s.previewBusy}>
                <ActivityIndicator color="#fff" />
              </View>
            )}
            {/* What the SELECTED option will actually produce, over the
                picture it applies to. Reading the choice at the bottom of the
                sheet and the source at the top left the user doing the
                arithmetic themselves. */}
            <View style={s.previewBadge}>
              <Text style={s.previewBadgeText}>
                {selectedNoChange
                  ? `Sent as-is · ${size ? `${size.width}×${size.height}` : 'original'}`
                  : `${presetFor(quality).label} · ${selectedTarget
                      ? `${selectedTarget.width}×${selectedTarget.height}`
                      : size ? `${size.width}×${size.height}` : '…'}`}
                {selectedBytes ? `  ·  ~${fmtBytes(selectedBytes)}` : ''}
              </Text>
            </View>
          </View>

          <View style={s.metaRow}>
            <Text style={s.meta}>
              {size ? `${size.width}×${size.height}` : '…'}
              {duration ? `  ·  ${fmtDuration(duration)}` : ''}
              {originalBytes ? `  ·  ${fmtBytes(originalBytes)}` : ''}
            </Text>
            <TouchableOpacity style={s.trimBtn} onPress={doTrim} disabled={trimming}>
              <Ionicons name="cut-outline" size={15} color={C.accent} />
              <Text style={s.trimText}>{trimmed ? 'Trim again' : 'Trim'}</Text>
            </TouchableOpacity>
          </View>

          {trimmed && (
            <Text style={s.trimmedNote}>
              Trimmed — only the part you kept will be sent.
            </Text>
          )}

          <Text style={s.sectionLabel}>QUALITY</Text>
          {VIDEO_PRESETS.map(p => {
            const target = size ? videoTarget(size.width, size.height, p.id) : null;
            // "Original" for a clip that is already smaller than the preset:
            // saying "480p" when nothing will change would be a lie.
            // Either already small enough, or re-encoding would not shrink it
            // enough to be worth the wait — both send the file untouched.
            const noChange = p.id !== 'original'
              && !shouldTranscode(p.id, originalBytes, seconds, size);
            const bytes = estimateBytes(
              noChange ? 'original' : p.id, seconds, originalBytes, originalSeconds,
            );
            const active = quality === p.id;
            return (
              <TouchableOpacity
                key={p.id}
                style={[s.opt, active && s.optOn]}
                onPress={() => setQuality(p.id)}
              >
                <Ionicons
                  name={active ? 'radio-button-on' : 'radio-button-off'}
                  size={19}
                  color={active ? C.accent : C.muted}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[s.optLabel, active && s.optLabelOn]}>
                    {p.label}
                    {p.id === 'original' ? '  ·  full quality' : ''}
                  </Text>
                  <Text style={s.optMeta} numberOfLines={1}>
                    {noChange ? 'sent as-is — already small' : target ? `${target.width}×${target.height}` : 'unchanged'}
                    {bytes ? `  ·  about ${fmtBytes(bytes)}` : ''}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}

          <View style={s.actions}>
            <TouchableOpacity style={s.cancel} onPress={onCancel}>
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.send}
              onPress={() => onConfirm({ quality, uri: workUri, size, seconds })}
            >
              <Ionicons name="send" size={16} color="#fff" />
              <Text style={s.sendText}>Send</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 18, paddingBottom: 24, maxHeight: '92%',
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginTop: 10 },
  title: { color: C.text, fontSize: 17, fontWeight: '800', marginTop: 12, marginBottom: 10 },
  preview: {
    height: 190, borderRadius: 12, backgroundColor: '#000', overflow: 'hidden',
  },
  previewBusy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  previewBadge: {
    position: 'absolute', left: 8, bottom: 8,
    backgroundColor: 'rgba(15,23,42,0.82)', borderRadius: 8,
    paddingHorizontal: 9, paddingVertical: 5,
  },
  previewBadgeText: { color: '#fff', fontSize: 11.5, fontWeight: '700' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 9 },
  meta: { flex: 1, color: C.muted, fontSize: 12 },
  trimBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 14, borderWidth: 1, borderColor: C.accent,
  },
  trimText: { color: C.accent, fontSize: 12.5, fontWeight: '700' },
  trimmedNote: { color: '#22c55e', fontSize: 11.5, marginTop: 6, fontWeight: '600' },
  sectionLabel: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginTop: 14, marginBottom: 4 },
  opt: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    paddingVertical: 10, paddingHorizontal: 10, borderRadius: 10,
  },
  optOn: { backgroundColor: 'rgba(59,125,216,0.10)' },
  optLabel: { color: C.text, fontSize: 14.5, fontWeight: '700' },
  optLabelOn: { color: C.accent },
  optMeta: { color: C.muted, fontSize: 11.5, marginTop: 1 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  cancel: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 13,
    borderRadius: 12, borderWidth: 1, borderColor: C.border,
  },
  cancelText: { color: C.text, fontSize: 14.5, fontWeight: '700' },
  send: {
    flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13,
  },
  sendText: { color: '#fff', fontSize: 14.5, fontWeight: '800' },
});
