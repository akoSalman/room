// The small card that appears while something is being saved to the device.
//
// It exists because tapping Download used to do nothing visible for a couple
// of seconds and then announce success — long enough to assume the tap missed,
// tap again, and download a 40 MB video twice.
//
// Subscribes to the save state directly rather than taking it as a prop, so
// the many progress reports a download produces re-render these few lines and
// nothing else in the chat.
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import * as save from '../saveProgress';
import { isDeterminate, overallPercent, saveLabel, canCancel } from '../saveProgress';

export default function SaveOverlay() {
  const [state, setState] = useState<save.SaveState | null>(() => save.get());

  useEffect(() => {
    setState(save.get());
    return save.subscribe(setState);
  }, []);

  // Clear itself a moment after finishing: the result has to stay long enough
  // to be read, and then get out of the way on its own.
  useEffect(() => {
    if (!state?.done) return;
    const t = setTimeout(() => save.clear(), 1600);
    return () => clearTimeout(t);
  }, [state?.done]);

  if (!state) return null;
  const pct = overallPercent(state);
  const determinate = isDeterminate(state) && !state.done;

  return (
    // box-none: the card no longer swallows every touch, because there is a
    // button inside it now — but the empty strip either side of it must still
    // let taps through to the chat behind.
    <View style={s.wrap} pointerEvents="box-none">
      <View style={s.card}>
        {state.done
          ? <Text style={s.tick}>{state.done === 'saved' ? '✓' : '⚠'}</Text>
          : <ActivityIndicator size="small" color={C.accent} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.label} numberOfLines={1}>{saveLabel(state)}</Text>
          {determinate && (
            <View style={s.track}>
              <View style={[s.fill, { width: `${pct}%` }]} />
            </View>
          )}
        </View>
        {determinate && <Text style={s.pct}>{pct}%</Text>}
        {/* Asked for: a way out. A forty-megabyte video started by a mistaken
            tap otherwise has to be waited out — on these connections, for
            minutes. */}
        {canCancel(state) && (
          <TouchableOpacity
            onPress={() => save.requestCancel()}
            style={s.cancel}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel="Stop the download"
          >
            <Ionicons name="close" size={16} color={C.muted} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute', top: 96, left: 0, right: 0,
    alignItems: 'center', zIndex: 50,
  },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    minWidth: 210, maxWidth: '86%',
    paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12,
    backgroundColor: C.sidebar, borderWidth: 1, borderColor: C.border,
    elevation: 6, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  tick: { fontSize: 17, color: C.success, width: 20, textAlign: 'center' },
  label: { color: C.text, fontSize: 13.5, fontWeight: '700' },
  track: {
    height: 3, borderRadius: 2, marginTop: 6,
    backgroundColor: 'rgba(0,0,0,0.12)', overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: C.accent, borderRadius: 2 },
  pct: { color: C.muted, fontSize: 11.5, fontWeight: '700', minWidth: 34, textAlign: 'right' },
  cancel: {
    width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(128,128,128,0.16)',
  },
});
