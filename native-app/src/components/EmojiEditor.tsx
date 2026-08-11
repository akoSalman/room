// Editor for the user's favourite-emoji list, reached from the ✏️ button at the
// end of the quick-emoji bar and the reaction row.
import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, Pressable, ScrollView, StyleSheet, TouchableOpacity,
} from 'react-native';
import { C } from '../theme';
import {
  EMOJI_PALETTE, DEFAULT_FAV_EMOJIS, MAX_FAV_EMOJIS, getFavEmojis, setFavEmojis,
} from '../favEmojis';

export default function EmojiEditor({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [sel, setSel] = useState<string[]>(getFavEmojis());

  // Start from whatever is current each time the sheet opens.
  useEffect(() => { if (visible) setSel(getFavEmojis()); }, [visible]);

  function toggle(em: string) {
    setSel(prev => {
      if (prev.includes(em)) return prev.filter(e => e !== em);
      if (prev.length >= MAX_FAV_EMOJIS) return prev;
      return [...prev, em];
    });
  }

  async function save() { await setFavEmojis(sel); onClose(); }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={s.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={s.sheet}>
          <View style={s.grip} />
          <Text style={s.title}>Your emojis</Text>
          <Text style={s.sub}>
            {sel.length}/{MAX_FAV_EMOJIS} chosen · tap to add or remove
          </Text>

          <View style={s.chosenRow}>
            {sel.map(em => (
              <TouchableOpacity key={em} style={s.chosenBtn} onPress={() => toggle(em)}>
                <Text style={s.chosenEmoji}>{em}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={s.divider} />
          <ScrollView style={{ maxHeight: 260 }} showsVerticalScrollIndicator={false}>
            <View style={s.palette}>
              {EMOJI_PALETTE.map(em => {
                const on = sel.includes(em);
                return (
                  <TouchableOpacity
                    key={em}
                    style={[s.paletteBtn, on && s.paletteBtnOn]}
                    onPress={() => toggle(em)}
                  >
                    <Text style={s.paletteEmoji}>{em}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>

          <Pressable style={s.saveBtn} onPress={save}>
            <Text style={s.saveText}>Save</Text>
          </Pressable>
          <Pressable style={s.resetBtn} onPress={() => setSel(DEFAULT_FAV_EMOJIS)}>
            <Text style={s.resetText}>Reset to default</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 24, paddingTop: 8, maxHeight: '85%',
  },
  grip: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginBottom: 10 },
  title: { color: C.text, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  sub: { color: C.muted, fontSize: 12.5, textAlign: 'center', marginTop: 4, marginBottom: 12 },
  chosenRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    paddingHorizontal: 16, justifyContent: 'center', minHeight: 44,
  },
  chosenBtn: {
    width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(59,125,216,0.18)', borderWidth: 1, borderColor: C.accent,
  },
  chosenEmoji: { fontSize: 23 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginVertical: 12 },
  palette: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 16, justifyContent: 'center' },
  paletteBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(128,128,128,0.10)',
  },
  paletteBtnOn: { backgroundColor: 'rgba(59,125,216,0.22)' },
  paletteEmoji: { fontSize: 24 },
  saveBtn: {
    marginTop: 14, marginHorizontal: 16, backgroundColor: C.accent,
    borderRadius: 12, paddingVertical: 13, alignItems: 'center',
  },
  saveText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  resetBtn: { marginTop: 8, paddingVertical: 10, alignItems: 'center' },
  resetText: { color: C.muted, fontSize: 13.5, fontWeight: '600' },
});
