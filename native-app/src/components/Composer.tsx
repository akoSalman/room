// The message composer, extracted so its text state is LOCAL to it. Typing and
// clearing never re-render the parent chat screen (and its heavy message list),
// which is what made the input feel laggy and leave stale text after sending.
import React, {
  forwardRef, memo, useImperativeHandle, useRef, useState, useCallback,
} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Image, StyleSheet,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { C, isRTL } from '../theme';
import { useFavEmojis } from '../favEmojis';
import EmojiEditor from './EmojiEditor';

export type ComposerHandle = {
  setText: (v: string) => void;
  append: (v: string) => void;
  getText: () => string;
  focus: () => void;
};

type Media = { uri: string; name: string; mime: string };

type Props = {
  pendingMedia: Media[];
  oneTimeSecs: number | null;
  quickEmoji: boolean;
  editing: boolean;
  onTyping: () => void;
  onSend: (text: string) => void;   // parent handles media/edit/reply/dispatch
  onAttach: () => void;
  onRecord: () => void;
  onOneTime: () => void;
  onLocation: () => void;
  /** Truthy while this device is streaming a live location. */
  liveLocation?: boolean;
  onToggleQuickEmoji: (open: boolean) => void;
  onRemoveMedia: (index: number) => void;
  onPreviewMedia: (uri: string) => void;
};

