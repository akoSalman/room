// ── A video in the chat ──────────────────────────────────────────────────────
//
// The tile shows the file size before anything is fetched, so nobody starts a
// 200 MB download by accident, and a download button that fills with real
// progress in MB/KB. Once downloaded the video plays from disk — instantly,
// and offline.
//
// Tapping the tile DOWNLOADS the video and then opens the player by itself.
//
// It used to stream instead, keeping nothing — and that was a deliberate
// choice, written down right here. It was reported as a bug, and the report
// was right: "it will download and play but when closing video the download
// button is still there". The bytes were spent, the video played, and the
// tile went back to offering a download of the thing just watched, on every
// rewatch. For somebody on a metered connection that is the wrong trade
// twice, so the data is now spent once and the phone keeps what it paid for.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { fmtBytes, progressPercent, videoTapAction, shouldAutoOpen } from '../download';
import * as downloads from '../videoDownloads';
import * as covers from '../videoCoverStore';
import { coverToShow } from '../videoCover';

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
  // A frame from the video, so a chat full of videos is not a column of
  // identical dark rectangles.
  const [cover, setCover] = useState(() => covers.get(url));

  useEffect(() => downloads.subscribe(() => setDl(downloads.get(url))), [url]);
  useEffect(() => covers.subscribe(() => setCover(covers.get(url))), [url]);

  useEffect(() => {
    if (uploading) return;
    let alive = true;
    // A file already on disk from an earlier session must show as downloaded.
    downloads.localUri(url).then(() => { if (alive) setDl(downloads.get(url)); });
    downloads.sizeOf(url).then(n => { if (alive) setSize(n); });
    return () => { alive = false; };
  }, [url, uploading]);

  // Extract the cover from the local copy when there is one — reading from
  // disk is faster and costs nothing — and from the remote file otherwise,
  // but only when it is small enough to be worth streaming for a picture.
  const localUri = dl?.status === 'done' ? dl.uri : undefined;
  useEffect(() => {
    if (uploading) return;
    covers.ensureCover({
      url,
      source: localUri || url,
      local: !!localUri,
      sizeBytes: size || dl?.total || 0,
    }).catch(() => {});
  }, [url, uploading, localUri, size, dl?.total]);

  const coverUri = coverToShow(cover);

  const status = dl?.status;
  const total = dl?.total || size;
  const pct = status === 'downloading' ? progressPercent(dl!.written, total) : 0;

  // Whether a tap is waiting on a download to finish, so the player can be
  // opened the moment it does — once, and only for the person who asked.
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!shouldAutoOpen({ waiting, status: dl?.status, hasFile: !!dl?.uri })) return;
    setWaiting(false);
    onOpen(dl!.uri!);
  }, [waiting, dl?.status, dl?.uri]);

  // A download the user did not ask to wait for must not yank them into a
  // player later; leaving the tile cancels the waiting, not the download.
  useEffect(() => () => setWaiting(false), [url]);

  function play() {
    const action = videoTapAction({ status, hasFile: !!dl?.uri });
    if (action === 'play-local') { onOpen(dl!.uri!); return; }
    setWaiting(true);
    if (action === 'start-download') downloads.start(url).catch(() => {});
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
        {coverUri && (
          <Image source={{ uri: coverUri }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
        )}
        {/* Over a real frame the play mark needs its own backing, or it
            disappears into whatever the picture happens to be. */}
        <View style={coverUri ? s.playOnCover : undefined}>
          <Ionicons name="play" size={34} color="#fff" style={{ opacity: 0.9 }} />
        </View>

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
              // Just the arrow. The word "Download" said nothing the arrow
              // did not, on the one part of the screen that is meant to be a
              // picture — and the size, which IS worth knowing before
              // pressing, sits above it either way.
              <TouchableOpacity
                style={[s.dockBtn, s.dockIconOnly]}
                onPress={() => downloads.start(url)}
                hitSlop={hit}
                accessibilityLabel={status === 'failed' ? 'Retry download' : 'Download video'}
              >
                <Ionicons
                  name={status === 'failed' ? 'refresh' : 'arrow-down'}
                  size={18}
                  color="#fff"
                />
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
  playOnCover: {
    width: 62, height: 62, borderRadius: 31,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
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
  // A circle, not a pill: with the label gone the old padding left a wide
  // lozenge with an arrow rattling around in the middle of it.
  dockIconOnly: {
    width: 34, height: 34, borderRadius: 17,
    paddingHorizontal: 0, paddingVertical: 0, justifyContent: 'center',
  },
  dockText: { color: '#fff', fontSize: 11.5, fontWeight: '700' },
  progressTrack: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    height: 3, backgroundColor: 'rgba(255,255,255,0.18)',
  },
  progressFill: { height: 3, backgroundColor: C.accent },
});
