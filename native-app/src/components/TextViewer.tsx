// Full-screen, reliably selectable copy of a message's text.
//
// Why this exists: inline selection in a chat bubble is not dependable. Links,
// phone numbers and plain digit runs are rendered as nested pressable <Text>
// spans so they can be tapped, and on Android a pressable span consumes the
// long-press that would otherwise start text selection. The result is that
// selection works on a message of plain words and silently does nothing on one
// containing a price, a phone number or a link — which is most messages.
//
// Rather than choose between tappable links and selectable text, this gives an
// explicit path to the second: one plain <Text selectable>, no nested spans, no
// gesture competition, so a long-press always starts selection and the handles
// always work.
import React from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';

export default function TextViewer({
  visible, text, onClose, onCopyAll,
}: {
  visible: boolean;
  text: string;
  onClose: () => void;
  onCopyAll: () => void;
}) {
  // Persian messages must not be laid out left-to-right.
  const t = text || '';
  const rtlChars = (t.match(/[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const rtl = rtlChars > 0 && rtlChars >= (rtlChars + latin) * 0.3;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.screen}>
        <View style={s.header}>
          <TouchableOpacity onPress={onClose} style={s.iconBtn} hitSlop={hit}>
            <Ionicons name="close" size={24} color={C.text} />
          </TouchableOpacity>
          <Text style={s.title}>Select text</Text>
          <TouchableOpacity onPress={onCopyAll} style={s.copyAll}>
            <Ionicons name="copy-outline" size={16} color="#fff" />
            <Text style={s.copyAllText}>Copy all</Text>
          </TouchableOpacity>
        </View>

        <Text style={s.hint}>
          Long-press a word to start selecting, then drag the handles.
        </Text>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
          <Text
            selectable
            style={[s.body, rtl && s.bodyRTL]}
          >
            {text}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const hit = { top: 10, bottom: 10, left: 10, right: 10 };

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingTop: 42, paddingBottom: 12, paddingHorizontal: 12,
    backgroundColor: C.header,
  },
  iconBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: C.text, fontSize: 16, fontWeight: '800' },
  copyAll: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: C.accent, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 7,
  },
  copyAllText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  hint: {
    color: C.muted, fontSize: 12, paddingHorizontal: 16, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  body: { color: C.text, fontSize: 17, lineHeight: 26 },
  bodyRTL: { textAlign: 'right', writingDirection: 'rtl' },
});
