import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, Dimensions,
  ActivityIndicator, Modal, ScrollView, Image, Linking, Share, Pressable, AppState,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio, Video, ResizeMode } from 'expo-av';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as Clipboard from 'expo-clipboard';
import * as IntentLauncher from 'expo-intent-launcher';
import * as ScreenCapture from 'expo-screen-capture';
import {
  PinchGestureHandler, PanGestureHandler, State as GHState, GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { C, isRTL } from '../theme';
import { apiFetch, getSocket, getToken, getUsername, getAvatar, BASE_URL, ensureSocketAlive } from '../api';
import { e2eReady, e2eDMPeerKey, e2eEncrypt, e2eDecrypt, e2eIsEncrypted, e2eSetup, e2eVerifyIdentity } from '../e2e';
import { callManager } from '../callManager';
import { audioManager } from '../audioManager';
import VoicePlayer from '../components/VoicePlayer';
import VoiceRecorder from '../components/VoiceRecorder';
import { Ionicons } from '@expo/vector-icons';
import Composer, { ComposerHandle } from '../components/Composer';
import AwesomeGallery from 'react-native-awesome-gallery';
import GalleryGrid from '../components/GalleryGrid';
import ImageWithSpinner from '../components/ImageWithSpinner';
import SwipeableMessage from '../components/SwipeableMessage';
import MusicPlayer from '../components/MusicPlayer';
import FullMusicPlayer from '../components/FullMusicPlayer';
import type { Track } from '../audioManager';
import { guessMime, messageTypeFor, fileIcon, extOf } from '../mime';
import { tokenize, telHref, toAsciiDigits } from '../textTokens';
import { toast } from '../components/Toast';
import * as outbox from '../outbox';
import EmojiBurst from '../components/EmojiBurst';

type Message = {
  id: number | string; room_id: number; user_id: number; username: string; avatar?: string | null;
  type: string; content: string | null; file_path: string | null;
  file_name: string | null; edited: number; created_at: string; forwarded_from?: string | null;
  reply_to_id?: number | null; reply_username?: string | null;
  reply_content?: string | null; reply_type?: string | null;
  client_id?: string;
  played?: number;
  one_time_seconds?: number | null; viewed_at?: number | null;
  _uploading?: boolean; _uploadFailed?: boolean;
};
// Shows a spinner over the image until it finishes loading (download progress proxy).
type Reaction = { emoji: string; username: string; user_id: number };
type ReplyTo = { id: number | string; username: string; content: string | null; type: string };

const EMOJIS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉','🤔','😍','👎','😡'];
// Emoji-only messages of these play a full-screen burst effect. Keyed by the
// first code point so ❤️ (heart + VS16) matches regardless of the selector.
const BURST_EMOJIS = ['😂','❤️','👍','🙏','😍','🔥','🎉','😢','😮','👌','💯','😭','🥰','😎','👏','🙌','🤣'];
const EMOJI_EFFECTS = new Set(BURST_EMOJIS.map(e => Array.from(e)[0]));
const BURST_FORM: Record<string, string> = Object.fromEntries(BURST_EMOJIS.map(e => [Array.from(e)[0], e]));
const MESSAGES_PAGE_SIZE = 20;

// Right-align predominantly RTL text (Persian/Arabic) in the select sheet.
function looksRTLText(t: string): boolean {
  const rtl = (t.match(/[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return rtl > 0 && rtl >= (rtl + latin) * 0.3;
}

export default function ChatScreen({ room, onBack, onOpenDM, onOpenProfile, initialJumpMsgId, initialShare, onShareConsumed }: {
  room: { id: number; name: string; is_dm: number; other_username?: string; is_private?: number; created_by?: number };
  initialShare?: { files?: { path: string; mimeType?: string; fileName?: string }[]; text?: string | null } | null;
  onShareConsumed?: () => void;
  onBack: () => void;
  onOpenDM: (room: { id: number; name: string; is_dm: number; other_username?: string }) => void;
  onOpenProfile: () => void;
  initialJumpMsgId?: number | null;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<Record<number, Reaction[]>>({});
  // The draft lives in a ref, NOT state: keystrokes and emoji taps must not
  // re-render the whole message list (that's what made typing/sending laggy).
  // Controlled composer state: React owns the value, so clearing after send is
  // deterministic (no lost/duplicated keystrokes when typing right after send).
  // Text lives INSIDE the Composer (local state) so typing never re-renders
  // this screen. We reach it imperatively only for edit prefill / share text.
  const composerRef = useRef<ComposerHandle>(null);
  const [me, setMe] = useState('');
  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  const [online, setOnline] = useState<string[]>([]);
  const [typing, setTyping] = useState<string[]>([]);
  const [recordingUsers, setRecordingUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | string | null>(null);
  // Reaction picker: rendered in a Modal at the tap position so ANY outside tap closes it
  const [emojiPicker, setEmojiPicker] = useState<{ id: number | string; x: number; y: number } | null>(null);
  const [recording, setRecording] = useState(false);
  // Fullscreen image viewer. images is snapshotted ONCE when opening so the
  // gallery's data prop stays stable (churning it on every swipe made fast
  // swiping hang and left stale frames behind on close). viewerIdx tracks the
  // current image for the counter / save / screenshot-guard.
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null);
  const [viewerIdx, setViewerIdx] = useState(0);
  const viewerUrl = viewer ? viewer.images[viewerIdx] ?? null : null;
  function openViewer(url: string) {
    const list = allImages.includes(url) ? allImages : chatImageUrls();
    let idx = list.indexOf(url);
    let images = list;
    if (idx < 0) { images = [url, ...list]; idx = 0; }
    setViewerIdx(idx);
    setViewer({ images, index: idx });
  }
  function closeViewer() { setViewer(null); }
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [showOnline, setShowOnline] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [maxOtherReadMsgId, setMaxOtherReadMsgId] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  // clientId -> uploaded file URL, so the server's echo can be matched back to
  // its optimistic bubble even when the server doesn't echo client_id.
  const pendingUploadPaths = useRef<Record<string, string>>({});
  const reconnectHandlerRef = useRef<(() => void) | null>(null);
  const [oneTimeSecs, setOneTimeSecs] = useState<number | null>(null); // 🔥 applies to next message
  const [revealedOneTime, setRevealedOneTime] = useState<Set<number | string>>(new Set());
  const [showOneTimeMenu, setShowOneTimeMenu] = useState(false);
  const [actionsMsg, setActionsMsg] = useState<{ msg: Message; x: number; y: number } | null>(null); // tap menu for a message
  const [pendingMedia, setPendingMedia] = useState<{ uri: string; name: string; mime: string }[]>([]);
  const dmPeerPk = useRef<Uint8Array | null>(null); // DM partner's public key (E2E)
  const dmPeerId = useRef<number | null>(null); // DM partner's user id (calls)
  const [e2eActive, setE2eActive] = useState(false);
  const [showE2EUnlock, setShowE2EUnlock] = useState(false);
  const [e2ePass, setE2ePass] = useState('');
  const [oneTimeExpiry, setOneTimeExpiry] = useState<Record<number, number>>({});
  const [, setOtTick] = useState(0); // 1s ticker while one-time countdowns run
  const [showMedia, setShowMedia] = useState(false);
  const [mediaTab, setMediaTab] = useState<'images' | 'files' | 'music' | 'links'>('images');
  const [mediaData, setMediaData] = useState<any>(null);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [forwardTargets, setForwardTargets] = useState<any[]>([]);
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [roomInfo, setRoomInfo] = useState<any>(null);
  const [showPlayer, setShowPlayer] = useState(false);
  // Tapped link / phone number → sheet offering both sensible actions.
  const [tokenAction, setTokenAction] = useState<{ kind: 'url' | 'phone'; text: string } | null>(null);
  // Double-tap "select all" sheet: a read-only TextInput lets the selection be
  // preset to the whole message and then adjusted by hand, which a <Text> can't.
  const [selectText, setSelectText] = useState<string | null>(null);
  const [selectRange, setSelectRange] = useState<{ start: number; end: number } | undefined>(undefined);
  // How many messages arrived while the user was scrolled up, shown as a badge
  // on the scroll-to-bottom button.
  const [missedCount, setMissedCount] = useState(0);
  const [inviteName, setInviteName] = useState('');
  const [inviteSuggestions, setInviteSuggestions] = useState<any[]>([]);
  const [inviteSearching, setInviteSearching] = useState(false);
  const [highlightId, setHighlightId] = useState<number | string | null>(null);
  const [showScrollFab, setShowScrollFab] = useState(false);
  // Every image ever sent in this chat (chronological), from /room-media —
  // lets the lightbox traverse the whole chat, not just loaded messages.
  const [allImages, setAllImages] = useState<string[]>([]);
  // A message arrived in ANOTHER chat while this one is open → dot on "Chats"
  const [otherUnread, setOtherUnread] = useState(false);
  // Quick-emoji bar above the composer (closable; reopens from the strip)
  const [quickEmoji, setQuickEmoji] = useState(true);
  // Heart-only messages splash a short full-screen love effect on both sides.
  // Emoji-only messages splash a full-screen effect. The key restarts the
  // animation; burstEmoji is which emoji to rain.
  const [burst, setBurst] = useState<{ key: number; emoji: string }>({ key: 0, emoji: '' });
  function triggerBurst(emoji: string) { setBurst(b => ({ key: b.key + 1, emoji })); }
  // Returns the single emoji if the text is ONE emoji-only message (optionally
  // repeated), else null. Covers the popular emojis worth celebrating.
  function burstEmojiOf(text: string | null | undefined): string | null {
    if (!text) return null;
    const t = String(text).trim();
    if (!t || t.length > 16) return null;
    // strip variation selectors / ZWJ / whitespace, then grapheme-split
    const chars = Array.from(t).filter(c => !/[\uFE0E\uFE0F\u200D\s]/.test(c));
    if (!chars.length) return null;
    const uniq = new Set(chars);
    if (uniq.size !== 1) return null;
    const emoji = t.replace(/\s+/g, '').slice(0, 8); // keep the rendered form (with VS16)
    const single = Array.from(t.replace(/\s+/g, ''))[0];
    return EMOJI_EFFECTS.has(single) ? (BURST_FORM[single] || single) : null;
  }
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
    if (nearBottom && missedCount) setMissedCount(0);
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
      // Auto-advanced voices count as played too (manual taps report via VoicePlayer)
      if (next.username !== meRef.current && !next.played) {
        socketRef.current?.emit('voice_played', { messageId: next.id });
      }
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
    if (!room.is_dm) return;
    (async () => {
      try {
        const res = await apiFetch(`/dm-peer-key/${room.id}`);
        dmPeerId.current = res?.userId ?? null;
      } catch {}
      if (await e2eReady()) {
        // Make sure the local keypair still matches what the server published
        // for this account. If it diverged (e.g. the identity was rebuilt on
        // the web and our stored private key no longer corresponds), peers
        // encrypt to a key we can't open — so wipe it and prompt to unlock the
        // real identity instead of silently showing undecryptable messages.
        const status = await e2eVerifyIdentity();
        if (status === 'mismatch') {
          setShowE2EUnlock(true);
        } else {
          dmPeerPk.current = await e2eDMPeerKey(room.id);
          setE2eActive(!!dmPeerPk.current);
        }
      } else {
        // Session predates E2E: the identity was never unlocked on this device
        setShowE2EUnlock(true);
      }
    })();
  }, [room.id]);

  async function unlockE2E() {
    const ok = await e2eSetup(e2ePass);
    setE2ePass('');
    if (!ok) { Alert.alert('Wrong password', 'Could not unlock encryption with that password.'); return; }
    setShowE2EUnlock(false);
    dmPeerPk.current = await e2eDMPeerKey(room.id);
    setE2eActive(!!dmPeerPk.current);
  }

  // Does the open lightbox image belong to this (image/gallery) message?
  function lightboxBelongsTo(m: Message): boolean {
    if (!viewerUrl || !m.file_path) return false;
    if (m.type === 'image') return `${BASE_URL}${m.file_path}` === viewerUrl || m.file_path === viewerUrl;
    if (m.type === 'gallery') {
      try { return JSON.parse(m.file_path).some((u: string) => `${BASE_URL}${u}` === viewerUrl || u === viewerUrl); } catch { return false; }
    }
    return false;
  }

  // ── (9) one-time countdown ticker ──
  useEffect(() => {
    if (!Object.keys(oneTimeExpiry).length) return;
    const iv = setInterval(() => {
      setOtTick(t => t + 1);
      // If a one-time image is open in the lightbox and its window has closed,
      // dismiss it immediately (don't wait for the server's delete event).
      if (viewerUrl) {
        const now = Date.now();
        const expired = messagesRef.current.find(m =>
          m.one_time_seconds && oneTimeExpiry[m.id as number] && oneTimeExpiry[m.id as number] <= now && lightboxBelongsTo(m));
        if (expired) closeViewer();
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [Object.keys(oneTimeExpiry).length > 0, viewerUrl]);

  // Pull anything we missed while the device was locked / app backgrounded.
  // The socket auto-reconnects, but events sent meanwhile are gone — so on
  // every reconnect and every return to the foreground, re-sync the tail.
  async function refreshLatest() {
    try {
      const msgs = await apiFetch(`/messages/${room.id}`);
      if (!Array.isArray(msgs) || !msgs.length) return;
      setMessages(prev => {
        const have = new Set(prev.map(m => m.id));
        const fresh = msgs.filter((m: any) => !have.has(m.id));
        // Reconcile DELETIONS too. A one-time message opened while we were in
        // the background is destroyed server-side; if the socket event was
        // missed the message would otherwise sit in the chat forever. Only
        // messages inside the window this response covers can be judged
        // missing — anything older simply wasn't returned.
        const serverIds = new Set(msgs.map((m: any) => m.id));
        const windowStart = msgs[0].id;
        const survives = (m: any) =>
          typeof m.id !== 'number' || m.id < windowStart || serverIds.has(m.id);
        const dropped = prev.filter(m => !survives(m));
        if (!fresh.length && !dropped.length) return prev;
        // Server messages (numeric ids) stay ordered; optimistic tmp-* stay last
        const kept = prev.filter(survives);
        const numeric = kept.filter(m => typeof m.id === 'number');
        const temp = kept.filter(m => typeof m.id !== 'number');
        const merged = [...numeric, ...fresh].sort((a: any, b: any) => a.id - b.id);
        return [...merged, ...temp];
      });
      socketRef.current?.emit('mark_read', { roomId: room.id, lastMsgId: msgs[msgs.length - 1].id });
      if (isNearBottomRef.current) setTimeout(scrollBottom, 100);
    } catch {}
  }

  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st !== 'active') {
        // Backgrounded: tell the server we're no longer viewing this room so
        // our other devices (or a later re-open) get push notifications again.
        socketRef.current?.emit('leave_room');
        return;
      }
      // The socket can be a half-dead zombie after Doze or a SIM call:
      // verify with an acked ping and force-reconnect if needed.
      ensureSocketAlive();
      // Coming back to the foreground on this screen: re-mark as viewing.
      socketRef.current?.emit('join_room', room.id);
      refreshLatest();
      // Mobile radio may need a moment after unlock — one delayed retry
      setTimeout(refreshLatest, 2500);
    });
    return () => sub.remove();
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
      // Reactions already on these messages. Without this the chat opened with
      // an empty reaction map, so every existing reaction disappeared from the
      // UI on restart even though the server still had it.
      apiFetch(`/room-reactions/${room.id}`).then(all => {
        if (!mounted || !all || all.error) return;
        const parsed: Record<number, any[]> = {};
        Object.keys(all).forEach(k => { parsed[Number(k)] = all[k]; });
        setReactions(prev => ({ ...parsed, ...prev })); // live updates win
      }).catch(() => {});
      apiFetch(`/read-receipts/${room.id}`).then(receipts => {
        if (!mounted) return;
        if (receipts && typeof receipts === 'object' && !Array.isArray(receipts) && !receipts.error) {
          const vals = Object.values(receipts) as number[];
          setMaxOtherReadMsgId(vals.length ? Math.max(0, ...vals) : 0);
        }
      }).catch(() => {});
      if (Array.isArray(msgs)) {
        const exp: Record<number, number> = {};
        msgs.forEach((m: any) => {
          if (m.one_time_seconds && m.viewed_at) exp[m.id] = m.viewed_at + m.one_time_seconds * 1000;
        });
        if (Object.keys(exp).length) setOneTimeExpiry(prev => ({ ...prev, ...exp }));
        setMessages(msgs);
        messagesRef.current = msgs;
        hasMoreOlderRef.current = msgs.length >= MESSAGES_PAGE_SIZE;
        if (msgs.length) sock.emit('mark_read', { roomId: room.id, lastMsgId: msgs[msgs.length - 1].id });
        // Emoji effect received while we were away: if the newest message is a
        // recent emoji-only message from the other person, play it on entry.
        const last: any = msgs[msgs.length - 1];
        if (last && last.type === 'text' && last.username !== (u || '')) {
          let c: any = last.content;
          if (e2eIsEncrypted(c)) c = e2eDecrypt(c, dmPeerPk.current);
          const em = burstEmojiOf(c);
          const ageMs = Date.now() - new Date((last.created_at || '').includes('T') ? last.created_at : (last.created_at || '').replace(' ', 'T') + 'Z').getTime();
          if (em && ageMs < 30000) setTimeout(() => triggerBurst(em), 400);
        }
      }
      // Re-append failed sends persisted from a previous session (retryable)
      try {
        const failed = JSON.parse((await AsyncStorage.getItem(failedKey)) || '[]');
        if (mounted && Array.isArray(failed) && failed.length) {
          setMessages(prev => {
            // If the send actually reached the server before the app died (the
            // echo just never arrived to clear the crash-safety copy), the row
            // is already in history — drop the copy instead of duplicating.
            const delivered = (f: any) => prev.some(p =>
              typeof p.id === 'number' && p.username === (u || '') && p.type === f.type &&
              (f.type === 'text' ? p.content === f.content : p.file_name === f.file_name && p.content === f.content));
            // An upload that is STILL RUNNING (the user left this chat and came
            // straight back) must neither be re-listed as failed nor retried —
            // doing both is what previously produced two copies of the image.
            const keep = failed.filter((f: any) =>
              !prev.some(p => p.id === f.id) && !delivered(f) && !outbox.isInFlight(f.id));
            failed.filter((f: any) => delivered(f)).forEach((f: any) => removeFailedMsg(f.id));
            // Whatever is genuinely stalled (the process died mid-send) resumes
            // automatically, since a JS upload cannot outlive the process.
            const resumable = keep.filter((f: any) =>
              f.type === 'text' || (f.file_path && /^(file|content):\/\//.test(String(f.file_path))));
            if (resumable.length) {
              setTimeout(() => resumable.forEach((f: any) => {
                if (!outbox.isInFlight(f.id)) retryUpload({ ...f, _uploadFailed: true });
              }), 800);
            }
            // Still-uploading sends are shown with their progress bar, not as failures.
            const running = failed.filter((f: any) => outbox.isInFlight(f.id) && !prev.some(p => p.id === f.id));
            return [
              ...prev,
              ...running.map((f: any) => ({ ...f, _uploading: true, _uploadFailed: false })),
              ...keep.map((f: any) => ({ ...f, _uploading: false, _uploadFailed: true })),
            ];
          });
        }
      } catch {}
      setLoading(false);
      if (initialJumpMsgId) setTimeout(() => jumpToMessage(initialJumpMsgId), 300);

      socketRef.current = sock;
      sock.emit('join_room', room.id);

      // socket.io reconnects by itself, but the server no longer has us in
      // the room channel — re-join and re-sync on every reconnect.
      reconnectHandlerRef.current = () => {
        sock.emit('join_room', room.id);
        refreshLatest();
      };
      sock.on('connect', reconnectHandlerRef.current);

      sock.on('message_received', (msg: Message) => {
        if (msg.room_id !== room.id) {
          if (msg.username !== me) setOtherUnread(true);
          return;
        }
        if (msg.type === 'text' && msg.username !== me) {
          let c: any = msg.content;
          if (e2eIsEncrypted(c)) c = e2eDecrypt(c, dmPeerPk.current);
          const em = burstEmojiOf(c);
          if (em) triggerBurst(em);
        }
        // Reconcile our optimistic upload bubble with the server's echo.
        // Prefer the echoed client_id; fall back to matching the uploaded
        // file path (covers servers that don't echo client_id back).
        const pendingId = (msg.client_id && String(msg.client_id))
          || (msg.file_path
              && Object.keys(pendingUploadPaths.current).find(id => pendingUploadPaths.current[id] === msg.file_path))
          || null;
        if (pendingId) {
          delete pendingUploadPaths.current[pendingId];
          outbox.markDone(pendingId);
          removeFailedMsg(pendingId); // send confirmed — drop the crash-safety copy
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
        else if (msg.username !== meRef.current) setMissedCount(n => n + 1);
        sock.emit('mark_read', { roomId: room.id, lastMsgId: msg.id });
      });
      // The owner removed us: leave the chat immediately.
      sock.on('removed_from_room', ({ roomId, roomName }: any) => {
        if (roomId !== room.id) return;
        Alert.alert('Removed', `You were removed from "${roomName}".`);
        onBack();
      });
      sock.on('message_edited', ({ messageId, content }: any) => {
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content, edited: 1 } : m));
      });
      sock.on('message_deleted', ({ messageId, roomId }: any) => {
        if (roomId != null && roomId !== room.id) return; // now also personal-channel

        // If the lightbox is showing an image that belongs to the message
        // being destroyed (e.g. a one-time image whose timer ran out), close
        // it so the picture vanishes from view too.
        const gone = messagesRef.current.find(m => m.id === messageId);
        if (gone && lightboxBelongsTo(gone)) closeViewer();
        setMessages(prev => prev.filter(m => m.id !== messageId));
      });
      sock.on('reactions_updated', ({ messageId, roomId, reactions: r }: any) => {
        // These now also arrive on our personal channel (so they reach us even
        // when backgrounded), which means updates for OTHER rooms land here too.
        if (roomId != null && roomId !== room.id) return;
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
      sock.on('one_time_viewed', ({ messageId, roomId, seconds }: any) => {
        // Also delivered on our personal channel now, so ignore other rooms.
        if (roomId != null && roomId !== room.id) return;
        setOneTimeExpiry(prev => ({ ...prev, [messageId]: Date.now() + seconds * 1000 }));
      });

      sock.on('voice_played', ({ messageId }: any) => {
        setMessages(prev => prev.map(msg => msg.id === messageId ? { ...msg, played: 1 } : msg));
      });
      sock.on('messages_read', ({ roomId, lastReadMsgId }: any) => {
        if (roomId != room.id) return;
        setMaxOtherReadMsgId(prev => lastReadMsgId > prev ? lastReadMsgId : prev);
      });
    })();
    return () => {
      mounted = false;
      socketRef.current?.emit('leave_room');
      socketRef.current?.off('message_received');
      socketRef.current?.off('removed_from_room');
      socketRef.current?.off('message_edited');
      socketRef.current?.off('message_deleted');
      socketRef.current?.off('reactions_updated');
      socketRef.current?.off('room_online');
      socketRef.current?.off('user_typing');
      socketRef.current?.off('user_stopped_typing');
      socketRef.current?.off('user_recording');
      socketRef.current?.off('user_stopped_recording');
      socketRef.current?.off('messages_read');
      socketRef.current?.off('one_time_viewed');
      socketRef.current?.off('voice_played');
      if (reconnectHandlerRef.current) socketRef.current?.off('connect', reconnectHandlerRef.current);
    };
  }, [room.id]);

  useEffect(() => {
    AsyncStorage.getItem('quickEmojiClosed').then(v => { if (v === '1') setQuickEmoji(false); });
  }, []);

  // Files/text shared from another app land staged in the composer
  useEffect(() => {
    if (!initialShare) return;
    if (initialShare.files?.length) {
      setPendingMedia(prev => [...prev, ...initialShare.files!
        .filter(f => f.path)
        .map(f => {
          const name = f.fileName || f.path.split('/').pop() || `shared-${Date.now()}`;
          // Share-sheet files often arrive with no (or a useless octet-stream)
          // mime type; fall back to the extension so music stays music and
          // documents keep their own look instead of all becoming plain files.
          return {
            uri: /^(file|content):\/\//.test(f.path) ? f.path : 'file://' + f.path,
            name,
            mime: guessMime(name || f.path, f.mimeType),
          };
        })]);
    }
    if (initialShare.text) composerRef.current?.setText(initialShare.text);
    onShareConsumed?.();
  }, []);

  // URLs belonging to one-time media: view-only, never saved or screenshotted
  function isOneTimeUrl(url: string | null): boolean {
    if (!url) return false;
    return messagesRef.current.some((m: any) => {
      if (!m.one_time_seconds || !m.file_path) return false;
      if (m.type === 'gallery') {
        try { return JSON.parse(m.file_path).some((u: string) => `${BASE_URL}${u}` === url || u === url); } catch { return false; }
      }
      return `${BASE_URL}${m.file_path}` === url || m.file_path === url;
    });
  }

  // Block screenshots/screen recording while any one-time content is on
  // screen (revealed in the chat or open in the lightbox).
  useEffect(() => {
    const sensitive = revealedOneTime.size > 0 || isOneTimeUrl(viewerUrl);
    if (sensitive) ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    else ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    return () => { ScreenCapture.allowScreenCaptureAsync().catch(() => {}); };
  }, [revealedOneTime, viewerUrl]);

  // Swiping the gallery is only smooth if the neighbours are already cached
  useEffect(() => {
    if (!viewer) return;
    const { images } = viewer;
    [images[viewerIdx - 1], images[viewerIdx + 1]].forEach(u => { if (u && u.startsWith('http')) Image.prefetch(u).catch(() => {}); });
  }, [viewer, viewerIdx]);

  useEffect(() => {
    let alive = true;
    setOtherUnread(false);
    apiFetch(`/room-media/${room.id}`)
      .then((m: any) => {
        if (alive && m && Array.isArray(m.images)) {
          setAllImages(m.images.slice().reverse().map((p: string) => `${BASE_URL}${p}`));
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [room.id]);

  // Optimistic text send: the bubble appears on first tap; if the server
  // doesn't ack within the timeout the bubble shows a retry button.
  function dispatchText(plain: string, replyToId: number | null, oneTime: number | null, replyMeta?: ReplyTo | null) {
    const sock = socketRef.current;
    if (!sock) return;
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: Message = {
      id: clientId, room_id: room.id, user_id: 0, username: me, avatar: myAvatar,
      type: 'text', content: plain, file_path: null, file_name: null,
      edited: 0, created_at: new Date().toISOString(),
      reply_to_id: replyToId, reply_username: replyMeta?.username ?? null,
      reply_content: replyMeta?.content ?? null, reply_type: replyMeta?.type ?? null,
      one_time_seconds: oneTime ?? null,
      _uploading: true,
    } as Message;
    setMessages(prev => [...prev, optimistic]);
    // Persist right away (removed on server ack) so a kill/close mid-send on a
    // slow connection can't drop the message silently.
    saveFailedMsg(optimistic);
    outbox.markStart(clientId, room.id);
    { const em = burstEmojiOf(plain); if (em) triggerBurst(em); }
    if (isNearBottomRef.current) setTimeout(scrollBottom, 50);
    // Encrypt + emit AFTER the bubble has painted — E2E key math on a slow
    // phone must never delay the send button's visual feedback.
    setTimeout(() => {
      const wire = (room.is_dm && dmPeerPk.current) ? (e2eEncrypt(plain, dmPeerPk.current) || plain) : plain;
      (sock as any).timeout(8000).emit('send_message', {
        roomId: room.id, type: 'text', content: wire, replyToId,
        clientId, oneTimeSeconds: oneTime ?? undefined,
      }, (err: any, res: any) => {
        if (err || !res?.ok) markUploadFailed(clientId);
      });
    }, 0);
  }

  // Receives the composer's text (already cleared locally by the Composer).
  function sendText(raw: string) {
    if (pendingMedia.length && !editingId) {
      const items = pendingMedia;
      let caption: string | null = raw.trim() || null;
      if (caption && room.is_dm && dmPeerPk.current) {
        caption = e2eEncrypt(caption, dmPeerPk.current) || caption;
      }
      const oneTime = oneTimeSecs ?? undefined;
      setPendingMedia([]);
      setOneTimeSecs(null);
      emitStopTyping();
      const images = items.filter(m => m.mime.startsWith('image/'));
      const others = items.filter(m => !m.mime.startsWith('image/'));
      if (images.length > 1) {
        // Multiple images travel as ONE gallery message with the caption below.
        sendGallery(images, caption, oneTime);
        others.forEach(m => uploadFile(m.uri, m.name, m.mime, null, oneTime));
      } else {
        items.forEach((m, i) => uploadFile(m.uri, m.name, m.mime, i === 0 ? caption : null, oneTime));
      }
      return;
    }
    const t = raw.trim();
    if (!t || !socketRef.current) return;
    if (editingId) {
      const wire = (room.is_dm && dmPeerPk.current) ? (e2eEncrypt(t, dmPeerPk.current) || t) : t;
      socketRef.current.emit('edit_message', { messageId: editingId, content: wire });
      setEditingId(null);
    } else {
      dispatchText(t, replyTo?.id ?? null, oneTimeSecs, replyTo);
      setOneTimeSecs(null);
    }
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

  // Every image in the chat, in order — the lightbox browses through these.
  // Every audio file in this chat, oldest first — the playlist the music
  // player walks through (and what the full-screen player lists).
  function chatTracks(): Track[] {
    return messagesRef.current
      .filter((m: any) => m.type === 'music' && m.file_path && !m._uploading && !m.one_time_seconds)
      .map((m: any) => ({
        id: m.id,
        uri: `${BASE_URL}${m.file_path}`,
        title: m.file_name || 'Audio',
      }));
  }

  function chatImageUrls(): string[] {
    const urls: string[] = [];
    messagesRef.current.forEach((m: any) => {
      if (m.one_time_seconds && !revealedOneTime.has(m.id)) return;
      if (m.type === 'image' && m.file_path && !m._uploading) urls.push(`${BASE_URL}${m.file_path}`);
      if (m.type === 'gallery' && m.file_path && !m._uploading) {
        try { JSON.parse(m.file_path).forEach((u: string) => urls.push(`${BASE_URL}${u}`)); } catch {}
      }
    });
    return urls;
  }

  function revealOneTime(msg: Message) {
    setRevealedOneTime(prev => new Set(prev).add(msg.id));
    const mine = msg.username === me;
    if (!mine && (msg.type === 'text' || msg.type === 'file')) startOneTimeClock(msg);
  }

  function hideOneTime(msg: Message) {
    setRevealedOneTime(prev => {
      const next = new Set(prev);
      next.delete(msg.id);
      return next;
    });
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
    const a = res.assets[0];
    setPendingMedia(prev => [...prev, { uri: a.uri, name: a.name, mime: guessMime(a.name || a.uri, a.mimeType) }]);
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
      quality: 0.6, // same compression as the camera — see pickFromCamera
      exif: false,
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
      // quality below 1 makes the native picker hand back a re-encoded JPEG
      // instead of the sensor's full-resolution original. A modern phone camera
      // produces 8–15 MB frames; at 0.6 they're a few hundred KB, which is what
      // was making "open camera → shoot → appears in chat" feel so slow (the
      // delay was the huge file being copied, read and then uploaded).
      // exif:false skips parsing/copying the metadata block as well.
      ? await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.6,
          exif: false,
        })
      : await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Videos,
          videoMaxDuration: 60,
          videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
        });
    if (res.canceled) return;
    const asset = res.assets[0];
    if (mode === 'photo') setPendingMedia(prev => [...prev, { uri: asset.uri, name: `photo-${Date.now()}.jpg`, mime: 'image/jpeg' }]);
    else setPendingMedia(prev => [...prev, { uri: asset.uri, name: `video-${Date.now()}.mp4`, mime: 'video/mp4' }]);
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
    // Persist right away (removed again on server ack): if the app is killed
    // while the upload is still in flight — the common case on a bad network —
    // the message must survive the restart as a retryable failed send.
    saveFailedMsg(optimistic);
    setUploadProgress(prev => ({ ...prev, [clientId]: 0 }));
    if (isNearBottomRef.current) setTimeout(scrollBottom, 50);
  }

  // Copy a picked/captured/shared file out of volatile storage (the cache dir,
  // or a content:// URI whose permission grant dies with the activity) into the
  // app's document directory. Without this, a send interrupted by the app
  // closing can't be retried later — the source file is already gone.
  async function persistLocal(uri: string, name: string): Promise<string> {
    try {
      if (uri.startsWith(FileSystem.documentDirectory || ' ')) return uri; // already durable
      const safe = name.replace(/[^\w.\-]/g, '_') || `file-${Date.now()}`;
      const dest = `${FileSystem.documentDirectory}outbox-${Date.now()}-${safe}`;
      await FileSystem.copyAsync({ from: uri, to: dest });
      return dest;
    } catch {
      return uri; // best effort — an un-copyable file still uploads normally
    }
  }

  // Failed sends survive app restarts so they can still be retried.
  const failedKey = `failed-msgs-${room.id}`;
  const saveFailedMsg = (m: Message) => outbox.remember(room.id, m);
  const removeFailedMsg = (id: string | number) => outbox.forget(room.id, id);

  function markUploadFailed(clientId: string) {
    outbox.markDone(clientId);
    setUploadProgress(prev => { const { [clientId]: _d, ...rest } = prev; return rest; });
    setMessages(prev => {
      const next = prev.map(m => m.id === clientId ? { ...m, _uploading: false, _uploadFailed: true } : m);
      const failed = next.find(m => m.id === clientId);
      if (failed) saveFailedMsg(failed);
      return next;
    });
  }

  async function uploadFile(uri: string, name: string, mime: string, caption: string | null = null, oneTimeOverride?: number) {
    // messageTypeFor re-checks the extension, so a file whose mime was missing
    // still lands as 'music'/'video'/'image' and gets the right player/bubble.
    const type = messageTypeFor(mime, name || uri);
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const replyToId = replyTo?.id ?? null;
    const oneTime = oneTimeOverride ?? (oneTimeSecs ?? undefined);
    setOneTimeSecs(null);
    // Keep a durable copy so an interrupted upload can resume on next open.
    uri = await persistLocal(uri, name);
    addOptimisticMessage(clientId, type, uri, name, replyToId, caption);
    setReplyTo(null);
    // Registered at module scope: the upload keeps running if the user leaves
    // this chat, and re-entering must not start a second copy of it.
    outbox.markStart(clientId, room.id);
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

  // Uploads several images and sends them as ONE gallery message.
  async function sendGallery(images: { uri: string; name: string; mime: string }[], caption: string | null, oneTime?: number) {
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const replyToId = replyTo?.id ?? null;
    // Durable copies first, so leaving the chat mid-upload doesn't strand the
    // pictures on cache paths that are gone by the time we retry.
    images = await Promise.all(images.map(async m => ({ ...m, uri: await persistLocal(m.uri, m.name) })));
    addOptimisticMessage(clientId, 'gallery', JSON.stringify(images.map(m => m.uri)), JSON.stringify(images.map(m => m.name)), replyToId, caption);
    setReplyTo(null);
    outbox.markStart(clientId, room.id);
    try {
      const progress = images.map(() => 0);
      const urls: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const res = await uploadWithProgress(images[i].uri, images[i].name, images[i].mime, pct => {
          progress[i] = pct;
          const avg = Math.round(progress.reduce((a, b) => a + b, 0) / images.length);
          setUploadProgress(prev => ({ ...prev, [clientId]: avg }));
        });
        if (res.error) throw new Error(res.error);
        urls.push(res.url);
      }
      const filePath = JSON.stringify(urls);
      pendingUploadPaths.current[clientId] = filePath;
      socketRef.current?.emit('send_message', {
        roomId: room.id, type: 'gallery', content: caption, filePath, fileName: null,
        replyToId, clientId, oneTimeSeconds: oneTime,
      });
    } catch {
      markUploadFailed(clientId);
    }
  }

  async function sendVoice(uri: string, peaks: number[], caption: string | null = null, oneTimeOverride?: number) {
    const peakStr = peaks.map(v => Math.round(v * 100)).join(',');
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const replyToId = replyTo?.id ?? null;
    const oneTime = oneTimeOverride ?? (oneTimeSecs ?? undefined);
    setOneTimeSecs(null);
    // Recordings land in the volatile cache dir, which the OS can purge as soon
    // as the app is backgrounded — keep a durable copy so a failed send can
    // still be retried (and played back) after a restart.
    uri = await persistLocal(uri, `voice-${Date.now()}.m4a`);
    addOptimisticMessage(clientId, 'audio', uri, peakStr, replyToId, caption);
    setReplyTo(null);
    outbox.markStart(clientId, room.id);
    try {
      const res = await uploadWithProgress(uri, `voice-${Date.now()}.m4a`, 'audio/m4a', pct => setUploadProgress(prev => ({ ...prev, [clientId]: pct })));
      if (res.error) throw new Error(res.error);
      pendingUploadPaths.current[clientId] = res.url;
      socketRef.current?.emit('send_message', {
        roomId: room.id, type: 'audio', content: caption, filePath: res.url, fileName: peakStr, replyToId, clientId, oneTimeSeconds: oneTime,
      });
    } catch {
      markUploadFailed(clientId);
    }
  }

  // Open a document in whatever app the device uses for that type. Android
  // refuses to open a remote https URL in most viewers, so download to a local
  // cache file first and hand over a content:// URI it will accept.
  async function openFile(msg: Message) {
    if (!msg.file_path) return;
    if (msg.one_time_seconds) { Alert.alert('Not allowed', 'One-time files cannot be opened externally.'); return; }
    const url = `${BASE_URL}${msg.file_path}`;
    const name = msg.file_name || msg.file_path.split('/').pop() || `file-${Date.now()}`;
    try {
      const local = FileSystem.cacheDirectory + name.replace(/[^\w.\-]/g, '_');
      const info = await FileSystem.getInfoAsync(local);
      const uri = info.exists ? local : (await FileSystem.downloadAsync(url, local)).uri;
      if (Platform.OS === 'android') {
        const contentUri = await FileSystem.getContentUriAsync(uri);
        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: contentUri,
          flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
          type: guessMime(name, null),
        });
      } else {
        await Share.share({ url: uri });
      }
    } catch {
      // No installed app can handle this type — offer the browser as a fallback.
      Alert.alert('Cannot open', 'No app on this device can open this file type.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open in browser', onPress: () => Linking.openURL(url).catch(() => {}) },
      ]);
    }
  }

  async function downloadMedia(msg: Message) {
    if (!msg.file_path) return;
    if (msg.one_time_seconds) { Alert.alert('Not allowed', 'One-time media cannot be downloaded.'); return; }
    if (msg.type === 'gallery') {
      try {
        let urls: string[] = [];
        try { urls = JSON.parse(msg.file_path); } catch {}
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status !== 'granted') { Alert.alert('Permission required', 'Allow media access to save downloads.'); return; }
        for (const u of urls) {
          const local = FileSystem.cacheDirectory + (u.split('/').pop() || `img-${Date.now()}.jpg`);
          const { uri } = await FileSystem.downloadAsync(`${BASE_URL}${u}`, local);
          await MediaLibrary.saveToLibraryAsync(uri);
        }
        Alert.alert('Saved', `${urls.length} photos saved to your gallery.`);
      } catch {
        Alert.alert('Error', 'Download failed.');
      }
      return;
    }
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
    removeFailedMsg(clientId);
    setMessages(prev => prev.filter(m => m.id !== clientId));
    if (msg.type === 'text') {
      dispatchText(msg.content || '', msg.reply_to_id ?? null, msg.one_time_seconds ?? null,
        msg.reply_to_id ? { id: msg.reply_to_id, username: msg.reply_username || '', content: msg.reply_content, type: msg.reply_type } as ReplyTo : null);
    } else if (msg.type === 'audio') {
      const peaks = (msg.file_name || '').split(',').map(n => Number(n) / 100);
      sendVoice(msg.file_path!, peaks);
    } else if (msg.type === 'gallery') {
      // A gallery bubble holds JSON arrays of local URIs and names.
      try {
        const uris: string[] = JSON.parse(msg.file_path || '[]');
        let names: string[] = [];
        try { names = JSON.parse(msg.file_name || '[]'); } catch {}
        const imgs = uris.map((u, i) => ({
          uri: u, name: names[i] || `photo-${i}.jpg`, mime: guessMime(names[i] || u, 'image/jpeg'),
        }));
        if (imgs.length) sendGallery(imgs, msg.content || null, msg.one_time_seconds ?? undefined);
      } catch {}
    } else {
      const name = msg.file_name || 'file';
      // Recover the real type from the name so a retried document/audio file
      // doesn't degrade into a generic octet-stream upload.
      uploadFile(msg.file_path!, name, guessMime(name || msg.file_path!, null));
    }
  }

  // Remove a failed message for good (from the list and persisted storage).
  function discardFailed(msg: Message) {
    const clientId = String(msg.id);
    removeFailedMsg(clientId);
    setMessages(prev => prev.filter(m => m.id !== clientId));
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
    setEmojiPicker(null);
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
    if (isOneTimeUrl(viewerUrl)) { Alert.alert('Not allowed', 'One-time media cannot be saved.'); return; }
    if (!viewerUrl) return;
    try {
      const { status } = await MediaLibrary.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Please allow access to save images to your device.');
        return;
      }
      const localUri = FileSystem.cacheDirectory + `chatroom-${Date.now()}.jpg`;
      const { uri } = await FileSystem.downloadAsync(viewerUrl, localUri);
      await MediaLibrary.saveToLibraryAsync(uri);
      Alert.alert('Saved', 'Image saved to your gallery.');
    } catch {
      Alert.alert('Error', 'Could not save the image.');
    }
  }

  // URLs (with or without protocol), card numbers, and phone numbers.
  // Copy helper: always confirms, so the user knows it worked.
  function copy(text: string, label?: string) {
    Clipboard.setStringAsync(text);
    toast(label ? `Copied ${label}` : 'Copied');
  }

  // Every number, phone number and link inside a message is tappable. Numbers
  // copy straight away; phones and links open a small sheet offering both
  // actions, since either could be what the user wanted. Persian and
  // Arabic-Indic digits are recognised the same as ASCII ones.
  function renderTextWithLinks(content: string) {
    return tokenize(content).map((tok, i) => {
      if (tok.kind === 'text') return <Text key={i}>{tok.text}</Text>;
      if (tok.kind === 'number') {
        return (
          <Text key={i} style={s.copyableNumber}
            onPress={() => copy(tok.text, 'number')}>{tok.text}</Text>
        );
      }
      return (
        <Text
          key={i}
          style={tok.kind === 'url' ? s.link : s.copyablePhone}
          onPress={() => setTokenAction({ kind: tok.kind as 'url' | 'phone', text: tok.text })}
        >{tok.text}</Text>
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

  // Live, case-insensitive username suggestions while typing an invite. The
  // /search endpoint matches with SQL LIKE, which is already case-insensitive
  // for ASCII; results exclude people who are already in the room.
  const inviteSearchTimer = useRef<any>(null);
  function onInviteNameChange(q: string) {
    setInviteName(q);
    clearTimeout(inviteSearchTimer.current);
    const term = q.trim();
    if (!term) { setInviteSuggestions([]); setInviteSearching(false); return; }
    setInviteSearching(true);
    inviteSearchTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`/search?q=${encodeURIComponent(term)}`);
        const already = new Set((roomInfo?.members || []).map((m: any) => m.username));
        const users = (res?.users || []).filter((u: any) => !already.has(u.username));
        setInviteSuggestions(users.slice(0, 6));
      } catch { setInviteSuggestions([]); }
      setInviteSearching(false);
    }, 250);
  }

  // Message press routing.
  //   • text bubbles      : single tap opens the menu, double tap selects all
  //   • media bubbles     : single tap opens/plays, long press opens the menu
  // A single tap on text is deferred briefly so a double tap can win instead.
  const tapTimer = useRef<any>(null);
  const lastTap = useRef(0);
  const DOUBLE_MS = 260;

  function openMenuFor(msg: Message, e?: any) {
    setActionsMsg({ msg, x: e?.nativeEvent?.pageX ?? 0, y: e?.nativeEvent?.pageY ?? 0 });
  }

  function onBubblePress(msg: Message, e: any) {
    if (!isTextual(msg)) return;           // media handles its own tap
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_MS) {
      clearTimeout(tapTimer.current);      // second tap: select the whole message
      lastTap.current = 0;
      openSelectText(msg);
      return;
    }
    lastTap.current = now;
    const ev = { nativeEvent: { pageX: e?.nativeEvent?.pageX, pageY: e?.nativeEvent?.pageY } };
    clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => openMenuFor(msg, ev), DOUBLE_MS);
  }

  // Bubbles whose primary content is text — everything else opens media on tap.
  function isTextual(m: Message) {
    return m.type === 'text' || m.type === 'system' || m.type === 'call' || m.type === 'invite';
  }

  function openSelectText(msg: Message) {
    const t = (msg.content || '').trim();
    if (!t) return;
    setSelectText(t);
    setSelectRange({ start: 0, end: t.length }); // whole message selected to begin with
    // Release the controlled selection shortly after so the handles are draggable.
    setTimeout(() => setSelectRange(undefined), 400);
  }

  async function loadRoomInfo() {
    try {
      const info = await apiFetch(`/room-info/${room.id}`);
      if (!info?.error) setRoomInfo(info);
    } catch {}
  }

  function removeMember(m: any) {
    Alert.alert(`Remove ${m.username}?`, 'They will lose access to this room.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: () => socketRef.current?.emit('remove_member', { roomId: room.id, userId: m.id }, (res: any) => {
          if (res?.error) { Alert.alert('Could not remove', res.error); return; }
          setRoomInfo((prev: any) => prev
            ? { ...prev, members: (prev.members || []).filter((x: any) => x.id !== m.id) }
            : prev);
        }),
      },
    ]);
  }

  function sendInvite() {
    const name = inviteName.trim();
    if (!name) return;
    socketRef.current?.emit('invite_to_room', { roomId: room.id, username: name }, (res: any) => {
      if (res?.error) Alert.alert('Invite failed', res.error);
      else {
        Alert.alert('Invitation sent', `${name} received an invite in their DMs.`);
        setInviteName(''); setInviteSuggestions([]);
        loadRoomInfo();
      }
    });
  }

  function replyPreview(msg: Message): string {
    if (msg.reply_type === 'audio') return '🎙 Voice message';
    if (msg.reply_type === 'image') return '🖼 Image';
    if (msg.reply_type === 'gallery') return '🖼 Photos';
    if (msg.reply_type === 'video') return '🎥 Video';
    if (msg.reply_type === 'music') return '🎵 Audio file';
    if (msg.reply_type === 'file') return '📄 File';
    return (msg.reply_content || '').slice(0, 60);
  }

  function renderMessage({ item: msg }: { item: Message }) {
    if (e2eIsEncrypted(msg.content) || e2eIsEncrypted(msg.reply_content)) {
      msg = { ...msg };
      if (e2eIsEncrypted(msg.content)) {
        const dec = e2eDecrypt(msg.content, dmPeerPk.current);
        msg.content = dec !== null ? dec : '🔒 Encrypted message (cannot decrypt on this device)';
      }
      if (e2eIsEncrypted(msg.reply_content)) {
        const decR = e2eDecrypt(msg.reply_content ?? null, dmPeerPk.current);
        msg.reply_content = decR !== null ? decR : '🔒 Encrypted';
      }
    }
    // System notices (a member joined, or was removed) render as a centered
    // line rather than a chat bubble, with the affected username tappable so
    // you can open a DM with them straight from the announcement.
    if (msg.type === 'system') {
      let d: any = {};
      try { d = JSON.parse(msg.content || '{}'); } catch {}
      const who = d.username || msg.username;
      const isMe = who === me;
      return (
        <View style={s.systemRow}>
          <Text style={s.systemText}>
            <Text
              style={[s.systemName, !isMe && s.systemNameLink]}
              onPress={isMe ? undefined : () => openDM(who)}>
              {d.avatar ? `${d.avatar} ` : ''}{isMe ? 'You' : who}
            </Text>
            {d.kind === 'removed'
              ? <Text>{' '}{isMe ? 'were' : 'was'} removed from the room{d.byUsername ? ` by ${d.byUsername}` : ''}</Text>
              : <Text>{' '}joined the room</Text>}
          </Text>
        </View>
      );
    }
    const mine = msg.username === me;
    const hiddenOneTime = !!msg.one_time_seconds && !revealedOneTime.has(msg.id) && !msg._uploading;
    const rxns = reactions[msg.id] || [];
    const grouped: Record<string, { count: number; mine: boolean }> = {};
    rxns.forEach(r => {
      if (!grouped[r.emoji]) grouped[r.emoji] = { count: 0, mine: false };
      grouped[r.emoji].count++;
      if (r.username === me) grouped[r.emoji].mine = true;
    });

    return (
      <View style={s.msgRow}>
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
        <View style={[s.bubbleRow, mine && s.bubbleRowMine]}>
        <SwipeableMessage
          onSwipeRight={() => { setReplyTo({ id: msg.id, username: msg.username, content: msg.content, type: msg.type }); composerRef.current?.focus(); }}
          onSwipeLeft={mine ? () => deleteMsg(msg.id) : undefined}
        >
        <TouchableOpacity
          style={[s.bubble, mine ? s.mineBubble : s.theirsBubble, highlightId === msg.id && s.bubbleHighlight]}
          onPress={(e) => onBubblePress(msg, e)}
          onLongPress={(e) => openMenuFor(msg, e)}
          delayLongPress={350}
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
            <Text style={s.msgText} selectable>{renderTextWithLinks(msg.content || '')}{msg.edited ? <Text style={s.edited}> (edited)</Text> : null}{msg.one_time_seconds ? <Text style={s.oneTimeTag}> 🔥{msg.one_time_seconds}s</Text> : null}</Text>
          )}
          {msg.type === 'call' && (() => {
            let c: any = {};
            try { c = JSON.parse(msg.content || '{}'); } catch {}
            const fmtDur = (n: number) => n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`;
            const label = c.outcome === 'completed' ? `${c.kind === 'video' ? 'Video' : 'Voice'} call · ${fmtDur(c.duration || 0)}`
              : c.outcome === 'declined' ? 'Call declined'
              : c.outcome === 'missed' ? 'Missed call'
              : 'Call failed';
            const bad = c.outcome !== 'completed';
            const color = bad ? '#f87171' : C.accent;
            return (
              <View style={s.callLog}>
                <View style={[s.callLogIconWrap, { backgroundColor: bad ? 'rgba(248,113,113,0.15)' : 'rgba(59,125,216,0.15)' }]}>
                  <Ionicons name={c.kind === 'video' ? 'videocam' : 'call'} size={16} color={color} />
                </View>
                <Text style={[s.callLogText, bad && { color: '#f87171' }]}>{label}</Text>
              </View>
            );
          })()}
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
              <TouchableOpacity
                onPress={() => !msg._uploading && openViewer(uri)}
                onLongPress={(e) => openMenuFor(msg, e)}
                delayLongPress={350}
                disabled={msg._uploading}>
                {msg._uploading
                  ? <Image source={{ uri }} style={s.msgImage} resizeMode="cover" />
                  : <ImageWithSpinner uri={uri} style={s.msgImage} resizeMode="cover" onLoaded={onLoaded} />}
              </TouchableOpacity>
            );
          })()}
          {!hiddenOneTime && msg.type === 'gallery' && (() => {
            let urls: string[] = [];
            try { urls = JSON.parse(msg.file_path || '[]'); } catch {}
            const full = urls.map(u => (msg._uploading ? u : `${BASE_URL}${u}`));
            if (msg._uploading) {
              // While uploading, show a simple grid of the local previews.
              return (
                <View style={s.galleryGrid}>
                  {full.slice(0, 4).map((uri, i) => (
                    <Image key={i} source={{ uri }} style={s.galleryImg} resizeMode="cover" />
                  ))}
                </View>
              );
            }
            return (
              <GalleryGrid
                uris={full}
                onLongPress={() => openMenuFor(msg)}
                onOpen={(i) => openViewer(full[i])}
                onFirstLoaded={msg.one_time_seconds && !mine ? () => startOneTimeClock(msg) : undefined}
              />
            );
          })()}
          {!hiddenOneTime && msg.type === 'audio' && !msg._uploading && (
            <VoicePlayer url={`${BASE_URL}${msg.file_path}`} peaks={msg.file_name || ''} mine={mine} msgId={msg.id} roomId={room.id} roomMeta={room} label={`🎙 ${msg.username} · voice message`}
              played={!!msg.played}
              onPlayStart={() => {
                if (mine) return;
                if (msg.one_time_seconds) startOneTimeClock(msg);
                if (!msg.played) socketRef.current?.emit('voice_played', { messageId: msg.id });
              }} />
          )}
          {msg.type === 'audio' && msg._uploading && (
            <View style={s.uploadingVoicePlaceholder}>
              <Text style={s.uploadingVoiceText}>🎙 Voice message</Text>
            </View>
          )}
          {!hiddenOneTime && msg.type === 'music' && !msg._uploading && (
            <MusicPlayer url={`${BASE_URL}${msg.file_path}`} fileName={msg.file_name || 'Audio'} mine={mine} msgId={msg.id} roomId={room.id} roomMeta={room}
              playlist={chatTracks}
              onOpenPlayer={() => setShowPlayer(true)}
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
          {!hiddenOneTime && (msg.type === 'file' || (msg.type === 'music' && msg._uploading)) && (() => {
            const fname = msg.file_name || 'File';
            const icon = fileIcon(fname, null);
            const kind = (extOf(fname) || 'file').toUpperCase();
            // A real card per file type — the icon distinguishes PDFs, docs,
            // sheets and archives, and tapping opens it in the device's viewer.
            return (
              <TouchableOpacity
                style={s.fileCard}
                disabled={!!msg._uploading}
                onPress={() => openFile(msg)}>
                <Text style={s.fileCardIcon}>{icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.fileCardName} numberOfLines={2}>{fname}</Text>
                  <Text style={s.fileCardMeta}>{msg._uploading ? 'Uploading…' : `${kind} · tap to open`}</Text>
                </View>
              </TouchableOpacity>
            );
          })()}
          {!hiddenOneTime && msg.type !== 'text' && msg.type !== 'invite' && msg.type !== 'call' && msg.content ? (
            <Text style={[s.msgText, s.caption]} selectable>{renderTextWithLinks(msg.content)}</Text>
          ) : null}
          {msg.one_time_seconds && !hiddenOneTime && !msg._uploading ? (
            <TouchableOpacity onPress={() => hideOneTime(msg)}>
              <Text style={s.oneTimeHideBtn}>🙈 Hide</Text>
            </TouchableOpacity>
          ) : null}
          {msg._uploading && (
            <View style={s.uploadOverlay}>
              <View style={[s.uploadProgressBar, { width: `${uploadProgress[String(msg.id)] ?? 0}%` }]} />
            </View>
          )}
          {msg._uploadFailed && (
            <View style={s.failedRow}>
              <TouchableOpacity onPress={() => retryUpload(msg)}>
                <Text style={s.uploadRetryText}>⚠️ Failed — tap to retry</Text>
              </TouchableOpacity>
            </View>
          )}
        </TouchableOpacity>
        </SwipeableMessage>

        </View>

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
          {msg.one_time_seconds ? (
            <Text style={s.oneTimeTag}>
              🔥{oneTimeExpiry[msg.id as number]
                ? Math.max(0, Math.ceil((oneTimeExpiry[msg.id as number] - Date.now()) / 1000))
                : msg.one_time_seconds}s
            </Text>
          ) : null}
          {mine && !msg._uploading && !msg._uploadFailed && (
            <Text style={[s.ticks, msg.id <= maxOtherReadMsgId && s.ticksSeen]}>
              {msg.id <= maxOtherReadMsgId ? '✓✓' : '✓'}
            </Text>
          )}
          {!msg._uploading && !msg._uploadFailed && (
            <TouchableOpacity onPress={(e) => setActionsMsg({ msg, x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={s.footerBtn}>😊</Text>
            </TouchableOpacity>
          )}
        </View>


      </View>
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
          {otherUnread && <View style={s.unreadDot} />}
        </TouchableOpacity>
        <TouchableOpacity style={s.headerCenter} activeOpacity={0.7}
          onPress={async () => {
            if (room.is_dm) {
              setShowMedia(true);
              setMediaTab('images');
              const m = await apiFetch(`/room-media/${room.id}`);
              if (!m.error) setMediaData(m);
              return;
            }
            setShowRoomInfo(true);
            loadRoomInfo();
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
        {room.is_dm ? (
          <>
            <TouchableOpacity
              onPress={() => callManager.startDM(dmPeerId.current, room.other_username || room.name, 'voice')}
              style={s.callBtn} hitSlop={{ top: 10, bottom: 10 }}>
              <Ionicons name="call-outline" size={22} color={C.accent} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => callManager.startDM(dmPeerId.current, room.other_username || room.name, 'video')}
              style={s.callBtn} hitSlop={{ top: 10, bottom: 10 }}>
              <Ionicons name="videocam-outline" size={23} color={C.accent} />
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            onPress={() => callManager.toggleRoomVoice(room.id, room.name)}
            style={s.callBtn} hitSlop={{ top: 10, bottom: 10 }}>
            <Ionicons name="call-outline" size={22} color={C.accent} />
          </TouchableOpacity>
        )}
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

      {/* Full-screen image viewer: real mobile-gallery feel — pinch zoom,
          double-tap, swipe left/right between images, and pull down to close.
          Powered by react-native-awesome-gallery (reanimated + gestures). */}
      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={closeViewer}>
        <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
          {viewer && (
            <>
              <AwesomeGallery
                data={viewer.images}
                initialIndex={viewer.index}
                numToRender={3}
                doubleTapScale={3}
                onIndexChange={(i: number) => setViewerIdx(i)}
                onSwipeToClose={closeViewer}
                loop={false}
              />
              <TouchableOpacity onPress={closeViewer} style={s.lightboxClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.lightboxCloseText}>✕</Text>
              </TouchableOpacity>
              {!isOneTimeUrl(viewerUrl) && (
                <TouchableOpacity onPress={saveImage} style={s.lightboxSave} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Text style={s.lightboxCloseText}>⬇</Text>
                </TouchableOpacity>
              )}
              {viewer.images.length > 1 && (
                <Text style={s.lightboxCounter}>{viewerIdx + 1} / {viewer.images.length}</Text>
              )}
            </>
          )}
        </GestureHandlerRootView>
      </Modal>

      {/* Tapped link or phone: copy vs open/call — one tap, both options. */}
      <Modal visible={!!tokenAction} transparent animationType="fade" onRequestClose={() => setTokenAction(null)}>
        <View style={s.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setTokenAction(null)} />
          {tokenAction && (
            <View style={s.actionSheet}>
              <View style={s.sheetGrip} />
              <Text style={s.tokenPreview} numberOfLines={2} selectable>{tokenAction.text}</Text>
              <View style={s.sheetDivider} />
              <TouchableOpacity style={s.sheetRow} onPress={() => {
                const t = tokenAction; setTokenAction(null);
                copy(t.text, t.kind === 'phone' ? 'number' : 'link');
              }}>
                <Text style={s.sheetRowIcon}>📋</Text>
                <Text style={s.sheetRowText}>Copy</Text>
              </TouchableOpacity>
              {tokenAction.kind === 'phone' ? (
                <TouchableOpacity style={s.sheetRow} onPress={() => {
                  const t = tokenAction; setTokenAction(null);
                  Linking.openURL(telHref(t.text)).catch(() => toast('No dialler available'));
                }}>
                  <Text style={s.sheetRowIcon}>📞</Text>
                  <Text style={s.sheetRowText}>Call {toAsciiDigits(tokenAction.text)}</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity style={s.sheetRow} onPress={() => {
                  const t = tokenAction; setTokenAction(null);
                  handleLinkPress(t.text);
                }}>
                  <Text style={s.sheetRowIcon}>🌐</Text>
                  <Text style={s.sheetRowText}>Open link</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={s.sheetCancel} onPress={() => setTokenAction(null)}>
                <Text style={s.sheetCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </Modal>

      {/* Double-tap select: whole message preselected, adjustable, copyable. */}
      <Modal visible={selectText !== null} transparent animationType="fade" onRequestClose={() => setSelectText(null)}>
        <View style={s.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSelectText(null)} />
          <View style={s.actionSheet}>
            <View style={s.sheetGrip} />
            <Text style={s.selectTitle}>Select text</Text>
            <TextInput
              style={[s.selectInput, looksRTLText(selectText || '') && s.selectInputRTL]}
              value={selectText || ''}
              // editable (so Android shows selection handles) but controlled with
              // no onChangeText, so any keystroke is immediately reverted — the
              // text can be selected and copied, never changed. The keyboard is
              // suppressed since there is nothing to type.
              editable
              showSoftInputOnFocus={false}
              multiline
              scrollEnabled
              autoFocus
              // Start with EVERYTHING selected, then release control after a
              // moment so the user can drag the handles to a narrower range.
              selection={selectRange}
              onSelectionChange={() => { if (selectRange) setSelectRange(undefined); }}
              contextMenuHidden={false}
            />
            <TouchableOpacity style={s.ocrCopyBtnLike} onPress={() => { copy(selectText || '', 'message'); setSelectText(null); }}>
              <Text style={s.ocrCopyTextLike}>📋  Copy all</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.sheetCancel} onPress={() => setSelectText(null)}>
              <Text style={s.sheetCancelText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <FullMusicPlayer
        visible={showPlayer}
        onClose={() => setShowPlayer(false)}
        tracks={chatTracks()}
        roomId={room.id}
        roomMeta={room}
      />

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
          extraData={[maxOtherReadMsgId, uploadProgress, reactions, highlightId, online, revealedOneTime, e2eActive]}
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
          {!fabIsBack && missedCount > 0 && (
            <View style={s.scrollFabBadge}>
              <Text style={s.scrollFabBadgeText}>{missedCount > 99 ? '99+' : missedCount}</Text>
            </View>
          )}
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
          <TouchableOpacity onPress={() => { setEditingId(null); composerRef.current?.setText(''); }}>
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

      {/* Reaction picker: popover at the tap position; closes on outside tap */}
      <Modal visible={!!emojiPicker} transparent animationType="fade" onRequestClose={() => setEmojiPicker(null)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setEmojiPicker(null)}>
          {emojiPicker && (() => {
            const win = Dimensions.get('window');
            const W = Math.min(340, win.width - 24);
            const left = Math.max(12, Math.min(emojiPicker.x - W / 2, win.width - W - 12));
            const top = Math.max(70, Math.min(emojiPicker.y - 64, win.height - 130));
            return (
              <View style={[s.emojiPicker, { position: 'absolute', left, top, width: W }]} onStartShouldSetResponder={() => true}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always">
                  {EMOJIS.map(e => (
                    <TouchableOpacity key={e} onPress={() => toggleReact(emojiPicker.id, e)} style={s.emojiBtn}>
                      <Text style={s.emoji}>{e}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            );
          })()}
        </Pressable>
      </Modal>

      {/* Message actions: a bottom sheet with quick reactions on top. Replaces
          the old cramped ⋮ button and tap-positioned popover — the whole bubble
          is now the target (long-press), the rows are full-width and finger
          sized, and reactions live in the same place as the actions. */}
      <Modal visible={!!actionsMsg} transparent animationType="slide" onRequestClose={() => setActionsMsg(null)}>
        <View style={s.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setActionsMsg(null)} />
          {actionsMsg && (() => {
            const m = actionsMsg.msg;
            const mineMsg = m.username === me;
            const hidden = !!m.one_time_seconds && !mineMsg && !revealedOneTime.has(m.id);
            const close = () => setActionsMsg(null);
            const Row = ({ icon, label, onPress, danger }: any) => (
              <TouchableOpacity style={s.sheetRow} onPress={onPress} activeOpacity={0.6}>
                <Text style={s.sheetRowIcon}>{icon}</Text>
                <Text style={[s.sheetRowText, danger && s.sheetRowDanger]}>{label}</Text>
              </TouchableOpacity>
            );

            // A failed (never-sent) message only supports local actions.
            if (m._uploadFailed) {
              return (
                <View style={s.actionSheet}>
                  <View style={s.sheetGrip} />
                  <Row icon="🔄" label="Retry" onPress={() => { close(); retryUpload(m); }} />
                  <Row icon="🗑" label="Delete" danger onPress={() => {
                    close();
                    Alert.alert('Delete message?', '', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => discardFailed(m) },
                    ]);
                  }} />
                </View>
              );
            }

            return (
              <View style={s.actionSheet}>
                <View style={s.sheetGrip} />

                {/* Quick reactions */}
                <ScrollView horizontal showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.sheetReactRow} keyboardShouldPersistTaps="always">
                  {EMOJIS.map(e => (
                    <TouchableOpacity key={e} style={s.sheetReactBtn}
                      onPress={() => { close(); toggleReact(m.id, e); }}>
                      <Text style={s.sheetReactEmoji}>{e}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <View style={s.sheetDivider} />

                <Row icon="↩" label="Reply" onPress={() => {
                  close();
                  setReplyTo({ id: m.id, username: m.username, content: m.content, type: m.type });
                  composerRef.current?.focus();
                }} />
                {(m.type === 'text' || (m.file_path && !m.one_time_seconds)) && !hidden && (
                  <Row icon="📋" label="Copy" onPress={() => {
                    let fp = m.file_path || '';
                    if (m.type === 'gallery') { try { fp = JSON.parse(fp)[0] || ''; } catch {} }
                    const t = m.type === 'text' ? (m.content || '') : `${BASE_URL}${fp}`;
                    if (t) copy(t, m.type === 'text' ? 'message' : 'link');
                    close();
                  }} />
                )}
                {m.type !== 'invite' && !m.one_time_seconds && (
                  <Row icon="↪" label="Forward" onPress={() => { close(); openForwardPicker(m); }} />
                )}
                {m.file_path && !hidden && !m.one_time_seconds && (
                  <Row icon="⬇" label="Download" onPress={() => { close(); downloadMedia(m); }} />
                )}
                {mineMsg && m.type === 'text' && (
                  <Row icon="✏️" label="Edit" onPress={() => {
                    close();
                    composerRef.current?.setText(m.content || ''); setEditingId(m.id);
                  }} />
                )}
                {mineMsg && (
                  <Row icon="🗑" label="Delete" danger onPress={() => { close(); deleteMsg(m.id); }} />
                )}
                <TouchableOpacity style={s.sheetCancel} onPress={close}>
                  <Text style={s.sheetCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            );
          })()}
        </View>
      </Modal>

      {/* Shared media browser (DM profile) */}
      <Modal visible={showMedia} transparent animationType="slide" onRequestClose={() => setShowMedia(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowMedia(false)} />
          <View style={[s.attachSheet, { maxHeight: '75%' }]}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>{room.other_username || room.name}</Text>
            <View style={s.mediaTabs}>
              {([['images', '🖼 Photos'], ['files', '📄 Files'], ['music', '🎵 Music'], ['links', '🔗 Links']] as const).map(([key, label]) => (
                <TouchableOpacity key={key} style={[s.mediaTab, mediaTab === key && s.mediaTabActive]} onPress={() => setMediaTab(key)}>
                  <Text style={[s.mediaTabText, mediaTab === key && s.mediaTabTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {!mediaData ? (
              <ActivityIndicator color={C.accent} style={{ marginVertical: 30 }} />
            ) : (
              <ScrollView style={{ maxHeight: 380 }} nestedScrollEnabled>
                {mediaTab === 'images' && (
                  <View style={s.mediaGrid}>
                    {mediaData.images.map((u: string, i: number) => (
                      <TouchableOpacity key={i} onPress={() => { setShowMedia(false); openViewer(`${BASE_URL}${u}`); }}>
                        <Image source={{ uri: `${BASE_URL}${u}` }} style={s.mediaThumb} />
                      </TouchableOpacity>
                    ))}
                    {!mediaData.images.length && <Text style={s.mediaEmpty}>No photos yet</Text>}
                  </View>
                )}
                {mediaTab === 'files' && (
                  <>
                    {mediaData.files.map((f: any, i: number) => (
                      <TouchableOpacity key={i} style={s.attachOption} onPress={() => Linking.openURL(`${BASE_URL}${f.url}`)}>
                        <Text style={s.attachOptionText} numberOfLines={1}>📄 {f.name}</Text>
                      </TouchableOpacity>
                    ))}
                    {!mediaData.files.length && <Text style={s.mediaEmpty}>No files yet</Text>}
                  </>
                )}
                {mediaTab === 'music' && (
                  <>
                    {mediaData.music.map((f: any, i: number) => (
                      <TouchableOpacity key={i} style={s.attachOption}
                        onPress={() => audioManager.play(`media-${i}`, `${BASE_URL}${f.url}`, `🎵 ${f.name}`, room.id, room)}>
                        <Text style={s.attachOptionText} numberOfLines={1}>🎵 {f.name}</Text>
                      </TouchableOpacity>
                    ))}
                    {!mediaData.music.length && <Text style={s.mediaEmpty}>No music yet</Text>}
                  </>
                )}
                {mediaTab === 'links' && (
                  <>
                    {mediaData.links.map((l: string, i: number) => (
                      <TouchableOpacity key={i} style={s.attachOption}
                        onPress={() => Linking.openURL(/^https?:/.test(l) ? l : 'https://' + l)}>
                        <Text style={[s.attachOptionText, { color: C.accent }]} numberOfLines={1}>🔗 {l}</Text>
                      </TouchableOpacity>
                    ))}
                    {!mediaData.links.length && <Text style={s.mediaEmpty}>No links yet</Text>}
                  </>
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* E2E unlock (sessions that logged in before encryption existed) */}
      <Modal visible={showE2EUnlock} transparent animationType="fade" onRequestClose={() => setShowE2EUnlock(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowE2EUnlock(false)} />
          <View style={[s.attachSheet, { paddingHorizontal: 16 }]}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>🔒 Unlock encrypted messages</Text>
            <Text style={s.oneTimeHint}>
              Enter your account password once to unlock end-to-end encryption on this device.
            </Text>
            <TextInput
              style={s.unlockInput} secureTextEntry placeholder="Password" placeholderTextColor={C.muted}
              value={e2ePass} onChangeText={setE2ePass} onSubmitEditing={unlockE2E}
            />
            <TouchableOpacity style={s.unlockBtn} onPress={unlockE2E}>
              <Text style={s.unlockBtnText}>Unlock</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.attachCancel} onPress={() => setShowE2EUnlock(false)}>
              <Text style={s.attachCancelText}>Not now</Text>
            </TouchableOpacity>
          </View>
        </View>
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
                    <View key={m.id ?? m.username} style={s.memberRow}>
                      <Text style={s.memberName}>{m.avatar ? m.avatar + ' ' : ''}{m.username}</Text>
                      {m.username === roomInfo.owner_username
                        ? <Text style={s.memberOwnerTag}>owner</Text>
                        : (roomInfo.is_owner && m.id ? (
                            <TouchableOpacity onPress={() => removeMember(m)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                              <Text style={s.memberRemove}>Remove</Text>
                            </TouchableOpacity>
                          ) : null)}
                    </View>
                  ))}
                </View>
              )}

              {!!roomInfo?.is_private && !!roomInfo?.is_owner && (
                <View style={s.roomLinkBox}>
                  <Text style={s.roomLinkLabel}>ADD MEMBER</Text>
                  <TextInput
                    style={s.inviteInput} placeholder="Search a username…" placeholderTextColor={C.muted}
                    value={inviteName} onChangeText={onInviteNameChange} autoCapitalize="none"
                    autoCorrect={false} onSubmitEditing={sendInvite}
                  />
                  {inviteSuggestions.length > 0 && (
                    <View style={s.suggestBox}>
                      {inviteSuggestions.map((u: any) => (
                        <TouchableOpacity key={u.id} style={s.suggestRow}
                          onPress={() => { setInviteName(u.username); setInviteSuggestions([]); }}>
                          <Text style={s.suggestIcon}>{u.avatar || '👤'}</Text>
                          <Text style={s.suggestName}>{u.username}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {inviteSearching && inviteSuggestions.length === 0 && !!inviteName.trim() && (
                    <Text style={s.inviteHint}>Searching…</Text>
                  )}
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
        <Composer
          ref={composerRef}
          pendingMedia={pendingMedia}
          oneTimeSecs={oneTimeSecs}
          quickEmoji={quickEmoji}
          editing={!!editingId}
          onTyping={emitTyping}
          onSend={sendText}
          onAttach={() => setShowAttachMenu(true)}
          onRecord={() => startRecordingUI()}
          onOneTime={() => setShowOneTimeMenu(true)}
          onToggleQuickEmoji={setQuickEmoji}
          onRemoveMedia={(i) => setPendingMedia(prev => prev.filter((_, j) => j !== i))}
          onPreviewMedia={(uri) => openViewer(uri)}
        />
      )}
      {burst.key > 0 && burst.emoji ? (
        <EmojiBurst key={burst.key} emoji={burst.emoji} onDone={() => setBurst(b => ({ ...b, emoji: '' }))} />
      ) : null}
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
  msgRow: { width: '100%' },
  callBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  callBtnText: { fontSize: 18 },
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
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  callLog: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  callLogIconWrap: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  callLogText: { color: C.text, fontSize: 14, fontWeight: '600' },
  uploadingVoicePlaceholder: { paddingVertical: 4 },
  uploadingVoiceText: { color: C.text, fontSize: 14, opacity: 0.7 },
  oneTimeReveal: { color: '#f87171', fontSize: 14, fontWeight: '600', paddingVertical: 4 },
  oneTimeTag: { color: '#f87171', fontSize: 11 },
  oneTimeActive: { backgroundColor: 'rgba(248,113,113,0.25)', borderRadius: 8 },
  oneTimeHint: { color: C.muted, fontSize: 13, paddingHorizontal: 16, paddingBottom: 8 },
  oneTimeHideBtn: { color: C.muted, fontSize: 12, marginTop: 5 },
  lightboxNav: {
    position: 'absolute', top: '50%', marginTop: -23, zIndex: 10,
    width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  lightboxNavText: { color: '#fff', fontSize: 28, lineHeight: 32 },
  lightboxCounter: {
    position: 'absolute', bottom: 26, alignSelf: 'center', color: '#fff', fontSize: 13,
    backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 12, paddingVertical: 4,
    borderRadius: 12, overflow: 'hidden',
  },
  mediaTabs: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 10, flexWrap: 'wrap' },
  mediaTab: { borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(59,125,216,0.08)' },
  mediaTabActive: { backgroundColor: C.accent },
  mediaTabText: { color: C.accent, fontSize: 12.5, fontWeight: '600' },
  mediaTabTextActive: { color: '#fff' },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingHorizontal: 12 },
  mediaThumb: { width: 100, height: 100, borderRadius: 8 },
  mediaEmpty: { color: C.muted, textAlign: 'center', paddingVertical: 24, width: '100%' },
  unlockInput: {
    backgroundColor: 'rgba(128,128,128,0.12)', borderRadius: 10, color: C.text,
    paddingHorizontal: 14, paddingVertical: 10, marginHorizontal: 4, marginBottom: 10, fontSize: 15,
  },
  unlockBtn: { backgroundColor: C.accent, borderRadius: 10, padding: 12, alignItems: 'center', marginHorizontal: 4 },
  unlockBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
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
  quickEmojiBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 2,
    backgroundColor: 'transparent',
  },
  quickEmojiBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  quickEmojiText: { fontSize: 22 },
  quickEmojiClose: {
    width: 24, height: 24, borderRadius: 12, marginLeft: 6,
    backgroundColor: 'rgba(239,68,68,0.9)', alignItems: 'center', justifyContent: 'center',
  },
  quickEmojiCloseText: { color: '#fff', fontSize: 12, fontWeight: '800', lineHeight: 14 },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.online, marginLeft: 4, marginTop: -8 },
  actionsMenu: {
    backgroundColor: C.msgBg, borderRadius: 16, paddingVertical: 6, paddingHorizontal: 5,
    borderWidth: 1, borderColor: C.border,
    elevation: 12, shadowColor: '#000', shadowOpacity: 0.35,
    shadowRadius: 18, shadowOffset: { width: 0, height: 6 },
  },
  actionItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 11, borderRadius: 10,
  },
  actionText: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  bubbleRow: { flexDirection: 'row', alignItems: 'center', maxWidth: '100%' },
  bubbleRowMine: { flexDirection: 'row-reverse' },
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  actionSheet: {
    backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 24, paddingTop: 8, maxHeight: '80%',
  },
  sheetGrip: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: C.border,
    alignSelf: 'center', marginBottom: 8,
  },
  sheetReactRow: { paddingHorizontal: 12, paddingVertical: 4, alignItems: 'center' },
  sheetReactBtn: {
    width: 46, height: 46, borderRadius: 23, marginHorizontal: 3,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(128,128,128,0.10)',
  },
  sheetReactEmoji: { fontSize: 25 },
  sheetDivider: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginVertical: 8 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 22, paddingVertical: 15 },
  sheetRowIcon: { fontSize: 19, width: 26, textAlign: 'center' },
  sheetRowText: { color: C.text, fontSize: 16, fontWeight: '500' },
  sheetRowDanger: { color: '#f87171' },
  sheetCancel: {
    marginTop: 8, marginHorizontal: 16, backgroundColor: C.inputBg,
    borderRadius: 14, paddingVertical: 14, alignItems: 'center',
  },
  sheetCancelText: { color: C.muted, fontSize: 16, fontWeight: '600' },
  selectTitle: { color: C.text, fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 10 },
  selectInput: {
    marginHorizontal: 16, backgroundColor: C.inputBg, borderRadius: 12,
    borderWidth: 1, borderColor: C.border, color: C.text,
    fontSize: 15.5, lineHeight: 24, padding: 14, maxHeight: 300,
  },
  selectInputRTL: { textAlign: 'right', writingDirection: 'rtl' },
  ocrCopyBtnLike: {
    marginTop: 12, marginHorizontal: 16, backgroundColor: C.accent,
    borderRadius: 12, paddingVertical: 13, alignItems: 'center',
  },
  ocrCopyTextLike: { color: '#fff', fontSize: 15, fontWeight: '700' },
  tokenPreview: {
    color: C.text, fontSize: 15, fontWeight: '600', textAlign: 'center',
    paddingHorizontal: 22, paddingVertical: 4,
  },

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
  copyablePhone: { color: C.accent, fontWeight: '700', textDecorationLine: 'underline' },
  inlineCopy: { fontSize: 13 },
  bubbleHighlight: { borderWidth: 2, borderColor: C.accent },
  mineBubble: { backgroundColor: C.mine, borderBottomRightRadius: 3 },
  theirsBubble: { backgroundColor: C.msgBg, borderBottomLeftRadius: 3 },
  msgText: { color: C.text, fontSize: 15, lineHeight: 21 },
  edited: { color: C.muted, fontSize: 11 },
  fileLink: { color: '#93c5fd', fontSize: 14 },
  systemRow: { alignItems: 'center', paddingVertical: 6, paddingHorizontal: 20 },
  systemText: {
    color: C.muted, fontSize: 12.5, textAlign: 'center', lineHeight: 18,
    backgroundColor: 'rgba(148,163,184,0.10)', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 5, overflow: 'hidden',
  },
  systemName: { fontWeight: '700', color: C.text },
  systemNameLink: { color: C.accent, textDecorationLine: 'underline' },
  fileCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 190,
    backgroundColor: 'rgba(148,163,184,0.12)', borderRadius: 10, padding: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(148,163,184,0.3)',
  },
  fileCardIcon: { fontSize: 26 },
  fileCardName: { color: C.text, fontSize: 14, fontWeight: '600' },
  fileCardMeta: { color: C.muted, fontSize: 11.5, marginTop: 2 },
  msgImage: { width: 200, height: 180, borderRadius: 10 },
  galleryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, maxWidth: 248 },
  galleryImg: { width: 120, height: 120, borderRadius: 8 },
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
  emojiPicker: { flexDirection: 'row', backgroundColor: C.sidebar, borderRadius: 14, padding: 6, borderWidth: 1, borderColor: C.border, elevation: 10, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 5 } },
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
    position: 'absolute', end: 16, bottom: 148, width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  scrollFabIcon: { color: '#fff', fontSize: 18, fontWeight: '700' },
  scrollFabBadge: {
    position: 'absolute', top: -5, right: -5, minWidth: 20, height: 20,
    borderRadius: 10, paddingHorizontal: 5, backgroundColor: C.online,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: C.bg,
  },
  scrollFabBadgeText: { color: '#fff', fontSize: 10.5, fontWeight: '800' },
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
  memberRemove: { color: '#f87171', fontSize: 12, fontWeight: '700' },
  suggestBox: {
    backgroundColor: C.inputBg, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    marginTop: 6, overflow: 'hidden',
  },
  suggestRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  suggestIcon: { fontSize: 16, width: 22, textAlign: 'center' },
  suggestName: { color: C.text, fontSize: 14.5, fontWeight: '600', flex: 1 },
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
