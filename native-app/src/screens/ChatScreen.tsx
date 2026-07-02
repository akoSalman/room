import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert,
  ActivityIndicator, Modal, ScrollView, Image, Linking, Share,
} from 'react-native';
import * as Notifications from 'expo-notifications';
import { Audio, Video, ResizeMode } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import {
  PinchGestureHandler, PanGestureHandler, State as GHState,
} from 'react-native-gesture-handler';
import { C, isRTL } from '../theme';
import { apiFetch, getSocket, getToken, getUsername, getAvatar, BASE_URL } from '../api';
import { audioManager } from '../audioManager';
import VoicePlayer from '../components/VoicePlayer';
import VoiceRecorder from '../components/VoiceRecorder';
import ZoomableImage from '../components/ZoomableImage';
import SwipeableMessage from '../components/SwipeableMessage';
import MusicPlayer from '../components/MusicPlayer';

// Show notifications even when app is foregrounded
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

type Message = {
  id: number; room_id: number; user_id: number; username: string; avatar?: string | null;
  type: string; content: string | null; file_path: string | null;
  file_name: string | null; edited: number; created_at: string; forwarded_from?: string | null;
  reply_to_id?: number | null; reply_username?: string | null;
  reply_content?: string | null; reply_type?: string | null;
};
type Reaction = { emoji: string; username: string; user_id: number };
type ReplyTo = { id: number; username: string; content: string | null; type: string };

const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','🤔','😍','👎','😡'];
const MESSAGES_PAGE_SIZE = 20;