function ComposerInner(props: Props, ref: React.Ref<ComposerHandle>) {
  const {
    pendingMedia, oneTimeSecs, quickEmoji, editing,
    onTyping, onSend, onAttach, onRecord, onOneTime, onLocation, liveLocation,
    onToggleQuickEmoji, onRemoveMedia, onPreviewMedia,
  } = props;

  const [text, setText] = useState('');
  const favEmojis = useFavEmojis();
  const [editEmojis, setEditEmojis] = useState(false);
  const textRef = useRef('');
  const inputRef = useRef<TextInput>(null);
  const set = useCallback((v: string) => {
    textRef.current = v;
    setText(v);
    // Also clear/set the native input directly so it updates instantly,
    // independent of React's batched commit (which can be gated behind the
    // message-list re-render).
    inputRef.current?.setNativeProps({ text: v });
  }, []);

  useImperativeHandle(ref, () => ({
    setText: set,
    append: (v: string) => set(textRef.current + v),
    getText: () => textRef.current,
    // Blur first, then focus on the next tick. A bare focus() is a no-op when
    // the input is already the focused view (the case on the 2nd+ reply), so
    // the keyboard never reopens after it's been dismissed once. Cycling focus
    // forces the keyboard to come back every time.
    focus: () => {
      const el = inputRef.current;
      if (!el) return;
      el.blur();
      setTimeout(() => inputRef.current?.focus(), 30);
    },
  }), [set]);

  const send = useCallback(() => {
    const t = textRef.current;
    if (!t.trim() && !props.pendingMedia.length) return;
    // Clear the input FIRST (native + state), then hand off the actual send on
    // the next tick. This keeps the heavy message-list update out of the same
    // render pass as the clear, so the box empties immediately and the next
    // keystrokes never land on top of the just-sent text.
    set('');
    setTimeout(() => onSend(t), 0);
  }, [set, onSend, props.pendingMedia.length]);

  return (
    <View>
      {/* Floating quick-emoji bar */}
      {quickEmoji && (
        <View style={s.quickEmojiBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ alignItems: 'center' }} style={{ flex: 1 }}>
            {favEmojis.map(em => (
              <TouchableOpacity key={em} style={s.quickEmojiBtn} onPress={() => set(textRef.current + em)}>
                <Text style={s.quickEmojiText}>{em}</Text>
              </TouchableOpacity>
            ))}
            {/* Edit button at the end of the list. Deliberately NOT another
                emoji glyph — a divider, a tinted pill and a line icon so it
                reads as a control rather than one more emoji to send. */}
            <View style={s.quickEmojiDivider} />
            <TouchableOpacity style={s.quickEmojiEditBtn} onPress={() => setEditEmojis(true)}>
              <Ionicons name="options-outline" size={16} color={C.accent} />
            </TouchableOpacity>
          </ScrollView>
          <TouchableOpacity style={s.quickEmojiClose} hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            onPress={() => { onToggleQuickEmoji(false); AsyncStorage.setItem('quickEmojiClosed', '1'); }}>
            <Text style={s.quickEmojiCloseText}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Options strip */}
      <View style={s.optionsStrip}>
        <TouchableOpacity style={s.stripBtn} onPress={onAttach}>
          <Text style={s.stripBtnText}>📎 Media</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.stripBtn, oneTimeSecs ? s.oneTimeActive : null]} onPress={onOneTime}>
          <Text style={s.stripBtnText}>🔥 One-time{oneTimeSecs ? ` ${oneTimeSecs}s` : ''}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.stripBtn, liveLocation ? s.locationActive : null]}
          onPress={onLocation}
          accessibilityLabel="Share location"
        >
          <Ionicons
            name={liveLocation ? 'navigate' : 'location-outline'}
            size={17}
            color={liveLocation ? '#22c55e' : C.text}
          />
        </TouchableOpacity>
        {!quickEmoji && (
          <TouchableOpacity style={s.stripBtn}
            onPress={() => { onToggleQuickEmoji(true); AsyncStorage.removeItem('quickEmojiClosed'); }}>
            <Text style={s.stripBtnText}>😊</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Staged media previews */}
      {pendingMedia.length > 0 && (
        <View style={s.pendingMediaBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
            {pendingMedia.map((m, i) => (
              <View key={`${m.uri}-${i}`} style={s.pendingMediaItem}>
                <TouchableOpacity onPress={() => m.mime.startsWith('image/') && onPreviewMedia(m.uri)}>
                  {m.mime.startsWith('image/') ? (
                    <Image source={{ uri: m.uri }} style={s.pendingMediaThumb} />
                  ) : (
                    <View style={[s.pendingMediaThumb, s.pendingMediaFile]}>
                      <Text style={s.pendingMediaIcon}>{m.mime.startsWith('video/') ? '🎥' : '📄'}</Text>
                    </View>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={s.pendingMediaRemove} onPress={() => onRemoveMedia(i)}>
                  <Text style={s.pendingMediaRemoveText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity style={[s.pendingMediaThumb, s.pendingMediaFile]} onPress={onAttach}>
              <Text style={s.pendingMediaIcon}>＋</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {/* Input bar — the trailing button is a mic while the composer is empty
          (and no media staged), and turns into Send as soon as you type. */}
      <View style={s.inputBar}>
        <TextInput
          ref={inputRef}
          style={s.input}
          placeholder={pendingMedia.length ? 'Add a caption…' : 'Message...'}
          placeholderTextColor={C.muted}
          value={text}
          onChangeText={(v: string) => { textRef.current = v; setText(v); onTyping(); }}
          onSubmitEditing={send}
          blurOnSubmit={false}
          multiline
        />
        {text.trim().length === 0 && pendingMedia.length === 0 ? (
          <TouchableOpacity style={s.micBtn} onPress={onRecord} accessibilityLabel="Record voice message">
            <Ionicons name="mic" size={22} color="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.sendBtn} onPress={send} accessibilityLabel="Send">
            <Ionicons name="send" size={19} color="#fff" style={{ marginLeft: -2 }} />
          </TouchableOpacity>
        )}
      </View>

      <EmojiEditor visible={editEmojis} onClose={() => setEditEmojis(false)} />
    </View>
  );
}

// memo: the parent may re-render on unrelated state; the composer should only
// re-render when its own props (media/one-time/emoji bar) actually change.
const Composer = memo(forwardRef<ComposerHandle, Props>(ComposerInner));
export default Composer;

const s = StyleSheet.create({
  quickEmojiBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 2,
    backgroundColor: 'transparent',
  },
  quickEmojiBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  quickEmojiText: { fontSize: 22 },
  quickEmojiDivider: {
    width: StyleSheet.hairlineWidth, height: 22, marginHorizontal: 6,
    backgroundColor: C.border, alignSelf: 'center',
  },
  quickEmojiEditBtn: {
    width: 30, height: 30, borderRadius: 15, marginLeft: 2,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(59,125,216,0.14)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: C.accent,
  },
  quickEmojiClose: {
    width: 24, height: 24, borderRadius: 12, marginLeft: 6,
    backgroundColor: 'rgba(239,68,68,0.9)', alignItems: 'center', justifyContent: 'center',
  },
  quickEmojiCloseText: { color: '#fff', fontSize: 12, fontWeight: '800', lineHeight: 14 },
  optionsStrip: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: C.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(128,128,128,0.25)',
  },
  stripBtn: {
    backgroundColor: 'rgba(59,125,216,0.10)', borderRadius: 16,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  stripBtnText: { color: C.accent, fontSize: 13, fontWeight: '600' },
  oneTimeActive: { backgroundColor: 'rgba(248,113,113,0.25)', borderRadius: 8 },
  locationActive: { backgroundColor: 'rgba(34,197,94,0.22)', borderRadius: 8 },
  pendingMediaBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 6,
    backgroundColor: 'rgba(59,125,216,0.08)', borderTopWidth: 1, borderTopColor: C.accent,
  },
  pendingMediaItem: { position: 'relative' },
  pendingMediaThumb: { width: 54, height: 54, borderRadius: 8 },
  pendingMediaFile: { backgroundColor: 'rgba(59,125,216,0.12)', alignItems: 'center', justifyContent: 'center' },
  pendingMediaIcon: { fontSize: 22, color: C.accent },
  pendingMediaRemove: {
    position: 'absolute', top: -5, right: -5, width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#f87171', alignItems: 'center', justifyContent: 'center',
  },
  pendingMediaRemoveText: { color: '#fff', fontSize: 10, fontWeight: '700', lineHeight: 12 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, backgroundColor: C.header, borderTopWidth: 1, borderTopColor: C.border, gap: 6 },
  input: { flex: 1, backgroundColor: C.inputBg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, color: C.text, fontSize: 15, borderWidth: 1, borderColor: C.border, maxHeight: 120, textAlign: isRTL ? 'right' : 'left' },
  sendBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  sendBtnText: { color: '#fff', fontSize: 16 },
  micBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
});
