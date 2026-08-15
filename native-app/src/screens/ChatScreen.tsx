import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, Dimensions,
  ActivityIndicator, Modal, ScrollView, Image, Linking, Share, Pressable, AppState, BackHandler,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import MediaBrowser, { MediaAction, MediaItem } from '../components/MediaBrowser';
import ImageWithSpinner from '../components/ImageWithSpinner';
import GalleryImage from '../components/GalleryImage';
import VideoPlayer, { VideoItem } from '../components/VideoPlayer';
import VideoBubble from '../components/VideoBubble';
import EdgeBack from '../components/EdgeBack';
import ExpiryRing from '../components/ExpiryRing';
import TextViewer from '../components/TextViewer';
import ChatSearch from '../components/ChatSearch';
import TileMap from '../components/TileMap';
import LocationView, { LocationPin } from '../components/LocationView';
import * as locationManager from '../locationManager';
import {
  parseLocation, isLiveNow, formatRemaining, formatCoords, distanceMeters, formatDistance,
} from '../geo';
import CameraScreen from './CameraScreen';
import * as Sharing from 'expo-sharing';
import SwipeableMessage from '../components/SwipeableMessage';
import MusicPlayer from '../components/MusicPlayer';
import FullMusicPlayer from '../components/FullMusicPlayer';
import type { Track } from '../audioManager';
import { guessMime, messageTypeFor, fileIcon, extOf } from '../mime';
import { compressForSend } from '../compressImage';
import VideoSendSheet, { VideoChoice } from '../components/VideoSendSheet';
import { compressVideo } from '../compressVideo';
import { VideoQuality } from '../videoQuality';
import { Quality } from '../imageQuality';
import { tokenize, telHref, toAsciiDigits } from '../textTokens';
import { DISAPPEARING_OPTIONS, disappearingLabel, disappearingPredicate } from '../disappearing';
import { toast } from '../components/Toast';
import * as outbox from '../outbox';
import EmojiBurst from '../components/EmojiBurst';
import EmojiEditor from '../components/EmojiEditor';
import { useFavEmojis } from '../favEmojis';

type Message = {
  id: number | string; room_id: number; user_id: number; username: string; avatar?: string | null;
  type: string; content: string | null; file_path: string | null;
  file_name: string | null; edited: number; created_at: string; forwarded_from?: string | null;
  reply_to_id?: number | null; reply_username?: string | null;
  reply_content?: string | null; reply_type?: string | null;
  client_id?: string;
  played?: number;
  one_time_seconds?: number | null; viewed_at?: number | null;
  /** Disappearing mode: the lifetime, and the deadline once someone has seen it. */
  disappear_seconds?: number | null; expires_at?: number | null;
  _uploading?: boolean; _uploadFailed?: boolean;
};
// Shows a spinner over the image until it finishes loading (download progress proxy).
type Reaction = { emoji: string; username: string; user_id: number };
type ReplyTo = { id: number | string; username: string; content: string | null; type: string };

