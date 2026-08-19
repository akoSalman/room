// ── A video in the chat ──────────────────────────────────────────────────────
//
// The tile shows the file size before anything is fetched, so nobody starts a
// 200 MB download by accident, and a download button that fills with real
// progress in MB/KB. Once downloaded the video plays from disk — instantly,
// and offline.
//
// Streaming still works without downloading: tapping the tile opens the player,
// which plays while it buffers. The button is for keeping it.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { fmtBytes, progressPercent } from '../download';
import * as downloads from '../videoDownloads';

export default function VideoBubble({
  url, uploading, onOpen, onLongPress,
}: {
  url: string;
  uploading?: boolean;
  /** Called with the local file when it is downloaded, else the remote URL. */
  onOpen: (playUrl: string) => void;
  onLongPress: () => void;
}) {
  const [dl, setDl] = useState(() => downloads.get(url));
  const [size, setSize] = useState(0);

  useEffect(() => downloads.subscribe(() => setDl(downloads.get(url))), [url]);

  useEffect(() => {
    if (uploading) return;
    let alive = true;
    // A file already on disk from an earlier session must show as downloaded.
    downloads.localUri(url).then(() => { if (alive) setDl(downloads.get(url)); });
    downloads.sizeOf(url).then(n => { if (alive) setSize(n); });
    return () => { alive = false; };
  }, [url, uploading]);

  const status = dl?.status;
  const total = dl?.total || size;
  const pct = status === 'downloading' ? progressPercent(dl!.written, total) : 0;

  function play() {
    onOpen(status === 'done' && dl?.uri ? dl.uri : url);
  }

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={play}
      onLongPress={onLongPress}
      delayLongPress={350}
      disabled={uploading}
    >
      <View style={s.thumb}>
        <Ionicons name="play" size={34} color="#fff" style={{ opacity: 0.9 }} />

        {/* Size, always visible: the point of a download button is knowing
            what it will cost before pressing it. */}
        {/* The size matters before you have the file, not after. */}
        {!uploading && total > 0 && status !== 'done' && (
          <Text style={s.size}>{fmtBytes(total)}</Text>
        )}

        {/* Kept on the device: a mark, not a control. */}
        {!uploading && status === 'done' && (
          <View style={s.savedMark}>
            <Ionicons name="checkmark-circle" size={14} color="#22c55e" />
          </View>
        )}

        {!uploading && (
          <View style={s.dock}>
            {status === 'downloading' ? (
              <TouchableOpacity
                style={s.dockBtn}
                onPress={() => downloads.cancel(url)}
                hitSlop={hit}
              >
                <ActivityIndicator size="small" color="#fff" />
                <Text style={s.dockText}>
                  {total > 0
                    ? `${fmtBytes(dl!.written)} / ${fmtBytes(total)}`
                    : fmtBytes(dl!.written)}
                </Text>
                <Ionicons name="close" size={15} color="#fff" />
              </TouchableOpacity>
            ) : status === 'done' ? (
              // Nothing. A video already on the device needs no button: there
              // is nothing left to press and the dock was only taking up the
              // picture. The small tick in the corner says it is kept.
              null
            ) : (
              <TouchableOpacity
                style={s.dockBtn}
                onPress={() => downloads.start(url)}
                hitSlop={hit}
              >
                <Ionicons
                  name={status === 'failed' ? 'refresh' : 'arrow-down-circle'}
                  size={16}
                  color="#fff"
                />
                <Text style={s.dockText}>
                  {status === 'failed' ? 'Retry' : 'Download'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {status === 'downloading' && (
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${pct}%` }]} />
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const hit = { top: 8, bottom: 8, left: 8, right: 8 };

const s = StyleSheet.create({
  savedMark: {
    position: 'absolute', top: 6, right: 6,
    backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 9, padding: 2,
  },
  thumb: {
    width: 200, height: 140, borderRadius: 10, backgroundColor: '#000',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  size: {
    position: 'absolute', top: 6, left: 8,
    color: '#e2e8f0', fontSize: 10.5, fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 4,
    paddingHorizontal: 5, paddingVertical: 1.5, overflow: 'hidden',
  },
  dock: { position: 'absolute', bottom: 10, alignSelf: 'center' },
  dockBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(15,23,42,0.82)', borderRadius: 14,
    paddingHorizontal: 11, paddingVertical: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  dockText: { color: '#fff', fontSize: 11.5, fontWeight: '700' },
  progressTrack: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    height: 3, backgroundColor: 'rgba(255,255,255,0.18)',
  },
  progressFill: { height: 3, backgroundColor: C.accent },
});
