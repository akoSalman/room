// The "finding your location" wait, with a way out of it.
//
// Its own component because it ticks: the wording changes once the wait stops
// looking normal, and a ticker inside the chat screen would re-render the
// whole chat to move a line of text. See LiveAge, which is the same decision
// for the same reason.
import React, { useEffect, useState } from 'react';
import {
  View, Text, Modal, StyleSheet, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { C } from '../theme';
import { waitMessage } from '../locationWait';

export default function LocatingDialog({ visible, startedAt, onCancel }: {
  visible: boolean;
  /** When the wait began, so the wording can grow a reason. */
  startedAt: number | null;
  onCancel: () => void;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [visible]);

  const elapsed = visible && startedAt ? Date.now() - startedAt : 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Android's back button must do what Cancel does, not dismiss the dialog
      // and leave the request running behind it.
      onRequestClose={onCancel}
    >
      <View style={s.backdrop}>
        <View style={s.card}>
          <ActivityIndicator size="large" color={C.accent} />
          <Text style={s.text}>{waitMessage(elapsed)}</Text>
          <TouchableOpacity style={s.cancel} onPress={onCancel} activeOpacity={0.8}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  card: {
    width: '100%', maxWidth: 320, borderRadius: 16, padding: 22, gap: 14,
    backgroundColor: C.header, alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: C.border, elevation: 6,
  },
  text: { color: C.text, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  cancel: {
    paddingVertical: 10, paddingHorizontal: 22, borderRadius: 10,
    backgroundColor: C.sidebar, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border,
  },
  cancelText: { color: C.text, fontSize: 14, fontWeight: '700' },
});
