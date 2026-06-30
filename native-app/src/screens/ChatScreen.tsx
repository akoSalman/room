import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert,
  ActivityIndicator, Modal, ScrollView, Image,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { Audio } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { C } from '../theme';
import { apiFetch, getSocket, getToken, getUsername, BASE_URL } from '../api';
import VoicePlayer from '../components/VoicePlayer';
import VoiceRecorder from '../components/VoiceRecorder';

// Show notifications even when app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

type Message = {
  id: number; room_id: number; user_id: number; username: string;
  type: string; content: string | null; file_path: string | null;
  file_name: string | null; edited: number; created_at: string;
  reply_to_id?: number | null; reply_username?: string | null;
  reply_content?: string | null; reply_type?: string | null;
};
type Reaction = { emoji: string; username: string; user_id: number };
type ReplyTo = { id: number; username: string; content: string | null; type: string };

const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','🤔','😍','👎','😡'];

export default function ChatScreen({ room, onBack }: {
  room: { id: number; name: string; is_dm: number; other_username?: string };
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<Record<number, Reaction[]>>({});
  const [text, setText] = useState('');
  const [me, setMe] = useState('');
  const [online, setOnline] = useState<string[]>([]);
  const [typing, setTyping] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showEmojiFor, setShowEmojiFor] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [showOnline, setShowOnline] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const typingTimer = useRef<any>(null);
  const socketRef = useRef<any>(null);
  const meRef = useRef('');
  const title = room.is_dm ? (room.other_username || '') : room.name;

  const scrollBottom = useCallback(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }, []);

  useEffect(() => {
    // Request notification permission
    Notifications.requestPermissionsAsync().catch(() => {});

    let mounted = true;
    (async () => {
      const [msgs, u, sock] = await Promise.all([
        apiFetch(`/messages/${room.id}`),
        getUsername(),
        getSocket(),
      ]);
      if (!mounted) return;
      setMe(u || '');
      meRef.current = u || '';
      if (Array.isArray(msgs)) setMessages(msgs);
      setLoading(false);
      scrollBottom();

      socketRef.current = sock;
      sock.emit('join_room', room.id);

      sock.on('message_received', (msg: Message) => {
        if (msg.room_id !== room.id) return;
        setMessages(prev => [...prev, msg]);
        scrollBottom();
        // Show notification if message is from someone else
        if (msg.username !== meRef.current) {
          const body = msg.type === 'text' ? (msg.content || '') : msg.type === 'audio' ? '🎙 Voice message' : msg.type === 'image' ? '🖼 Image' : '📄 File';
          Notifications.scheduleNotificationAsync({
            content: { title: msg.username, body, sound: true },
            trigger: null,
          }).catch(() => {});
        }
      });
      sock.on('message_edited', ({ messageId, content }: any) => {
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content, edited: 1 } : m));
      });
      sock.on('message_deleted', ({ messageId }: any) => {
        setMessages(prev => prev.filter(m => m.id !== messageId));
      });
      sock.on('reactions_updated', ({ messageId, reactions: r }: any) => {
        setReactions(prev => ({ ...prev, [messageId]: r }));
      });
      sock.on('room_online', ({ users }: any) => setOnline(users));
      sock.on('user_typing', ({ username: u }: any) => {
        setTyping(prev => prev.includes(u) ? prev : [...prev, u]);
      });
      sock.on('user_stopped_typing', ({ username: u }: any) => {
        setTyping(prev => prev.filter(x => x !== u));
      });
    })();
    return () => {
      mounted = false;
      socketRef.current?.off('message_received');
      socketRef.current?.off('message_edited');
      socketRef.current?.off('message_deleted');
      socketRef.current?.off('reactions_updated');
      socketRef.current?.off('room_online');
      socketRef.current?.off('user_typing');
      socketRef.current?.off('user_stopped_typing');
    };
  }, [room.id]);

  function sendText() {
    const t = text.trim();
    if (!t || !socketRef.current) return;
    if (editingId) {
      socketRef.current.emit('edit_message', { messageId: editingId, content: t });
      setEditingId(null);
    } else {
      socketRef.current.emit('send_message', { roomId: room.id, type: 'text', content: t, replyToId: replyTo?.id ?? null });
    }
    setText('');
    setReplyTo(null);
    emitStopTyping();
  }

  function emitTyping() {
    socketRef.current?.emit('typing_start', { roomId: room.id });
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => emitStopTyping(), 2500);
  }
  function emitStopTyping() {
    clearTimeout(typingTimer.current);
    socketRef.current?.emit('typing_stop', { roomId: room.id });
  }

  async function pickFile() {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled) return;
    uploadFile(res.assets[0].uri, res.assets[0].name, res.assets[0].mimeType || 'application/octet-stream');
  }

  async function pickImage() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (res.canceled) return;
    const asset = res.assets[0];
    uploadFile(asset.uri, 'photo.jpg', 'image/jpeg');
  }

  async function uploadFile(uri: string, name: string, mime: string) {
    const token = await getToken();
    const form = new FormData();
    form.append('file', { uri, name, type: mime } as any);
    const res = await fetch(`${BASE_URL}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }).then(r => r.json());
    if (res.error) { Alert.alert('Error', res.error); return; }
    const type = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file';
    socketRef.current?.emit('send_message', {
      roomId: room.id, type, filePath: res.url, fileName: name, replyToId: replyTo?.id ?? null,
    });
    setReplyTo(null);
  }

  async function sendVoice(uri: string, peaks: number[]) {
    const token = await getToken();
    const form = new FormData();
    form.append('file', { uri, name: `voice-${Date.now()}.m4a`, type: 'audio/m4a' } as any);
    const res = await fetch(`${BASE_URL}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }).then(r => r.json());
    if (res.error) { Alert.alert('Error', res.error); return; }
    const peakStr = peaks.map(v => Math.round(v * 100)).join(',');
    socketRef.current?.emit('send_message', {
      roomId: room.id, type: 'audio', filePath: res.url, fileName: peakStr, replyToId: replyTo?.id ?? null,
    });
    setReplyTo(null);
  }

  function toggleReact(messageId: number, emoji: string) {
    socketRef.current?.emit('toggle_reaction', { messageId, emoji });
    setShowEmojiFor(null);
  }

  function deleteMsg(id: number) {
    Alert.alert('Delete message?', '', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => socketRef.current?.emit('delete_message', { messageId: id }) },
    ]);
  }

  function fmtTime(iso: string) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function replyPreview(msg: Message): string {
    if (msg.reply_type === 'audio') return '🎙 Voice message';
    if (msg.reply_type === 'image') return '🖼 Image';
    if (msg.reply_type === 'file') return '📄 File';
    return (msg.reply_content || '').slice(0, 60);
  }

  function renderMessage({ item: msg }: { item: Message }) {
    const mine = msg.username === me;
    const rxns = reactions[msg.id] || [];
    const grouped: Record<string, { count: number; mine: boolean }> = {};
    rxns.forEach(r => {
      if (!grouped[r.emoji]) grouped[r.emoji] = { count: 0, mine: false };
      grouped[r.emoji].count++;
      if (r.username === me) grouped[r.emoji].mine = true;
    });

    return (
      <View style={[s.msgWrapper, mine ? s.mine : s.theirs]}>
        {!mine && <Text style={s.sender}>{msg.username}</Text>}
        <TouchableOpacity
          style={[s.bubble, mine ? s.mineBubble : s.theirsBubble]}
          onLongPress={() => setShowEmojiFor(msg.id)}
          activeOpacity={0.85}
        >
          {/* Reply quote */}
          {msg.reply_to_id && msg.reply_username && (
            <View style={s.replyQuote}>
              <Text style={s.replyQuoteUser}>{msg.reply_username}</Text>
              <Text style={s.replyQuoteText} numberOfLines={1}>{replyPreview(msg)}</Text>
            </View>
          )}

          {msg.type === 'text' && (
            <Text style={s.msgText}>{msg.content}{msg.edited ? <Text style={s.edited}> (edited)</Text> : null}</Text>
          )}
          {msg.type === 'image' && (
            <TouchableOpacity onPress={() => setLightboxUrl(`${BASE_URL}${msg.file_path}`)}>
              <Image
                source={{ uri: `${BASE_URL}${msg.file_path}` }}
                style={s.msgImage}
                resizeMode="cover"
              />
            </TouchableOpacity>
          )}
          {msg.type === 'audio' && (
            <VoicePlayer url={`${BASE_URL}${msg.file_path}`} peaks={msg.file_name || ''} mine={mine} />
          )}
          {msg.type === 'file' && (
            <Text style={s.fileLink}>📄 {msg.file_name || 'File'}</Text>
          )}
        </TouchableOpacity>

        {/* Reactions */}
        {Object.keys(grouped).length > 0 && (
          <View style={s.reactRow}>
            {Object.entries(grouped).map(([emoji, d]) => (
              <TouchableOpacity key={emoji} style={[s.reactChip, d.mine && s.reactMine]}
                onPress={() => toggleReact(msg.id, emoji)}>
                <Text style={s.reactText}>{emoji} {d.count}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={s.footer}>
          <Text style={s.time}>{fmtTime(msg.created_at)}</Text>
          <TouchableOpacity onPress={() => setReplyTo({ id: msg.id, username: msg.username, content: msg.content, type: msg.type })}>
            <Text style={s.footerBtn}>↩</Text>
          </TouchableOpacity>
          {mine && (
            <>
              {msg.type === 'text' && (
                <TouchableOpacity onPress={() => { setText(msg.content || ''); setEditingId(msg.id); }}>
                  <Text style={s.footerBtn}>✏️</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => deleteMsg(msg.id)}>
                <Text style={s.footerBtn}>🗑</Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity onPress={() => setShowEmojiFor(msg.id)}>
            <Text style={s.footerBtn}>😊</Text>
          </TouchableOpacity>
        </View>

        {/* Emoji picker */}
        {showEmojiFor === msg.id && (
          <View style={[s.emojiPicker, mine ? { alignSelf: 'flex-end' } : {}]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {EMOJIS.map(e => (
                <TouchableOpacity key={e} onPress={() => toggleReact(msg.id, e)} style={s.emojiBtn}>
                  <Text style={s.emoji}>{e}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={() => setShowEmojiFor(null)} style={s.emojiBtn}>
                <Text style={s.emoji}>✕</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.backBtn}>
          <Text style={s.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{room.is_dm ? '💬 ' : '# '}{title}</Text>
        {online.length > 0 && (
          <TouchableOpacity style={s.onlineBadge} onPress={() => setShowOnline(true)}>
            <Text style={s.onlineText}>● {online.length} online</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Online users modal */}
      <Modal visible={showOnline} transparent animationType="fade" onRequestClose={() => setShowOnline(false)}>
        <TouchableOpacity style={s.modalOverlay} onPress={() => setShowOnline(false)}>
          <View style={s.onlinePanel}>
            <Text style={s.onlinePanelTitle}>ONLINE NOW</Text>
            {online.map(u => <Text key={u} style={s.onlineUser}>● {u}</Text>)}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Image lightbox */}
      <Modal visible={!!lightboxUrl} transparent animationType="fade" onRequestClose={() => setLightboxUrl(null)}>
        <TouchableOpacity style={s.lightboxOverlay} activeOpacity={1} onPress={() => setLightboxUrl(null)}>
          <TouchableOpacity onPress={() => setLightboxUrl(null)} style={s.lightboxClose}>
            <Text style={s.lightboxCloseText}>✕</Text>
          </TouchableOpacity>
          {lightboxUrl && (
            <Image source={{ uri: lightboxUrl }} style={s.lightboxImage} resizeMode="contain" />
          )}
        </TouchableOpacity>
      </Modal>

      {/* Messages */}
      {loading ? (
        <View style={s.loadingContainer}>
          <ActivityIndicator color={C.accent} size="large" />
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={m => String(m.id)}
          renderItem={renderMessage}
          contentContainerStyle={s.messagesList}
          onContentSizeChange={scrollBottom}
        />
      )}

      {/* Typing indicator */}
      {typing.filter(u => u !== me).length > 0 && (
        <Text style={s.typingBar}>{typing.filter(u => u !== me).join(', ')} is typing…</Text>
      )}

      {/* Edit banner */}
      {editingId && (
        <View style={s.editBanner}>
          <Text style={s.editText}>✏️ Editing message</Text>
          <TouchableOpacity onPress={() => { setEditingId(null); setText(''); }}>
            <Text style={s.editClose}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Reply banner */}
      {replyTo && !editingId && (
        <View style={s.replyBanner}>
          <Text style={s.replyBannerIcon}>↩</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.replyBannerUser}>{replyTo.username}</Text>
            <Text style={s.replyBannerText} numberOfLines={1}>
              {replyTo.type === 'audio' ? '🎙 Voice message' : replyTo.type === 'image' ? '🖼 Image' : replyTo.type === 'file' ? '📄 File' : (replyTo.content || '')}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyTo(null)}>
            <Text style={s.editClose}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Voice recorder or input bar */}
      {recording ? (
        <VoiceRecorder
          onCancel={() => setRecording(false)}
          onSend={(uri, peaks) => { setRecording(false); sendVoice(uri, peaks); }}
        />
      ) : (
        <View style={s.inputBar}>
          <TouchableOpacity onPress={pickFile} style={s.iconBtn}>
            <Text style={s.iconBtnText}>📎</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setRecording(true)} style={s.iconBtn}>
            <Text style={s.iconBtnText}>🎙</Text>
          </TouchableOpacity>
          <TextInput
            style={s.input} placeholder="Message..." placeholderTextColor={C.muted}
            value={text} onChangeText={t => { setText(t); emitTyping(); }}
            onSubmitEditing={sendText} blurOnSubmit={false} multiline
          />
          <TouchableOpacity style={s.sendBtn} onPress={sendText}>
            <Text style={s.sendBtnText}>➤</Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.header, padding: 12, paddingTop: 14, borderBottomWidth: 1, borderBottomColor: C.border, gap: 8 },
  backBtn: { padding: 4 },
  backText: { color: C.accent, fontSize: 28, lineHeight: 32 },
  headerTitle: { flex: 1, color: C.text, fontWeight: '600', fontSize: 16 },
  onlineBadge: { backgroundColor: 'rgba(74,222,128,0.15)', borderWidth: 1, borderColor: C.online, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  onlineText: { color: C.online, fontSize: 12, fontWeight: '600' },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messagesList: { padding: 12, gap: 6 },
  msgWrapper: { maxWidth: '80%', marginVertical: 2 },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  theirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  sender: { fontSize: 11, color: C.accent, marginBottom: 2, paddingHorizontal: 4 },
  bubble: { borderRadius: 12, padding: 10, maxWidth: '100%' },
  mineBubble: { backgroundColor: C.mine, borderBottomRightRadius: 3 },
  theirsBubble: { backgroundColor: C.msgBg, borderBottomLeftRadius: 3 },
  msgText: { color: C.text, fontSize: 15, lineHeight: 21 },
  edited: { color: C.muted, fontSize: 11 },
  fileLink: { color: '#93c5fd', fontSize: 14 },
  msgImage: { width: 200, height: 180, borderRadius: 10 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, paddingHorizontal: 4 },
  time: { color: C.muted, fontSize: 11 },
  footerBtn: { fontSize: 14, opacity: 0.6 },
  reactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactChip: { backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  reactMine: { borderColor: C.accent, backgroundColor: 'rgba(82,136,193,0.15)' },
  reactText: { fontSize: 13, color: C.text },
  emojiPicker: { flexDirection: 'row', backgroundColor: C.sidebar, borderRadius: 12, padding: 6, borderWidth: 1, borderColor: C.border, marginTop: 4 },
  emojiBtn: { padding: 6 },
  emoji: { fontSize: 22 },
  typingBar: { color: C.success, fontSize: 12, textAlign: 'center', paddingVertical: 4, paddingHorizontal: 12 },
  editBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(82,136,193,0.12)', borderTopWidth: 1, borderTopColor: C.accent, padding: 10, paddingHorizontal: 14 },
  editText: { flex: 1, color: C.accent, fontSize: 13 },
  editClose: { color: C.muted, fontSize: 18 },
  replyBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(82,136,193,0.08)', borderTopWidth: 1, borderTopColor: C.accent, padding: 10, paddingHorizontal: 14, gap: 8 },
  replyBannerIcon: { color: C.accent, fontSize: 16 },
  replyBannerUser: { color: C.accent, fontSize: 12, fontWeight: '700' },
  replyBannerText: { color: C.muted, fontSize: 12 },
  replyQuote: { borderLeftWidth: 3, borderLeftColor: C.accent, paddingLeft: 8, marginBottom: 6, borderRadius: 2 },
  replyQuoteUser: { color: C.accent, fontSize: 11, fontWeight: '700', marginBottom: 1 },
  replyQuoteText: { color: C.muted, fontSize: 12 },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', padding: 10, backgroundColor: C.header, borderTopWidth: 1, borderTopColor: C.border, gap: 6 },
  iconBtn: { padding: 8 },
  iconBtnText: { fontSize: 22 },
  input: { flex: 1, backgroundColor: C.inputBg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, color: C.text, fontSize: 15, borderWidth: 1, borderColor: C.border, maxHeight: 120 },
  sendBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  sendBtnText: { color: '#fff', fontSize: 16 },
  lightboxOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center' },
  lightboxClose: { position: 'absolute', top: 50, right: 20, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  lightboxCloseText: { color: '#fff', fontSize: 18 },
  lightboxImage: { width: '100%', height: '85%' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: 80, paddingRight: 12 },
  onlinePanel: { backgroundColor: C.sidebar, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.border, minWidth: 180 },
  onlinePanelTitle: { color: C.muted, fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 },
  onlineUser: { color: C.online, fontSize: 14, paddingVertical: 4 },
});
