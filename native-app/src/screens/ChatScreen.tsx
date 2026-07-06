import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, Dimensions,
  ActivityIndicator, Modal, ScrollView, Image, Linking, Share, Pressable,
} from 'react-native';
import { Audio, Video, ResizeMode } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as Clipboard from 'expo-clipboard';
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

type Message = {
  id: number | string; room_id: number; user_id: number; username: string; avatar?: string | null;
  type: string; content: string | null; file_path: string | null;
  file_name: string | null; edited: number; created_at: string; forwarded_from?: string | null;
  reply_to_id?: number | null; reply_username?: string | null;
  reply_content?: string | null; reply_type?: string | null;
  client_id?: string;
  one_time_seconds?: number | null; viewed_at?: number | null;
  _uploading?: boolean; _uploadFailed?: boolean;
};
// Shows a spinner over the image until it finishes loading (download progress proxy).
function ImageWithSpinner({ uri, style, resizeMode, onLoaded }: { uri: string; style: any; resizeMode: 'cover' | 'contain'; onLoaded?: () => void }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <View>
      <Image
        source={{ uri }} style={style} resizeMode={resizeMode}
        onLoad={() => { setLoaded(true); onLoaded?.(); }}
        onError={() => setLoaded(true)}
      />
      {!loaded && (
        <View style={[style, { position: 'absolute', top: 0, left: 0, alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="small" color="#fff" />
        </View>
      )}
    </View>
  );
}

type Reaction = { emoji: string; username: string; user_id: number };
type ReplyTo = { id: number | string; username: string; content: string | null; type: string };

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
  const [editingId, setEditingId] = useState<number | string | null>(null);
  const [showEmojiFor, setShowEmojiFor] = useState<number | string | null>(null);
  const [recording, setRecording] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [showOnline, setShowOnline] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [maxOtherReadMsgId, setMaxOtherReadMsgId] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  // clientId -> uploaded file URL, so the server's echo can be matched back to
  // its optimistic bubble even when the server doesn't echo client_id.
  const pendingUploadPaths = useRef<Record<string, string>>({});
  const [oneTimeSecs, setOneTimeSecs] = useState<number | null>(null); // 🔥 applies to next message
  const [revealedOneTime, setRevealedOneTime] = useState<Set<number | string>>(new Set());
  const [showOneTimeMenu, setShowOneTimeMenu] = useState(false);
  const [actionsMsg, setActionsMsg] = useState<{ msg: Message; x: number; y: number } | null>(null); // tap menu for a message
  const [pendingMedia, setPendingMedia] = useState<{ uri: string; name: string; mime: string }[]>([]);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [forwardTargets, setForwardTargets] = useState<any[]>([]);
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [roomInfo, setRoomInfo] = useState<any>(null);
  const [inviteName, setInviteName] = useState('');
  const [highlightId, setHighlightId] = useState<number | string | null>(null);
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
      apiFetch(`/read-receipts/${room.id}`).then(receipts => {
        if (!mounted) return;
        if (receipts && typeof receipts === 'object' && !Array.isArray(receipts) && !receipts.error) {
          const vals = Object.values(receipts) as number[];
          setMaxOtherReadMsgId(vals.length ? Math.max(0, ...vals) : 0);
        }
      }).catch(() => {});
      if (Array.isArray(msgs)) {
        setMessages(msgs);
        messagesRef.current = msgs;
        hasMoreOlderRef.current = msgs.length >= MESSAGES_PAGE_SIZE;
        if (msgs.length) sock.emit('mark_read', { roomId: room.id, lastMsgId: msgs[msgs.length - 1].id });
      }
      setLoading(false);
      if (initialJumpMsgId) setTimeout(() => jumpToMessage(initialJumpMsgId), 300);

      socketRef.current = sock;
      sock.emit('join_room', room.id);

      sock.on('message_received', (msg: Message) => {
        if (msg.room_id !== room.id) return;
        // Reconcile our optimistic upload bubble with the server's echo.
        // Prefer the echoed client_id; fall back to matching the uploaded
        // file path (covers servers that don't echo client_id back).
        const pendingId = (msg.client_id && String(msg.client_id))
          || (msg.file_path
              && Object.keys(pendingUploadPaths.current).find(id => pendingUploadPaths.current[id] === msg.file_path))
          || null;
        if (pendingId) {
          delete pendingUploadPaths.current[pendingId];
          setUploadProgress(prev => {
            const { [pendingId]: _drop, ...rest } = prev;
            return rest;
          });
          setMessages(prev => {
            const idx = prev.findIndex(m => String(m.id) === pendingId);
            if (idx === -1) return [...prev, msg];
            const next = prev.slice();
            next[idx] = msg;
            return next;
          });
        } else {
          setMessages(prev => [...prev, msg]);
        }
        if (isNearBottomRef.current) scrollBottom();
        sock.emit('mark_read', { roomId: room.id, lastMsgId: msg.id });
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
      sock.on('messages_read', ({ roomId, lastReadMsgId }: any) => {
        if (roomId != room.id) return;
        setMaxOtherReadMsgId(prev => lastReadMsgId > prev ? lastReadMsgId : prev);
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
      socketRef.current?.off('messages_read');
    };
  }, [room.id]);

  function sendText() {
    if (pendingMedia.length && !editingId) {
      const items = pendingMedia;
      const caption = text.trim() || null;
      setPendingMedia([]);
      if (caption) { setText(''); emitStopTyping(); }
      items.forEach((m, i) => uploadFile(m.uri, m.name, m.mime, i === 0 ? caption : null));
      return;
    }
    const t = text.trim();
    if (!t || !socketRef.current) return;
    if (editingId) {
      socketRef.current.emit('edit_message', { messageId: editingId, content: t });
      setEditingId(null);
    } else {
      socketRef.current.emit('send_message', {
        roomId: room.id, type: 'text', content: t, replyToId: replyTo?.id ?? null,
        oneTimeSeconds: oneTimeSecs ?? undefined,
      });
      setOneTimeSecs(null);
    }
    setText('');
    setReplyTo(null);
    emitStopTyping();
  }

  function chooseOneTime(secs: number | null) {
    setOneTimeSecs(secs);
    setShowOneTimeMenu(false);
  }

  // The destruction clock starts when the content is actually available to
  // the viewer: immediately for text/files, on load for images, on first
  // play for voice/music/video.
  const oneTimeClockStarted = useRef<Set<number | string>>(new Set());
  function startOneTimeClock(msg: Message) {
    if (oneTimeClockStarted.current.has(msg.id)) return;
    oneTimeClockStarted.current.add(msg.id);
    socketRef.current?.emit('view_one_time', { messageId: msg.id });
  }

  function revealOneTime(msg: Message) {
    setRevealedOneTime(prev => new Set(prev).add(msg.id));
    if (msg.type === 'text' || msg.type === 'file') startOneTimeClock(msg);
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
    setPendingMedia(prev => [...prev, { uri: res.assets[0].uri, name: res.assets[0].name, mime: res.assets[0].mimeType || 'application/octet-stream' }]);
  }

  async function pickFromGallery() {
    setShowAttachMenu(false);
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow access to your photo library.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      allowsMultipleSelection: true,
      selectionLimit: 10,
    });
    if (res.canceled) return;
    setPendingMedia(prev => [...prev, ...res.assets.map((asset, i) => {
      const isVideo = asset.type === 'video';
      return { uri: asset.uri, name: isVideo ? `video-${i}.mp4` : `photo-${i}.jpg`, mime: isVideo ? 'video/mp4' : 'image/jpeg' };
    })]);
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
    if (mode === 'photo') setPendingMedia(prev => [...prev, { uri: asset.uri, name: 'photo.jpg', mime: 'image/jpeg' }]);
    else setPendingMedia(prev => [...prev, { uri: asset.uri, name: 'video.mp4', mime: 'video/mp4' }]);
  }

  // FileSystem.createUploadTask (unlike fetch) reports real progress events.
  async function uploadWithProgress(uri: string, name: string, mime: string, onProgress: (pct: number) => void) {
    const token = await getToken();
    const task = FileSystem.createUploadTask(
      `${BASE_URL}/upload`,
      uri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        mimeType: mime,
        parameters: {},
        headers: { Authorization: `Bearer ${token}` },
      },
      (data) => {
        if (data.totalBytesExpectedToSend > 0) {
          onProgress(Math.round((data.totalBytesSent / data.totalBytesExpectedToSend) * 100));
        }
      }
    );
    const result = await task.uploadAsync();
    if (!result || !result.body) throw new Error('Upload failed');
    return JSON.parse(result.body);
  }

  function addOptimisticMessage(clientId: string, type: string, localUri: string, fileName: string | null, replyToId: number | null, caption: string | null = null) {
    const optimistic: Message = {
      id: clientId, room_id: room.id, user_id: 0, username: me, avatar: myAvatar,
      type, content: caption, file_path: localUri, file_name: fileName,
      edited: 0, created_at: new Date().toISOString(),
      reply_to_id: replyToId, reply_username: replyTo?.username ?? null,
      reply_content: replyTo?.content ?? null, reply_type: replyTo?.type ?? null,
      _uploading: true,
    };
    setMessages(prev => [...prev, optimistic]);
    setUploadProgress(prev => ({ ...prev, [clientId]: 0 }));
    if (isNearBottomRef.current) setTimeout(scrollBottom, 50);
  }

  function markUploadFailed(clientId: string) {
    setUploadProgress(prev => { const { [clientId]: _d, ...rest } = prev; return rest; });
    setMessages(prev => prev.map(m => m.id === clientId ? { ...m, _uploading: false, _uploadFailed: true } : m));
  }

  async function uploadFile(uri: string, name: string, mime: string, caption: string | null = null) {
    const type = mime.startsWith('image/') ? 'image'
      : mime.startsWith('video/') ? 'video'
      : mime.startsWith('audio/') ? 'music' : 'file';
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const replyToId = replyTo?.id ?? null;
    const oneTime = oneTimeSecs ?? undefined;
    setOneTimeSecs(null);
    addOptimisticMessage(clientId, type, uri, name, replyToId, caption);
    setReplyTo(null);
    try {
      const res = await uploadWithProgress(uri, name, mime, pct => setUploadProgress(prev => ({ ...prev, [clientId]: pct })));
      if (res.error) throw new Error(res.error);
      pendingUploadPaths.current[clientId] = res.url;
      socketRef.current?.emit('send_message', {
        roomId: room.id, type, content: caption, filePath: res.url, fileName: name, replyToId, clientId, oneTimeSeconds: oneTime,
      });
    } catch {
      markUploadFailed(clientId);
    }
  }

  async function sendVoice(uri: string, peaks: number[]) {
    const peakStr = peaks.map(v => Math.round(v * 100)).join(',');
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const replyToId = replyTo?.id ?? null;
    const oneTime = oneTimeSecs ?? undefined;
    setOneTimeSecs(null);
    addOptimisticMessage(clientId, 'audio', uri, peakStr, replyToId);
    setReplyTo(null);
    try {
      const res = await uploadWithProgress(uri, `voice-${Date.now()}.m4a`, 'audio/m4a', pct => setUploadProgress(prev => ({ ...prev, [clientId]: pct })));
      if (res.error) throw new Error(res.error);
      pendingUploadPaths.current[clientId] = res.url;
      socketRef.current?.emit('send_message', {
        roomId: room.id, type: 'audio', filePath: res.url, fileName: peakStr, replyToId, clientId, oneTimeSeconds: oneTime,
      });
    } catch {
      markUploadFailed(clientId);
    }
  }

  async function downloadMedia(msg: Message) {
    if (!msg.file_path) return;
    try {
      const url = `${BASE_URL}${msg.file_path}`;
      const name = (msg.file_name && !msg.file_name.includes(',')) ? msg.file_name : msg.file_path.split('/').pop() || `file-${Date.now()}`;
      const local = FileSystem.cacheDirectory + name;
      const { uri } = await FileSystem.downloadAsync(url, local);
      if (msg.type === 'image' || msg.type === 'video') {
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status !== 'granted') { Alert.alert('Permission required', 'Allow media access to save downloads.'); return; }
        await MediaLibrary.saveToLibraryAsync(uri);
        Alert.alert('Saved', msg.type === 'image' ? 'Image saved to your gallery.' : 'Video saved to your gallery.');
      } else {
        Alert.alert('Downloaded', `Saved as ${name}`);
      }
    } catch {
      Alert.alert('Error', 'Download failed.');
    }
  }

  function retryUpload(msg: Message) {
    if (!msg.client_id && typeof msg.id !== 'string') return;
    const clientId = String(msg.id);
    setMessages(prev => prev.filter(m => m.id !== clientId));
    if (msg.type === 'audio') {
      const peaks = (msg.file_name || '').split(',').map(n => Number(n) / 100);
      sendVoice(msg.file_path!, peaks);
    } else {
      uploadFile(msg.file_path!, msg.file_name || 'file', msg.type === 'image' ? 'image/jpeg' : msg.type === 'video' ? 'video/mp4' : 'application/octet-stream');
    }
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

  function toggleReact(messageId: number | string, emoji: string) {
    socketRef.current?.emit('toggle_reaction', { messageId, emoji });
    setShowEmojiFor(null);
  }

  function deleteMsg(id: number | string) {
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

  // URLs (with or without protocol), card numbers, and phone numbers.
  const COPYABLE_RE = /(https?:\/\/[^\s]+|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?|(?:\d{4}[ -]?){3}\d{4}|\+?\d[\d ()-]{8,14}\d)/g;
  const isUrlToken = (t: string) => /^https?:\/\//.test(t) || /^(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/.test(t);

  // Each copyable token (link / phone / card number) gets a small inline 📋
  // right after it — no duplicated text below the message.
  function renderTextWithLinks(content: string) {
    const parts = content.split(COPYABLE_RE);
    return parts.map((part, i) => {
      if (!part) return null;
      COPYABLE_RE.lastIndex = 0;
      if (!COPYABLE_RE.test(part)) return <Text key={i}>{part}</Text>;
      COPYABLE_RE.lastIndex = 0;
      const url = isUrlToken(part);
      return (
        <Text key={i}>
          <Text
            style={url ? s.link : s.copyableNumber}
            onPress={url ? () => handleLinkPress(part) : undefined}
          >{part}</Text>
          <Text style={s.inlineCopy} onPress={() => Clipboard.setStringAsync(part.trim())}> 📋</Text>
        </Text>
      );
    });
  }

  async function handleLinkPress(url: string) {
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
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
    const hiddenOneTime = !!msg.one_time_seconds && !mine && !revealedOneTime.has(msg.id) && !msg._uploading;
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
            <View style={s.senderChip}>
              {msg.avatar ? (
                <Text style={s.senderAvatarEmoji}>{msg.avatar}</Text>
              ) : (
                <View style={s.senderAvatar}>
                  <Text style={s.senderAvatarText}>{msg.username.slice(0, 2).toUpperCase()}</Text>
                </View>
              )}
              <Text style={s.sender}>{msg.username}</Text>
            </View>
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
          onPress={(e) => !msg._uploading && setActionsMsg({ msg, x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })}
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
          {hiddenOneTime && (
            <TouchableOpacity onPress={() => revealOneTime(msg)}>
              <Text style={s.oneTimeReveal}>🔥 One-time message — tap to view ({msg.one_time_seconds}s)</Text>
            </TouchableOpacity>
          )}
          {!hiddenOneTime && msg.type === 'text' && (
            <Text style={s.msgText}>{renderTextWithLinks(msg.content || '')}{msg.edited ? <Text style={s.edited}> (edited)</Text> : null}{msg.one_time_seconds ? <Text style={s.oneTimeTag}> 🔥{msg.one_time_seconds}s</Text> : null}</Text>
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
          {!hiddenOneTime && msg.type === 'image' && (() => {
            const uri = msg._uploading ? msg.file_path! : `${BASE_URL}${msg.file_path}`;
            const onLoaded = msg.one_time_seconds && !mine ? () => startOneTimeClock(msg) : undefined;
            return (
              <TouchableOpacity onPress={() => !msg._uploading && setLightboxUrl(uri)} disabled={msg._uploading}>
                {msg._uploading
                  ? <Image source={{ uri }} style={s.msgImage} resizeMode="cover" />
                  : <ImageWithSpinner uri={uri} style={s.msgImage} resizeMode="cover" onLoaded={onLoaded} />}
              </TouchableOpacity>
            );
          })()}
          {!hiddenOneTime && msg.type === 'audio' && !msg._uploading && (
            <VoicePlayer url={`${BASE_URL}${msg.file_path}`} peaks={msg.file_name || ''} mine={mine} msgId={msg.id} roomId={room.id} roomMeta={room} label={`🎙 ${msg.username} · voice message`}
              onPlayStart={msg.one_time_seconds && !mine ? () => startOneTimeClock(msg) : undefined} />
          )}
          {msg.type === 'audio' && msg._uploading && (
            <View style={s.uploadingVoicePlaceholder}>
              <Text style={s.uploadingVoiceText}>🎙 Voice message</Text>
            </View>
          )}
          {!hiddenOneTime && msg.type === 'music' && !msg._uploading && (
            <MusicPlayer url={`${BASE_URL}${msg.file_path}`} fileName={msg.file_name || 'Audio'} mine={mine} msgId={msg.id} roomId={room.id} roomMeta={room}
              onPlayStart={msg.one_time_seconds && !mine ? () => startOneTimeClock(msg) : undefined} />
          )}
          {!hiddenOneTime && msg.type === 'video' && (() => {
            const uri = msg._uploading ? msg.file_path! : `${BASE_URL}${msg.file_path}`;
            return (
              <TouchableOpacity
                onPress={() => {
                  if (msg._uploading) return;
                  setVideoUrl(uri);
                  if (msg.one_time_seconds && !mine) startOneTimeClock(msg);
                }}
                disabled={msg._uploading}
              >
                <View style={s.videoThumb}>
                  <Text style={s.videoPlayIcon}>▶</Text>
                </View>
              </TouchableOpacity>
            );
          })()}
          {!hiddenOneTime && (msg.type === 'file' || (msg.type === 'music' && msg._uploading)) && (
            <Text style={s.fileLink}>📄 {msg.file_name || 'File'}</Text>
          )}
          {!hiddenOneTime && msg.type !== 'text' && msg.type !== 'invite' && msg.content ? (
            <Text style={[s.msgText, s.caption]}>{renderTextWithLinks(msg.content)}</Text>
          ) : null}
          {msg._uploading && (
            <View style={s.uploadOverlay}>
              <View style={[s.uploadProgressBar, { width: `${uploadProgress[String(msg.id)] ?? 0}%` }]} />
            </View>
          )}
          {msg._uploadFailed && (
            <TouchableOpacity onPress={() => retryUpload(msg)}>
              <Text style={s.uploadRetryText}>⚠️ Failed to send — tap to retry</Text>
            </TouchableOpacity>
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
          {mine && !msg._uploading && !msg._uploadFailed && (
            <Text style={[s.ticks, msg.id <= maxOtherReadMsgId && s.ticksSeen]}>
              {msg.id <= maxOtherReadMsgId ? '✓✓' : '✓'}
            </Text>
          )}
          {!msg._uploading && !msg._uploadFailed && (
            <TouchableOpacity onPress={() => setShowEmojiFor(msg.id)}>
              <Text style={s.footerBtn}>😊</Text>
            </TouchableOpacity>
          )}
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
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowOnline(false)} />
          <View style={s.onlineSheet}>
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
              <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false} nestedScrollEnabled>
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
          </View>
        </View>
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
          extraData={[maxOtherReadMsgId, uploadProgress, reactions, showEmojiFor, highlightId, online, revealedOneTime]}
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
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowAttachMenu(false)} />
          <View style={s.attachSheet}>
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
          </View>
        </View>
      </Modal>

      {/* Message actions: minimal popover near the tapped message; closes on outside tap */}
      <Modal visible={!!actionsMsg} transparent animationType="fade" onRequestClose={() => setActionsMsg(null)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setActionsMsg(null)}>
          {actionsMsg && (() => {
            const { msg: m, x, y } = actionsMsg;
            const mineMsg = m.username === me;
            const hidden = !!m.one_time_seconds && !mineMsg && !revealedOneTime.has(m.id);
            const win = Dimensions.get('window');
            const MENU_W = 165;
            const items = 1
              + ((m.type === 'text' || m.file_path) && !hidden ? 1 : 0)
              + (m.type !== 'invite' && !m.one_time_seconds ? 1 : 0)
              + (m.file_path && !hidden ? 1 : 0)
              + (mineMsg && m.type === 'text' ? 1 : 0)
              + (mineMsg ? 1 : 0);
            const menuH = items * 42 + 8;
            const left = Math.max(8, Math.min(x - MENU_W / 2, win.width - MENU_W - 8));
            const top = Math.max(60, Math.min(y + 8, win.height - menuH - 16));
            return (
              <View style={[s.actionsMenu, { position: 'absolute', left, top, width: MENU_W }]} onStartShouldSetResponder={() => true}>
                <TouchableOpacity style={s.actionItem} onPress={() => {
                  setActionsMsg(null);
                  setReplyTo({ id: m.id, username: m.username, content: m.content, type: m.type });
                }}>
                  <Text style={s.actionText}>↩  Reply</Text>
                </TouchableOpacity>
                {(m.type === 'text' || m.file_path) && !hidden && (
                  <TouchableOpacity style={s.actionItem} onPress={() => {
                    const t = m.type === 'text' ? (m.content || '') : `${BASE_URL}${m.file_path}`;
                    if (t) Clipboard.setStringAsync(t);
                    setActionsMsg(null);
                  }}>
                    <Text style={s.actionText}>📋  Copy</Text>
                  </TouchableOpacity>
                )}
                {m.type !== 'invite' && !m.one_time_seconds && (
                  <TouchableOpacity style={s.actionItem} onPress={() => { setActionsMsg(null); openForwardPicker(m); }}>
                    <Text style={s.actionText}>↪  Forward</Text>
                  </TouchableOpacity>
                )}
                {m.file_path && !hidden && (
                  <TouchableOpacity style={s.actionItem} onPress={() => { setActionsMsg(null); downloadMedia(m); }}>
                    <Text style={s.actionText}>⬇  Download</Text>
                  </TouchableOpacity>
                )}
                {mineMsg && m.type === 'text' && (
                  <TouchableOpacity style={s.actionItem} onPress={() => {
                    setActionsMsg(null);
                    setText(m.content || ''); setEditingId(m.id);
                  }}>
                    <Text style={s.actionText}>✏️  Edit</Text>
                  </TouchableOpacity>
                )}
                {mineMsg && (
                  <TouchableOpacity style={s.actionItem} onPress={() => { setActionsMsg(null); deleteMsg(m.id); }}>
                    <Text style={[s.actionText, { color: '#f87171' }]}>🗑  Delete</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })()}
        </Pressable>
      </Modal>

      {/* One-time message duration picker */}
      <Modal visible={showOneTimeMenu} transparent animationType="slide" onRequestClose={() => setShowOneTimeMenu(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowOneTimeMenu(false)} />
          <View style={s.attachSheet}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>🔥 One-time message</Text>
            <Text style={s.oneTimeHint}>The next message disappears this many seconds after being opened:</Text>
            {[5, 30, 60].map(secs => (
              <TouchableOpacity key={secs} style={s.attachOption} onPress={() => chooseOneTime(secs)}>
                <Text style={s.attachOptionText}>{secs} seconds{oneTimeSecs === secs ? '  ✓' : ''}</Text>
              </TouchableOpacity>
            ))}
            {oneTimeSecs ? (
              <TouchableOpacity style={s.attachOption} onPress={() => chooseOneTime(null)}>
                <Text style={[s.attachOptionText, { color: '#f87171' }]}>Turn off</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={s.attachCancel} onPress={() => setShowOneTimeMenu(false)}>
              <Text style={s.attachCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Forward picker */}
      <Modal visible={!!forwardMsg} transparent animationType="slide" onRequestClose={() => setForwardMsg(null)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setForwardMsg(null)} />
          <View style={s.attachSheet}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>Forward to…</Text>
            <ScrollView style={{ maxHeight: 380 }} nestedScrollEnabled>
              {forwardTargets.map(t => (
                <TouchableOpacity key={`${t.is_dm ? 'd' : 'r'}${t.id}`} style={s.attachOption} onPress={() => doForward(t)}>
                  <Text style={s.attachOptionText}>{t._label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.attachCancel} onPress={() => setForwardMsg(null)}>
              <Text style={s.attachCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Room dashboard */}
      <Modal visible={showRoomInfo} transparent animationType="slide" onRequestClose={() => setShowRoomInfo(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowRoomInfo(false)} />
          <View style={[s.attachSheet, { maxHeight: '85%' }]}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>{(roomInfo?.is_private ?? room.is_private) ? '🔒 ' : '# '}{room.name}</Text>
            <ScrollView showsVerticalScrollIndicator={false} nestedScrollEnabled>
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

              {Array.isArray(roomInfo?.members) && roomInfo.members.length > 0 && (
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
          </View>
        </View>
      </Modal>

      {/* Voice recorder or input bar */}
      {recording ? (
        <VoiceRecorder
          onCancel={() => stopRecordingUI()}
          onSend={(uri, peaks) => { stopRecordingUI(); sendVoice(uri, peaks); }}
        />
      ) : (
        <View>
          {/* Options strip: always pinned on top of the input bar. Media
              picked while text is present is ONE message (caption). */}
          <View style={s.optionsStrip}>
            <TouchableOpacity style={s.stripBtn} onPress={() => setShowAttachMenu(true)}>
              <Text style={s.stripBtnText}>📎 Media</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.stripBtn} onPress={() => startRecordingUI()}>
              <Text style={s.stripBtnText}>🎙 Voice</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.stripBtn, oneTimeSecs ? s.oneTimeActive : null]} onPress={() => setShowOneTimeMenu(true)}>
              <Text style={s.stripBtnText}>🔥 One-time{oneTimeSecs ? ` ${oneTimeSecs}s` : ''}</Text>
            </TouchableOpacity>
          </View>
          {pendingMedia.length > 0 && (
            <View style={s.pendingMediaBar}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
                {pendingMedia.map((m, i) => (
                  <View key={`${m.uri}-${i}`} style={s.pendingMediaItem}>
                    <TouchableOpacity onPress={() => m.mime.startsWith('image/') && setLightboxUrl(m.uri)}>
                      {m.mime.startsWith('image/') ? (
                        <Image source={{ uri: m.uri }} style={s.pendingMediaThumb} />
                      ) : (
                        <View style={[s.pendingMediaThumb, s.pendingMediaFile]}>
                          <Text style={s.pendingMediaIcon}>{m.mime.startsWith('video/') ? '🎥' : '📄'}</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity style={s.pendingMediaRemove} onPress={() => setPendingMedia(prev => prev.filter((_, j) => j !== i))}>
                      <Text style={s.pendingMediaRemoveText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                <TouchableOpacity style={[s.pendingMediaThumb, s.pendingMediaFile]} onPress={() => setShowAttachMenu(true)}>
                  <Text style={s.pendingMediaIcon}>＋</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          )}
          <View style={s.inputBar}>
            <TextInput
              style={s.input} placeholder={pendingMedia.length ? 'Add a caption…' : 'Message...'} placeholderTextColor={C.muted}
              value={text} onChangeText={t => { setText(t); emitTyping(); }}
              onSubmitEditing={sendText} blurOnSubmit={false} multiline
            />
            <TouchableOpacity style={s.sendBtn} onPress={sendText}>
              <Text style={s.sendBtnText}>➤</Text>
            </TouchableOpacity>
          </View>
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
  sender: { fontSize: 12, color: C.accent, fontWeight: '700' },
  senderChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20,
    backgroundColor: 'rgba(59,125,216,0.1)',
  },
  senderAvatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  senderAvatarText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  senderAvatarEmoji: {
    fontSize: 14, width: 20, height: 20, textAlign: 'center', lineHeight: 20,
    borderRadius: 10, backgroundColor: 'rgba(59,125,216,0.16)', overflow: 'hidden',
  },
  bubble: { borderRadius: 12, padding: 10, maxWidth: '100%', overflow: 'hidden' },
  uploadOverlay: { height: 3, backgroundColor: 'rgba(255,255,255,0.25)', marginTop: 6, borderRadius: 2, overflow: 'hidden' },
  uploadProgressBar: { height: '100%', backgroundColor: C.accent },
  uploadRetryText: { color: '#f87171', fontSize: 12, marginTop: 6, textDecorationLine: 'underline' },
  uploadingVoicePlaceholder: { paddingVertical: 4 },
  uploadingVoiceText: { color: C.text, fontSize: 14, opacity: 0.7 },
  oneTimeReveal: { color: '#f87171', fontSize: 14, fontWeight: '600', paddingVertical: 4 },
  oneTimeTag: { color: '#f87171', fontSize: 11 },
  oneTimeActive: { backgroundColor: 'rgba(248,113,113,0.25)', borderRadius: 8 },
  oneTimeHint: { color: C.muted, fontSize: 13, paddingHorizontal: 16, paddingBottom: 8 },
  plusBtnText: { fontSize: 22, color: C.accent, fontWeight: '600' },
  caption: { marginTop: 6 },
  optionsStrip: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: C.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(128,128,128,0.25)',
  },
  stripBtn: {
    backgroundColor: 'rgba(59,125,216,0.10)', borderRadius: 16,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  stripBtnText: { color: C.accent, fontSize: 13, fontWeight: '600' },
  actionsMenu: {
    backgroundColor: C.msgBg, borderRadius: 12, paddingVertical: 4,
    elevation: 6, shadowColor: '#000', shadowOpacity: 0.2,
    shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
  },
  actionItem: { paddingHorizontal: 14, paddingVertical: 10 },
  actionText: { color: C.text, fontSize: 14, fontWeight: '600' },
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
  copyableNumber: { color: C.accent, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  inlineCopy: { fontSize: 13 },
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
  ticks: { color: C.muted, fontSize: 12, letterSpacing: -2, marginRight: -2 },
  ticksSeen: { color: '#4fc3f7' },
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