// Reaction row = the user's own favourite set (editable via the ✏️ at the end).
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
  // Opened from the media gallery? Then closing the image must put the gallery
  // back, not dump the user in the chat. (Two RN Modals stacked on Android is
  // unreliable, so the gallery is closed on the way in and restored on the way
  // out rather than left open underneath.)
  const [viewerFromMedia, setViewerFromMedia] = useState(false);
  const viewerUrl = viewer ? viewer.images[viewerIdx] ?? null : null;
  // `list` lets a caller supply the exact set being browsed (the media
  // gallery's own images, in its own order). Without it the media gallery's
  // urls often weren't found in the chat's list, so the viewer opened at
  // index 0 — the wrong image — and swiping went somewhere unrelated.
  function openViewer(url: string, list?: string[]) {
    const base = list ?? (allImages.includes(url) ? allImages : chatImageUrls());
    let idx = base.indexOf(url);
    let images = base;
    if (idx < 0) { images = [url, ...base]; idx = 0; }
    setViewerIdx(idx);
    setViewer({ images, index: idx });
  }
  function closeViewer() {
    // Remember the image being looked at, not the scroll offset — the grid
    // scrolls to this index when it reappears.
    setMediaFocusIndex(viewerIdx);
    setViewer(null);
    if (viewerFromMedia) { setViewerFromMedia(false); setShowMedia(true); }
  }
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const [showOnline, setShowOnline] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  // Which mode the in-app camera is open in; null = closed.
  const [cameraMode, setCameraMode] = useState<'photo' | 'video' | null>(null);
  // Preparing a file for the OS share sheet (download happens first).
  const [sharingOut, setSharingOut] = useState(false);
  // The open video, plus whether it is shrunk to the floating window. The
  // player is NOT a Modal — see VideoPlayer — so minimising keeps it playing.
  const [videoItem, setVideoItem] = useState<VideoItem | null>(null);
  const [videoMini, setVideoMini] = useState(false);
  // Snapshotted when a video is opened, so next/previous stays stable even if
  // new messages arrive while watching.
  const [videoPlaylist, setVideoPlaylist] = useState<VideoItem[]>([]);
  // Which location message is open fullscreen, and the live-share menu.
  // A message opened for reliable text selection (see TextViewer).
  const [selectTextOf, setSelectTextOf] = useState<string | null>(null);
  // Fetching the context around a message being jumped to.
  const [jumping, setJumping] = useState(false);
  // In-chat search: replaces the header while open.
  const [searching, setSearching] = useState(false);
  const [openLocationId, setOpenLocationId] = useState<number | string | null>(null);
  const [showLocationMenu, setShowLocationMenu] = useState(false);
  const [liveShare, setLiveShare] = useState(locationManager.activeShare());
  // The viewer's own position, only fetched once a location message exists in
  // this chat — no point asking for GPS in a chat that has none.
  const [myPosition, setMyPosition] = useState<{ lat: number; lng: number } | null>(null);
  // Ticks so "12m left" on a live pin stays honest without a per-second render.
  const [clockTick, setClockTick] = useState(0);
  const [maxOtherReadMsgId, setMaxOtherReadMsgId] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  // clientId -> uploaded file URL, so the server's echo can be matched back to
  // its optimistic bubble even when the server doesn't echo client_id.
  const pendingUploadPaths = useRef<Record<string, string>>({});
  const reconnectHandlerRef = useRef<(() => void) | null>(null);
  const [oneTimeSecs, setOneTimeSecs] = useState<number | null>(null); // 🔥 applies to next message
  const [revealedOneTime, setRevealedOneTime] = useState<Set<number | string>>(new Set());
  const [showOneTimeMenu, setShowOneTimeMenu] = useState(false);
  // Chat-wide disappearing timer, 0 = off. Drives the menu, the banner and the
  // "secret" look of the whole screen.
  const [disappearing, setDisappearing] = useState(0);
  useEffect(() => {
    let alive = true;
    apiFetch(`/room-settings/${room.id}`)
      .then((r: any) => { if (alive && r && !r.error) setDisappearing(r.disappearingSeconds || 0); })
      .catch(() => {});
    return () => { alive = false; };
  }, [room.id]);
  function chooseDisappearing(seconds: number) {
    setShowOneTimeMenu(false);
    socketRef.current?.emit('set_disappearing', { roomId: room.id, seconds }, (res: any) => {
      if (res?.error) { Alert.alert('Could not change', res.error); return; }
      setDisappearing(res.seconds || 0);
    });
  }
  const [actionsMsg, setActionsMsg] = useState<{ msg: Message; x: number; y: number } | null>(null); // tap menu for a message
  // Long press puts the chat into multi-select: pick several messages and
  // forward or delete them in one go.
  const [selectedIds, setSelectedIds] = useState<Set<Message['id']>>(new Set());
  // The one message whose text is currently being selected in place.
  // Controlled selection range, used only to preselect the whole message the
  // instant double-tap turns it into a selectable field; released a moment
  // later so the handles become draggable.
  const [pendingMedia, setPendingMedia] = useState<{ uri: string; name: string; mime: string }[]>([]);
  // Photos are sent re-encoded by default — a phone camera's 8 MB original is
  // what makes sending "take a couple of seconds". HD sends the file untouched.
  const [sendQuality, setSendQuality] = useState<Quality>('standard');
  // A staged video waiting on the resolution/trim sheet, and the rest of the
  // send it was pulled out of, so it can be resumed once the user chooses.
  const [videoChoice, setVideoChoice] = useState<
    { item: { uri: string; name: string; mime: string }; bytes: number;
      caption: string | null; oneTime?: number } | null>(null);
  const [videoWorking, setVideoWorking] = useState(0);
  useEffect(() => {
    AsyncStorage.getItem('sendQuality').then(v => {
      if (v === 'hd' || v === 'standard') setSendQuality(v);
    });
  }, []);
  function chooseQuality(q: Quality) {
    setSendQuality(q);
    AsyncStorage.setItem('sendQuality', q).catch(() => {});
  }
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
  // The photo the media grid should return to. Set when the viewer closes,
  // so dismissing an image from the middle of a long gallery puts you back
  // where you were rather than at the top.
  const [mediaFocusIndex, setMediaFocusIndex] = useState(0);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [forwardTargets, setForwardTargets] = useState<any[]>([]);
  // Separate from forwardMsg: the picker is also opened for a multi-selection,
  // where there is no single message to hang visibility off.
  const [forwardOpen, setForwardOpen] = useState(false);
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [roomInfo, setRoomInfo] = useState<any>(null);
  const [showPlayer, setShowPlayer] = useState(false);
  // Tapped link / phone number → sheet offering both sensible actions.
  const [tokenAction, setTokenAction] = useState<{ kind: 'url' | 'phone'; text: string } | null>(null);
  const favEmojis = useFavEmojis();
  const [editEmojis, setEditEmojis] = useState(false);
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
  const keyExtractor = useCallback((m: Message) => String(m.id), []);
  // Only the things a row actually reads. Anything else changing must NOT
  // invalidate the rows.
  const rowExtraData = useMemo(
    () => ({ maxOtherReadMsgId, uploadProgress, reactions, highlightId, online, revealedOneTime, e2eActive, selectedIds }),
    [maxOtherReadMsgId, uploadProgress, reactions, highlightId, online, revealedOneTime, e2eActive, selectedIds],
  );

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
    // Already loaded: nothing to fetch.
    if (messagesRef.current.findIndex(m => m.id === messageId) === -1) {
      // Fetch the message and its neighbours in ONE request rather than paging
      // backwards until it turns up. For a photo from months ago the old loop
      // was dozens of round trips and looked exactly like the button being
      // broken — which is what it was reported as.
      setJumping(true);
      try {
        const ctx = await apiFetch(`/message-context/${room.id}/${messageId}`);
        if (ctx?.error || !Array.isArray(ctx?.messages) || !ctx.messages.length) {
          setJumping(false);
          toast(ctx?.error || 'That message is no longer here');
          return;
        }
        // Merge, keeping whatever is already on screen, so returning to the
        // bottom afterwards still works.
        setMessages(prev => {
          const seen = new Set(prev.map(m => String(m.id)));
          const add = ctx.messages.filter((m: any) => !seen.has(String(m.id)));
          return [...add, ...prev].sort((a: any, b: any) => Number(a.id) - Number(b.id));
        });
        hasMoreOlderRef.current = !!ctx.hasOlder;
      } catch {
        setJumping(false);
        toast('Could not open that message');
        return;
      }
      setJumping(false);
    }

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

  // Messages the user has actually LOOKED at. A disappearing message's clock
  // starts here, not when it was sent: sitting scrolled up in a long chat is
  // not reading the bottom of it, and being offline is not reading at all.
  const seenReported = useRef<Set<string>>(new Set());
  const seenPending = useRef<Set<number | string>>(new Set());
  const seenTimer = useRef<any>(null);

  function flushSeen() {
    const sock = socketRef.current;
    const ids = [...seenPending.current];
    seenPending.current.clear();
    if (!sock || !ids.length) return;
    sock.emit('messages_seen', { roomId: room.id, messageIds: ids });
  }

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems.length > 0) {
      visibleIdRef.current = viewableItems[0].item.id;
    }
    for (const v of viewableItems) {
      const m = v?.item;
      if (!m || !m.disappear_seconds || m.expires_at) continue;
      // Never report your own message: seeing what you sent says nothing about
      // whether it was delivered.
      if (m.username === meRef.current) continue;
      const key = String(m.id);
      if (seenReported.current.has(key)) continue;
      seenReported.current.add(key);
      seenPending.current.add(m.id);
    }
    // Batched: scrolling through a long chat would otherwise emit per row.
    if (seenPending.current.size) {
      clearTimeout(seenTimer.current);
      seenTimer.current = setTimeout(flushSeen, 400);
    }
  }).current;
  useEffect(() => () => clearTimeout(seenTimer.current), []);
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
      const idx = msgs.findIndex(m => String(m.id) === String(finishedId));
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
            // automatically, since a JS upload cannot outlive the process —
            // but only a bounded number of times. A send that can never
            // succeed used to retry on EVERY open and re-persist itself on
            // every failure, looping forever with no way out.
            const resumable = keep.filter((f: any) =>
              (f._attempts || 0) < outbox.MAX_AUTO_RETRIES &&
              (f.type === 'text' || (f.file_path && /^(file|content):\/\//.test(String(f.file_path)))));
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
          // meRef, not the `me` state: this listener is bound once, and on the
          // first render `me` is still ''. Every message from another room —
          // including the echo of a message YOU just forwarded there — then
          // looked like someone else's and lit the dot on the back button.
          if (msg.username !== meRef.current) setOtherUnread(true);
          return;
        }
        // meRef for the same reason as above — bound once, `me` is '' then.
        if (msg.type === 'text' && msg.username !== meRef.current) {
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
          // If this message is the one currently playing, move the player onto
          // its real id — otherwise its bubble goes back to looking idle while
          // the audio keeps playing.
          audioManager.retarget(pendingId, msg.id);
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
        // A live share we just requested: the watcher can only start now, once
        // the server has given the message a real id to keep updating.
        if (msg.type === 'location' && msg.username === meRef.current && pendingLiveShare.current) {
          const { until } = pendingLiveShare.current;
          pendingLiveShare.current = null;
          locationManager.startSharing(msg.id, room.id, until,
            room.is_dm ? (room.other_username || room.name) : room.name).catch(() => {});
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
        if (err || !res?.ok) { markUploadFailed(clientId); return; }
        // The server has it. Clear the crash-safety copy here rather than
        // waiting for the echo — leaving the chat right after sending used to
        // race the two and could leave a stale copy behind to be resent.
        outbox.markDone(clientId);
        outbox.forget(room.id, clientId);
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
      let others = items.filter(m => !m.mime.startsWith('image/'));

      // Exactly one video and nothing else: ask how to send it first. With a
      // mixed batch the sheet would have to be answered once per video, which
      // is worse than just sending them, so it is skipped there.
      const videos = others.filter(m => m.mime.startsWith('video/'));
      if (videos.length === 1 && items.length === 1) {
        const v = videos[0];
        FileSystem.getInfoAsync(v.uri, { size: true })
          .then(info => setVideoChoice({
            item: v, bytes: (info as any)?.size || 0, caption, oneTime,
          }))
          .catch(() => setVideoChoice({ item: v, bytes: 0, caption, oneTime }));
        return;
      }
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

  // Every playable video in the chat, so the player can offer next/previous.
  function chatVideos(): VideoItem[] {
    return messagesRef.current
      .filter((m: any) => m.type === 'video' && m.file_path && !m._uploading && !m.one_time_seconds)
      .map((m: any) => ({
        id: m.id,
        url: `${BASE_URL}${m.file_path}`,
        name: m.file_name || 'Video',
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
    // Same as the camera: only ask when we don't already have it.
    let allowed = (await ImagePicker.getMediaLibraryPermissionsAsync()).granted;
    if (!allowed) allowed = (await ImagePicker.requestMediaLibraryPermissionsAsync()).granted;
    if (!allowed) {
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

  // Opens the in-app camera. The old path fired an intent into the system
  // camera app, which meant a cold app start on every open and a shutter
  // round-trip through another process — that, not the file size, was where
  // the latency was. CameraScreen owns the preview, so opening is a mount.
  function pickFromCamera(mode: 'photo' | 'video') {
    setShowAttachMenu(false);
    setCameraMode(mode);
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

  async function uploadFile(
    uri: string, name: string, mime: string, caption: string | null = null,
    oneTimeOverride?: number, quality: Quality = sendQuality,
    // Slow video work, deferred so it runs AFTER the bubble is on screen.
    videoPrep?: (onProgress: (p: number) => void) => Promise<{ uri: string; name: string }>,
  ) {
    // messageTypeFor re-checks the extension, so a file whose mime was missing
    // still lands as 'music'/'video'/'image' and gets the right player/bubble.
    const type = messageTypeFor(mime, name || uri);
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const replyToId = replyTo?.id ?? null;
    const oneTime = oneTimeOverride ?? (oneTimeSecs ?? undefined);
    setOneTimeSecs(null);
    // The bubble goes up FIRST, showing the original file, and the slow work
    // happens behind it.
    //
    // This used to run the other way round: re-encode, then persist, then show
    // the bubble. Choosing 720p and pressing Send therefore left the user
    // staring at "Preparing video…" with nothing in the chat, for as long as
    // the transcode took. Every other messenger puts the message in the chat
    // immediately and does the work underneath it, because the message being
    // there is what the user pressed Send for.
    addOptimisticMessage(clientId, type, uri, name, replyToId, caption);
    setReplyTo(null);

    if (type === 'image') {
      const c = await compressForSend(uri, name, mime, quality);
      uri = c.uri; name = c.name; mime = c.mime;
    } else if (type === 'video' && videoPrep) {
      // Transcode/trim, reported as progress on the bubble itself.
      const out = await videoPrep((pct) =>
        setUploadProgress(prev => ({ ...prev, [clientId]: Math.round(pct * 40) })));
      uri = out.uri; name = out.name;
    }
    // Keep a durable copy so an interrupted upload can resume on next open.
    uri = await persistLocal(uri, name);
    // The bubble was created against the ORIGINAL file; point it at whatever
    // is actually going to be uploaded.
    setMessages(prev => prev.map(m =>
      String(m.id) === clientId ? { ...m, file_path: uri, file_name: name } : m));
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
  async function sendGallery(
    images: { uri: string; name: string; mime: string }[], caption: string | null,
    oneTime?: number, quality: Quality = sendQuality,
  ) {
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const replyToId = replyTo?.id ?? null;
    // Durable copies first, so leaving the chat mid-upload doesn't strand the
    // pictures on cache paths that are gone by the time we retry.
    images = await Promise.all(images.map(async m => {
      const c = await compressForSend(m.uri, m.name, m.mime, quality);
      return { ...c, uri: await persistLocal(c.uri, c.name) };
    }));
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

  // Send a received file out to any other app (WhatsApp, Drive, Gmail, …).
  // Download first: the OS share sheet needs a real local file, not a URL.
  async function shareOut(msg: Message) {
    if (!msg.file_path) return;
    if (msg.one_time_seconds) { Alert.alert('Not allowed', 'One-time media cannot be shared.'); return; }
    // A gallery is several files; the share sheet takes one, so share the first.
    let remote = msg.file_path;
    if (msg.type === 'gallery') {
      try { remote = JSON.parse(msg.file_path)[0]; } catch {}
    }
    if (!remote) return;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Not available', 'Sharing is not available on this device.');
        return;
      }
      setSharingOut(true);
      const name = msg.file_name && msg.type !== 'gallery' && msg.type !== 'audio'
        ? msg.file_name
        : (String(remote).split('/').pop() || 'file');
      const local = FileSystem.cacheDirectory + name;
      const { uri } = await FileSystem.downloadAsync(`${BASE_URL}${remote}`, local);
      await Sharing.shareAsync(uri, {
        mimeType: guessMime(name, 'application/octet-stream') || undefined,
        dialogTitle: name,
      });
    } catch {
      Alert.alert('Error', 'Could not share that file.');
    } finally {
      setSharingOut(false);
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

  // `manual` = the user pressed Retry, which forgives the attempt count; the
  // automatic resume on chat open does not.
  function retryUpload(msg: Message, manual = false) {
    if (!msg.client_id && typeof msg.id !== 'string') return;
    const clientId = String(msg.id);
    // Carry the stable identity into the new dispatch so attempts keep
    // counting and a later delete can still tombstone this lineage.
    const m: any = msg;
    outbox.setNextOrigin(String(m._originId || clientId), manual ? 0 : (m._attempts || 0) + 1);
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

  // Remove a failed message for good. outbox.discard tombstones it, so a retry
  // still in flight cannot re-persist it under its new clientId when it fails.
  function discardFailed(msg: Message) {
    const clientId = String(msg.id);
    outbox.discard(room.id, msg);
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
    // In-app room links OPEN the room. They do not join it: joining is a
    // deliberate act, done with the Join bar inside the room once you have
    // read it — following a link should never quietly make you a member.
    const m = /\/join\/(\d+)/.exec(url);
    if (m) {
      const info = await apiFetch(`/room-info/${m[1]}`);
      if (info.error) { Alert.alert('Cannot open room', info.error); return; }
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
    setForwardOpen(true);
  }

  function doForward(target: any) {
    // In multi-select the sheet forwards every picked message, oldest first,
    // so they arrive in the order they were written.
    const ids = forwardMsg
      ? [forwardMsg.id]
      : messagesRef.current.filter(m => selectedIds.has(m.id)).map(m => m.id);
    if (!ids.length) return;
    // Sequentially, waiting for each ack: firing them all at once let the
    // server insert them in whatever order they happened to arrive, so a
    // forwarded conversation could land shuffled in the destination chat.
    (async () => {
      for (const id of ids) {
        const err = await new Promise<string | null>(resolve => {
          socketRef.current?.emit('forward_message', { messageId: id, toRoomId: target.id },
            (res: any) => resolve(res?.error || null));
          setTimeout(() => resolve(null), 6000);   // never hang the loop
        });
        if (err) { Alert.alert('Cannot forward', err); break; }
      }
    })();
    setForwardMsg(null);
    setForwardOpen(false);
    exitSelectMode();
  }

  // Forward picker opened for the current multi-selection rather than one message.
  async function openForwardPickerForSelection() {
    const [rooms, dms] = await Promise.all([apiFetch('/rooms'), apiFetch('/dm-rooms')]);
    setForwardTargets([
      ...(Array.isArray(rooms) ? rooms.map((r: any) => ({ ...r, _label: `# ${r.name}` })) : []),
      ...(Array.isArray(dms) ? dms.map((d: any) => ({ ...d, _label: `💬 ${d.other_username}` })) : []),
    ]);
    setForwardMsg(null);   // signals "use the selection"
    setForwardOpen(true);
  }

  function deleteSelected() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    Alert.alert(
      `Delete ${ids.length} message${ids.length > 1 ? 's' : ''}?`, '',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: () => {
            ids.forEach(id => socketRef.current?.emit('delete_message', { messageId: id }));
            exitSelectMode();
          },
        },
      ],
    );
  }

  // Become a member of the room already on screen (the Join bar above the
  // composer). You are already here, so there is nothing to navigate to —
  // just refresh membership so the bar goes away.
  function joinThisRoom() {
    socketRef.current?.emit('accept_invite', { roomId: room.id }, (res: any) => {
      if (res?.error) { Alert.alert('Cannot join', res.error); return; }
      loadRoomInfo();
    });
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

  // The media endpoint returns objects now; older servers returned bare
  // strings. Both are handled so a stale server does not empty the gallery.
  const normaliseMediaUrls = (list: any): string[] =>
    (Array.isArray(list) ? list : []).map((x: any) => (typeof x === 'string' ? x : x?.url)).filter(Boolean);

  const roomLink = `${BASE_URL}/join/${room.id}`;
  // Server-rendered, disk-cached thumbnail for an /uploads path. Media paths
  // now carry a signature (?e=&s=); /thumb checks the same one, so it has to
  // be carried across rather than dropped with the rest of the path.
  const thumbUrl = (uploadPath: string, w: number) => {
    const [bare, query] = String(uploadPath).split('?');
    const name = encodeURIComponent(bare.replace(/^\/uploads\//, ''));
    return `${BASE_URL}/thumb/${name}?w=${w}${query ? '&' + query : ''}`;
  };
  // Public rooms are readable by anyone but writable only by members.
  const notMember = !room.is_dm && !!roomInfo && !roomInfo.is_member;

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
  //   • long press on a text bubble : the platform's own text selection
  //   • long press elsewhere        : multi-select (forward/delete several)
  //   • tap on media                : opens the media; never the menu
  //   • tap on the space beside a message : opens the menu (which has Copy)
  //   • any tap while multi-selecting toggles that message instead
  const tapTimer = useRef<any>(null);

  function openMenuFor(msg: Message, e?: any) {
    setActionsMsg({ msg, x: e?.nativeEvent?.pageX ?? 0, y: e?.nativeEvent?.pageY ?? 0 });
  }

  // Bubbles whose primary content is text — everything else opens media on tap.
  function isTextual(m: Message) {
    return m.type === 'text' || m.type === 'system' || m.type === 'call' || m.type === 'invite';
  }
  function canSelectText(m: Message) {
    return isTextual(m) && !!(m.content || '').trim() && m.type !== 'invite' && m.type !== 'call';
  }

  /**
   * Whether a message's content may be selected, copied, downloaded or shared.
   *
   * Two rules, both about the same thing — content that was sent on the
   * understanding it would not travel:
   *
   *  • A DISAPPEARING message cannot be copied out. Copying defeats the point
   *    of a message that deletes itself, so selection is off for exactly those
   *    messages — and stays on for everything sent before the mode was turned
   *    on, and after it is turned off, which are ordinary messages.
   *  • In a PRIVATE room, only the message's own author may take their content
   *    out of it. You can always copy and download what you wrote yourself.
   */
  function canTakeContent(m: Message) {
    if (m.disappear_seconds) return false;
    const priv = !!(roomInfo?.is_private ?? room.is_private);
    if (priv && m.username !== me) return false;
    return true;
  }

  // ── Multi-select ───────────────────────────────────────────────────────────
  function toggleSelected(msg: Message) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
      return next;
    });
  }
  function enterSelectMode(msg: Message) {
    clearTimeout(tapTimer.current);
    setSelectedIds(new Set([msg.id]));
  }
  function exitSelectMode() { setSelectedIds(new Set()); }

  function onMessageLongPress(msg: Message) {
    enterSelectMode(msg);
  }

  // Tap on a text bubble, or on the empty space beside any message.
  //
  // No double-tap handling any more: text selection is the platform's job now
  // (long-press or double-tap on a selectable Text), so a tap no longer has to
  // wait to find out whether a second one is coming. The menu opens at once.
  function onMessageTap(msg: Message, e: any, _fromText: boolean) {
    if (selectedIds.size) { toggleSelected(msg); return; }
    openMenuFor(msg, e);
  }

  useEffect(() => () => clearTimeout(tapTimer.current), []);

  useEffect(() => locationManager.subscribe(() => setLiveShare(locationManager.activeShare())), []);
  useEffect(() => {
    const t = setInterval(() => setClockTick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  // Hardware back on the video: shrink first, close from the floating window.
  // Leaving the chat outright would be a surprise while something is playing.
  useEffect(() => {
    if (!videoItem) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!videoMini) { setVideoMini(true); return true; }
      setVideoItem(null);
      setVideoMini(false);
      return true;
    });
    return () => sub.remove();
  }, [videoItem, videoMini]);

  // The fullscreen map takes hardware back before the chat does.
  useEffect(() => {
    if (openLocationId == null) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setOpenLocationId(null);
      return true;
    });
    return () => sub.remove();
  }, [openLocationId]);

  // Hardware back closes search before it leaves the chat.
  useEffect(() => {
    if (!searching) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSearching(false);
      setHighlightId(null);
      return true;
    });
    return () => sub.remove();
  }, [searching]);

  // Hardware back gets out of a selection first, rather than leaving the chat
  // with messages still picked.
  useEffect(() => {
    if (!selectedIds.size) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectedIds.size) { exitSelectMode(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [selectedIds.size]);

  // Membership gates posting, so it must be known as soon as the room opens —
  // not only when the info sheet is opened.
  useEffect(() => { if (!room.is_dm) loadRoomInfo(); }, [room.id]);

  function leaveRoom() {
    Alert.alert('Leave this room?', 'You will stop receiving its messages.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave', style: 'destructive',
        onPress: () => socketRef.current?.emit('leave_room_membership', { roomId: room.id }, (res: any) => {
          if (res?.error) { Alert.alert('Cannot leave', res.error); return; }
          setShowRoomInfo(false);
          onBack();
        }),
      },
    ]);
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

  // The user chose a resolution (and possibly trimmed): do the work, then send.
  async function sendChosenVideo(choice: VideoChoice) {
    const pending = videoChoice;
    setVideoChoice(null);
    if (!pending) return;

    // Hand the transcode to uploadFile as a deferred step: the bubble appears
    // straight away and this runs behind it, reporting onto the bubble's own
    // progress bar. Pressing Send now feels instant even for a 4K clip.
    const prep = async (onProgress: (p: number) => void) => {
      let uri = choice.uri;
      let name = pending.item.name;
      if (choice.quality !== 'original') {
        uri = await compressVideo(
          choice.uri, choice.quality, choice.size, onProgress, pending.bytes, choice.seconds,
        );
      }
      // Re-encoding, and the trimmer, both produce an mp4 whatever went in.
      if (uri !== pending.item.uri) name = name.replace(/\.[^.]+$/, '') + '.mp4';
      return { uri, name };
    };

    uploadFile(choice.uri, pending.item.name, 'video/mp4', pending.caption, pending.oneTime,
      sendQuality, prep);
  }

  // Actions for the photo currently open in the viewer. The url is matched
  // back to the shared-media list so "Show in chat" knows which message it
  // came from.
  const [viewerActions, setViewerActions] = useState<MediaItem | null>(null);
  function openViewerActions() {
    if (!viewerUrl) return;
    const rel = viewerUrl.startsWith(BASE_URL) ? viewerUrl.slice(BASE_URL.length) : viewerUrl;
    const list: any[] = Array.isArray(mediaData?.images) ? mediaData.images : [];
    const hit = list.find((x: any) => (typeof x === 'string' ? x : x?.url) === rel);
    setViewerActions(hit && typeof hit === 'object'
      ? hit
      : { url: rel, name: rel.split('/').pop() || 'photo' });
  }

  // What the media browser's long-press menu does. Everything routes through
  // the same helpers the chat itself uses, so a file behaves identically
  // whether it is opened from a bubble or from the gallery.
  async function onMediaAction(action: MediaAction, item: MediaItem) {
    const abs = item.url.startsWith('http') ? item.url : `${BASE_URL}${item.url}`;
    if (action === 'showInChat') {
      if (!item.msgId) { toast('That message is no longer here'); return; }
      setShowMedia(false);
      setViewerFromMedia(false);
      // Paging back to an old message takes a moment; close the browser first
      // so the jump is visible rather than happening behind it.
      jumpToMessage(Number(item.msgId));
      return;
    }
    if (action === 'open') {
      const images = normaliseMediaUrls(mediaData?.images);
      const idx = images.indexOf(item.url);
      if (idx >= 0) {
        setShowMedia(false);
        setViewerFromMedia(true);
        openViewer(`${BASE_URL}${images[idx]}`, images.map(u => `${BASE_URL}${u}`));
      } else {
        Linking.openURL(abs).catch(() => toast('Could not open this'));
      }
      return;
    }
    // Download and Share reuse the chat's own paths, which already handle the
    // durable copy, the progress and the OS share sheet.
    const asMessage: any = {
      id: item.msgId ?? `media-${item.url}`,
      file_path: item.url.startsWith('http') ? item.url : item.url,
      file_name: item.name || item.url.split('/').pop() || 'file',
      type: item.kind === 'music' ? 'music' : item.kind === 'video' ? 'video' : 'file',
    };
    if (action === 'download') downloadMedia(asMessage);
    else if (action === 'share') shareOut(asMessage);
  }

  // Post a location. `liveMinutes` 0 = a one-off pin; anything else starts a
  // live share that keeps updating the SAME message.
  async function sendLocation(liveMinutes: number) {
    setShowLocationMenu(false);
    if (!(await locationManager.ensurePermission())) {
      Alert.alert('Location needed', 'Allow location access to share where you are.');
      return;
    }
    const pos = await locationManager.currentPosition();
    if (!pos) { Alert.alert('No position', 'Could not get your location. Try again outdoors.'); return; }

    const liveUntil = liveMinutes > 0 ? Date.now() + liveMinutes * 60_000 : null;
    const payload = { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, liveUntil, updatedAt: Date.now() };

    socketRef.current?.emit('send_message', {
      roomId: room.id, type: 'location', content: JSON.stringify(payload),
    }, (res: any) => {
      if (res?.error) { Alert.alert('Could not share location', res.error); return; }
    });

    if (liveUntil) {
      // The message id only exists once the server echoes it back, so the
      // watcher starts from the echo rather than guessing.
      pendingLiveShare.current = { until: liveUntil };
    }
  }

  // Set between requesting a live share and its message arriving back.
  const pendingLiveShare = useRef<{ until: number } | null>(null);

  function stopLiveShare() {
    locationManager.stopSharing();
  }

  // Every location in this chat, newest position per sender. Live shares win
  // over old static pins so a person appears once, where they actually are.
  const locationPins = useMemo<LocationPin[]>(() => {
    const byUser = new Map<string, LocationPin>();
    const loose: LocationPin[] = [];
    for (const m of messages) {
      if (m.type !== 'location') continue;
      const p = parseLocation(m.content);
      if (!p) continue;
      const pin: LocationPin = { id: m.id, username: m.username, payload: p, mine: m.username === me };
      if (isLiveNow(p)) {
        const prev = byUser.get(m.username);
        if (!prev || (p.updatedAt || 0) >= (prev.payload.updatedAt || 0)) byUser.set(m.username, pin);
      } else {
        loose.push(pin);
      }
    }
    // A static pin is still worth showing unless that person is live.
    return [...byUser.values(), ...loose.filter(p => !byUser.has(p.username))];
  }, [messages, me, clockTick]);

  // Distances are only meaningful with a position of our own.
  useEffect(() => {
    if (myPosition || !locationPins.length) return;
    let alive = true;
    (async () => {
      const granted = await locationManager.ensurePermission().catch(() => false);
      if (!granted) return;
      const p = await locationManager.currentPosition();
      if (alive && p) setMyPosition({ lat: p.lat, lng: p.lng });
    })();
    return () => { alive = false; };
  }, [locationPins.length, myPosition]);

  useEffect(() => {
    const sock = socketRef.current;
    if (!sock) return;
    const onChanged = ({ roomId, seconds }: any) => {
      if (String(roomId) !== String(room.id)) return;
      setDisappearing(seconds || 0);
    };
    sock.on('disappearing_changed', onChanged);
    return () => { sock.off('disappearing_changed', onChanged); };
  }, [room.id, socketRef.current]);

  // A countdown started somewhere — record the deadline so the ring can be
  // drawn, on the sender's side as well as the reader's.
  useEffect(() => {
    const sock = socketRef.current;
    if (!sock) return;
    const onStarted = ({ roomId, started }: any) => {
      if (String(roomId) !== String(room.id) || !Array.isArray(started)) return;
      const byId = new Map(started.map((x: any) => [String(x.messageId), x.expiresAt]));
      setMessages(prev => prev.map(m =>
        byId.has(String(m.id)) ? { ...m, expires_at: byId.get(String(m.id)) } : m));
    };
    sock.on('expiry_started', onStarted);
    return () => { sock.off('expiry_started', onStarted); };
  }, [room.id, socketRef.current]);

  // Everyone in the room sees live pins move.
  useEffect(() => {
    const sock = socketRef.current;
    if (!sock) return;
    const onMoved = ({ messageId, roomId, content }: any) => {
      if (String(roomId) !== String(room.id)) return;
      setMessages(prev => prev.map(m =>
        String(m.id) === String(messageId) ? { ...m, content } : m));
    };
    sock.on('location_updated', onMoved);
    return () => { sock.off('location_updated', onMoved); };
  }, [room.id, socketRef.current]);

  function replyPreview(msg: Message): string {
    if (msg.reply_type === 'audio') return '🎙 Voice message';
    if (msg.reply_type === 'image') return '🖼 Image';
    if (msg.reply_type === 'gallery') return '🖼 Photos';
    if (msg.reply_type === 'video') return '🎥 Video';
    if (msg.reply_type === 'music') return '🎵 Audio file';
    if (msg.reply_type === 'file') return '📄 File';
    if (msg.reply_type === 'location') return '📍 Location';
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
      // The name is NOT pressable — these are announcements, not people to
      // message, and a stray tap opening a DM was surprising.
      return (
        <View style={s.systemRow}>
          <Text style={s.systemText}>
            <Text style={s.systemName}>
              {d.avatar ? `${d.avatar} ` : ''}{isMe ? 'You' : who}
            </Text>
            {d.kind === 'disappearing_on' || d.kind === 'disappearing_off'
              ? <Text>{' '}{disappearingPredicate(d.seconds || 0)}</Text>
              : d.kind === 'removed'
              ? <Text>{' '}{isMe ? 'were' : 'was'} removed from the room{d.byUsername ? ` by ${d.byUsername}` : ''}</Text>
              : d.kind === 'left'
              ? <Text>{' '}left the room</Text>
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

    const picked = selectedIds.has(msg.id);
    return (
      <View style={[s.msgRow, picked && s.msgRowPicked]}>
      {/* Press-catcher across the WHOLE row, behind the bubble: the empty
          space beside a message reacts exactly like the message does. It sits
          behind, so the bubble's own taps, media taps and swipe-to-reply all
          keep priority. It must live here rather than inside msgWrapper —
          that is capped at 80% width, so a catcher in there covered only the
          bubble's own column. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={(e) => onMessageTap(msg, e, false)}
        onLongPress={() => onMessageLongPress(msg)}
        delayLongPress={350}
      />
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
          enabled={!selectedIds.size}
          onSwipeRight={() => { setReplyTo({ id: msg.id, username: msg.username, content: msg.content, type: msg.type }); composerRef.current?.focus(); }}
          onSwipeLeft={mine ? () => deleteMsg(msg.id) : undefined}
        >
        {(() => {
        const textual = isTextual(msg);
        // While the text is being selected the bubble must not capture
        // touches at all, or the OS selection handles never get them.
        // Text: tap is routed for the double-tap check. Media: no tap handler,
        // so a tap reaches the image/video and only opens it.
        // Text bubbles are NOT pressable: a Pressable ancestor swallows the
        // long-press that starts native text selection. The row-wide catcher
        // behind the bubble still opens the menu from the space beside it, and
        // the menu carries Copy.
        const bubbleProps: any = textual
          ? {}
          : {
              onPress: selectedIds.size ? () => toggleSelected(msg) : undefined,
              activeOpacity: 1,
              onLongPress: () => onMessageLongPress(msg),
              delayLongPress: 350,
            };
        const Bubble: any = textual ? View : TouchableOpacity;
        return (
        <Bubble
          {...bubbleProps}
          style={[s.bubble, mine ? s.mineBubble : s.theirsBubble,
                  highlightId === msg.id && s.bubbleHighlight,
                  ]}
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
            // Plain <Text selectable>, never swapped for a TextInput.
            //
            // The old approach replaced the bubble with an editable field on
            // double-tap so the selection could be set programmatically. A
            // TextInput lays text out differently from a Text — different line
            // breaking and vertical metrics — so on some devices the message
            // visibly jumped and a line could end up clipped out of the bubble.
            // Losing sight of the message you are trying to copy is a worse
            // failure than not pre-selecting a word.
            //
            // Native selection on a selectable Text does the job: long-press or
            // double-tap picks the word under the finger, the handles adjust it,
            // and the system Copy appears. Nothing re-lays-out, so nothing moves.
            <Text
              style={s.msgText}
              selectable={canTakeContent(msg)}
            >{renderTextWithLinks(msg.content || '')}{msg.edited ? <Text style={s.edited}> (edited)</Text> : null}{msg.one_time_seconds ? <Text style={s.oneTimeTag}> 🔥{msg.one_time_seconds}s</Text> : null}</Text>
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
                onPress={() => {
                  if (selectedIds.size) { toggleSelected(msg); return; }
                  if (!msg._uploading) openViewer(uri);
                }}
                onLongPress={() => onMessageLongPress(msg)}
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
                onLongPress={() => onMessageLongPress(msg)}
                onOpen={(i) => { if (selectedIds.size) toggleSelected(msg); else openViewer(full[i]); }}
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
              <VideoBubble
                url={uri}
                uploading={!!msg._uploading}
                onLongPress={() => onMessageLongPress(msg)}
                // `playUrl` is the downloaded copy when there is one, so a
                // saved video opens instantly and works with no signal.
                onOpen={(playUrl) => {
                  if (selectedIds.size) { toggleSelected(msg); return; }
                  setVideoPlaylist(chatVideos());
                  setVideoItem({ id: msg.id, url: playUrl, name: msg.file_name || 'Video' });
                  setVideoMini(false);
                  if (msg.one_time_seconds && !mine) startOneTimeClock(msg);
                }}
              />
            );
          })()}
          {!hiddenOneTime && msg.type === 'location' && (() => {
            const p = parseLocation(msg.content);
            if (!p) return <Text style={s.msgText}>📍 Location (unreadable)</Text>;
            const live = isLiveNow(p);
            const away = myPosition ? distanceMeters(myPosition, p) : null;
            return (
              <TouchableOpacity
                activeOpacity={0.85}
                onPress={() => {
                  if (selectedIds.size) { toggleSelected(msg); return; }
                  setOpenLocationId(msg.id);
                }}
                onLongPress={() => onMessageLongPress(msg)}
                delayLongPress={350}
              >
                <View style={s.locCard}>
                  {/* A still preview: not interactive, so the tap opens the
                      fullscreen map instead of being eaten by a map drag. */}
                  <TileMap
                    center={{ lat: p.lat, lng: p.lng }}
                    zoom={15}
                    markers={[{ at: { lat: p.lat, lng: p.lng }, label: '', mine, live }]}
                    width={224}
                    height={132}
                    interactive={false}
                  />
                  <View style={s.locFoot}>
                    <Ionicons
                      name={live ? 'navigate' : 'location'}
                      size={14}
                      color={live ? '#22c55e' : C.accent}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.locTitle} numberOfLines={1}>
                        {live ? 'Live location' : 'Location'}
                      </Text>
                      <Text style={s.locSub} numberOfLines={1}>
                        {live ? formatRemaining(p.liveUntil || 0) : formatCoords(p)}
                        {away != null ? ` · ${formatDistance(away)} away` : ''}
                      </Text>
                    </View>
                  </View>
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
          {!hiddenOneTime && msg.type !== 'text' && msg.type !== 'invite' && msg.type !== 'call'
            && msg.type !== 'location' && msg.content ? (
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
              <TouchableOpacity onPress={() => retryUpload(msg, true)}>
                <Text style={s.uploadRetryText}>⚠️ Failed — tap to retry</Text>
              </TouchableOpacity>
            </View>
          )}
        </Bubble>
        );
        })()}
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
          {/* How much life this message has left. Absent until someone has
              actually seen it — an unread message is not counting down. */}
          {msg.disappear_seconds ? (
            msg.expires_at ? (
              <ExpiryRing expiresAt={msg.expires_at} seconds={msg.disappear_seconds} />
            ) : (
              <Text style={s.pendingExpiry}>⏳</Text>
            )
          ) : null}
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
    // Swipe in from either side edge to leave the chat, like the device's back
    // button. Suspended whenever something is on top or the user is in the
    // middle of something modal — going back from under a fullscreen video or
    // out of a half-finished selection would be a surprise.
    <EdgeBack
      onBack={onBack}
      enabled={
        !videoItem && openLocationId == null && !cameraMode
        && !selectedIds.size && !searching
        && !forwardOpen && !showPlayer && !recording
      }
    >
    <KeyboardAvoidingView
      // A visibly different, darker chat while messages are being destroyed.
      // The mode is easy to forget you switched on, and forgetting it is
      // exactly when it does damage — so the whole screen says so, not a
      // single small icon.
      style={[s.container, disappearing > 0 && s.containerSecret]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {disappearing > 0 && (
        <View style={s.secretBar}>
          <Text style={s.secretBarText} numberOfLines={1}>
            ⏳  Disappearing messages on · {disappearingLabel(disappearing)}
          </Text>
        </View>
      )}
      {/* Multi-select action bar. Replaces the header while messages are
          picked, the way every chat app does it, so the count and the actions
          sit where the user is already looking. */}
      {selectedIds.size > 0 && (
        <View style={s.selBar}>
          <TouchableOpacity onPress={exitSelectMode} style={s.selBarBtn} hitSlop={hitSlop10}>
            <Ionicons name="close" size={24} color={C.text} />
          </TouchableOpacity>
          <Text style={s.selBarCount}>{selectedIds.size} selected</Text>
          <TouchableOpacity onPress={openForwardPickerForSelection} style={s.selBarBtn} hitSlop={hitSlop10}>
            <Ionicons name="arrow-redo-outline" size={23} color={C.accent} />
          </TouchableOpacity>
          <TouchableOpacity onPress={deleteSelected} style={s.selBarBtn} hitSlop={hitSlop10}>
            <Ionicons name="trash-outline" size={22} color="#f87171" />
          </TouchableOpacity>
        </View>
      )}

      {/* Search takes over the header while it is open, like every chat app
          people already use — the chat stays visible underneath so results can
          be scrolled to as they are stepped through. */}
      {selectedIds.size === 0 && searching && (
        <ChatSearch
          onClose={() => { setSearching(false); setHighlightId(null); }}
          onSearch={async (q) => {
            const r = await apiFetch(`/search-messages/${room.id}?q=${encodeURIComponent(q)}`);
            if (!r || r.error) return { results: [], encryptedSkipped: 0 };
            return { results: r.results || [], encryptedSkipped: r.encryptedSkipped || 0 };
          }}
          onJump={(id) => jumpToMessage(id)}
        />
      )}

      {/* Header */}
      {selectedIds.size === 0 && !searching && (
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
        {/* Search, where the profile avatar used to be. Your own avatar is one
            tap away on the rooms list; searching a chat is something you want
            FROM inside the chat. */}
        <TouchableOpacity onPress={() => setSearching(true)} style={s.callBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="search" size={22} color={C.accent} />
        </TouchableOpacity>
      </View>
      )}

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
                // Replaces the library's bare <Image>, which shows nothing but
                // black while loading and stays black forever on failure.
                renderItem={({ item, setImageDimensions }: any) => (
                  <GalleryImage uri={item} setImageDimensions={setImageDimensions} />
                )}
              />
              {/* Close and Download used to sit here as separate buttons. They
                  are in the ⋯ menu now — three controls in a row over the
                  picture, two of them duplicating the menu beside them, was
                  clutter on top of the thing you came to look at. Swipe down
                  still closes. */}
              {/* The same actions as the gallery's long-press menu, on the
                  photo you are actually looking at — including Show in chat. */}
              {(
                <TouchableOpacity
                  onPress={() => openViewerActions()}
                  style={s.lightboxMore}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons name="ellipsis-horizontal" size={20} color="#fff" />
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


      {/* Preparing a file for the OS share sheet: it has to be downloaded
          first, which is not instant for a large file. */}
      <Modal visible={sharingOut} transparent animationType="fade">
        <View style={s.busyOverlay}>
          <View style={s.busyCard}>
            <ActivityIndicator size="large" color={C.accent} />
            <Text style={s.busyText}>Preparing file…</Text>
          </View>
        </View>
      </Modal>

      {/* In-app camera, fullscreen */}
      <Modal visible={!!cameraMode} animationType="slide" onRequestClose={() => setCameraMode(null)} statusBarTranslucent>
        {cameraMode && (
          <CameraScreen
            initialMode={cameraMode}
            onClose={() => setCameraMode(null)}
            onDone={(shots) => {
              setCameraMode(null);
              setPendingMedia(prev => [...prev, ...shots]);
            }}
          />
        )}
      </Modal>

      <EmojiEditor visible={editEmojis} onClose={() => setEditEmojis(false)} />

      <FullMusicPlayer
        visible={showPlayer}
        onClose={() => setShowPlayer(false)}
        tracks={chatTracks()}
        roomId={room.id}
        roomMeta={room}
      />

      {/* Video player. Rendered in-tree (not in a Modal) so minimising to the
          floating window keeps the same <Video> alive and playing. */}
      <VideoPlayer
        item={videoItem}
        playlist={videoPlaylist}
        minimized={videoMini}
        onMinimize={() => setVideoMini(true)}
        onExpand={() => setVideoMini(false)}
        onClose={() => { setVideoItem(null); setVideoMini(false); }}
        onSelect={(it) => setVideoItem(it)}
      />

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
          keyExtractor={keyExtractor}
          // Render a screenful, not the whole history. Without these the list
          // mounts far more rows than are visible, and every one of them costs
          // on each re-render.
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          updateCellsBatchingPeriod={50}
          windowSize={9}
          renderItem={renderMessage}
          // extraData was an inline ARRAY LITERAL, which is a new object on
          // every render — so FlatList re-rendered every visible row on EVERY
          // state change anywhere in the screen, including opening a sheet.
          // That is what made the One-time menu feel slow to open and close.
          extraData={rowExtraData}
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
        <TouchableOpacity
          style={[s.scrollFab, (replyTo || editingId) && s.scrollFabRaised]}
          onPress={handleScrollFabPress}
        >
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
              <View style={s.attachIconWrap}><Ionicons name="camera" size={20} color={C.accent} /></View>
              <Text style={s.attachOptionText}>Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.attachOption} onPress={() => pickFromCamera('video')}>
              <View style={s.attachIconWrap}><Ionicons name="videocam" size={20} color={C.accent} /></View>
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
                  {favEmojis.map(e => (
                    <TouchableOpacity key={e} onPress={() => toggleReact(emojiPicker.id, e)} style={s.emojiBtn}>
                      <Text style={s.emoji}>{e}</Text>
                    </TouchableOpacity>
                  ))}
                  <View style={s.sheetReactDivider} />
                  <TouchableOpacity onPress={() => { setEmojiPicker(null); setEditEmojis(true); }} style={s.emojiEditBtn}>
                    <Ionicons name="options-outline" size={17} color={C.accent} />
                  </TouchableOpacity>
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
      {/* animationType="none": the slide-up took ~300ms on top of the modal's
          own mount cost, which is what made the menu feel slow to appear. */}
      <Modal visible={!!actionsMsg} transparent animationType="none" onRequestClose={() => setActionsMsg(null)}>
        <View style={s.sheetOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setActionsMsg(null)} />
          {actionsMsg && (() => {
            const m = actionsMsg.msg;
            const mineMsg = m.username === me;
            const hidden = !!m.one_time_seconds && !mineMsg && !revealedOneTime.has(m.id);
            const close = () => setActionsMsg(null);
            // Whole row is the button — the label used to be the only thing
            // that reacted, so a tap an inch to its right did nothing.
            const Row = ({ icon, label, onPress, danger }: any) => (
              <Pressable
                style={({ pressed }) => [s.sheetRow, pressed && s.sheetRowPressed]}
                android_ripple={{ color: 'rgba(128,128,128,0.18)' }}
                onPress={onPress}
              >
                <Text style={s.sheetRowIcon}>{icon}</Text>
                <Text style={[s.sheetRowText, danger && s.sheetRowDanger]}>{label}</Text>
              </Pressable>
            );

            // A failed (never-sent) message only supports local actions.
            if (m._uploadFailed) {
              return (
                <View style={s.actionSheet}>
                  <View style={s.sheetGrip} />
                  <Row icon="🔄" label="Retry" onPress={() => { close(); retryUpload(m, true); }} />
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
                  {favEmojis.map(e => (
                    <TouchableOpacity key={e} style={s.sheetReactBtn}
                      onPress={() => { close(); toggleReact(m.id, e); }}>
                      <Text style={s.sheetReactEmoji}>{e}</Text>
                    </TouchableOpacity>
                  ))}
                  {/* Edit button at the end of the list — styled as a
                      control, not as one more emoji to react with. */}
                  <View style={s.sheetReactDivider} />
                  <TouchableOpacity style={s.sheetReactEditBtn} onPress={() => { close(); setEditEmojis(true); }}>
                    <Ionicons name="options-outline" size={18} color={C.accent} />
                  </TouchableOpacity>
                </ScrollView>
                <View style={s.sheetDivider} />

                <Row icon="↩" label="Reply" onPress={() => {
                  close();
                  setReplyTo({ id: m.id, username: m.username, content: m.content, type: m.type });
                  composerRef.current?.focus();
                }} />
                {/* Inline selection is unreliable on any message containing a
                    link, a phone number or even a price: those render as
                    pressable spans and swallow the long-press. This always
                    works, whatever the message contains. */}
                {m.type === 'text' && !hidden && !!m.content && canTakeContent(m) && (
                  <Row icon="✏️" label="Select text" onPress={() => {
                    close();
                    setSelectTextOf(m.content || '');
                  }} />
                )}
                {(m.type === 'text' || (m.file_path && !m.one_time_seconds)) && !hidden && canTakeContent(m) && (
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
                {m.file_path && !hidden && !m.one_time_seconds && canTakeContent(m) && (
                  <Row icon="⬇" label="Download" onPress={() => { close(); downloadMedia(m); }} />
                )}
                {m.file_path && !hidden && !m.one_time_seconds && canTakeContent(m) && (
                  <Row icon="📤" label="Share to another app" onPress={() => { close(); shareOut(m); }} />
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

      {/* Shared media browser — fullscreen, and it keeps your place. */}
      <MediaBrowser
        visible={showMedia}
        title={room.other_username || room.name}
        data={mediaData}
        tab={mediaTab}
        onTab={setMediaTab}
        onClose={() => setShowMedia(false)}
        thumbUrl={thumbUrl}
        baseUrl={BASE_URL}
        focusIndex={mediaFocusIndex}
        onOpenImage={(i, all) => {
          setShowMedia(false);
          setViewerFromMedia(true);
          openViewer(all[i], all);
        }}
        onAction={onMediaAction}
      />

      {/* One-time message duration picker */}
      <Modal visible={showOneTimeMenu} transparent animationType="slide" onRequestClose={() => setShowOneTimeMenu(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowOneTimeMenu(false)} />
          <View style={s.attachSheet}>
            <View style={s.sheetHandle} />
            {/* Two compact rows of chips instead of a scroll of full-width
                rows. Both settings and their current state are visible at a
                glance, and choosing one is a single tap without reading a
                list. */}
            <Text style={s.fireHeading}>🔥  One-time message</Text>
            <Text style={s.fireHint}>Just the next message, gone after it is opened</Text>
            <View style={s.chipRow}>
              {[5, 30, 60].map(secs => (
                <TouchableOpacity
                  key={secs}
                  style={[s.chip, oneTimeSecs === secs && s.chipOn]}
                  onPress={() => chooseOneTime(oneTimeSecs === secs ? null : secs)}
                >
                  <Text style={[s.chipText, oneTimeSecs === secs && s.chipTextOn]}>{secs}s</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[s.chip, !oneTimeSecs && s.chipOn]}
                onPress={() => chooseOneTime(null)}
              >
                <Text style={[s.chipText, !oneTimeSecs && s.chipTextOn]}>Off</Text>
              </TouchableOpacity>
            </View>

            <View style={s.sheetDivider} />

            <Text style={s.fireHeading}>⏳  Disappearing messages</Text>
            <Text style={s.fireHint}>
              Every new message from both of you, deleted after it is seen
            </Text>
            <View style={s.chipRow}>
              {DISAPPEARING_OPTIONS.filter(v => v > 0).map(secs => (
                <TouchableOpacity
                  key={`d${secs}`}
                  style={[s.chip, disappearing === secs && s.chipOn]}
                  onPress={() => chooseDisappearing(disappearing === secs ? 0 : secs)}
                >
                  <Text style={[s.chipText, disappearing === secs && s.chipTextOn]}>
                    {disappearingLabel(secs).replace(' seconds', 's').replace(' minutes', 'm')
                      .replace('1 hour', '1h').replace('24 hours', '24h').replace('1 week', '1w')}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[s.chip, !disappearing && s.chipOn]}
                onPress={() => chooseDisappearing(0)}
              >
                <Text style={[s.chipText, !disappearing && s.chipTextOn]}>Off</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={s.attachCancel} onPress={() => setShowOneTimeMenu(false)}>
              <Text style={s.attachCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* How to send a video: resolution, and trimming. */}
      {videoChoice && (
        <VideoSendSheet
          visible
          uri={videoChoice.item.uri}
          originalBytes={videoChoice.bytes}
          onCancel={() => setVideoChoice(null)}
          onConfirm={sendChosenVideo}
        />
      )}
      {jumping && (
        <View style={s.jumpingBar}>
          <ActivityIndicator size="small" color={C.accent} />
          <Text style={s.transcodeText}>Finding that message…</Text>
        </View>
      )}
      {videoWorking > 0 && (
        <View style={s.transcodeBar}>
          <ActivityIndicator size="small" color={C.accent} />
          <Text style={s.transcodeText}>
            Preparing video… {Math.round(videoWorking * 100)}%
          </Text>
        </View>
      )}

      {/* Share location */}
      <Modal visible={showLocationMenu} transparent animationType="slide" onRequestClose={() => setShowLocationMenu(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowLocationMenu(false)} />
          <View style={s.attachSheet}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>📍 Share location</Text>
            <TouchableOpacity style={s.attachOption} onPress={() => sendLocation(0)}>
              <Text style={s.attachOptionText}>Send my current location</Text>
            </TouchableOpacity>
            <Text style={s.oneTimeHint}>
              Live location keeps updating for everyone in this chat until it ends or you stop it.
            </Text>
            {[15, 60, 480].map(mins => (
              <TouchableOpacity key={mins} style={s.attachOption} onPress={() => sendLocation(mins)}>
                <Text style={s.attachOptionText}>
                  Share live for {mins < 60 ? `${mins} minutes` : mins === 60 ? '1 hour' : `${mins / 60} hours`}
                </Text>
              </TouchableOpacity>
            ))}
            {liveShare ? (
              <TouchableOpacity style={s.attachOption} onPress={() => { setShowLocationMenu(false); stopLiveShare(); }}>
                <Text style={[s.attachOptionText, { color: '#f87171' }]}>Stop sharing live location</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={s.attachCancel} onPress={() => setShowLocationMenu(false)}>
              <Text style={s.attachCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={!!viewerActions} transparent animationType="fade" onRequestClose={() => setViewerActions(null)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewerActions(null)} />
          <View style={s.attachSheet}>
            <View style={s.sheetHandle} />
            {(([
              ['showInChat', '💬  Show in chat'],
              // Saving a one-time photo would defeat it.
              ...(isOneTimeUrl(viewerUrl) ? [] : [['download', '⬇  Download'] as [MediaAction, string]]),
              ...(isOneTimeUrl(viewerUrl) ? [] : [['share', '📤  Share'] as [MediaAction, string]]),
            ] as [MediaAction, string][])).map(([action, label]) => (
              <TouchableOpacity key={action} style={s.attachOption} onPress={() => {
                const it = viewerActions; setViewerActions(null);
                if (!it) return;
                setViewer(null);
                onMediaAction(action, it);
              }}>
                <Text style={s.attachOptionText}>{label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={s.attachOption} onPress={() => { setViewerActions(null); closeViewer(); }}>
              <Text style={s.attachOptionText}>✕  Close photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.attachCancel} onPress={() => setViewerActions(null)}>
              <Text style={s.attachCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {selectTextOf != null && (
        <TextViewer
          visible
          text={selectTextOf}
          onClose={() => setSelectTextOf(null)}
          onCopyAll={() => { copy(selectTextOf, 'message'); setSelectTextOf(null); }}
        />
      )}

      {/* Fullscreen map for a tapped location, with everyone who is sharing. */}
      {openLocationId != null && (
        <LocationView
          pins={locationPins}
          focusId={openLocationId}
          onClose={() => setOpenLocationId(null)}
        />
      )}

      {/* Forward picker */}
      <Modal visible={forwardOpen} transparent animationType="slide" onRequestClose={() => { setForwardOpen(false); setForwardMsg(null); }}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => { setForwardOpen(false); setForwardMsg(null); }} />
          <View style={s.attachSheet}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>{forwardMsg ? 'Forward to…' : `Forward ${selectedIds.size} message${selectedIds.size > 1 ? 's' : ''} to…`}</Text>
            <ScrollView style={{ maxHeight: 380 }} nestedScrollEnabled>
              {forwardTargets.map(t => (
                <TouchableOpacity key={`${t.is_dm ? 'd' : 'r'}${t.id}`} style={s.attachOption} onPress={() => doForward(t)}>
                  <Text style={s.attachOptionText}>{t._label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.attachCancel} onPress={() => { setForwardOpen(false); setForwardMsg(null); }}>
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
            {/* Leave is the counterpart to Join. The owner cannot leave their
                own room, so it is hidden for them. */}
            {roomInfo && !roomInfo.is_owner && roomInfo.is_member && (
              <TouchableOpacity style={s.leaveRoomBtn} onPress={leaveRoom}>
                <Text style={s.leaveRoomText}>Leave room</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={s.attachCancel} onPress={() => setShowRoomInfo(false)}>
              <Text style={s.attachCancelText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Streaming a live location is easy to forget about, so it stays
          visible with Stop one tap away. */}
      {liveShare ? (
        <View style={s.liveBar}>
          <Ionicons name="navigate" size={15} color="#22c55e" />
          <Text style={s.liveBarText} numberOfLines={1}>
            {String(liveShare.roomId) === String(room.id)
              ? `Sharing your live location · ${formatRemaining(liveShare.until)}`
              : `Sharing live location in another chat · ${formatRemaining(liveShare.until)}`}
          </Text>
          <TouchableOpacity onPress={stopLiveShare} hitSlop={hitSlop10}>
            <Text style={s.liveBarStop}>Stop</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Not a member: the room is read-only, so the Join bar REPLACES the
          composer rather than sitting above it. The server enforces the same
          rule, so a stale screen cannot post either. */}
      {notMember ? (
        <View style={s.joinBar}>
          <Text style={s.joinBarText} numberOfLines={1}>
            Join this room to post in it
          </Text>
          <TouchableOpacity style={s.joinBarBtn} onPress={joinThisRoom}>
            <Text style={s.joinBarBtnText}>Join</Text>
          </TouchableOpacity>
        </View>
      ) : recording ? (
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
          onLocation={() => setShowLocationMenu(true)}
          liveLocation={!!liveShare}
          disappearing={disappearing}
          sendQuality={sendQuality}
          onQuality={chooseQuality}
          onToggleQuickEmoji={setQuickEmoji}
          onRemoveMedia={(i) => setPendingMedia(prev => prev.filter((_, j) => j !== i))}
          onPreviewMedia={(uri) => openViewer(uri)}
        />
      )}
      {burst.key > 0 && burst.emoji ? (
        <EmojiBurst key={burst.key} emoji={burst.emoji} onDone={() => setBurst(b => ({ ...b, emoji: '' }))} />
      ) : null}
    </KeyboardAvoidingView>
    </EdgeBack>
  );
}

const hitSlop10 = { top: 10, bottom: 10, left: 10, right: 10 };
// Bubble padding, subtracted from a tap so it lines up with the text box.
const BUBBLE_PAD = 10;

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
  // The ONLY selection indicator. The bubble used to be tinted as well,
  // which read as two different colours stacked on each other.
  msgRowPicked: { backgroundColor: 'rgba(59,125,216,0.22)' },
  selBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: C.header, padding: 12, paddingTop: 14,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  selBarBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  selBarCount: { flex: 1, color: C.text, fontSize: 16.5, fontWeight: '700', marginLeft: 4 },
  msgTextInput: { padding: 0, margin: 0, textAlignVertical: 'top' },
  msgTextRTL: { textAlign: 'right', writingDirection: 'rtl' },
  bubbleRow: { flexDirection: 'row', alignItems: 'center', maxWidth: '100%' },
  bubbleRowMine: { flexDirection: 'row-reverse' },
  leaveRoomBtn: {
    marginTop: 8, marginHorizontal: 16, borderRadius: 12,
    paddingVertical: 13, alignItems: 'center',
    borderWidth: 1, borderColor: '#f87171',
  },
  leaveRoomText: { color: '#f87171', fontSize: 15, fontWeight: '700' },
  attachIconWrap: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(59,125,216,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  busyOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  busyCard: {
    backgroundColor: C.header, borderRadius: 16, paddingHorizontal: 30, paddingVertical: 26,
    alignItems: 'center', gap: 14,
  },
  busyText: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  jumpingBar: {
    position: 'absolute', left: 14, right: 14, top: 90,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.sidebar, borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: C.border, zIndex: 40,
  },
  transcodeBar: {
    position: 'absolute', left: 14, right: 14, bottom: 96,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.sidebar, borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: C.border, zIndex: 40,
  },
  transcodeText: { color: C.text, fontSize: 13, fontWeight: '600' },

  locCard: {
    width: 224, borderRadius: 12, overflow: 'hidden',
    borderWidth: 1, borderColor: C.border, backgroundColor: C.sidebar,
  },
  locFoot: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 9 },
  locTitle: { color: C.text, fontSize: 13.5, fontWeight: '700' },
  locSub: { color: C.muted, fontSize: 11.5, marginTop: 1 },

  liveBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: 'rgba(34,197,94,0.14)',
    borderTopWidth: 1, borderTopColor: 'rgba(34,197,94,0.3)',
  },
  liveBarText: { flex: 1, color: C.text, fontSize: 12.5, fontWeight: '600' },
  liveBarStop: { color: '#f87171', fontSize: 12.5, fontWeight: '800' },

  joinBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: C.sidebar, borderTopWidth: 1, borderTopColor: C.border,
  },
  joinBarText: { color: C.muted, fontSize: 13.5, flex: 1 },
  joinBarBtn: { backgroundColor: C.accent, borderRadius: 16, paddingHorizontal: 20, paddingVertical: 8 },
  joinBarBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
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
  emojiEditBtn: {
    width: 38, height: 38, borderRadius: 19, marginHorizontal: 2,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(59,125,216,0.14)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: C.accent,
  },
  sheetReactDivider: {
    width: StyleSheet.hairlineWidth, height: 26, marginHorizontal: 7,
    backgroundColor: C.border, alignSelf: 'center',
  },
  sheetReactEditBtn: {
    width: 46, height: 46, borderRadius: 23, marginHorizontal: 3,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(59,125,216,0.14)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: C.accent,
  },
  // ── The "secret" skin ──────────────────────────────────────────────────────
  pendingExpiry: { fontSize: 10, opacity: 0.55 },
  containerSecret: { backgroundColor: '#141a24' },
  secretBar: {
    backgroundColor: '#1f2a3a',
    paddingVertical: 6, paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#31415a',
  },
  secretBarText: { color: '#9fb4d4', fontSize: 11.5, fontWeight: '700', textAlign: 'center' },
  fireHeading: { color: C.text, fontSize: 15.5, fontWeight: '800', paddingHorizontal: 16, paddingTop: 6 },
  fireHint: { color: C.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16,
    borderWidth: 1, borderColor: C.border, backgroundColor: 'transparent',
  },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  chipText: { color: C.text, fontSize: 13, fontWeight: '700' },
  chipTextOn: { color: '#fff' },
  sheetDivider: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginVertical: 8 },
  sheetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    paddingHorizontal: 22, paddingVertical: 16, width: '100%', minHeight: 54,
  },
  sheetRowPressed: { backgroundColor: 'rgba(128,128,128,0.14)' },
  sheetRowIcon: { fontSize: 19, width: 26, textAlign: 'center' },
  // flex:1 so the label fills the row — nothing dead to the right of the text.
  sheetRowText: { color: C.text, fontSize: 16, fontWeight: '500', flex: 1 },
  sheetRowDanger: { color: '#f87171' },
  sheetCancel: {
    marginTop: 8, marginHorizontal: 16, backgroundColor: C.inputBg,
    borderRadius: 14, paddingVertical: 14, alignItems: 'center',
  },
  sheetCancelText: { color: C.muted, fontSize: 16, fontWeight: '600' },
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
  // The reply/edit banner adds a row above the composer; without this the FAB
  // sat right on top of the banner's ✕.
  scrollFabRaised: { bottom: 214 },
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
  lightboxMore: { position: 'absolute', top: 50, end: 108, width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center', zIndex: 10 },
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