export default function ChatScreen({ room, onBack, onOpenDM, onOpenProfile, initialJumpMsgId }: {
  room: { id: number; name: string; is_dm: number; other_username?: string; is_private?: number; created_by?: number };
  onBack: () => void;
  onOpenDM: (room: { id: number; name: string; is_dm: number; other_username?: string }) => void;
  onOpenProfile: () => void;
  initialJumpMsgId?: number | null;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<Record<number, Reaction[]>>({});
  const [text, setText] = useState('');
  const [me, setMe] = useState('');
  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  const [online, setOnline] = useState<string[]>([]);
  const [typing, setTyping] = useState<string[]>([]);
  const [recordingUsers, setRecordingUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showEmojiFor, setShowEmojiFor] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [showOnline, setShowOnline] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [forwardTargets, setForwardTargets] = useState<any[]>([]);
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [roomInfo, setRoomInfo] = useState<any>(null);
  const [inviteName, setInviteName] = useState('');
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [showScrollFab, setShowScrollFab] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const hasMoreOlderRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const [backStackSize, setBackStackSize] = useState(0);
  const flatListRef = useRef<FlatList>(null);
  const messagesRef = useRef<Message[]>([]);
  const visibleIdRef = useRef<number | null>(null);
  const isNearBottomRef = useRef(true);
  const jumpBackStackRef = useRef<Array<number | 'bottom'>>([]);
  const typingTimer = useRef<any>(null);
  const socketRef = useRef<any>(null);
  const meRef = useRef('');
  const title = room.is_dm ? (room.other_username || '') : room.name;

  // The FlatList is inverted (index 0 renders at the visual bottom), so the
  // latest message is on screen from the first frame with no scroll jump.
  const invertedMessages = React.useMemo(() => [...messages].reverse(), [messages]);

  const scrollBottom = useCallback(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  function scrollToId(messageId: number) {
    const index = messagesRef.current.findIndex(m => m.id === messageId);
    if (index === -1) return false;
    const invertedIndex = messagesRef.current.length - 1 - index;
    flatListRef.current?.scrollToIndex({ index: invertedIndex, animated: true, viewPosition: 0.5 });
    return true;
  }

  async function jumpToMessage(messageId: number) {
    // Target may be older than what's loaded — page backwards until we find it
    while (messagesRef.current.findIndex(m => m.id === messageId) === -1 && hasMoreOlderRef.current) {
      await loadOlderMessages();
    }
    if (messagesRef.current.findIndex(m => m.id === messageId) === -1) return;

    // Push where we came from so the FAB can walk back through each reply level
    jumpBackStackRef.current.push(isNearBottomRef.current ? 'bottom' : (visibleIdRef.current ?? 'bottom'));
    setBackStackSize(jumpBackStackRef.current.length);
    // Give freshly prepended rows a moment to render before scrolling
    setTimeout(() => scrollToId(messageId), 50);
    setHighlightId(messageId);
    setTimeout(() => setHighlightId(null), 1500);
  }

  function handleScrollFabPress() {
    const marker = jumpBackStackRef.current.pop();
    setBackStackSize(jumpBackStackRef.current.length);
    if (marker && marker !== 'bottom' && scrollToId(marker)) {
      setHighlightId(marker);
      setTimeout(() => setHighlightId(null), 1500);
      return;
    }
    scrollBottom();
  }

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems.length > 0) {
      visibleIdRef.current = viewableItems[0].item.id;
    }
  }).current;
  const viewabilityConfigRef = useRef({ itemVisiblePercentThreshold: 50 }).current;

  function onMessagesScroll(e: any) {
    // Inverted list: offset 0 == visual bottom (latest message)
    const nearBottom = e.nativeEvent.contentOffset.y < 80;
    isNearBottomRef.current = nearBottom;
    setShowScrollFab(!nearBottom);
  }

  async function loadOlderMessages() {
    if (loadingOlderRef.current || !hasMoreOlderRef.current || !messagesRef.current.length) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const oldestId = messagesRef.current[0].id;
    const older = await apiFetch(`/messages/${room.id}?before=${oldestId}`);
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    if (!Array.isArray(older) || !older.length) { hasMoreOlderRef.current = false; return; }
    hasMoreOlderRef.current = older.length >= MESSAGES_PAGE_SIZE;
    // Sync the ref immediately so callers awaiting this (e.g. reply backfill) see the new page
    messagesRef.current = [...older, ...messagesRef.current];
    setMessages(messagesRef.current);
  }

  const fabVisible = showScrollFab || backStackSize > 0;
  const fabIsBack = backStackSize > 0;

  // When a voice message finishes, auto-play the next voice message in this chat
  useEffect(() => {
    audioManager.setFinishHandler(finishedId => {
      const msgs = messagesRef.current;
      const idx = msgs.findIndex(m => m.id === finishedId);
      if (idx === -1) return;
      if (msgs[idx].type !== 'audio') return; // only chain voice messages
      const next = msgs.slice(idx + 1).find(m => m.type === 'audio');
      if (!next) return;
      audioManager.play(
        next.id,
        `${BASE_URL}${next.file_path}`,
        `🎙 ${next.username} · voice message`,
        room.id,
        room
      );
    });
    // Intentionally NOT cleared on unmount: playback continues in the mini
    // player after leaving the chat and should keep chaining voice messages.
  }, [room.id]);

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
      getAvatar().then(setMyAvatar);
      if (Array.isArray(msgs)) {
        setMessages(msgs);
        messagesRef.current = msgs;
        hasMoreOlderRef.current = msgs.length >= MESSAGES_PAGE_SIZE;
      }
      setLoading(false);
      if (initialJumpMsgId) setTimeout(() => jumpToMessage(initialJumpMsgId), 300);

      socketRef.current = sock;
      sock.emit('join_room', room.id);

      sock.on('message_received', (msg: Message) => {
        if (msg.room_id !== room.id) return;
        setMessages(prev => [...prev, msg]);
        if (isNearBottomRef.current) scrollBottom();
        // Show notification if message is from someone else
        if (msg.username !== meRef.current) {
          const body = msg.type === 'text' ? (msg.content || '') : msg.type === 'audio' ? '🎙 Voice message' : msg.type === 'image' ? '🖼 Image' : msg.type === 'video' ? '🎥 Video' : msg.type === 'music' ? '🎵 Audio file' : '📄 File';
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
      sock.on('user_recording', ({ username: u }: any) => {
        setRecordingUsers(prev => prev.includes(u) ? prev : [...prev, u]);
      });
      sock.on('user_stopped_recording', ({ username: u }: any) => {
        setRecordingUsers(prev => prev.filter(x => x !== u));
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
      socketRef.current?.off('user_recording');
      socketRef.current?.off('user_stopped_recording');
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
    setShowAttachMenu(false);
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled) return;
    uploadFile(res.assets[0].uri, res.assets[0].name, res.assets[0].mimeType || 'application/octet-stream');
  }

  async function pickFromGallery() {
    setShowAttachMenu(false);
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow access to your photo library.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All });
    if (res.canceled) return;
    const asset = res.assets[0];
    const isVideo = asset.type === 'video';
    uploadFile(asset.uri, isVideo ? 'video.mp4' : 'photo.jpg', isVideo ? 'video/mp4' : 'image/jpeg');
  }

  async function pickFromCamera(mode: 'photo' | 'video') {
    setShowAttachMenu(false);
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow camera access in Settings to use this feature.');
      return;
    }
    const res = mode === 'photo'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images })
      : await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Videos, videoMaxDuration: 60 });
    if (res.canceled) return;
    const asset = res.assets[0];
    if (mode === 'photo') uploadFile(asset.uri, 'photo.jpg', 'image/jpeg');
    else uploadFile(asset.uri, 'video.mp4', 'video/mp4');
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
    const type = mime.startsWith('image/') ? 'image'
      : mime.startsWith('video/') ? 'video'
      : mime.startsWith('audio/') ? 'music' : 'file';
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

  function startRecordingUI() {
    audioManager.stop(); // don't record over playing audio
    setRecording(true);
    socketRef.current?.emit('recording_start', { roomId: room.id });
  }

  function stopRecordingUI() {
    setRecording(false);
    socketRef.current?.emit('recording_stop', { roomId: room.id });
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
    // created_at is UTC ("YYYY-MM-DD HH:MM:SS"); mark it as such so it's
    // rendered in the device's local timezone
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function openDM(otherUsername: string) {
    if (otherUsername === me) return;
    setShowOnline(false);
    const users = await apiFetch('/users');
    if (!Array.isArray(users)) return;
    const other = users.find((u: any) => u.username === otherUsername);
    if (!other) return;
    const res = await apiFetch(`/dm/${other.id}`, 'POST');
    if (res.error) { Alert.alert('Error', res.error); return; }
    onOpenDM({ id: res.id, name: res.name, is_dm: 1, other_username: res.otherUsername || otherUsername });
  }

  async function saveImage() {
    if (!lightboxUrl) return;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to save images to your device.');
        return;
      }
      const localUri = FileSystem.cacheDirectory + `chatroom-${Date.now()}.jpg`;
      const { uri } = await FileSystem.downloadAsync(lightboxUrl, localUri);
      await MediaLibrary.saveToLibraryAsync(uri);
      Alert.alert('Saved', 'Image saved to your gallery.');
    } catch {
      Alert.alert('Error', 'Could not save the image.');
    }
  }

  const URL_RE = /(https?:\/\/[^\s]+)/g;

  function renderTextWithLinks(content: string) {
    const parts = content.split(URL_RE);
    return parts.map((part, i) =>
      URL_RE.test(part) && part.startsWith('http') ? (
        <Text key={i} style={s.link} onPress={() => handleLinkPress(part)}>{part}</Text>
      ) : (
        <Text key={i}>{part}</Text>
      )
    );
  }

  async function handleLinkPress(url: string) {
    // In-app room links join directly
    const m = /\/join\/(\d+)/.exec(url);
    if (m) {
      const info = await apiFetch(`/room-info/${m[1]}`);
      if (info.error) { Alert.alert('Cannot join', info.error); return; }
      onOpenDM({ id: info.id, name: info.name, is_dm: 0 });
      return;
    }
    Linking.openURL(url).catch(() => {});
  }

  async function openForwardPicker(msg: Message) {
    const [rooms, dms] = await Promise.all([apiFetch('/rooms'), apiFetch('/dm-rooms')]);
    const targets = [
      ...(Array.isArray(rooms) ? rooms.map((r: any) => ({ ...r, _label: `# ${r.name}` })) : []),
      ...(Array.isArray(dms) ? dms.map((d: any) => ({ ...d, _label: `💬 ${d.other_username}` })) : []),
    ];
    setForwardTargets(targets);
    setForwardMsg(msg);
  }

  function doForward(target: any) {
    if (!forwardMsg) return;
    socketRef.current?.emit('forward_message', { messageId: forwardMsg.id, toRoomId: target.id }, (res: any) => {
      if (res?.error) Alert.alert('Cannot forward', res.error);
    });
    setForwardMsg(null);
  }

  function acceptInvite(inviteContent: string | null) {
    let parsed: any = null;
    try { parsed = JSON.parse(inviteContent || ''); } catch {}
    if (!parsed?.roomId) return;
    socketRef.current?.emit('accept_invite', { roomId: parsed.roomId }, (res: any) => {
      if (res?.error) { Alert.alert('Cannot join', res.error); return; }
      onOpenDM({ id: res.room.id, name: res.room.name, is_dm: 0 });
    });
  }

  const roomLink = `${BASE_URL}/join/${room.id}`;

  function sendInvite() {
    const name = inviteName.trim();
    if (!name) return;
    socketRef.current?.emit('invite_to_room', { roomId: room.id, username: name }, (res: any) => {
      if (res?.error) Alert.alert('Invite failed', res.error);
      else { Alert.alert('Invitation sent', `${name} received an invite in their DMs.`); setInviteName(''); }
    });
  }

  function replyPreview(msg: Message): string {
    if (msg.reply_type === 'audio') return '🎙 Voice message';
    if (msg.reply_type === 'image') return '🖼 Image';
    if (msg.reply_type === 'video') return '🎥 Video';
    if (msg.reply_type === 'music') return '🎵 Audio file';
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
      <View
        style={[s.msgWrapper, mine ? s.mine : s.theirs]}
      >
        {!mine && (
          room.is_dm ? (
            <Text style={s.sender}>{msg.username}</Text>
          ) : (
            <TouchableOpacity style={s.senderChip} onPress={() => openDM(msg.username)} activeOpacity={0.6}>
              {msg.avatar ? (
                <Text style={s.senderAvatarEmoji}>{msg.avatar}</Text>
              ) : (
                <View style={s.senderAvatar}>
                  <Text style={s.senderAvatarText}>{msg.username.slice(0, 2).toUpperCase()}</Text>
                </View>
              )}
              <Text style={s.sender}>{msg.username}</Text>
            </TouchableOpacity>
          )
        )}
        <SwipeableMessage
          onSwipeRight={() => setReplyTo({ id: msg.id, username: msg.username, content: msg.content, type: msg.type })}
          onSwipeLeft={mine ? () => deleteMsg(msg.id) : undefined}
        >
        <TouchableOpacity
          style={[s.bubble, mine ? s.mineBubble : s.theirsBubble, highlightId === msg.id && s.bubbleHighlight]}
          onLongPress={() => setShowEmojiFor(msg.id)}
          activeOpacity={0.85}
        >
          {/* Reply quote */}
          {msg.reply_to_id && msg.reply_username && (
            <TouchableOpacity style={s.replyQuote} onPress={() => jumpToMessage(msg.reply_to_id!)}>
              <Text style={s.replyQuoteUser}>{msg.reply_username}</Text>
              <Text style={s.replyQuoteText} numberOfLines={1}>{replyPreview(msg)}</Text>
            </TouchableOpacity>
          )}

          {msg.forwarded_from ? (
            <Text style={s.forwardedLabel}>↪ Forwarded from {msg.forwarded_from}</Text>
          ) : null}
          {msg.type === 'text' && (
            <Text style={s.msgText}>{renderTextWithLinks(msg.content || '')}{msg.edited ? <Text style={s.edited}> (edited)</Text> : null}</Text>
          )}
          {msg.type === 'invite' && (() => {
            let inv: any = null;
            try { inv = JSON.parse(msg.content || ''); } catch {}
            return (
              <View style={s.inviteCard}>
                <Text style={s.inviteTitle}>🔒 Room invitation</Text>
                <Text style={s.inviteText}>{msg.username === me ? `You invited someone to` : `${msg.username} invited you to`} “{inv?.roomName || 'a room'}”</Text>
                {msg.username !== me && (
                  <TouchableOpacity style={s.inviteBtn} onPress={() => acceptInvite(msg.content)}>
                    <Text style={s.inviteBtnText}>Join room</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })()}
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
            <VoicePlayer url={`${BASE_URL}${msg.file_path}`} peaks={msg.file_name || ''} mine={mine} msgId={msg.id} roomId={room.id} roomMeta={room} label={`🎙 ${msg.username} · voice message`} />
          )}
          {msg.type === 'music' && (
            <MusicPlayer url={`${BASE_URL}${msg.file_path}`} fileName={msg.file_name || 'Audio'} mine={mine} msgId={msg.id} roomId={room.id} roomMeta={room} />
          )}
          {msg.type === 'video' && (
            <TouchableOpacity onPress={() => setVideoUrl(`${BASE_URL}${msg.file_path}`)}>
              <View style={s.videoThumb}>
                <Text style={s.videoPlayIcon}>▶</Text>
              </View>
            </TouchableOpacity>
          )}
          {msg.type === 'file' && (
            <Text style={s.fileLink}>📄 {msg.file_name || 'File'}</Text>
          )}
        </TouchableOpacity>
        </SwipeableMessage>

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
          <TouchableOpacity
            style={s.footerBtnTouch}
            onPress={() => setReplyTo({ id: msg.id, username: msg.username, content: msg.content, type: msg.type })}
          >
            <Text style={s.replyFooterBtn}>↩ Reply</Text>
          </TouchableOpacity>
          {msg.type !== 'invite' && (
            <TouchableOpacity style={s.footerBtnTouch} onPress={() => openForwardPicker(msg)}>
              <Text style={s.replyFooterBtn}>↪ Fwd</Text>
            </TouchableOpacity>
          )}
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
        <TouchableOpacity onPress={onBack} style={s.backBtn} activeOpacity={0.6}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}>
          <Text style={s.backText}>‹</Text>
          <Text style={s.backLabel}>Chats</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.headerCenter} activeOpacity={0.7}
          onPress={async () => {
            if (room.is_dm) return;
            setShowRoomInfo(true);
            const info = await apiFetch(`/room-info/${room.id}`);
            if (!info.error) setRoomInfo(info);
          }}>
          <View style={s.roomAvatar}>
            <Text style={s.roomAvatarText}>{room.is_dm ? '💬' : room.is_private ? '🔒' : '#'}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.headerTitle} numberOfLines={1}>{title}</Text>
            {room.is_dm ? (
              online.includes(room.other_username || '') ? (
                <Text style={s.headerSubtitle}>● online</Text>
              ) : null
            ) : online.length > 0 ? (
              <TouchableOpacity onPress={() => setShowOnline(true)} hitSlop={{ top: 6, bottom: 6 }}>
                <Text style={s.headerSubtitle}>● {online.length} online · tap to view</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={onOpenProfile} style={s.headerAvatar} activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          {myAvatar
            ? <Text style={s.headerAvatarEmoji}>{myAvatar}</Text>
            : <Text style={s.headerAvatarText}>{(me || '?').slice(0, 2).toUpperCase()}</Text>}
        </TouchableOpacity>
      </View>

      {/* Online users modal */}
      <Modal visible={showOnline} transparent animationType="slide" onRequestClose={() => setShowOnline(false)}>
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowOnline(false)}>
          <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={s.onlineSheet}>
            <View style={s.sheetHandle} />
            <View style={s.onlineSheetHeader}>
              <Text style={s.onlineSheetTitle}>Online Now</Text>
              <TouchableOpacity onPress={() => setShowOnline(false)}>
                <Text style={s.onlineSheetClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.onlinePanelTitle}>Tap a person to start a direct message</Text>
            {online.filter(u => u !== me).length === 0 ? (
              <Text style={s.onlineEmpty}>No one else is online right now</Text>
            ) : (
              <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
                {online.filter(u => u !== me).map(u => (
                  <TouchableOpacity key={u} style={s.onlineUserRow} onPress={() => openDM(u)} activeOpacity={0.6}>
                    <View style={s.onlineAvatar}>
                      <Text style={s.onlineAvatarText}>{u.slice(0, 2).toUpperCase()}</Text>
                      <View style={s.onlineAvatarDot} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.onlineUser}>{u}</Text>
                      <Text style={s.onlineUserSub}>Active now</Text>
                    </View>
                    <Text style={s.onlineUserChevron}>💬</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Image lightbox */}
      <Modal visible={!!lightboxUrl} transparent animationType="fade" onRequestClose={() => setLightboxUrl(null)}>
        <View style={s.lightboxOverlay}>
          <TouchableOpacity onPress={() => setLightboxUrl(null)} style={s.lightboxClose}>
            <Text style={s.lightboxCloseText}>✕</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={saveImage} style={s.lightboxSave}>
            <Text style={s.lightboxCloseText}>⬇</Text>
          </TouchableOpacity>
          {lightboxUrl && <ZoomableImage uri={lightboxUrl} />}
        </View>
      </Modal>

      {/* Video player */}
      <Modal visible={!!videoUrl} transparent animationType="fade" onRequestClose={() => setVideoUrl(null)}>
        <View style={s.lightboxOverlay}>
          <TouchableOpacity onPress={() => setVideoUrl(null)} style={s.lightboxClose}>
            <Text style={s.lightboxCloseText}>✕</Text>
          </TouchableOpacity>
          {videoUrl && (
            <Video
              source={{ uri: videoUrl }}
              style={s.videoFullscreen}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
            />
          )}
        </View>
      </Modal>

      {/* Messages */}
      {loading ? (
        <View style={s.loadingContainer}>
          <ActivityIndicator color={C.accent} size="large" />
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={invertedMessages}
          inverted
          keyExtractor={m => String(m.id)}
          renderItem={renderMessage}
          contentContainerStyle={s.messagesList}
          onScroll={onMessagesScroll}
          scrollEventThrottle={100}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfigRef}
          onEndReached={loadOlderMessages}
          onEndReachedThreshold={1.5}
          ListFooterComponent={loadingOlder ? (
            <ActivityIndicator color={C.accent} size="small" style={{ marginVertical: 10 }} />
          ) : null}
          onScrollToIndexFailed={info => {
            setTimeout(() => {
              flatListRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
            }, 100);
          }}
        />
      )}

      {fabVisible && (
        <TouchableOpacity style={s.scrollFab} onPress={handleScrollFabPress}>
          <Text style={s.scrollFabIcon}>{fabIsBack ? '↩' : '↓'}</Text>
        </TouchableOpacity>
      )}

      {/* Recording / typing indicator (recording takes priority) */}
      {recordingUsers.filter(u => u !== me).length > 0 ? (
        <Text style={s.recordingBar}>🎙 {recordingUsers.filter(u => u !== me).join(', ')} is recording…</Text>
      ) : typing.filter(u => u !== me).length > 0 ? (
        <Text style={s.typingBar}>{typing.filter(u => u !== me).join(', ')} is typing…</Text>
      ) : null}

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
              {replyTo.type === 'audio' ? '🎙 Voice message' : replyTo.type === 'image' ? '🖼 Image' : replyTo.type === 'video' ? '🎥 Video' : replyTo.type === 'music' ? '🎵 Audio file' : replyTo.type === 'file' ? '📄 File' : (replyTo.content || '')}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyTo(null)}>
            <Text style={s.editClose}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Attach menu */}
      <Modal visible={showAttachMenu} transparent animationType="slide" onRequestClose={() => setShowAttachMenu(false)}>
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowAttachMenu(false)}>
          <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={s.attachSheet}>
            <View style={s.sheetHandle} />
            <TouchableOpacity style={s.attachOption} onPress={() => pickFromCamera('photo')}>
              <Text style={s.attachOptionIcon}>📷</Text>
              <Text style={s.attachOptionText}>Take Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.attachOption} onPress={() => pickFromCamera('video')}>
              <Text style={s.attachOptionIcon}>🎥</Text>
              <Text style={s.attachOptionText}>Record Video</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.attachOption} onPress={pickFromGallery}>
              <Text style={s.attachOptionIcon}>🖼</Text>
              <Text style={s.attachOptionText}>Photo & Video Library</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.attachOption} onPress={pickFile}>
              <Text style={s.attachOptionIcon}>📄</Text>
              <Text style={s.attachOptionText}>Choose File</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.attachCancel} onPress={() => setShowAttachMenu(false)}>
              <Text style={s.attachCancelText}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Forward picker */}
      <Modal visible={!!forwardMsg} transparent animationType="slide" onRequestClose={() => setForwardMsg(null)}>
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setForwardMsg(null)}>
          <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={s.attachSheet}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>Forward to…</Text>
            <ScrollView style={{ maxHeight: 380 }}>
              {forwardTargets.map(t => (
                <TouchableOpacity key={`${t.is_dm ? 'd' : 'r'}${t.id}`} style={s.attachOption} onPress={() => doForward(t)}>
                  <Text style={s.attachOptionText}>{t._label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.attachCancel} onPress={() => setForwardMsg(null)}>
              <Text style={s.attachCancelText}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Room dashboard */}
      <Modal visible={showRoomInfo} transparent animationType="slide" onRequestClose={() => setShowRoomInfo(false)}>
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowRoomInfo(false)}>
          <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={[s.attachSheet, { maxHeight: '85%' }]}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>{(roomInfo?.is_private ?? room.is_private) ? '🔒 ' : '# '}{room.name}</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={s.roomLinkBox}>
                <View style={s.roomMetaRow}>
                  <Text style={s.roomMetaLabel}>TYPE</Text>
                  <Text style={s.roomMetaValue}>{(roomInfo?.is_private ?? room.is_private) ? 'Private room' : 'Public room'}</Text>
                </View>
                <View style={s.roomMetaRow}>
                  <Text style={s.roomMetaLabel}>OWNER</Text>
                  <Text style={s.roomMetaValue}>
                    {roomInfo ? `${roomInfo.owner_avatar ? roomInfo.owner_avatar + ' ' : ''}${roomInfo.owner_username || 'unknown'}` : '…'}
                  </Text>
                </View>
                <View style={s.roomMetaRow}>
                  <Text style={s.roomMetaLabel}>CREATED</Text>
                  <Text style={s.roomMetaValue}>
                    {roomInfo?.created_at
                      ? new Date(roomInfo.created_at.includes('T') ? roomInfo.created_at : roomInfo.created_at.replace(' ', 'T') + 'Z')
                          .toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })
                      : '…'}
                  </Text>
                </View>
              </View>

              {!(roomInfo?.is_private ?? room.is_private) && (
                <View style={s.roomLinkBox}>
                  <Text style={s.roomLinkLabel}>ROOM LINK · SHARE TO INVITE</Text>
                  <Text style={s.roomLinkText} selectable>{roomLink}</Text>
                  <TouchableOpacity style={s.shareBtn} onPress={() => Share.share({ message: roomLink })}>
                    <Text style={s.shareBtnText}>Share link</Text>
                  </TouchableOpacity>
                </View>
              )}

              {!!roomInfo?.is_private && Array.isArray(roomInfo.members) && (
                <View style={s.roomLinkBox}>
                  <Text style={s.roomLinkLabel}>MEMBERS ({roomInfo.members.length})</Text>
                  {roomInfo.members.map((m: any) => (
                    <View key={m.username} style={s.memberRow}>
                      <Text style={s.memberName}>{m.avatar ? m.avatar + ' ' : ''}{m.username}</Text>
                      {m.username === roomInfo.owner_username && <Text style={s.memberOwnerTag}>owner</Text>}
                    </View>
                  ))}
                </View>
              )}

              {!!roomInfo?.is_private && !!roomInfo?.is_owner && (
                <View style={s.roomLinkBox}>
                  <Text style={s.roomLinkLabel}>ADD MEMBER</Text>
                  <TextInput
                    style={s.inviteInput} placeholder="Username to invite" placeholderTextColor={C.muted}
                    value={inviteName} onChangeText={setInviteName} autoCapitalize="none"
                    onSubmitEditing={sendInvite}
                  />
                  <TouchableOpacity style={s.shareBtn} onPress={sendInvite}>
                    <Text style={s.shareBtnText}>Send invitation</Text>
                  </TouchableOpacity>
                  <Text style={s.inviteHint}>The user gets an invitation in their DMs and joins once they accept.</Text>
                </View>
              )}
            </ScrollView>
            <TouchableOpacity style={s.attachCancel} onPress={() => setShowRoomInfo(false)}>
              <Text style={s.attachCancelText}>Close</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Voice recorder or input bar */}
      {recording ? (
        <VoiceRecorder
          onCancel={() => stopRecordingUI()}
          onSend={(uri, peaks) => { stopRecordingUI(); sendVoice(uri, peaks); }}
        />
      ) : (
        <View style={s.inputBar}>
          <TouchableOpacity onPress={() => setShowAttachMenu(true)} style={s.iconBtn}>
            <Text style={s.iconBtnText}>📎</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => startRecordingUI()} style={s.iconBtn}>
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
  backBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingRight: 6 },
  backText: { color: C.accent, fontSize: 28, lineHeight: 30, marginTop: -2 },
  backLabel: { color: C.accent, fontSize: 15, fontWeight: '600' },
  headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  roomAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  roomAvatarText: { fontSize: 15, color: C.accent, fontWeight: '700' },
  headerSubtitle: { color: C.online, fontSize: 11.5, marginTop: 1 },
  headerAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  headerAvatarText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  headerAvatarEmoji: { fontSize: 18 },
  headerTitle: { color: C.text, fontWeight: '600', fontSize: 16 },
  onlineBadge: { flexDirection: 'row', alignItems: 'center', gap: 2, backgroundColor: 'rgba(74,222,128,0.15)', borderWidth: 1, borderColor: C.online, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  onlineText: { color: C.online, fontSize: 12, fontWeight: '600' },
  onlineChevron: { color: C.online, fontSize: 14, fontWeight: '700', marginLeft: 1 },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messagesList: { padding: 12, gap: 6 },
  msgWrapper: { maxWidth: '80%', marginVertical: 2 },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  theirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  sender: { fontSize: 11.5, color: C.accent, fontWeight: '700' },
  senderChip: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 3, paddingHorizontal: 4, paddingVertical: 2 },
  senderAvatar: { width: 16, height: 16, borderRadius: 8, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  senderAvatarText: { color: '#fff', fontSize: 8, fontWeight: '700' },
  senderAvatarEmoji: { fontSize: 13 },
  bubble: { borderRadius: 12, padding: 10, maxWidth: '100%' },
  bubbleHighlight: { borderWidth: 2, borderColor: C.accent },
  mineBubble: { backgroundColor: C.mine, borderBottomRightRadius: 3 },
  theirsBubble: { backgroundColor: C.msgBg, borderBottomLeftRadius: 3 },
  msgText: { color: C.text, fontSize: 15, lineHeight: 21 },
  edited: { color: C.muted, fontSize: 11 },
  fileLink: { color: '#93c5fd', fontSize: 14 },
  msgImage: { width: 200, height: 180, borderRadius: 10 },
  videoThumb: { width: 200, height: 140, borderRadius: 10, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  videoPlayIcon: { color: '#fff', fontSize: 30 },
  videoFullscreen: { width: '100%', height: '70%' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, paddingHorizontal: 4 },
  time: { color: C.muted, fontSize: 11 },
  footerBtn: { fontSize: 14, opacity: 0.6 },
  footerBtnTouch: { paddingVertical: 2, paddingHorizontal: 4 },
  replyFooterBtn: { fontSize: 12, color: C.accent, fontWeight: '600' },
  reactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactChip: { backgroundColor: C.inputBg, borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  reactMine: { borderColor: C.accent, backgroundColor: 'rgba(82,136,193,0.15)' },
  reactText: { fontSize: 13, color: C.text },
  emojiPicker: { flexDirection: 'row', backgroundColor: C.sidebar, borderRadius: 12, padding: 6, borderWidth: 1, borderColor: C.border, marginTop: 4 },
  emojiBtn: { padding: 6 },
  emoji: { fontSize: 22 },
  typingBar: { color: C.success, fontSize: 12, textAlign: 'center', paddingVertical: 4, paddingHorizontal: 12 },
  recordingBar: { color: C.danger, fontSize: 12, textAlign: 'center', paddingVertical: 4, paddingHorizontal: 12, fontWeight: '600' },
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
  input: { flex: 1, backgroundColor: C.inputBg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, color: C.text, fontSize: 15, borderWidth: 1, borderColor: C.border, maxHeight: 120, textAlign: isRTL ? 'right' : 'left' },
  sendBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  sendBtnText: { color: '#fff', fontSize: 16 },
  scrollFab: {
    position: 'absolute', end: 16, bottom: 90, width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  scrollFabIcon: { color: '#fff', fontSize: 18, fontWeight: '700' },
  lightboxOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  attachSheet: { backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 24 },
  attachOption: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 22, paddingVertical: 14 },
  attachOptionIcon: { fontSize: 22, width: 28, textAlign: 'center' },
  attachOptionText: { color: C.text, fontSize: 16, fontWeight: '500' },
  attachCancel: { marginTop: 8, marginHorizontal: 16, backgroundColor: C.inputBg, borderRadius: 12, padding: 14, alignItems: 'center' },
  attachCancelText: { color: C.muted, fontSize: 15, fontWeight: '600' },
  forwardTitle: { color: C.text, fontWeight: '700', fontSize: 16, paddingHorizontal: 20, paddingVertical: 10 },
  link: { color: C.accent, textDecorationLine: 'underline' },
  forwardedLabel: { color: C.muted, fontSize: 11, fontStyle: 'italic', marginBottom: 4 },
  inviteCard: { gap: 6, minWidth: 200 },
  inviteTitle: { color: C.text, fontWeight: '700', fontSize: 14 },
  inviteText: { color: C.muted, fontSize: 13 },
  inviteBtn: { backgroundColor: C.accent, borderRadius: 8, paddingVertical: 8, alignItems: 'center', marginTop: 4 },
  inviteBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  roomLinkBox: { marginHorizontal: 20, marginBottom: 10, gap: 8 },
  roomLinkLabel: { color: C.muted, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5 },
  roomLinkText: { color: C.accent, fontSize: 13, backgroundColor: C.inputBg, borderRadius: 8, padding: 10 },
  shareBtn: { backgroundColor: C.accent, borderRadius: 10, padding: 12, alignItems: 'center' },
  shareBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  inviteInput: { backgroundColor: C.inputBg, borderRadius: 8, padding: 10, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.border },
  inviteHint: { color: C.muted, fontSize: 11.5 },
  roomMetaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.border },
  roomMetaLabel: { color: C.muted, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5 },
  roomMetaValue: { color: C.text, fontSize: 13.5, fontWeight: '600' },
  memberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  memberName: { color: C.text, fontSize: 14 },
  memberOwnerTag: { color: C.accent, fontSize: 11, fontWeight: '700', backgroundColor: 'rgba(59,125,216,0.1)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  lightboxClose: { position: 'absolute', top: 50, end: 20, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  lightboxSave: { position: 'absolute', top: 50, end: 68, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
  lightboxCloseText: { color: '#fff', fontSize: 18 },
  lightboxImage: { width: '100%', height: '85%' },
  onlineSheet: { backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 24, maxHeight: '75%' },
  onlineSheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 6 },
  onlineSheetTitle: { color: C.text, fontWeight: '700', fontSize: 17 },
  onlineSheetClose: { color: C.muted, fontSize: 18, padding: 4 },
  onlinePanelTitle: { color: C.muted, fontSize: 12.5, paddingHorizontal: 20, marginBottom: 10 },
  onlineEmpty: { color: C.muted, fontSize: 13, paddingVertical: 20, textAlign: 'center' },
  onlineUserRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: C.border },
  onlineAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  onlineAvatarText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  onlineAvatarDot: { position: 'absolute', bottom: -1, end: -1, width: 12, height: 12, borderRadius: 6, backgroundColor: C.online, borderWidth: 2, borderColor: C.sidebar },
  onlineUser: { color: C.text, fontSize: 15, fontWeight: '600' },
  onlineUserSub: { color: C.online, fontSize: 11.5, marginTop: 1 },
  onlineUserChevron: { color: C.muted, fontSize: 18 },
});
