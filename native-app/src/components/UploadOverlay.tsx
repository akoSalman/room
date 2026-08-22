// The progress strip on a bubble that is still being sent.
//
// It used to be a bare blue line with no numbers and no controls: no way to
// tell a slow upload from a stuck one, and no way to stop either. Now it says
// how far it has got, how fast, and how long is left, and it has the two
// buttons that make a long upload bearable — pause and cancel.
//
// It subscribes to progress for ITS OWN message. The previous arrangement kept
// progress in the screen's state and in the list's extraData, so every report
// re-rendered every bubble in the chat; during a video transcode that is
// hundreds of full-list re-renders competing with the encoder for the CPU.
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import * as up from '../uploadProgress';
import { canPause, canResume, canCancel, statusLine, uploadDeterminate, isActive } from '../uploadSession';

export default function UploadOverlay({ msgId }: { msgId: string | number }) {
  const id = String(msgId);
  const [view, setView] = useState<up.UploadView | null>(() => up.get(id));

  useEffect(() => {
    setView(up.get(id));
    return up.subscribe(id, setView);
  }, [id]);

  if (!view) return null;

  const pausable = canPause(view.phase);
  const resumable = canResume(view.phase);
  const stoppable = canCancel(view.phase);

  const determinate = uploadDeterminate(view);

  return (
    <View style={s.wrap}>
      {/* A bar only once there is something real to draw it from. Before the
          first byte is reported a bar at 0% is a claim — that this has started
          and got nowhere — where a spinner claims only that something is
          happening, which is all anybody knows. */}
      {determinate ? (
        <View style={s.track}>
          <View style={[s.fill, { width: `${Math.max(0, Math.min(100, view.percent))}%` },
            view.phase === 'paused' && s.fillPaused]} />
        </View>
      ) : null}

      <View style={s.row}>
        {/* A spinner only while something is actually happening — a failed or
            cancelled upload spinning forever would say the opposite of what is
            true. */}
        {!determinate && isActive(view.phase) && (
          <ActivityIndicator size="small" color={C.accent} style={{ marginRight: 2 }} />
        )}
        {determinate && <Text style={s.pct}>{view.percent}%</Text>}
        <View style={{ flex: 1 }} />

        {pausable && (
          <TouchableOpacity onPress={() => up.pause(id)} style={s.btn} hitSlop={hit}
            accessibilityLabel="Pause upload">
            <Ionicons name="pause" size={15} color={C.accent} />
          </TouchableOpacity>
        )}
        {resumable && (
          <TouchableOpacity onPress={() => up.resume(id)} style={s.btn} hitSlop={hit}
            accessibilityLabel="Resume upload">
            <Ionicons name="play" size={15} color={C.accent} />
          </TouchableOpacity>
        )}
        {stoppable && (
          <TouchableOpacity onPress={() => up.cancel(id)} style={s.btn} hitSlop={hit}
            accessibilityLabel="Cancel upload">
            <Ionicons name="close" size={16} color={C.danger} />
          </TouchableOpacity>
        )}
      </View>

      {/* On its own row, with the whole bubble to itself.
          It used to share a row with the percentage and both buttons, and a
          voice message bubble is only as wide as the words "Voice message" —
          so after the fixed parts there was room for about one character and
          the line rendered as a bare ellipsis. */}
      <Text style={s.status} numberOfLines={1} ellipsizeMode="tail">
        {statusLine({
          phase: view.phase, sent: view.sent, total: view.total, bytesPerSec: view.bytesPerSec,
        })}
      </Text>
    </View>
  );
}

const hit = { top: 10, bottom: 10, left: 8, right: 8 };

const s = StyleSheet.create({
  // A percentage width resolves against the bubble's final width without
  // contributing to it, so the overlay can never be what decides how wide a
  // message is.
  wrap: { marginTop: 6, gap: 4, width: '100%' },
  track: { height: 3, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.12)', overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: C.accent, borderRadius: 2 },
  fillPaused: { backgroundColor: C.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  pct: { color: C.text, fontSize: 11.5, fontWeight: '800', minWidth: 30 },
  status: { color: C.muted, fontSize: 11 },
  btn: {
    width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
});
