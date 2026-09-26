import React, { useEffect, useMemo, useRef, useState, useCallback, useReducer } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, Dimensions,
  ActivityIndicator, Modal, ScrollView, Image, Linking, Share, Pressable, AppState, BackHandler,
  PanResponder, DeviceEventEmitter,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as storage from '../storage';
import * as pickFailure from '../pickFailure';
import { BUILD_VERSION } from '../version';
import * as Clipboard from 'expo-clipboard';
import * as IntentLauncher from 'expo-intent-launcher';
import * as ScreenCapture from 'expo-screen-capture';
import {
  PinchGestureHandler, PanGestureHandler, State as GHState, GestureHandlerRootView,
} from 'react-native-gesture-handler';
import { C, isRTL } from '../theme';
import { baseDirection, textDirection, isolate as bidiIsolate } from '../bidi';
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
import MediaBrowser, { MediaAction, MediaItem, MediaTab } from '../components/MediaBrowser';
import * as rm from '../roomMedia';
import { linksFrom, mergeLinks } from '../mediaLinks';
import {
  canComment, showsBadge, badgeLabel, normaliseCount, commentsTitle, EMPTY_HINT,
} from '../comments';
import {
  commentsBarLabel, parentPreview, isNearBottom, shouldStickToBottom,
  showsJumpButton, closesOnSwipe,
} from '../commentsView';
import * as up from '../uploadProgress';
import UploadOverlay from '../components/UploadOverlay';
import SaveOverlay from '../components/SaveOverlay';
import * as save from '../saveProgress';
import { parseDataUri, pastedName, fileUriFromText, extensionFor, shouldReadText, clipboardOffer } from '../pasteDrop';
import * as pending from '../pendingMedia';
import * as textDraft from '../textDraft';
import {
  activityBar, sendKindFor, announceOnChange, nextInFlight, SendKind, Sender,
} from '../activityBar';
import * as Contacts from 'expo-contacts';
import {
  AttachAction, OPENS_IN, opensCamera, contactMessage, contactWorthSending,
} from '../attachActions';
import { dropExpired, msUntilNextExpiry } from '../expiryRing';
import { isMine, markMine } from '../messageSide';
import {
  deleteKind, deleteEvent, deleteLabel, deleteConfirm, splitForDeletion, splitConfirm,
} from '../messageDelete';
import LocationPicker from '../components/LocationPicker';
import PeerSheet from '../components/PeerSheet';
import { PeerView, ClearScope, vanishedStyle } from '../peerActions';
import * as peerActions from '../peerActions';
import * as messageInfo from '../messageInfo';
import * as live from '../liveIndicator';
import * as saveTarget from '../saveTarget';
import * as pick from '../locationPick';
import { uploadResumable } from '../chunkedUpload';

/**
 * Thrown when the user pressed cancel, so it can be told apart from a real
 * failure. Module scope, not inside the component: a class redeclared on every
 * render is a different class each time, and `instanceof` across renders would
 * quietly answer false.
 */
class UploadCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'UploadCancelled'; }
}
import ImageWithSpinner from '../components/ImageWithSpinner';
import GalleryImage from '../components/GalleryImage';
import VideoPlayer, { VideoItem } from '../components/VideoPlayer';
import VideoBubble from '../components/VideoBubble';
import EdgeBack from '../components/EdgeBack';
import ExpiryRing from '../components/ExpiryRing';
import TextViewer from '../components/TextViewer';
import * as mediaCache from '../mediaCache';
import * as offline from '../offlineStore';
import ImageEditor from '../components/ImageEditor';
import SelectedRow, { SelectionCount } from '../components/SelectedRow';
import SelectableText, { clearSelectionOf } from '../components/SelectableText';
import LinkCard from '../components/LinkCard';
import { spentByToken, menuWasStrayTap } from '../tokenTap';
import { shownText, showsToggle, toggleLabel } from '../longText';
import * as attachments from '../videoDownloads';
import {
  kindOf, tapAction as fileTapAction, cardMeta, showsDownloadButton, installHelp, openHelp, isApk,
} from '../fileOpen';
import * as voiceRecorder from '../voiceRecorder';
import { shouldWarm, WARM_TTL_MS } from '../recordStart';
import * as selection from '../selection';
import { searchLocal, mergeResults } from '../localSearch';
import * as win from '../messageWindow';
import { fabMode, atPresent, clearsUnseenOnTap, fabBottom, chipBottom } from '../scrollFab';
import {
  reduceSelection, initialSelection, stillMoving, LONG_PRESS_MS, DOUBLE_TAP_MS,
  type SelectionState, type MsgId,
} from '../textSelection';
import ChatSearch from '../components/ChatSearch';
import TileMap from '../components/TileMap';
import LocationView, { LocationPin } from '../components/LocationView';
import * as locationManager from '../locationManager';
import {
  parseLocation, isLiveNow, formatRemaining, formatCoords, distanceMeters, formatDistance,
  type LatLng,
} from '../geo';
import CameraScreen from './CameraScreen';
import * as Sharing from 'expo-sharing';
import SwipeableMessage from '../components/SwipeableMessage';
import MusicPlayer from '../components/MusicPlayer';
import FullMusicPlayer from '../components/FullMusicPlayer';
import type { Track } from '../audioManager';
import { guessMime, messageTypeFor, fileIcon, extOf } from '../mime';
import { progressPercent } from '../download';
import { compressForSend } from '../compressImage';
import VideoSendSheet, { VideoChoice } from '../components/VideoSendSheet';
import { compressVideo } from '../compressVideo';
import { VideoQuality } from '../videoQuality';
import { Quality } from '../imageQuality';
import { tokenize, telHref, toAsciiDigits } from '../textTokens';
import { DISAPPEARING_OPTIONS, disappearingLabel, disappearingPredicate, chipLabel, oneTimePredicate } from '../disappearing';
import { toast } from '../components/Toast';
import * as outbox from '../outbox';
import EmojiBurst from '../components/EmojiBurst';
import EmojiEditor from '../components/EmojiEditor';
import { useOrderedFavEmojis, noteEmojiUse } from '../favEmojis';
import { canOpenMenu, forwardedTo } from '../messageMenu';
import {
  phaseFor as e2ePhaseFor, undecryptedBody, undecryptedQuote,
  keepTryingKey, keyRetryDelay,
} from '../e2eState';
import {
  noteComment, clearFor, countFor, chooseJump, jumpLabel,
  badgeLabel as commentBadgeLabel, jumpArrow, Jump,
} from '../commentUnread';
import { firstUnread, worthJumping, unreadLabel, unreadDivider } from '../unreadJump';
import { marksRead, opensAsRead } from '../readPosition';
import { isForRoom } from '../presence';
import { safeName, cacheName, renamed, editableStem } from '../fileName';

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
  /**
   * Sent to somebody who has blocked the sender.
   *
   * Only ever set on the sender's own copy — the recipient never receives the
   * message at all. It exists so their own chat can show it as never having
   * landed, rather than pretending it went through.
   */
  blocked_delivery?: number;
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

/**
 * Lay a message out the way it is written.
 *
 * The rule lives in src/bidi.ts so the web and the app cannot disagree about
 * which way a paragraph goes — a message that reads correctly on one and is
 * scrambled on the other is worse than either.
 */
function msgDirStyle(text: string) {
  const { dir, align } = textDirection(text);
  return { writingDirection: dir, textAlign: align } as const;
}

// Kept for the select sheet, which asks the same question.
function looksRTLText(t: string): boolean {
  return baseDirection(t) === 'rtl';
}

export default function ChatScreen({ room, onBack, onOpenDM, onOpenProfile, onOpenRoom, initialJumpMsgId, initialCommentTarget, initialShare, onShareConsumed }: {
  room: { id: number; name: string; is_dm: number; other_username?: string; other_avatar?: string | null; is_private?: number; created_by?: number };
  initialShare?: { files?: { path: string; mimeType?: string; fileName?: string }[]; text?: string | null } | null;
  onShareConsumed?: () => void;
  onBack: () => void;
  onOpenDM: (room: { id: number; name: string; is_dm: number; other_username?: string }) => void;
  onOpenProfile: () => void;
  /** Open a DIFFERENT chat and land on one message in it. */
  onOpenRoom?: (room: any, msgId: number) => void;
  initialJumpMsgId?: number | null;
  /** A tapped comment notification: the thread to open, and the comment in it. */
  initialCommentTarget?: { parentId: number; commentId: number | null } | null;
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
  // ── Typing / recording / sending, as CLAIMS rather than latches ──────────
  //
  // Each of these used to be a list a name went into on "started" and came
  // out of on "stopped" — so it was correct only if the stop event always
  // arrived, and it does not: the sender's app is killed, their socket drops,
  // they lose signal mid-recording. Then "Dr.Soran is recording…" stands on
  // screen for ever, which is what was photographed.
  //
  // Now each name is remembered with the time it was last heard, and anything
  // not repeated recently is dropped. See src/liveIndicator.ts.
  const [typingAt, setTypingAt] = useState<live.Claims>({});
  const [recordingAt, setRecordingAt] = useState<live.Claims>({});
  const [sendingAt, setSendingAt] = useState<Record<string, { at: number; kind: SendKind }>>({});
  // Bumped by a timer while anything is live, so the lists above are re-read
  // and the expired names disappear without an event to prompt it.
  const [indicatorTick, setIndicatorTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const typing = React.useMemo(() => live.active(typingAt, Date.now()), [typingAt, indicatorTick]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const recordingUsers = React.useMemo(() => live.active(recordingAt, Date.now()), [recordingAt, indicatorTick]);
  const sendingUsers = React.useMemo<Sender[]>(() => {
    const now = Date.now();
    return Object.keys(sendingAt)
      .filter(u => now - sendingAt[u].at < live.EXPIRY_MS)
      .map(u => ({ username: u, kind: sendingAt[u].kind }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendingAt, indicatorTick]);

  // The timer runs ONLY while something is showing. An idle chat costs
  // nothing, and the one that is showing something wrong for a few seconds is
  // the whole complaint.
  const somethingLive = typing.length > 0 || recordingUsers.length > 0 || sendingUsers.length > 0;
  useEffect(() => {
    if (!somethingLive) return;
    const t = setInterval(() => setIndicatorTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [somethingLive]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | string | null>(null);
  // Read from callbacks that must not be rebuilt on every edit — the draft
  // writer in particular, which has to know whether what is in the composer is
  // a new message or somebody's edit of an old one.
  const editingIdRef = useRef<number | string | null>(null);
  editingIdRef.current = editingId;
  // Reaction picker: rendered in a Modal at the tap position so ANY outside tap closes it
  const [emojiPicker, setEmojiPicker] = useState<{ id: number | string; x: number; y: number } | null>(null);
  const [recording, setRecording] = useState(false);
  // Fullscreen image viewer. images is snapshotted ONCE when opening so the
  // gallery's data prop stays stable (churning it on every swipe made fast
  // swiping hang and left stale frames behind on close). viewerIdx tracks the
  // current image for the counter / save / screenshot-guard.
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null);
  const [viewerIdx, setViewerIdx] = useState(0);
  // Resolved once when the viewer opens: which of these photos must not be
  // written to disk.
  const [viewerNoCache, setViewerNoCache] = useState<Set<string>>(new Set());
  // A photo staged for sending, opened for a look. Deliberately NOT the chat's
  // media viewer: that one offers "Show in chat", Download and Share, none of
  // which mean anything for a picture that has not been sent yet.
  const [pendingPreview, setPendingPreview] = useState<{ uri: string; index: number } | null>(null);
  // The photo currently open in the editor, and where it came from.
  const [editing, setEditing] = useState<{ uri: string; index?: number } | null>(null);
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
    const base = list ?? chatImageUrls();
    let idx = base.indexOf(url);
    let images = base;
    if (idx < 0) { images = [url, ...base]; idx = 0; }
    setViewerIdx(idx);
    setViewerNoCache(noCacheUrls());
    setViewer({ images, index: idx });
  }
  function closeViewer() {
    // Remember the image being looked at, not the scroll offset — the grid
    // scrolls to this index when it reappears.
    setMediaFocusIndex(viewerIdx);
    setViewer(null);
    // The grid was never closed, so there is nothing to re-open — it has been
    // sitting underneath the whole time.
    //
    // It used to be closed on the way in and opened again here, which meant
    // two Android modal windows swapping places: the photo's window is torn
    // down before the grid's is created, and in between the chat behind them
    // both is on screen. That single frame is the reported "for one instant
    // you see the chat and then the gallery".
    if (viewerFromMedia) { setViewerFromMedia(false); setMediaOpenId(n => n + 1); }
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
  // What a jump is FOR, not merely that one is happening.
  //
  // Reported as: closing the search box and tapping the "back to the newest"
  // arrow says "Finding that message…". It was the same banner for both, and
  // for the arrow it is simply untrue — there is no "that message"; the
  // person asked to go to the end of the chat.
  const [jumping, setJumping] = useState<null | 'message' | 'latest'>(null);
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
  // Who is in THIS room's voice chat, from callManager's per-room record.
  // Held as state so the badge and banner re-render when somebody joins or
  // leaves a call this screen is not part of.
  const [voiceIn, setVoiceIn] = useState(() => callManager.voiceIn(room.id));

  // callManager records every room's voice chat, including rooms nobody has
  // open. This subscribes the header badge and the join banner to it.
  useEffect(() => {
    const sync = () => setVoiceIn(callManager.voiceIn(room.id));
    sync();
    // Both subscriptions: onRoomVoice fires when somebody else joins or
    // leaves, subscribe fires when I do — and the banner hides itself once I
    // am in the call, so it has to hear about both.
    const offRoom = callManager.onRoomVoice(sync);
    const offMine = callManager.subscribe(sync);
    return () => { offRoom(); offMine?.(); };
  }, [room.id]);
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
  // Whether one-time messages are allowed in this chat at all. Either side may
  // switch them off for BOTH — the person a self-destructing message is aimed
  // at is the one who has to live with it, and until now only the sender had a
  // say. The server refuses them too; this is only what the composer offers.
  const [oneTimeAllowed, setOneTimeAllowed] = useState(true);
  useEffect(() => {
    let alive = true;
    apiFetch(`/room-settings/${room.id}`)
      .then((r: any) => {
        if (!alive || !r || r.error) return;
        setDisappearing(r.disappearingSeconds || 0);
        setOneTimeAllowed(r.oneTimeAllowed !== false);
        if (r.oneTimeAllowed === false) setOneTimeSecs(null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [room.id]);
  function chooseOneTimeAllowed(allowed: boolean) {
    socketRef.current?.emit('set_one_time_allowed', { roomId: room.id, allowed }, (res: any) => {
      if (res?.error) { Alert.alert('Could not change', res.error); return; }
      setOneTimeAllowed(!!res.allowed);
      // An armed one-time message would otherwise be sent into a chat that has
      // just forbidden them, and be refused on send.
      if (!res.allowed) setOneTimeSecs(null);
    });
  }
  function chooseDisappearing(seconds: number) {
    setShowOneTimeMenu(false);
    socketRef.current?.emit('set_disappearing', { roomId: room.id, seconds }, (res: any) => {
      if (res?.error) { Alert.alert('Could not change', res.error); return; }
      setDisappearing(res.seconds || 0);
    });
  }
  // Which long messages the reader has opened out. Kept per chat screen: a
  // message folds itself again when the chat is left, which is the behaviour
  // that keeps a scrolled-back chat readable.
  const [expandedIds, setExpandedIds] = useState<Set<number | string>>(new Set());
  function toggleExpanded(id: number | string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const [actionsMsg, setActionsMsg] = useState<{ msg: Message; x: number; y: number } | null>(null); // tap menu for a message
  // Long press puts the chat into multi-select: pick several messages and
  // forward or delete them in one go.
  // Whether select mode is ON — the one part of selection that genuinely
  // changes the whole screen (toolbar appears, taps mean "tick"). WHICH
  // messages are ticked lives in src/selection.ts, outside React, because
  // keeping it here re-rendered every mounted row on every tick.
  const [selectMode, setSelectMode] = useState(false);
  // Subscribes to the selection directly, so ticking a message redraws this
  // number and the one row involved — not the list.
  // The one message whose text is currently being selected in place.
  // Controlled selection range, used only to preselect the whole message the
  // instant double-tap turns it into a selectable field; released a moment
  // later so the handles become draggable.
  const [pendingMedia, setPendingMedia] = useState<{ uri: string; name: string; mime: string }[]>([]);
  /** The staged file being renamed, what has been typed, and its old name. */
  const [renaming, setRenaming] = useState<{ index: number; value: string; of: string } | null>(null);
  /**
   * Staged photos survive leaving the chat.
   *
   * Reported as: take pictures, go back to the chat list, come back — the
   * images are gone. They were: this screen unmounts when you leave it, and
   * the photos lived only in its state. The files were still on the device,
   * with nothing pointing at them.
   *
   * Restored before the first paint the user can act on, and written on every
   * change. `restoredDraft` guards the write: an empty list on the very first
   * render is "not loaded yet", not "the user removed everything", and saving
   * it would erase the draft we are about to read.
   */
  const restoredDraft = useRef(false);

  useEffect(() => {
    let alive = true;
    restoredDraft.current = false;
    (async () => {
      let items: pending.Staged[] = [];
      try {
        items = pending.parse(await AsyncStorage.getItem(pending.draftKey(room.id)), Date.now());
        // The cache directory is Android's to empty. Anything gone is dropped
        // here rather than becoming a broken tile that fails on send.
        const present = new Set<string>();
        await Promise.all(items.map(async m => {
          try { if ((await FileSystem.getInfoAsync(m.uri)).exists) present.add(m.uri); } catch {}
        }));
        const alive2 = pending.keepExisting(items, uri => present.has(uri));
        const note = pending.lostMessage(items.length, alive2.length);
        items = alive2;
        if (note && alive) toast(note);
      } catch { items = []; }
      if (!alive) return;
      // Merge rather than replace: a photo shared into the app, or taken
      // while this was loading, must not be thrown away by the restore.
      if (items.length) setPendingMedia(prev => (prev.length ? [...items, ...prev] : items));
      restoredDraft.current = true;
    })();
    return () => { alive = false; };
  }, [room.id]);

  useEffect(() => {
    if (!restoredDraft.current) return;
    const key = pending.draftKey(room.id);
    const raw = pending.serialize(pendingMedia, Date.now());
    (raw ? AsyncStorage.setItem(key, raw) : AsyncStorage.removeItem(key)).catch(() => {});
  }, [pendingMedia, room.id]);

  /**
   * …and the other half of a half-written message: the TEXT.
   *
   * Reported alongside the photos: typing anything into the composer and
   * leaving the chat lost it. The staged photos above already survived, and
   * the sentence did not, because the text lives inside the composer's own
   * state — deliberately, so a keystroke re-renders one small component
   * instead of every message on screen — and that component is unmounted the
   * moment you go back to the list.
   *
   * So the composer reports what is typed, it is held in a ref (rendering from
   * it here would undo the whole reason it lives down there), and it is
   * written on a short debounce and flushed on the way out. See
   * src/textDraft.ts.
   */
  const draftRef = useRef('');
  const draftWritten = useRef('');
  const draftTimer = useRef<any>(null);

  const writeDraft = useCallback((text: string) => {
    if (!textDraft.changed(text, draftWritten.current)) return;
    draftWritten.current = text;
    const key = textDraft.draftKey(room.id);
    const raw = textDraft.serialize(text, Date.now());
    (raw ? AsyncStorage.setItem(key, raw) : AsyncStorage.removeItem(key)).catch(() => {});
  }, [room.id]);

  const onDraftChange = useCallback((text: string) => {
    draftRef.current = text;
    // Not while editing an existing message: that text belongs to the message
    // being edited, and coming back to find it in the composer with the edit
    // no longer in progress would send somebody's edit as a new message.
    if (editingIdRef.current != null) return;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => writeDraft(draftRef.current), textDraft.SAVE_DEBOUNCE_MS);
  }, [writeDraft]);

  // Restore on open, and flush on the way out. The flush is what catches the
  // common case: the last keystroke before tapping back is still inside the
  // debounce window when this screen goes away.
  useEffect(() => {
    let alive = true;
    draftRef.current = '';
    draftWritten.current = '';
    (async () => {
      let saved = '';
      try {
        saved = textDraft.parse(
          await AsyncStorage.getItem(textDraft.draftKey(room.id)), Date.now());
      } catch { saved = ''; }
      if (!alive || !saved) return;
      // Anything already in the composer wins: text shared in from another app
      // or a forward got there because the user just did something, and a
      // week-old draft must not land on top of it.
      const next = textDraft.restoredText(saved, composerRef.current?.getText());
      if (next === composerRef.current?.getText()) return;
      composerRef.current?.setText(next);
      draftRef.current = next;
      draftWritten.current = next;
    })();
    const roomAtOpen = room.id;
    return () => {
      alive = false;
      clearTimeout(draftTimer.current);
      // Written against the room this effect belongs to, not whatever room is
      // current by the time the cleanup runs — otherwise leaving chat A for
      // chat B files A's draft under B.
      if (editingIdRef.current != null) return;
      const text = draftRef.current;
      if (!textDraft.changed(text, draftWritten.current)) return;
      const key = textDraft.draftKey(roomAtOpen);
      const raw = textDraft.serialize(text, Date.now());
      (raw ? AsyncStorage.setItem(key, raw) : AsyncStorage.removeItem(key)).catch(() => {});
    };
  }, [room.id]);

  /** Nothing left to keep: the message went. */
  const clearDraft = useCallback(() => {
    clearTimeout(draftTimer.current);
    draftRef.current = '';
    draftWritten.current = '';
    AsyncStorage.removeItem(textDraft.draftKey(room.id)).catch(() => {});
  }, [room.id]);
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
  /**
   * How many times this chat has asked for the peer's key.
   *
   * State, not a ref: it decides what an unreadable bubble SAYS, and a ref
   * changing would leave the old words on screen — which is the reported bug
   * in its other half.
   */
  const [keyAttempts, setKeyAttempts] = useState(0);
  /**
   * Does this device have an unlocked identity at all?
   *
   * Starts true so the first paint says "Decrypting…" rather than announcing a
   * permanent failure before anything has been checked.
   */
  const [identityReady, setIdentityReady] = useState(true);
  const e2ePhase = e2ePhaseFor({
    hasKey: !!dmPeerPk.current, ready: identityReady, attempts: keyAttempts,
  });
  const [showE2EUnlock, setShowE2EUnlock] = useState(false);
  const [e2ePass, setE2ePass] = useState('');
  const [oneTimeExpiry, setOneTimeExpiry] = useState<Record<number, number>>({});
  const [, setOtTick] = useState(0); // 1s ticker while one-time countdowns run
  const [showMedia, setShowMedia] = useState(false);
  const [mediaTab, setMediaTab] = useState<MediaTab>('images');
  // What the gallery knows about this room. Held in a module cache too
  // (src/roomMedia.ts), so closing and reopening it does not refetch the room.
  const [mediaState, setMediaState] = useState<rm.MediaState | null>(null);

  // ── Comments ──
  //
  // A comment is an ordinary message with a parent, so this screen is the
  // message list again with the parent at the top of it — and, deliberately,
  // with the SAME composer underneath. A composer of its own would have been a
  // second, poorer one, and "comments have all the features" would have been a
  // promise rather than a fact: media, voice, one-time, location and the
  // upload progress work in a thread because they are the code that works in
  // the room.
  const [commentParent, setCommentParent] = useState<Message | null>(null);
  const [comments, setComments] = useState<Message[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  /** Counts that have moved since the messages were fetched, by parent id. */
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  /**
   * Comments that arrived and have not been looked at, by parent id.
   *
   * Reported as: the chat is badged, you open it, and there is nothing new.
   * There wasn't — in the chat. The new thing was a comment, which never
   * appears in the conversation and hangs off a message that may be far up the
   * list. These counts put a number in that message's strip and a chip at the
   * edge of the screen pointing the way to it.
   */
  const [unreadComments, setUnreadComments] = useState<Record<string, number>>({});
  /** What the visible range was at the last scroll, for choosing which way to point. */
  const viewRange = useRef({ first: 0, last: 0 });
  const [commentJump, setCommentJump] = useState<Jump | null>(null);
  /** The first message of this visit's unread run, so it can be marked on screen. */
  const [unreadFrom, setUnreadFrom] = useState<number | null>(null);
  /** A thread was closed; this message is where the reader should land. */
  const [pendingParentJump, setPendingParentJump] = useState<number | null>(null);
  /** How many were waiting when this chat was opened — the divider's number. */
  const commentParentRef = useRef<Message | null>(null); commentParentRef.current = commentParent;

  /**
   * The parent a send should be hung off, read AT THE MOMENT of sending.
   *
   * Not captured when the upload starts: a photo that takes twenty seconds
   * must land where the composer was pointing when Send was pressed, and
   * leaving the thread mid-upload must not silently redirect it into the room.
   */
  function sendingParentId(): number | null {
    const p = commentParentRef.current;
    return p ? (p.id as number) : null;
  }

  /**
   * Put an outgoing bubble where it was actually sent.
   *
   * Every optimistic bubble used to go into the room's list. For a comment
   * that is the one thing this feature must not do — your own comment would
   * appear in the conversation it was written about, and never show up in the
   * thread until the screen was reopened.
   *
   * `parentId` is the one captured when the send began, not the thread open
   * now: a photo uploading for twenty seconds must land in the thread it was
   * sent to even if the user has since gone back to the room.
   */
  function addOutgoing(msg: Message, parentId: number | null) {
    if (parentId) {
      setComments(prev => [...prev, msg]);
      // Always, whatever the reader was looking at: being left staring at
      // older comments after sending one is the bug.
      if (shouldStickToBottom({ reason: 'mine', nearBottom: commentsAtBottom.current })) {
        setTimeout(() => scrollCommentsToEnd(true), 50);
      }
    } else setMessages(prev => [...prev, msg]);
  }

  /**
   * Swap an optimistic bubble for the server's version, in whichever list it
   * went into. Returns false when it was not found, so the caller can decide
   * whether the message is new.
   */
  function replaceOutgoing(clientId: string, msg: Message): boolean {
    let found = false;
    const swap = (prev: Message[]) => {
      const idx = prev.findIndex(m => String(m.id) === clientId);
      if (idx === -1) return prev;
      found = true;
      const next = prev.slice();
      next[idx] = msg;
      return next;
    };
    setComments(swap);
    setMessages(swap);
    return found;
  }

  /** The number drawn in a message's own strip. Empty when nothing is waiting. */
  function unreadBadge(id: number | string): string {
    return commentBadgeLabel(countFor(unreadComments, id));
  }

  /**
   * Recompute which unread thread to point at, from what is on screen now.
   *
   * Kept as state rather than computed in render: it depends on the visible
   * RANGE, which changes on scroll and would otherwise redraw every message on
   * every frame of a flick.
   */
  function refreshCommentJump(counts: Record<string, number>) {
    const order = new Map(messagesRef.current.map((m, i) => [String(m.id), i]));
    const items = Object.keys(counts).map(id => ({
      id, index: order.has(id) ? (order.get(id) as number) : -1, count: counts[id],
    }));
    const next = chooseJump(items, viewRange.current);
    // Compared before setting: this runs on every viewability change, and a
    // fresh object each time would redraw the whole list mid-flick.
    const key = next ? `${next.id}:${next.dir}:${next.count}` : '';
    if (key === lastJumpKey.current) return;
    lastJumpKey.current = key;
    setCommentJump(next);
  }
  const lastJumpKey = useRef('');
  // Held in a ref because the viewability handler is created once and would
  // otherwise keep calling the first render's copy, with the first render's
  // (empty) counts.
  const refreshJumpRef = useRef<() => void>(() => {});
  refreshJumpRef.current = () => refreshCommentJump(unreadComments);

  /** Go to the message whose thread has something new, and stop pointing at it. */
  function goToUnreadComments() {
    const target = commentJump;
    if (!target) return;
    jumpToMessage(Number(target.id));
  }

  /** How many comments a message has now, live count first. */
  function commentCountOf(m: Message): number {
    const live = commentCounts[String(m.id)];
    return normaliseCount(live !== undefined ? live : (m as any).comment_count);
  }

  async function openComments(m: Message) {
    // Opened means read: the badge on this message and any chip pointing at it
    // go now, not when the fetch comes back.
    setUnreadComments(u => {
      const next = clearFor(u, m.id);
      setTimeout(() => refreshJumpRef.current(), 0);
      return next;
    });
    setCommentParent(m);
    setComments([]);
    setCommentsLoading(true);
    const res = await apiFetch(`/comments/${room.id}/${m.id}`).catch(() => null);
    setCommentsLoading(false);
    // The thread may have been closed, or another opened, while that was out.
    if (!commentParentRef.current || String(commentParentRef.current.id) !== String(m.id)) return;
    if (!res || res.error) {
      toast(res?.error || 'Could not load the comments');
      setCommentParent(null);
      return;
    }
    setCommentParent(res.parent);
    setComments(res.comments || []);
    markCommentsRead(m.id, res.comments || []);
    // Opening a thread shows its newest comment, like opening a chat.
    commentsAtBottom.current = true;
    setTimeout(() => scrollCommentsToEnd(false), 50);
    setCommentCounts(c => ({ ...c, [String(m.id)]: (res.comments || []).length }));
  }

  /**
   * Tell the server this thread has been read.
   *
   * A comment is a message, so it counts towards the room's badge — but the
   * mark that clears that badge is advanced from the CHAT's message list,
   * which never contains a comment, so the badge could never go away.
   * Reported exactly that way. The server keeps a mark per thread.
   */
  function markCommentsRead(parentId: number | string, list: Message[]) {
    const last = (list || []).reduce((n, c) => Math.max(n, Number(c.id) || 0), 0);
    if (!last) return;
    socketRef.current?.emit('mark_comments_read', { parentId, lastMsgId: last });
  }

  /** The first picture in the parent, whatever shape the message stores it in. */
  function parentThumb(msg: Message | null): string {
    const path = msg?.file_path;
    if (!path) return '';
    let rel = path;
    if (msg?.type === 'gallery') {
      try { rel = JSON.parse(path)[0] || ''; } catch { rel = ''; }
    }
    return rel ? `${BASE_URL}${rel}` : '';
  }

  /**
   * Leave the thread and go to the message it is about.
   *
   * The jump is REMEMBERED rather than performed here. Reported as: sometimes
   * back from a thread lands at the end of the chat.
   *
   * The message list is unmounted while a thread is open — `commentParent ?
   * null : <FlatList>` — so at this moment there is no list to scroll and no
   * ref to scroll it by. Closing is a state change React has not applied yet;
   * the old code scrolled 60ms later and hoped, and when the list had not
   * mounted by then the scroll went nowhere. An inverted FlatList mounts at
   * offset 0, which is the NEWEST message — the end of the chat, exactly as
   * reported.
   */
  function jumpToParentMessage() {
    const id = commentParent?.id;
    closeComments();
    if (id != null) setPendingParentJump(Number(id));
  }

  /**
   * Perform that jump once the list is really back.
   *
   * Waits for the ref rather than for a delay: a slow device with a long chat
   * is exactly the case a fixed timeout gets wrong, and it is also the case
   * where landing in the wrong place is most disorienting.
   */
  useEffect(() => {
    if (commentParent || pendingParentJump == null) return;
    let alive = true;
    let tries = 0;
    const go = () => {
      if (!alive) return;
      if (flatListRef.current) {
        jumpToMessage(pendingParentJump);
        setPendingParentJump(null);
        return;
      }
      if (tries++ < 20) { timer = setTimeout(go, 50); return; }
      // A second of waiting and no list: give up rather than jump into
      // whatever is on screen by then.
      setPendingParentJump(null);
    };
    let timer: any = setTimeout(go, 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [commentParent, pendingParentJump]);

  function closeComments() {
    setCommentParent(null);
    setComments([]);
    setCommentsJump(false);
    commentsAtBottom.current = true;
  }

  const commentsListRef = useRef<FlatList<Message> | null>(null);
  /** Was the reader at the end of the thread when the last comment arrived? */
  const commentsAtBottom = useRef(true);
  const [commentsJump, setCommentsJump] = useState(false);

  function scrollCommentsToEnd(animated: boolean) {
    commentsAtBottom.current = true;
    setCommentsJump(false);
    try { commentsListRef.current?.scrollToEnd({ animated }); } catch {}
  }

  function onCommentsScroll(e: any) {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const box = {
      scrollHeight: contentSize.height,
      scrollTop: contentOffset.y,
      clientHeight: layoutMeasurement.height,
    };
    commentsAtBottom.current = isNearBottom(box);
    setCommentsJump(showsJumpButton(box));
  }

  /**
   * A rightward drag leaves the thread.
   *
   * Deliberately not limited to drags that begin at the screen edge: that is
   * the system's own back gesture on both platforms, and asking for it
   * competes with the OS rather than serving the user.
   */
  const commentsSwipe = useRef(PanResponder.create({
    // Claimed only once the drag is clearly a rightward one, so scrolling the
    // thread is untouched.
    onMoveShouldSetPanResponder: (_e, g) => closesOnSwipe({ dx: g.dx, dy: g.dy }),
    onPanResponderRelease: (_e, g) => { if (closesOnSwipe({ dx: g.dx, dy: g.dy })) closeComments(); },
  })).current;
  const [mediaLoadingMore, setMediaLoadingMore] = useState(false);
  const mediaLoadingRef = useRef(false);
  // Counts opens of the gallery. The grid restores its position once per open
  // and only for this number, which is what stopped it scrolling by itself.
  const [mediaOpenId, setMediaOpenId] = useState(0);
  // The photo the media grid should return to. Set when the viewer closes,
  // so dismissing an image from the middle of a long gallery puts you back
  // where you were rather than at the top.
  const [mediaFocusIndex, setMediaFocusIndex] = useState(0);
  // "Info": who has seen this message, and when. null = closed, and the panel
  // shows a spinner while the answer is still coming back rather than an empty
  // list, which reads as "nobody has seen it".
  const [msgInfo, setMsgInfo] = useState<
    { loading: boolean; error?: string; sentAt?: number;
      seen?: any[]; notSeen?: any[] } | null>(null);
  const [forwardMsg, setForwardMsg] = useState<Message | null>(null);
  const [forwardTargets, setForwardTargets] = useState<any[]>([]);
  // Separate from forwardMsg: the picker is also opened for a multi-selection,
  // where there is no single message to hang visibility off.
  const [forwardOpen, setForwardOpen] = useState(false);
  // The person whose sheet is open — mute, block, clear history.
  const [peer, setPeer] = useState<PeerView | null>(null);
  const [peerOpen, setPeerOpen] = useState(false);
  const [showRoomInfo, setShowRoomInfo] = useState(false);
  const [roomInfo, setRoomInfo] = useState<any>(null);
  const [showPlayer, setShowPlayer] = useState(false);
  // Tapped link / phone number → sheet offering both sensible actions.
  const [tokenAction, setTokenAction] = useState<{ kind: 'url' | 'phone'; text: string } | null>(null);
  // Reordered when a picker OPENS, never while one is on screen.
  const favEmojis = useOrderedFavEmojis(!!emojiPicker || !!actionsMsg);
  const [editEmojis, setEditEmojis] = useState(false);
  // How many messages arrived while the user was scrolled up, shown as a badge
  // on the scroll-to-bottom button.
  const [missedCount, setMissedCount] = useState(0);
  // Read by the press handler, which runs outside the render that produced the
  // state and must not decide what the button means from a stale copy.
  const missedCountRef = useRef(0);
  const [inviteName, setInviteName] = useState('');
  const [inviteSuggestions, setInviteSuggestions] = useState<any[]>([]);
  const [inviteSearching, setInviteSearching] = useState(false);
  const [highlightId, setHighlightId] = useState<number | string | null>(null);
  const [showScrollFab, setShowScrollFab] = useState(false);
  // Unread messages in this chat that name me. Telegram-style: a button that
  // walks you through them oldest-first, because the point of a mention is
  // that someone wanted an answer, and it is usually not the newest message.
  const [mentionIds, setMentionIds] = useState<number[]>([]);
  // Who is in this chat, for the composer's @ suggestions. Loaded once per
  // chat: a request per keystroke would be absurd for a list this small.
  const [mentionables, setMentionables] = useState<string[]>([]);
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
  // True only after jumping to an old message: the loaded window sits in the
  // MIDDLE of the chat, with history both behind and ahead of it. Normally a
  // chat is loaded from its newest message backwards and the only direction
  // that can run out is older, which is why this did not exist before.
  const hasMoreNewerRef = useRef(false);
  /**
   * The same answer, as state.
   *
   * The ref is what the socket handlers and scroll maths read — they run
   * outside render and must not be a frame behind. But whether the list
   * anchors its content is a PROP, so it has to be rendered, and a ref cannot
   * cause that. They are written together, through setHasMoreNewer, rather
   * than being two facts that can disagree.
   */
  const [hasMoreNewer, setHasMoreNewerState] = useState(false);
  const setHasMoreNewer = useCallback((v: boolean) => {
    hasMoreNewerRef.current = v;
    setHasMoreNewerState(v);
  }, []);
  const loadingNewerRef = useRef(false);
  // Has the user dragged the list since the window was last replaced?
  //
  // The list is INVERTED, so its "start" is the newest end — and after a jump
  // the target sits about half a window from it, comfortably inside any
  // sensible threshold. onStartReached therefore fired the instant the jump
  // finished, loaded a page, fired again, and walked the entire history to the
  // present on its own, dragging the view along with it. Loading forward is
  // something the user asks for by scrolling towards it, never something that
  // happens because a jump landed nearby.
  const userDraggedRef = useRef(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const loadingOlderRef = useRef(false);
  const flatListRef = useRef<FlatList>(null);
  const messagesRef = useRef<Message[]>([]);
  const visibleIdRef = useRef<number | null>(null);
  const isNearBottomRef = useRef(true);
  const typingTimer = useRef<any>(null);
  const socketRef = useRef<any>(null);
  /**
   * Every socket listener this screen registered, so the cleanup removes
   * exactly its own.
   *
   * It used to call off(event) with no handler, which socket.io reads as
   * "remove EVERY listener for this event" — including src/socketNotifier.ts's,
   * which is what raises the notification when the app is closed. Leaving this
   * screen therefore silenced notifications, from a file that has never heard
   * of the notifier.
   */
  const chatHandlersRef = useRef<Array<[string, (...a: any[]) => void]>>([]);
  const meRef = useRef('');
  const title = room.is_dm ? (room.other_username || '') : room.name;

  // The FlatList is inverted (index 0 renders at the visual bottom), so the
  // latest message is on screen from the first frame with no scroll jump.
  const invertedMessages = React.useMemo(() => [...messages].reverse(), [messages]);

  /**
   * Where the unread line goes and what it says.
   *
   * Recomputed from `messages` whenever the list changes, rather than counted
   * once while the chat was loading and remembered. A remembered count keeps
   * describing the list it was taken from: delete a message under the line,
   * merge in an older page, or let one arrive mid-load, and the label and the
   * rows beneath it stop matching — which is the "3 NEW MESSAGES" sitting
   * above two of them.
   *
   * `messages` is chat order and the list is drawn inverted from a reversed
   * copy, so "after the anchor" here is "below the line" there.
   */
  const unreadInfo = React.useMemo(
    () => unreadDivider(messages, unreadFrom, me),
    [messages, unreadFrom, me],
  );
  const keyExtractor = useCallback((m: Message) => String(m.id), []);
  // Only the things a row actually reads. Anything else changing must NOT
  // invalidate the rows.
  // ── Native text selection ──────────────────────────────────────────────────
  // The OS owns the selection inside a <Text selectable>; it will not tell us
  // one exists, so we infer it (see textSelection.ts) and remount the bubble
  // to clear it. `selKey` is what forces that remount.
  const selState = useRef<SelectionState>(initialSelection);
  const selLast = useRef<{ id: MsgId; at: number } | null>(null);
  // Changing chat throws away every message on screen, and any selection with
  // them — but the belief that one is live would survive into the new chat and
  // eat the first tap there. `selLast` goes too: a stale "you just tapped
  // message 12" from the previous chat could pair up with a first tap here and
  // read as a double tap on a completely different message.
  useEffect(() => {
    selState.current = initialSelection;
    selLast.current = null;
    // Ticked messages belong to the chat they were ticked in. The store lives
    // outside React and outlives this screen, so it has to be emptied here or
    // a forward in the next chat would carry ids from the last one.
    selection.clear();
    setSelectMode(false);
    return () => { selection.clear(); };
  }, [room.id]);

  // Drop ticks for messages that are no longer here — deleted by their sender,
  // or gone with a reload. Leaving them would delete or forward something the
  // user can no longer see.
  useEffect(() => {
    if (!selectMode) return;
    if (selection.retain(messages.map(m => m.id))) setSelectMode(false);
  }, [messages, selectMode]);
  const holdTimer = useRef<any>(null);

  const rowExtraData = useMemo(
    // Upload progress is deliberately NOT here. It used to be, and every
    // report — hundreds during a video transcode — re-rendered every row in
    // the chat. Each bubble subscribes to its own progress instead.
    // e2ePhase, not just e2eActive: a chat that runs out of attempts goes from
    // "Decrypting…" to the permanent wording without the key ever changing,
    // and the rows have to be told.
    // unreadFrom too: it is drawn INSIDE a row, so a row that never re-renders
    // never grows the divider.
    () => ({ maxOtherReadMsgId, reactions, highlightId, online, revealedOneTime, e2eActive, selectMode, e2ePhase, unreadInfo }),
    [maxOtherReadMsgId, reactions, highlightId, online, revealedOneTime, e2eActive, selectMode, e2ePhase, unreadInfo],
  );

  const scrollBottom = useCallback(() => {
    flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  /**
   * Follow a message that has just arrived.
   *
   * Deferred, and then done again. Calling scrollToOffset in the socket
   * handler asks the list to move before the row it is moving to exists —
   * React has not rendered it yet — so it scrolls to where the bottom already
   * was, which is nowhere. The second pass covers a row whose height settles
   * later, which is most of them: an image, a reply preview, a link card.
   */
  const followNewMessage = useCallback(() => {
    requestAnimationFrame(() => {
      if (isNearBottomRef.current) scrollBottom();
    });
    const t = setTimeout(() => { if (isNearBottomRef.current) scrollBottom(); }, 180);
    settleTimers.current.push(t);
  }, [scrollBottom]);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // A scroll to a message that is still being corrected. Cancelled the moment
  // the user touches the list, so the app never fights their finger.
  const settleTimers = useRef<any[]>([]);
  function cancelSettling() {
    settleTimers.current.forEach(clearTimeout);
    settleTimers.current = [];
  }

  /**
   * Put a message in the middle of the screen — and keep it there.
   *
   * One scrollToIndex is not enough, and that is why "Show in chat" landed
   * near the message rather than on it. The rows are different heights and
   * there is no getItemLayout, so FlatList can only ESTIMATE the offset of a
   * row it has never measured; the first scroll goes to a guessed position,
   * and rows measured on the way there move the target out from under it.
   * Photos make it worse: a picture bubble is one height until the image
   * loads and taller afterwards, which shifts everything below it.
   *
   * So the scroll is repeated as the layout settles. Each repeat uses the
   * measurements taken by the one before, so the target converges instead of
   * being left wherever the first estimate happened to point.
   */
  function scrollToId(messageId: number | string) {
    const find = () => messagesRef.current.findIndex(m => String(m.id) === String(messageId));
    if (find() === -1) return false;

    cancelSettling();
    const go = (animated: boolean) => {
      const index = find();
      if (index === -1) return;   // the window changed under us
      const invertedIndex = messagesRef.current.length - 1 - index;
      if (invertedIndex < 0 || invertedIndex >= messagesRef.current.length) return;
      // scrollToIndex throws on an out-of-range index rather than ignoring it,
      // and these run from timers, long after the list they were computed for.
      try {
        flatListRef.current?.scrollToIndex({ index: invertedIndex, animated, viewPosition: 0.5 });
      } catch {}
    };

    go(true);
    // Spread out rather than repeated quickly: the later ones are for images
    // that finish loading and change the height of what is above the target.
    [120, 320, 700].forEach(ms => {
      settleTimers.current.push(setTimeout(() => go(false), ms));
    });
    return true;
  }

  async function jumpToMessage(messageId: number) {
    // Already loaded: nothing to fetch.
    if (messagesRef.current.findIndex(m => m.id === messageId) === -1) {
      // Fetch the message and its neighbours in ONE request rather than paging
      // backwards until it turns up. For a photo from months ago the old loop
      // was dozens of round trips and looked exactly like the button being
      // broken — which is what it was reported as.
      setJumping('message');
      try {
        const ctx = await apiFetch(`/message-context/${room.id}/${messageId}`);
        if (ctx?.error || !Array.isArray(ctx?.messages) || !ctx.messages.length) {
          setJumping(null);
          toast(ctx?.error || 'That message is no longer here');
          return;
        }
        // REPLACES what was loaded rather than merging with it.
        //
        // Merging is what produced the hole. The jump's window and the recent
        // block are not adjacent, and once both are in one array sorted by id
        // nothing marks the join — a message from March sits directly above one
        // from August with thousands missing in between, and scrolling down
        // skips all of them in a single step. A window that is contiguous by
        // construction, plus a flag saying more follows, is what lets the rest
        // be loaded a screen at a time.
        applyWindow(win.aroundMessage(ctx.messages, !!ctx.hasOlder, !!ctx.hasNewer));
        userDraggedRef.current = false;
      } catch {
        setJumping(null);
        toast('Could not open that message');
        return;
      }
      setJumping(null);
    }

    // Nothing is remembered about where the jump came from. It used to be, so
    // the button could walk back through each level — but arriving at the
    // message you asked for is the END of that errand, and a button that then
    // insists on retracing it is in the way. Ten search results meant ten taps
    // to get out of the search, with the new-message count hidden behind them
    // the whole time.
    // Give freshly prepended rows a moment to render before scrolling
    // The window may have just been replaced wholesale, so give the new rows
    // a frame to mount; scrollToId corrects itself from there.
    setTimeout(() => scrollToId(messageId), 60);
    setHighlightId(messageId);
    setTimeout(() => setHighlightId(null), 1500);
  }

  function handleScrollFabPress() {
    const mode = fabMode({
      atEndOfWindow: isNearBottomRef.current,
      hasNewer: hasMoreNewerRef.current,
      unseen: missedCountRef.current,
    });
    // Going to the newest messages is a statement of intent: the unseen count
    // and the button itself go NOW, rather than waiting for a scroll event to
    // confirm it. That wait is what left the badge sitting over a chat the user
    // was already looking at — onScroll is throttled and the animated scroll
    // finished between two of its ticks.
    if (clearsUnseenOnTap(mode)) markCaughtUp();
    setHighlightId(null);
    // Going to the bottom is a direct request, not a walk: fetch the newest
    // page in one go rather than paging forward through months of history the
    // user has said they do not want to read.
    jumpToBottom();
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
      // Back into CHAT order. The list is inverted, so its index 0 is the
      // newest message at the visual bottom; a chip that said "up" from those
      // numbers would point the wrong way every time.
      const len = messagesRef.current.length;
      const idxs = viewableItems.map((v: any) => v?.index).filter((n: any) => Number.isFinite(n));
      if (idxs.length) {
        viewRange.current = {
          first: len - 1 - Math.max(...idxs),
          last: len - 1 - Math.min(...idxs),
        };
        refreshJumpRef.current();
      }
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
    // Inverted list: offset 0 == visual bottom (latest LOADED message).
    //
    // "Latest loaded" and "latest" are the same thing until a jump leaves the
    // window in the middle of the chat. While that gap is open the end of the
    // list is not the present, so being there must not count as being at the
    // bottom — it would hide the button that is the way back, and mark
    // messages read that the user has not reached.
    applyScrollPosition(e.nativeEvent.contentOffset.y);
  }

  /**
   * Update everything that depends on where the list is.
   *
   * Called from onScroll AND from onMomentumScrollEnd. onScroll is throttled,
   * so the event carrying the FINAL resting position is not guaranteed to be
   * delivered — an animated scroll can finish between two ticks, leaving the
   * button up over a chat that is already at the bottom. onMomentumScrollEnd
   * fires once, when the list has actually stopped, and corrects it.
   */
  function applyScrollPosition(offsetY: number) {
    const atEnd = offsetY < 80;
    const nearBottom = atPresent({ atEndOfWindow: atEnd, hasNewer: hasMoreNewerRef.current });
    isNearBottomRef.current = nearBottom;
    setShowScrollFab(!nearBottom);
    if (nearBottom) setMissed(0);
  }

  /**
   * How many new messages are waiting, in one place.
   *
   * The ref and the state move together. The press handler reads the ref
   * because it runs outside the render that produced the state, and deciding
   * what the button means from a stale count is how it came to behave
   * differently from the badge printed on it.
   */
  function setMissed(n: number) {
    if (missedCountRef.current === n) return;
    missedCountRef.current = n;
    setMissedCount(n);
  }

  function bumpMissed() {
    setMissed(missedCountRef.current + 1);
  }

  /** Everything is caught up: at the newest message, nothing unseen. */
  function markCaughtUp() {
    isNearBottomRef.current = true;
    setShowScrollFab(false);
    setMissed(0);
  }

  /** The loaded slice, as messageWindow sees it. */
  function currentWindow(): win.Window<Message> {
    return {
      messages: messagesRef.current,
      hasOlder: hasMoreOlderRef.current,
      hasNewer: hasMoreNewerRef.current,
    };
  }
  /** Adopt a window: the array and both flags move together, or not at all. */
  function applyWindow(next: win.Window<Message>) {
    // The ref is synced immediately so callers awaiting a page (the reply
    // backfill, for one) see it without waiting for a render.
    messagesRef.current = next.messages;
    hasMoreOlderRef.current = next.hasOlder;
    setHasMoreNewer(next.hasNewer);
    setMessages(next.messages);
  }

  async function loadOlderMessages() {
    if (loadingOlderRef.current || !hasMoreOlderRef.current || !messagesRef.current.length) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const oldestId = win.oldestId(currentWindow());
    const older = await apiFetch(`/messages/${room.id}?before=${oldestId}`);
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    if (!Array.isArray(older)) { hasMoreOlderRef.current = false; return; }
    applyWindow(win.prependOlder(currentWindow(), older, MESSAGES_PAGE_SIZE));
  }

  /**
   * One page towards the present, for a window left in the middle of the chat
   * by a jump. Reaching the newest end of the list asks for the next screenful
   * rather than everything between here and now.
   */
  async function loadNewerMessages() {
    if (!userDraggedRef.current) return;
    if (loadingNewerRef.current || !hasMoreNewerRef.current || !messagesRef.current.length) return;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    const newestId = win.newestId(currentWindow());
    const newer = await apiFetch(`/messages/${room.id}?after=${newestId}`);
    loadingNewerRef.current = false;
    setLoadingNewer(false);
    if (!Array.isArray(newer)) { setHasMoreNewer(false); return; }
    // appendNewer decides the flag: a short page means we have caught up with
    // the present, and live messages can be appended again from here on.
    // NOT trimmed any more.
    //
    // Dropping pages off the far end while the user scrolls was meant to keep
    // memory down, and it is the reason the screen "hops a lot and suddenly
    // goes too much down or up". Removing rows changes the total height of
    // everything below the viewport, and the list has no getItemLayout, so
    // the scroll position it lands on afterwards is computed from estimates
    // of rows that no longer exist.
    //
    // Six pages of text is a few hundred kilobytes. A visibly broken scroll
    // is not worth that. If memory ever becomes the real problem, the fix is
    // to trim only while the list is at rest, not mid-drag.
    applyWindow(win.appendNewer(currentWindow(), newer, MESSAGES_PAGE_SIZE));
  }

  /**
   * Straight to the newest messages, in one request.
   *
   * Walking forward page by page is right when the user is reading their way
   * back through the history, and wrong when they have simply asked to go to
   * the bottom — that would be dozens of requests to reach somewhere they can
   * be taken directly. So the window is thrown away and the newest page
   * fetched, exactly as it is when the chat is first opened.
   */
  async function jumpToBottom() {
    // A jump to a message keeps re-scrolling to it for the next 700ms while
    // the layout settles. Tapping "go to newest" inside that window used to
    // scroll to the bottom and then be dragged straight back to the search
    // result by a timer nobody had cancelled — which is exactly what "the
    // button doesn't work" looks like.
    cancelSettling();
    if (!hasMoreNewerRef.current) { scrollBottom(); return; }
    setJumping('latest');
    try {
      const latest = await apiFetch(`/messages/${room.id}`);
      if (Array.isArray(latest) && latest.length) {
        applyWindow(win.atBottom(latest, MESSAGES_PAGE_SIZE));
        markCaughtUp();
      }
    } catch {}
    setJumping(null);
    // After the list has re-rendered with the new window.
    setTimeout(() => flatListRef.current?.scrollToOffset({ offset: 0, animated: false }), 50);
  }

  // What the button is, decided in one place (src/scrollFab.ts) so the rules
  // the tests describe are the rules that run. `showScrollFab` is the negation
  // of "at the present", which already accounts for a window left short of the
  // newest message by a jump.
  const currentFabMode = fabMode({
    atEndOfWindow: !showScrollFab,
    hasNewer: hasMoreNewerRef.current,
    unseen: missedCount,
  });
  const fabVisible = currentFabMode !== 'hidden';
  /** Is a typing or recording line being drawn under the buttons? */
  // Derived from the SAME rule that draws the line, so the button's lift and
  // the line's presence cannot disagree — including for the new "is sending",
  // which a hand-written copy of this condition would have missed.
  const someoneIsBusy = !!activityBar({
    typing, recording: recordingUsers, sending: sendingUsers, me,
  });

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

  // The peer's key, asked for until it arrives.
  //
  // Reported with a photograph of a whole conversation reading "cannot decrypt
  // on this device": this ran ONCE, and a request that failed — or merely
  // landed after the messages were drawn — left that sentence on screen for
  // good. It retries now, and every attempt is counted so the bubbles can say
  // "Decrypting…" while there is still hope and the other thing when there is
  // not.
  useEffect(() => {
    if (!room.is_dm) return;
    let alive = true;
    let timer: any = null;
    let attempt = 0;

    const tick = async () => {
      if (!alive) return;
      attempt++;
      setKeyAttempts(attempt);
      try {
        const res = await apiFetch(`/dm-peer-key/${room.id}`);
        if (!alive) return;
        dmPeerId.current = res?.userId ?? null;
      } catch {}
      if (!alive) return;
      const ready = await e2eReady();
      if (!alive) return;
      setIdentityReady(ready);
      if (!ready) {
        // Session predates E2E: the identity was never unlocked on this device.
        // Nothing to retry — it needs the password.
        setShowE2EUnlock(true);
        return;
      }
      // Make sure the local keypair still matches what the server published
      // for this account. If it diverged (e.g. the identity was rebuilt on the
      // web and our stored private key no longer corresponds), peers encrypt
      // to a key we can't open — so prompt to unlock the real identity instead
      // of silently showing undecryptable messages.
      const status = await e2eVerifyIdentity();
      if (!alive) return;
      if (status === 'mismatch') { setShowE2EUnlock(true); return; }
      const key = await e2eDMPeerKey(room.id);
      if (!alive) return;
      dmPeerPk.current = key;
      // Always set, even to the same value: this is what redraws the bubbles
      // that were built before the key existed.
      setE2eActive(!!key);
      if (key || !keepTryingKey(attempt)) return;
      timer = setTimeout(tick, keyRetryDelay(attempt - 1));
    };

    tick();
    return () => { alive = false; clearTimeout(timer); };
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
      // Same rule. This refresh also runs on coming back to the foreground and
      // on a delayed retry, so an unguarded mark_read here wipes out the
      // position the reader was returning to before they have seen a word.
      if (marksRead({
        appActive: AppState.currentState === 'active',
        atBottom: isNearBottomRef.current,
      })) {
        socketRef.current?.emit('mark_read', { roomId: room.id, lastMsgId: msgs[msgs.length - 1].id });
      }
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

  // The device's copy of this chat, on screen before any request goes out.
  // A chat that was readable a minute ago should still be readable with the
  // network down — and even with a working connection, showing history
  // instantly beats showing a spinner for a second.
  useEffect(() => {
    let alive = true;
    // The username has to be in hand BEFORE the cached messages are painted.
    // Which side a bubble sits on is decided by `msg.username === me`, and
    // `me` starts empty — so painting the cache first put every message,
    // including the user's own, on the same side, and they all jumped across
    // the screen a moment later when the username resolved. Both come from
    // local storage, so waiting for the second costs nothing.
    Promise.all([offline.loadMessages(room.id), getUsername()]).then(([cached, u]) => {
      if (!alive) return;
      if (u) { setMe(u); meRef.current = u; }
      // Anything the server has already returned wins; this only fills a void.
      if (!cached || messagesRef.current.length) return;
      setMessages(cached);
      messagesRef.current = cached;
      setLoading(false);
    }).catch(() => {});
    return () => { alive = false; };
  }, [room.id]);

  // Keep the device's copy current as messages arrive, so it is up to date the
  // next time the app opens with no connection. Debounced: a busy room should
  // not write the whole history to storage on every incoming line.
  useEffect(() => {
    if (loading) return;
    const t = setTimeout(() => offline.saveMessages(room.id, messagesRef.current), 1500);
    return () => clearTimeout(t);
  }, [messages, loading, room.id]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      // The read position is fetched ALONGSIDE the messages and before
      // anything is marked read: opening the chat consumes it, so whatever
      // wants to know where the reader had got to has to ask first.
      const [msgs, u, sock, pos] = await Promise.all([
        apiFetch(`/messages/${room.id}`),
        getUsername(),
        getSocket(),
        apiFetch(`/read-position/${room.id}`).catch(() => null),
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
      // ── Seen means seen by EVERYONE ────────────────────────────────────
      //
      // This used to be Math.max over /read-receipts, which is the same
      // number as the minimum in a DM and quite a different one in a room:
      // the tick went blue the moment any single member opened the chat.
      //
      // The figure is asked of the server rather than worked out here,
      // because the answer turns on who has NOT read — a member who has
      // never opened the room has no read mark at all, so the people who
      // decide the answer are precisely the ones missing from that map, and
      // the client does not know the membership. See readReceipts.js.
      apiFetch(`/seen-by-all/${room.id}`).then(res => {
        if (!mounted) return;
        if (res && typeof res.upto === 'number') setMaxOtherReadMsgId(res.upto);
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
        setHasMoreNewer(false);
        // Opening a chat IS reading it — that is the one place marking the
        // whole page read is the point. Still refused when the app is not in
        // front of the user, because this path also runs from a refresh.
        if (msgs.length && opensAsRead({ appActive: AppState.currentState === 'active' })) {
          sock.emit('mark_read', { roomId: room.id, lastMsgId: msgs[msgs.length - 1].id });
        }
        // …and open where the unread messages START, not at the bottom with
        // everything new above the fold. Asked for as: take me to where those
        // messages are.
        const lastRead = Number(pos && !pos.error ? pos.lastReadId : 0) || 0;
        const target = firstUnread(msgs, lastRead, u || '');
        const waiting = msgs.filter((m: any) =>
          Number(m.id) > lastRead && m.username !== (u || '')).length;
        if (target && worthJumping(waiting)) {
          // Only the POSITION is stored. The label is worked out from the
          // rows below it on every render — see unreadInfo — because a count
          // taken here describes the list as it was while the chat was still
          // loading, and then keeps saying so.
          setUnreadFrom(Number(target.id));
          setTimeout(() => jumpToMessage(Number(target.id)), 350);
        } else {
          setUnreadFrom(null);
        }
        offline.saveMessages(room.id, msgs);
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
            // Marked as ours on the way back in. Everything in the outbox is
            // something this device tried to send, so the side it goes on is
            // not a question — and rows persisted by an older build carry an
            // empty username that would otherwise put them on the left.
            return [
              ...prev,
              ...running.map((f: any) => markMine({ ...f, _uploading: true, _uploadFailed: false })),
              ...keep.map((f: any) => markMine({ ...f, _uploading: false, _uploadFailed: true })),
            ];
          });
        }
      } catch {}
      setLoading(false);
      if (initialJumpMsgId) setTimeout(() => jumpToMessage(initialJumpMsgId), 300);
      // A tapped comment notification opens the THREAD, not the chat. The
      // comment is not in the conversation and never will be — sending the
      // user to the room was sending them somewhere with nothing new in it.
      // openComments refetches from the id, so a stub parent is enough.
      if (initialCommentTarget?.parentId) {
        setTimeout(() => {
          openComments({ id: initialCommentTarget.parentId } as Message);
          if (initialCommentTarget.commentId != null) {
            setHighlightId(initialCommentTarget.commentId);
          }
        }, 300);
      }

      // Which threads have something unread in them. Held only in memory
      // before, so leaving the chat lost every comment badge and the chip
      // that leads to it.
      apiFetch(`/comment-unread/${room.id}`)
        .then((u: any) => {
          if (!u || u.error) return;
          setUnreadComments(u);
          setTimeout(() => refreshJumpRef.current(), 0);
        })
        .catch(() => {});

      // Mentions of me that arrived while I was away.
      apiFetch(`/mentions/${room.id}`)
        .then((r: any) => { if (Array.isArray(r?.mentions)) setMentionIds(r.mentions); })
        .catch(() => {});
      apiFetch(`/room-usernames/${room.id}`)
        .then((r: any) => {
          if (Array.isArray(r?.users)) setMentionables(r.users.map((u: any) => u.username));
        })
        .catch(() => {});

      socketRef.current = sock;
      // Every listener this screen adds is remembered, so the cleanup can
      // remove exactly these and nobody else's. See the cleanup for what the
      // blunt form cost.
      const onSock = (event: string, handler: (...a: any[]) => void) => {
        chatHandlersRef.current.push([event, handler]);
        sock.on(event, handler);
      };
      sock.emit('join_room', room.id);

      // socket.io reconnects by itself, but the server no longer has us in
      // the room channel — re-join and re-sync on every reconnect.
      reconnectHandlerRef.current = () => {
        sock.emit('join_room', room.id);
        refreshLatest();
      };
      onSock('connect', reconnectHandlerRef.current);

      // A comment never arrives as a message: it would appear in the chat it
      // was written about. This carries the parent's new count for the badge,
      // and the comment itself for anyone with that thread open.
      onSock('comment_added', (ev: any) => {
        if (String(ev.roomId) !== String(room.id)) return;
        setCommentCounts(c => ({ ...c, [String(ev.parentId)]: normaliseCount(ev.count) }));
        const msg: Message = ev.comment;
        // Somebody else's comment, on a thread that is not open: this is the
        // thing the user opened the chat looking for and could not find.
        setUnreadComments(u => {
          const next = noteComment(u, {
            parentId: ev.parentId,
            mine: msg?.username === meRef.current,
            threadOpenId: commentParentRef.current?.id ?? null,
          });
          setTimeout(() => refreshJumpRef.current(), 0);
          return next;
        });
        // Our own comment coming back. The same bookkeeping the room's echo
        // does — without it a comment's upload bar spins forever, its voice
        // player keeps the temporary id, and the crash-safety copy is left on
        // disk to be resent next launch. None of that runs on this path
        // otherwise, because a comment never arrives as `message_received`.
        const pendingId = (msg.client_id && String(msg.client_id))
          || (msg.file_path
              && Object.keys(pendingUploadPaths.current).find(id => pendingUploadPaths.current[id] === msg.file_path))
          || null;
        if (pendingId) {
          delete pendingUploadPaths.current[pendingId];
          audioManager.retarget(pendingId, msg.id);
          outbox.markDone(pendingId);
          outbox.forget(room.id, pendingId);
          removeFailedMsg(pendingId);
          up.finish(pendingId);
          if (replaceOutgoing(pendingId, msg)) return;
        }
        // Somebody else's, or ours with the optimistic bubble already gone.
        if (commentParentRef.current && String(commentParentRef.current.id) === String(ev.parentId)) {
          setComments(prev => (prev.some(c => String(c.id) === String(msg.id))
            ? prev : [...prev, msg]));
        }
      });

      onSock('message_received', (msg: Message) => {
        // The gallery's memory of this room is now one message out of date.
        // Marked, not dropped: the next open still draws instantly from what
        // is held and picks up the new photo behind it.
        if (rm.affectsMedia(msg)) rm.markDirty(msg.room_id);
        if (msg.room_id !== room.id) {
          // meRef, not the `me` state: this listener is bound once, and on the
          // first render `me` is still ''. Every message from another room —
          // including the echo of a message YOU just forwarded there — then
          // looked like someone else's and lit the dot on the back button.
          if (msg.username !== meRef.current) setOtherUnread(true);
          return;
        }
        // A mention arriving while the chat is open still joins the queue —
        // it is only cleared when it has actually been jumped to.
        if (msg.type === 'text' && msg.username !== meRef.current
            && meRef.current && typeof msg.id === 'number'
            && new RegExp(`@${meRef.current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
                 .test(String(msg.content || ''))) {
          const mid = msg.id;
          setMentionIds(prev => (prev.includes(mid) ? prev : [...prev, mid]));
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
          up.finish(pendingId);
          setMessages(prev => {
            const idx = prev.findIndex(m => String(m.id) === pendingId);
            if (idx === -1) return [...prev, msg];
            const next = prev.slice();
            next[idx] = msg;
            return next;
          });
        } else if (!win.acceptsLive(currentWindow())) {
          // The window is parked in the middle of the chat after a jump, so a
          // message arriving now belongs thousands of messages later. Appending
          // it would draw it directly beneath the one being read, as though it
          // were the next thing said. It is not lost — going back to the bottom
          // fetches it with everything else.
        } else {
          setMessages(prev => [...prev, msg]);
        }
        // A live share we just requested: the watcher can only start now, once
        // the server has given the message a real id to keep updating.
        if (msg.type === 'location' && msg.username === meRef.current && pendingLiveShare.current) {
          const { until } = pendingLiveShare.current;
          pendingLiveShare.current = null;
          locationManager.startSharing(msg.id, room.id, until,
            room.is_dm ? (room.other_username || room.name) : room.name,
            // Kept so the bar can open this chat again from any other one.
            room).catch(() => {});
        }
        if (win.followsNewMessage({
          atEnd: isNearBottomRef.current,
          fromMe: msg.username === meRef.current,
          windowAcceptsLive: win.acceptsLive(currentWindow()),
        })) {
          followNewMessage();
        } else if (msg.username !== meRef.current) bumpMissed();
        // NOT unconditional. A message arriving is not a message read: the
        // phone may be locked with this screen still mounted, or the reader
        // may be scrolled back through history. Marking those read is what
        // moved the unread line below messages nobody had seen.
        if (marksRead({
          appActive: AppState.currentState === 'active',
          atBottom: isNearBottomRef.current,
          fromMe: msg.username === meRef.current,
        })) {
          sock.emit('mark_read', { roomId: room.id, lastMsgId: msg.id });
        }
      });
      // The owner removed us: leave the chat immediately.
      // The other side cleared the conversation for both of us. Their decision
      // has already taken effect on the server, so showing messages that no
      // longer exist until the next reload would be showing a lie.
      onSock('history_cleared', ({ roomId, uptoId, scope }: any) => {
        if (roomId !== room.id) { rm.forgetCached(roomId); return; }
        rm.forgetCached(roomId);
        const keep = messagesRef.current.filter(
          (m: any) => typeof m.id !== 'number' || m.id > (uptoId || 0));
        applyWindow({ messages: keep, hasOlder: false, hasNewer: hasMoreNewerRef.current });
        if (scope === 'both') toast('This chat was cleared');
      });

      onSock('removed_from_room', ({ roomId, roomName }: any) => {
        if (roomId !== room.id) return;
        Alert.alert('Removed', `You were removed from "${roomName}".`);
        onBack();
      });
      onSock('message_edited', ({ messageId, content }: any) => {
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, content, edited: 1 } : m));
      });
      onSock('message_deleted', ({ messageId, roomId }: any) => {
        // Before the room filter: a live share running in ANOTHER chat is
        // still mine, and deleting its message must stop it wherever I am.
        locationManager.stopForMessage(messageId);
        if (roomId != null && roomId !== room.id) return; // now also personal-channel

        // If the lightbox is showing an image that belongs to the message
        // being destroyed (e.g. a one-time image whose timer ran out), close
        // it so the picture vanishes from view too.
        const gone = messagesRef.current.find(m => m.id === messageId);
        if (gone && lightboxBelongsTo(gone)) closeViewer();
        // The message is being destroyed, so any copy of its media on this
        // device goes too. Without this a disappearing photo would live on in
        // the cache after the message that carried it was gone.
        if (gone) forgetCachedMedia(gone);
        setMessages(prev => prev.filter(m => m.id !== messageId));
      });
      // "Delete for me", done on another device this user is signed in on.
      // Nobody else is told, because for them nothing has happened.
      onSock('message_hidden', ({ messageId, roomId }: any) => {
        if (roomId != null && roomId !== room.id) return;
        const gone = messagesRef.current.find(m => String(m.id) === String(messageId));
        if (gone && lightboxBelongsTo(gone)) closeViewer();
        // The copy on this device goes with it: a photo deleted from the chat
        // living on in the cache is the thing the user asked to be rid of.
        if (gone) forgetCachedMedia(gone);
        hideLocally(messageId);
      });
      onSock('reactions_updated', ({ messageId, roomId, reactions: r }: any) => {
        // These now also arrive on our personal channel (so they reach us even
        // when backgrounded), which means updates for OTHER rooms land here too.
        if (roomId != null && roomId !== room.id) return;
        setReactions(prev => ({ ...prev, [messageId]: r }));
      });
      onSock('room_online', ({ users }: any) => setOnline(users));
      // Only about THIS chat. Reported on the web as a stranger's "is typing"
      // under somebody else's conversation; the app trusted the same routing,
      // so it could show it too — see src/presence.ts.
      onSock('user_typing', ({ username: u, roomId }: any) => {
        if (!isForRoom(roomId, room.id)) return;
        setTypingAt(prev => live.note(prev, u, Date.now()));
      });
      onSock('user_stopped_typing', ({ username: u, roomId }: any) => {
        if (!isForRoom(roomId, room.id)) return;
        setTypingAt(prev => live.drop(prev, u));
      });
      onSock('user_recording', ({ username: u, roomId }: any) => {
        if (!isForRoom(roomId, room.id)) return;
        setRecordingAt(prev => live.note(prev, u, Date.now()));
      });
      onSock('user_stopped_recording', ({ username: u, roomId }: any) => {
        if (!isForRoom(roomId, room.id)) return;
        setRecordingAt(prev => live.drop(prev, u));
      });
      // "is sending a photo", the same way "is typing" works. Guarded by
      // isForRoom like the rest: these arrive on the personal channel too, so
      // without it a file being sent in another chat shows up in this one.
      onSock('user_sending', ({ username: u, roomId, kind }: any) => {
        if (!isForRoom(roomId, room.id)) return;
        setSendingAt(prev => ({ ...prev, [u]: { at: Date.now(), kind: (kind || 'file') as SendKind } }));
      });
      onSock('user_stopped_sending', ({ username: u, roomId }: any) => {
        if (!isForRoom(roomId, room.id)) return;
        setSendingAt(prev => { const n = { ...prev }; delete n[u]; return n; });
      });
      onSock('one_time_viewed', ({ messageId, roomId, viewedAt, seconds }: any) => {
        // Also delivered on our personal channel now, so ignore other rooms.
        if (roomId != null && roomId !== room.id) return;
        setOneTimeExpiry(prev => ({ ...prev, [messageId]: Date.now() + seconds * 1000 }));
        // Stamped on the MESSAGE too, not only in the side map the badge
        // reads. The sweep that removes finished messages works from the
        // messages themselves — without this it cannot see that a one-time
        // message has started counting, which is how one reached "0s" and
        // stayed on screen.
        setMessages(prev => prev.map(m => (
          String(m.id) === String(messageId)
            ? { ...m, viewed_at: viewedAt || Date.now() }
            : m
        )));
      });

      onSock('voice_played', ({ messageId }: any) => {
        setMessages(prev => prev.map(msg => msg.id === messageId ? { ...msg, played: 1 } : msg));
      });
      onSock('messages_read', ({ roomId, lastReadMsgId, seenByAllUpTo }: any) => {
        if (roomId != room.id) return;
        // NOT monotonic any more, and that is the point. The old value only
        // ever climbed, which is right for "the furthest anyone has read" and
        // wrong for "the furthest EVERYONE has read": the latter drops the
        // moment somebody new is added to the room, or a member who had been
        // keeping up stops. Clamping it upwards would leave a blue tick
        // standing on a message that is no longer seen by all.
        if (typeof seenByAllUpTo === 'number') { setMaxOtherReadMsgId(seenByAllUpTo); return; }
        // A server that has not been deployed yet still sends only the
        // per-reader mark. Better the old behaviour than none.
        setMaxOtherReadMsgId(prev => lastReadMsgId > prev ? lastReadMsgId : prev);
      });
    })();
    return () => {
      mounted = false;
      socketRef.current?.emit('leave_room');
      // ── off(event) WITH NO HANDLER REMOVES EVERYBODY'S ───────────────────
      //
      // That is what these lines used to be, and it is what silenced
      // notifications. socket.io's off() given only an event name removes
      // EVERY listener registered for it, including ones belonging to modules
      // this file has never heard of. src/socketNotifier.ts listens for
      // message_received to raise the notification when the app is closed —
      // and leaving this screen, or closing the app, which unmounts it, tore
      // that listener off the socket from here.
      //
      // The socket stayed connected, every diagnostic stayed green, and
      // "messages reaching the app" sat at zero. It looked like an Android
      // problem for a week.
      //
      // These now name the listener they are removing. The notifier ALSO
      // moved to onAny, which an off(event) cannot reach at all, because the
      // next screen written will do the blunt thing again and the damage
      // lands in a different file from the mistake.
      const sock = socketRef.current;
      if (sock) {
        for (const [event, handler] of chatHandlersRef.current) sock.off(event, handler);
      }
      chatHandlersRef.current = [];
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

  // Opening a chat used to fetch the room's ENTIRE media list — a scan of
  // thousands of messages — to build a list of every photo, so that the
  // lightbox could swipe past the loaded messages. It cost that on every chat
  // open and, since the endpoint started returning objects rather than bare
  // paths, produced a list of "[object Object]" urls that never matched
  // anything. The gallery is where the whole history belongs, and it now
  // fetches it a page at a time when it is actually opened.
  useEffect(() => { setOtherUnread(false); }, [room.id]);

  // The gallery's own state follows the room, from the cache when there is one
  // so that reopening a chat does not empty it.
  useEffect(() => {
    setMediaState(rm.getCached(room.id));
    setMediaFocusIndex(0);
  }, [room.id]);

  /**
   * Open the shared-media gallery.
   *
   * Whatever is remembered goes up immediately; the server is asked only if
   * that memory is stale or something has arrived since. The old version put a
   * spinner up and waited for the whole room, every time.
   */
  async function openMediaBrowser(tab: MediaTab = 'images') {
    const cached = rm.getCached(room.id);
    setMediaState(cached);
    setMediaTab(tab);
    setMediaFocusIndex(0);
    setMediaOpenId(n => n + 1);
    setShowMedia(true);
    if (!rm.shouldRefresh(cached, rm.isDirty(room.id), Date.now())) return;
    const first = await apiFetch(`/room-media/${room.id}?v=2`);
    if (!first || first.error) return;
    // Merged rather than replaced: pages the user had already scrolled through
    // stay loaded, and their place in the grid does not move.
    const next = cached ? rm.mergeRefresh(cached, first, Date.now()) : rm.fromFirstPage(first, Date.now());
    rm.putCached(room.id, next);
    setMediaState(next);
    addEncryptedLinks(next);
  }

  /**
   * Links from the messages the server cannot read.
   *
   * The Links tab is built by scanning message text, and an end-to-end
   * encrypted message is ciphertext to the server — so in a DM the tab was
   * permanently empty and said "No links yet" as though that were a fact about
   * the conversation. The key is on this device, so the work happens here, the
   * same way searching an encrypted chat already does. Nothing goes back.
   *
   * After the tab is on screen, deliberately: the ciphertext is a second
   * request and a slow one on these connections.
   */
  async function addEncryptedLinks(base: rm.MediaState) {
    // The key this chat already resolved when it opened — asking again would
    // be a second round trip for something held a few lines away.
    const peer = dmPeerPk.current;
    if (!peer) return;
    const enc = await apiFetch(`/encrypted-messages/${room.id}`).catch(() => null);
    if (!enc || enc.error || !Array.isArray(enc.messages)) return;
    const plain = enc.messages.map((m: any) => ({
      id: m.id,
      content: e2eIsEncrypted(m.content) ? (e2eDecrypt(m.content, peer) || '') : m.content,
    }));
    const found = linksFrom(plain);
    if (!found.length) return;
    const merged = { ...base, links: mergeLinks(base.links || [], found) };
    rm.putCached(room.id, merged);
    setMediaState(merged);
  }

  /** The next page of photos, asked for by the grid as it is scrolled. */
  async function loadMoreMedia() {
    const cur = rm.getCached(room.id) || mediaState;
    if (!cur || !cur.imagesHasMore || !cur.imagesCursor) return;
    if (mediaLoadingRef.current) return;
    mediaLoadingRef.current = true;
    setMediaLoadingMore(true);
    try {
      const page = await apiFetch(`/room-media/${room.id}?v=2&before=${cur.imagesCursor}`);
      if (page && !page.error) {
        const next = rm.appendImages(cur, page);
        rm.putCached(room.id, next);
        setMediaState(next);
      }
    } catch {}
    mediaLoadingRef.current = false;
    setMediaLoadingMore(false);
  }

  // Optimistic text send: the bubble appears on first tap; if the server
  // doesn't ack within the timeout the bubble shows a retry button.
  function dispatchText(plain: string, replyToId: number | null, oneTime: number | null, replyMeta?: ReplyTo | null) {
    const sock = socketRef.current;
    if (!sock) return;
    const clientId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimistic: Message = markMine({
      // meRef, not the `me` state: a retry dispatched from a timer runs with
      // whatever value that closure captured, and an empty one stamped the row
      // with a username that never matches — which is how a failed message
      // came back on the other person's side.
      id: clientId, room_id: room.id, user_id: 0, username: meRef.current || me, avatar: myAvatar,
      type: 'text', content: plain, file_path: null, file_name: null,
      edited: 0, created_at: new Date().toISOString(),
      reply_to_id: replyToId, reply_username: replyMeta?.username ?? null,
      reply_content: replyMeta?.content ?? null, reply_type: replyMeta?.type ?? null,
      one_time_seconds: oneTime ?? null,
      _uploading: true,
    }) as Message;
    // Captured HERE, once: the thread this was sent to, whatever the user does
    // while it is in flight.
    const parentId = sendingParentId();
    addOutgoing(optimistic, parentId);
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
        clientId, oneTimeSeconds: oneTime ?? undefined, parentId,
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
    // The message is on its way, so there is no longer a draft of it. Done
    // here rather than in each of the branches below, all of which end in the
    // composer being emptied one way or another.
    clearDraft();
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
        cacheable: canTakeContent(m),
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
    const mine = isMine(msg, me);
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

  // ── Pasting ────────────────────────────────────────────────────────────────
  //
  // Android's message box is a text field: a screenshot on the clipboard is
  // invisible to it, and there is no keyboard gesture that would hand one
  // over. What the system does offer is a clipboard the app can ASK, so paste
  // is an action here rather than something that happens to the text field.
  //
  // Whether there is anything to paste is checked when the attach menu opens,
  // so the option is only offered when it would do something.
  const [clipboardHas, setClipboardHas] = useState<'image' | 'file' | null>(null);

  async function checkClipboard() {
    try {
      const hasImage = await Clipboard.hasImageAsync();
      // The text is only READ when there is no image and there is some text.
      // Reading it raises a system "pasted from" notice on newer Androids, and
      // this now runs whenever the chat is opened rather than once per attach
      // menu — a check that accused the app of snooping every few minutes
      // would be a worse bug than the one being fixed.
      const hasString = hasImage ? false : await Clipboard.hasStringAsync();
      const text = shouldReadText({ hasImage, hasString }) ? await Clipboard.getStringAsync() : '';
      setClipboardHas(clipboardOffer({ hasImage, text }));
    } catch { setClipboardHas(null); }
  }

  // Checked on arrival, and again every time the app comes back to the front:
  // coming back from a gallery or a file manager is precisely when somebody
  // has just copied the thing they want to send.
  useEffect(() => {
    checkClipboard();
    const sub = AppState.addEventListener('change', st => { if (st === 'active') checkClipboard(); });
    return () => sub.remove();
  }, []);

  // ── An image pasted from the KEYBOARD ─────────────────────────────────────
  //
  // Reported with a photo of Gboard refusing: "BistbargChat does not support
  // image pasting here". A React Native text field never tells the keyboard
  // which content types it accepts, so every keyboard assumes plain text and
  // greys the image out. There is no prop for that — the field is patched
  // (patches/react-native+0.74.5.patch) to advertise image/* and to hand the
  // committed file over here, already copied into our own cache because the
  // keyboard's read permission ends the moment it returns.
  //
  // The clipboard button below stays: it is the only route on iOS, and it
  // still works when a keyboard has no image key at all.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('onPasteImage', (ev: any) => {
      if (!ev?.uri) return;
      const mime = ev.mime || 'image/jpeg';
      setPendingMedia(prev => [...prev, {
        uri: ev.uri,
        // Named the way a pasted screenshot is named everywhere else, so two
        // of them are told apart rather than both being "image.png".
        name: pastedName(mime, Date.now()),
        mime,
      }]);
    });
    return () => sub.remove();
  }, []);

  /**
   * Rename a staged file before it is sent.
   *
   * Asked for: allow renaming a file when sharing, whether it arrived from
   * another app or was picked inside this one. Both routes end up in
   * pendingMedia, so renaming there covers both — and the name that is typed
   * is the name the message carries, so the person receiving it sees it too.
   */
  //
  // A Modal with a TextInput, NOT Alert.prompt: that one exists only on iOS
  // and does nothing at all on Android, which is what this app ships as. It
  // would have been a button that looked fine and never opened anything.
  function renameStaged(index: number) {
    const item = pendingMedia[index];
    if (!item) return;
    // The stem only: nobody wants to edit around ".pdf" on a phone keyboard,
    // and the extension is kept whatever they type.
    setRenaming({ index, value: editableStem(item.name), of: item.name });
  }

  function commitRename() {
    const r = renaming;
    setRenaming(null);
    if (!r) return;
    const next = renamed(r.of, r.value);
    if (next === r.of) return;
    setPendingMedia(prev => prev.map((m, i) => (i === r.index ? { ...m, name: next } : m)));
  }

  async function pasteFromClipboard() {
    setShowAttachMenu(false);
    try {
      // A file URI copied as text by a file manager. Sending the text would be
      // sending somebody a line of gibberish ending in .pdf.
      const asUri = fileUriFromText(await Clipboard.getStringAsync());
      if (asUri) {
        const name = decodeURIComponent(asUri.split('/').pop() || '') || `file-${Date.now()}`;
        setPendingMedia(prev => [...prev, { uri: asUri, name, mime: guessMime(name) }]);
        return;
      }
      const img = await Clipboard.getImageAsync({ format: 'png' });
      const parsed = img?.data ? parseDataUri(img.data) : null;
      if (!parsed) { Alert.alert('Nothing to paste', 'There is no image or file on the clipboard.'); return; }
      // The clipboard hands back base64; it has to become a real file before
      // anything can upload it.
      const name = pastedName(parsed.mime, Date.now());
      const uri = `${FileSystem.cacheDirectory}paste-${Date.now()}.${extensionFor(parsed.mime)}`;
      await FileSystem.writeAsStringAsync(uri, parsed.base64, { encoding: FileSystem.EncodingType.Base64 });
      setPendingMedia(prev => [...prev, { uri, name, mime: parsed.mime }]);
    } catch {
      Alert.alert('Could not paste', 'The clipboard could not be read.');
    }
  }

  /**
   * One of the actions around the shutter.
   *
   * Deferred by a moment after the camera closes, because two Android modal
   * windows opening across each other is the flash of chat this app has been
   * bitten by before.
   */
  async function runAttachAction(action: AttachAction) {
    switch (action) {
      case 'gallery': return pickFromGallery();
      case 'file': return pickFile();
      case 'voice': return startRecordingUI();
      case 'paste': return pasteFromClipboard();
      case 'contact': return pickContact();
    }
  }

  /**
   * Send somebody's contact card.
   *
   * As ordinary text, deliberately: a dedicated message type would mean a
   * server change, a new bubble and a card the web client would not
   * understand, for something whose whole content is a name and a number —
   * and the number arrives tappable, which is what the recipient wants to do
   * with it anyway.
   */
  async function pickContact() {
    try {
      const { granted } = await Contacts.requestPermissionsAsync();
      if (!granted) {
        Alert.alert('Permission required', 'Allow access to contacts to share one.');
        return;
      }
      const picked = await Contacts.presentContactPickerAsync();
      if (!picked) return;   // cancelled, which is not a failure
      if (!contactWorthSending(picked as any)) {
        Alert.alert('Nothing to send', 'That contact has no phone number saved.');
        return;
      }
      composerRef.current?.setText(contactMessage(picked as any));
    } catch {
      Alert.alert('Could not open contacts', 'The contact picker is not available on this device.');
    }
  }

  async function pickFile() {
    setShowAttachMenu(false);
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled) return;
    const a = res.assets[0];
    setPendingMedia(prev => [...prev, { uri: a.uri, name: a.name, mime: guessMime(a.name || a.uri, a.mimeType) }]);
  }

  /**
   * Attach a video through the document picker.
   *
   * Offered whenever the gallery could not hand one over, because the user
   * established that this route works on the very file the gallery refused:
   * "when picking 150MB video as video from gallery it doesn't pick but as
   * file is ok".
   */
  async function pickVideoAsFile() {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: 'video/*', copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const a = res.assets[0];
      setPendingMedia(prev => [...prev, {
        uri: a.uri, name: a.name || 'video.mp4', mime: guessMime(a.name || a.uri, a.mimeType),
      }]);
    } catch (e: any) {
      const f = pickFailure.failureMessage({ error: e, isVideo: true });
      Alert.alert(f.title, f.body);
    }
  }

  /** Offer the file route from an alert, rather than leaving a dead end. */
  function offerFileRoute(f: { title: string; body: string; offerFileRoute: boolean }) {
    Alert.alert(f.title, f.body, f.offerFileRoute
      ? [{ text: 'Cancel', style: 'cancel' }, { text: 'Attach as file', onPress: pickVideoAsFile }]
      : [{ text: 'OK' }]);
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
    // ── Every picked VIDEO is copied whole, before we see it ───────────────
    //
    // expo-image-picker's MediaHandler.handleVideo copies the file byte for
    // byte into the app's cache directory and then reads its metadata from
    // the copy. A 150 MB video therefore needs 150 MB of free space and a
    // full read-and-write before anything appears in the composer.
    //
    // And this whole call was awaited with no try/catch. When that copy
    // failed the rejection went nowhere: nothing was attached, nothing was
    // said, and the app looked like it had simply ignored the tap. That
    // silence is the bug as the user experienced it — "it doesn't pick".
    //
    // Making room first is not a workaround for somebody else's copy; the
    // space it frees is this app's own rubbish, and the phone that reported
    // this was holding nine gigabytes of it.
    await storage.sweep(BUILD_VERSION).catch(() => {});
    let res: any;
    try {
      res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.All,
        allowsMultipleSelection: true,
        selectionLimit: 10,
        quality: 0.6, // same compression as the camera — see pickFromCamera
        exif: false,
      });
    } catch (e: any) {
      const free = await FileSystem.getFreeDiskStorageAsync().catch(() => null);
      offerFileRoute(pickFailure.failureMessage({
        error: e,
        // Nothing here knows how big the file was — the picker threw before
        // saying. Free space alone is enough of a reason to name space as the
        // likely cause rather than shrug.
        outOfSpace: pickFailure.spaceLooksTight(free),
        isVideo: true,
      }));
      return;
    }
    if (res.canceled) return;
    setPendingMedia(prev => [...prev, ...res.assets.map((asset: any, i: number) => {
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

  /**
   * Send one file, resumably, reporting to the bubble it belongs to.
   *
   * A whole-file POST could be cancelled but never paused, so a connection
   * that died at 90% of a video cost the whole thing again — and there was no
   * honest pause button to offer. This goes up in chunks against a server
   * session that remembers what it already holds, which is what makes pause,
   * resume and surviving a dropped connection all the same mechanism.
   *
   * `clientId` is which bubble to report to; the pause/cancel buttons on that
   * bubble drive the handle registered here.
   */
  function uploadWithProgress(
    clientId: string, uri: string, name: string, mime: string,
    onProgress: (pct: number, sent: number, total: number) => void,
  ): Promise<{ url: string; name: string; mimetype: string }> {
    return new Promise(async (resolve, reject) => {
      const token = await getToken();
      const handle = uploadResumable(BASE_URL, uri, name, mime, token || '', {
        onProgress: (sent, total) => onProgress(total > 0 ? sent / total : 0, sent, total),
        onDone: resolve,
        onFailed: reject,
      });
      up.attach(clientId, {
        pause: () => handle.pause(),
        resume: () => handle.resume(),
        // Cancelling is a decision, not a failure: the promise is rejected so
        // the caller unwinds, and the bubble is removed rather than left
        // sitting there offering a retry nobody asked for.
        cancel: () => { handle.cancel(); reject(new UploadCancelled()); },
      });
    });
  }

  /** Take a cancelled send off the screen entirely. */
  function removeCancelled(clientId: string) {
    up.finish(clientId);
    outbox.markDone(clientId);
    removeFailedMsg(clientId);
    setMessages(prev => prev.filter(m => String(m.id) !== clientId));
  }

  /** A send that ended: cancelled means gone, anything else means retryable. */
  function settleUpload(clientId: string, err: any) {
    if (err instanceof UploadCancelled) removeCancelled(clientId);
    else markUploadFailed(clientId);
  }

  function addOptimisticMessage(clientId: string, type: string, localUri: string, fileName: string | null, replyToId: number | null, caption: string | null = null) {
    const parentId = sendingParentId();
    const optimistic: Message = markMine({
      // See dispatchText: the ref is the one that is always current.
      id: clientId, room_id: room.id, user_id: 0, username: meRef.current || me, avatar: myAvatar,
      type, content: caption, file_path: localUri, file_name: fileName,
      edited: 0, created_at: new Date().toISOString(),
      reply_to_id: replyToId, reply_username: replyTo?.username ?? null,
      reply_content: replyTo?.content ?? null, reply_type: replyTo?.type ?? null,
      _uploading: true,
    }) as Message;
    addOutgoing(optimistic, parentId);
    // Persist right away (removed again on server ack): if the app is killed
    // while the upload is still in flight — the common case on a bad network —
    // the message must survive the restart as a retryable failed send.
    saveFailedMsg(optimistic);

    if (isNearBottomRef.current) setTimeout(scrollBottom, 50);
  }

  // Copy a picked/captured/shared file out of volatile storage (the cache dir,
  // or a content:// URI whose permission grant dies with the activity) into the
  // app's document directory. Without this, a send interrupted by the app
  // closing can't be retried later — the source file is already gone.
  async function persistLocal(uri: string, name: string): Promise<string> {
    try {
      if (uri.startsWith(FileSystem.documentDirectory || '')) return uri; // already durable
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
    up.setPhase(clientId, 'failed');
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
    videoPrep?: (onProgress: (p: number) => void, clientId: string) => Promise<{ uri: string; name: string }>,
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
    // Whether there is a transcode in front decides how the one progress bar
    // is shared between preparing and sending.
    const hasProcessing = type === 'video' && !!videoPrep;
    up.begin(clientId, hasProcessing);
    setReplyTo(null);
    // From here to the end of this function a file is on the wire, including
    // the transcode and the compression in front of it — which is the part
    // that takes longest and is exactly when the other side is wondering why
    // nothing has arrived.
    const sendKind = sendKindFor(type);
    announceSending(sendKind, 1);
    try {

    if (type === 'image') {
      const c = await compressForSend(uri, name, mime, quality);
      uri = c.uri; name = c.name; mime = c.mime;
    } else if (type === 'video' && videoPrep) {
      // Transcode/trim, reported as progress on the bubble itself.
      const out = await videoPrep((pct) => up.report(clientId, 'processing', pct), clientId);
      if (up.get(clientId)?.phase === 'cancelled') { removeCancelled(clientId); return; }
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
      const res = await uploadWithProgress(clientId, uri, name, mime,
        (f, sent, total) => up.report(clientId, 'uploading', f, sent, total));
      pendingUploadPaths.current[clientId] = res.url;
      socketRef.current?.emit('send_message', {
        roomId: room.id, type, content: caption, filePath: res.url, fileName: name, replyToId, clientId, oneTimeSeconds: oneTime,
        parentId: sendingParentId(),
      });
    } catch (err) {
      settleUpload(clientId, err);
    }
    } finally {
      // Every exit, including the cancelled returns above: a line that says
      // somebody is sending a file for ever is worse than no line.
      announceSending(sendKind, -1);
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
    up.begin(clientId, false);
    outbox.markStart(clientId, room.id);
    announceSending('photos', 1);
    try {
      // One bar for the whole album: each picture is a slice of it, and the
      // byte counts are summed so the line underneath is about the album
      // rather than about whichever photo happens to be in flight.
      const progress = images.map(() => 0);
      const sentEach = images.map(() => 0);
      const totalEach = images.map(() => 0);
      const urls: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const res = await uploadWithProgress(clientId, images[i].uri, images[i].name, images[i].mime,
          (f, sent, total) => {
            progress[i] = f; sentEach[i] = sent; totalEach[i] = total;
            const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
            up.report(clientId, 'uploading', sum(progress) / images.length, sum(sentEach), sum(totalEach));
          });
        urls.push(res.url);
      }
      const filePath = JSON.stringify(urls);
      pendingUploadPaths.current[clientId] = filePath;
      socketRef.current?.emit('send_message', {
        roomId: room.id, type: 'gallery', content: caption, filePath, fileName: null,
        replyToId, clientId, oneTimeSeconds: oneTime, parentId: sendingParentId(),
      });
    } catch (err) {
      settleUpload(clientId, err);
    } finally {
      announceSending('photos', -1);
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
    up.begin(clientId, false);
    outbox.markStart(clientId, room.id);
    try {
      const res = await uploadWithProgress(clientId, uri, `voice-${Date.now()}.m4a`, 'audio/m4a',
        (f, sent, total) => up.report(clientId, 'uploading', f, sent, total));
      pendingUploadPaths.current[clientId] = res.url;
      socketRef.current?.emit('send_message', {
        roomId: room.id, type: 'audio', content: caption, filePath: res.url, fileName: peakStr, replyToId, clientId, oneTimeSeconds: oneTime,
        parentId: sendingParentId(),
      });
    } catch (err) {
      settleUpload(clientId, err);
    }
  }

  // Open a document in whatever app the device uses for that type. Android
  // refuses to open a remote https URL in most viewers, so download to a local
  // cache file first and hand over a content:// URI it will accept.
  /**
   * Tapping a file card: download it, then open or install it.
   *
   * Reported as: an APK arrived with no download on the message, and tapping
   * it said "error opening file". Three faults, all in here — see
   * src/fileOpen.ts. The download is now a visible step of its own rather than
   * something that happened invisibly inside "open", and an APK is handed to
   * the package INSTALLER, which is what installing an app has always
   * required and what this app already does for its own updates.
   */
  // ── Files already on the device ────────────────────────────────────────────
  // The download store only knows what it did THIS run; a file downloaded
  // yesterday is still there. Asked once per file, and the store emits when it
  // finds one, so the card redraws itself.
  const fileChecked = useRef<Set<string>>(new Set()).current;
  function noteFileOnDisk(url: string) {
    if (fileChecked.has(url)) return;
    fileChecked.add(url);
    attachments.localUri(url).catch(() => {});
  }
  // Redraw the file cards as their downloads move.
  const [, bumpDownloads] = useReducer((x: number) => x + 1, 0);
  useEffect(() => attachments.subscribe(bumpDownloads), []);

  async function openFile(msg: Message) {
    if (!msg.file_path) return;
    if (msg.one_time_seconds) { Alert.alert('Not allowed', 'One-time files cannot be opened externally.'); return; }
    const url = `${BASE_URL}${msg.file_path}`;
    const name = msg.file_name || msg.file_path.split('/').pop() || `file-${Date.now()}`;
    const kind = kindOf(name, null);
    const st = attachments.get(url);
    const action = fileTapAction({
      kind,
      downloaded: st?.status === 'done' || !!(await attachments.localUri(url)),
      downloading: st?.status === 'downloading',
    });
    if (action === 'wait') return;
    if (action === 'download') { attachments.start(url).catch(() => {}); return; }

    const uri = await attachments.localUri(url);
    if (!uri) { attachments.start(url).catch(() => {}); return; }

    if (Platform.OS !== 'android') { await Share.share({ url: uri }).catch(() => {}); return; }
    const contentUri = await FileSystem.getContentUriAsync(uri);
    try {
      await IntentLauncher.startActivityAsync(
        action === 'install'
          // Not VIEW. Nothing answers a VIEW of an APK in a way that leads
          // anywhere: the installer appears and fails, which is the reported
          // "error opening file".
          ? 'android.intent.action.INSTALL_PACKAGE'
          : 'android.intent.action.VIEW',
        {
          data: contentUri,
          flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
          ...(action === 'install' ? {} : { type: guessMime(name, null) }),
        },
      );
    } catch {
      // An APK almost always fails for one reason, and it is one the person
      // can fix in ten seconds if they are told which switch to look for.
      const help = action === 'install' ? installHelp() : openHelp(extOf(name));
      Alert.alert(help.title, help.message, [
        { text: 'OK', style: 'cancel' },
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
      const name = safeName(msg.file_name && msg.type !== 'gallery' && msg.type !== 'audio'
        ? msg.file_name
        : String(remote).split('/').pop());
      // THE CRASH: this used to be `cacheDirectory + name`, with `name` taken
      // straight from the message. A file called "گزارش ۱۴۰۳.pdf", or anything
      // with a space, a "/" or a "#" in it, is not a valid path — and a signed
      // media URL turns into "1788-4.jpg?e=1&s=abc", a filename with a question
      // mark in it. The download threw before the sheet could open, which is
      // "it prepares the file and then nothing happens".
      //
      // Stamped, so two files with the same name from two chats cannot become
      // one path where the second share hands out the first file.
      const local = FileSystem.cacheDirectory + cacheName(name);
      const { uri } = await FileSystem.downloadAsync(`${BASE_URL}${remote}`, local);
      await Sharing.shareAsync(uri, {
        mimeType: guessMime(name, 'application/octet-stream') || undefined,
        dialogTitle: name,
      });
    } catch (e: any) {
      // Say WHAT went wrong. "Could not share that file" for every cause is
      // how a broken path stayed a mystery through several reports.
      Alert.alert('Could not share', String(e?.message || e || 'Unknown error'));
    } finally {
      setSharingOut(false);
    }
  }

  /**
   * One file, fetched with its progress reported.
   *
   * createDownloadResumable rather than downloadAsync: the plain one reports
   * no progress at all, which is why Download looked like it had not
   * registered the tap for however long the file took.
   */
  async function fetchWithProgress(url: string, to: string): Promise<string> {
    const task = FileSystem.createDownloadResumable(url, to, {}, (p) => {
      save.report(p.totalBytesWritten, p.totalBytesExpectedToWrite);
      // Asked for: a cross on the progress. The flag is set by the overlay's
      // button; the task is the only thing that can actually stop the bytes,
      // and it is right here.
      if (save.isCancelling()) task.cancelAsync().catch(() => {});
    });
    const res = await task.downloadAsync();
    // A cancelled task resolves with nothing rather than throwing.
    if (!res?.uri) throw new Error(save.isCancelling() ? 'cancelled' : 'Download failed');
    return res.uri;
  }

  /**
   * Save a message's media to the device.
   *
   * The indicator goes up BEFORE the permission prompt and before the first
   * byte, because the complaint was not that it was slow — it was that
   * nothing acknowledged the tap, so people tap again and a large video
   * downloads twice.
   */
  async function downloadMedia(msg: Message) {
    if (!msg.file_path) return;
    if (msg.one_time_seconds) { Alert.alert('Not allowed', 'One-time media cannot be downloaded.'); return; }

    const urls: string[] = msg.type === 'gallery'
      ? (() => { try { return JSON.parse(msg.file_path!); } catch { return []; } })()
      : [msg.file_path];
    if (!urls.length) return;

    // Decided per FILE below, not from msg.type — a photo in a private room
    // was being taken for a document, which is why it never reached the
    // gallery and why a dialog appeared over it. See src/saveTarget.ts.
    const firstName = saveTarget.fileNameFor({ url: urls[0], fileName: msg.file_name, now: Date.now() });
    const toGallery = saveTarget.goesToGallery({ name: firstName, type: msg.type });
    save.begin(urls.length);
    try {
      if (toGallery) {
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status !== 'granted') {
          save.clear();
          Alert.alert('Permission required', 'Allow media access to save downloads.');
          return;
        }
      }
      let lastName = '';
      for (let i = 0; i < urls.length; i++) {
        // Between files as well as during one: a gallery of ten photos must
        // stop at the next one rather than finishing the set.
        if (save.isCancelling()) { save.finish('cancelled'); return; }
        save.advance(i);
        const u = urls[i];
        // The query string is NOT part of the name. Our media URLs are
        // HMAC-signed, so `split('/').pop()` returned "photo.jpg?e=…&s=…",
        // which Android reads as a file with no usable extension — written to
        // disk, invisible to everything, exactly as photographed.
        lastName = saveTarget.fileNameFor({
          url: u, fileName: urls.length === 1 ? msg.file_name : null, now: Date.now(),
        });
        const uri = await fetchWithProgress(`${BASE_URL}${u}`, FileSystem.cacheDirectory + lastName);
        if (toGallery) await MediaLibrary.saveToLibraryAsync(uri);
      }
      save.finish('saved');
      // No alert for media any more: the indicator has been saying so all
      // along and finishes with a tick, and a dialog on top of that is one
      // more thing to dismiss. A document still gets one, because "saved as
      // <name>" is information the indicator has no room for.
      if (saveTarget.shouldAnnounce({ name: lastName, type: msg.type })) {
        Alert.alert('Downloaded', `Saved as ${lastName}`);
      }
    } catch {
      // Stopping on purpose is not a failure, and must not be reported as one.
      save.finish(save.isCancelling() ? 'cancelled' : 'failed');
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
    // The retry gets a new clientId, so the old entry would sit in the store
    // for the life of the app with no bubble left to report to.
    up.finish(clientId);
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
    up.finish(clientId);
    outbox.discard(room.id, msg);
    setMessages(prev => prev.filter(m => m.id !== clientId));
  }

  /**
   * The finger landed on the microphone.
   *
   * Reported as: the first second or two of a voice message is empty. Opening
   * the microphone — the permission read, the audio-session switch, building
   * the encoder — takes up to a second or two on these phones, and none of it
   * depends on the user having decided to speak yet. Starting it here means
   * the recorder is usually already open by the time the bar appears.
   */
  function warmMic() {
    if (!shouldWarm({ target: 'mic', alreadyWarm: voiceRecorder.isWarm(), recording })) return;
    audioManager.stop();   // the mic cannot be opened over playing audio
    voiceRecorder.warmUp().catch(() => {});
    // A microphone opened for a tap that never came must be given back: it
    // shows as the recording indicator and locks other apps out.
    clearTimeout(warmTimer.current);
    warmTimer.current = setTimeout(() => {
      if (!recordingRef.current) voiceRecorder.cool().catch(() => {});
    }, WARM_TTL_MS);
  }
  const warmTimer = useRef<any>(null);
  /** True while the recorder bar is up, so the warm-up is not taken back under it. */
  const recordingRef = useRef(false);

  /**
   * The heartbeat that keeps "is recording…" alive on the other side.
   *
   * It used to be announced ONCE, at the start. A two-minute voice note sent
   * one event and then nothing, so the only thing that could ever clear it was
   * the matching stop — and if the app died, the signal went, or the process
   * was swiped away, that stop never came and the indicator stood for ever.
   * That is what was photographed.
   *
   * Repeating it costs one tiny event every few seconds and means the other
   * side can forget anybody it has not heard from. See src/liveIndicator.ts.
   */
  const recordingBeat = useRef<any>(null);

  function startRecordingUI() {
    audioManager.stop(); // don't record over playing audio
    clearTimeout(warmTimer.current);
    recordingRef.current = true;
    setRecording(true);
    socketRef.current?.emit('recording_start', { roomId: room.id });
    clearInterval(recordingBeat.current);
    recordingBeat.current = setInterval(() => {
      if (!recordingRef.current) { clearInterval(recordingBeat.current); return; }
      socketRef.current?.emit('recording_start', { roomId: room.id });
    }, live.HEARTBEAT_MS);
  }

  /**
   * Tell the chat that a file is on its way.
   *
   * Asked for: just like "is typing", sending an image or a file should be
   * reported.
   *
   * Counted rather than paired. Announcing on each upload's start and end
   * breaks the moment there are two: the first to finish clears the indicator
   * while the second is still going, and the other side sees the line vanish
   * with a file still on the way. So the announcement follows the count
   * crossing zero — see announceOnChange in src/activityBar.ts.
   */
  const sendingCount = useRef(0);
  function announceSending(kind: SendKind, delta: 1 | -1) {
    const before = sendingCount.current;
    const after = nextInFlight(before, delta);
    sendingCount.current = after;
    const what = announceOnChange(before, after);
    if (!what) return;
    socketRef.current?.emit(what === 'start' ? 'sending_start' : 'sending_stop',
      { roomId: room.id, kind });
    // Repeated while anything is still going up, for the same reason the
    // recording is: a large video takes minutes, and one announcement at the
    // start is a mark the other side can never safely remove by itself.
    clearInterval(sendingBeat.current);
    if (what === 'start') {
      sendingBeat.current = setInterval(() => {
        if (sendingCount.current <= 0) { clearInterval(sendingBeat.current); return; }
        socketRef.current?.emit('sending_start', { roomId: room.id, kind });
      }, live.HEARTBEAT_MS);
    }
  }
  const sendingBeat = useRef<any>(null);

  function stopRecordingUI() {
    recordingRef.current = false;
    setRecording(false);
    clearInterval(recordingBeat.current);
    socketRef.current?.emit('recording_stop', { roomId: room.id });
  }

  function toggleReact(messageId: number | string, emoji: string) {
    // A reaction is a deliberate pick, so it counts towards the bar's order.
    noteEmojiUse(emoji, 'reaction');
    socketRef.current?.emit('toggle_reaction', { messageId, emoji });
    setEmojiPicker(null);
  }

  /**
   * Delete one message — whichever of the two deletes applies to it.
   *
   * `mine` is passed in rather than worked out here: the caller already knows,
   * and the one thing that must never happen is `delete_message` going out for
   * a message somebody else wrote. That is not a failed delete, it is one
   * person removing another person's words from the conversation.
   */
  function deleteMsg(id: number | string, mineMsg: boolean) {
    const kind = deleteKind({ mine: mineMsg });
    const { title, body } = deleteConfirm(kind);
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: deleteLabel(kind), style: 'destructive',
        onPress: () => {
          socketRef.current?.emit(deleteEvent(kind), { messageId: id });
          // Taken off the screen straight away for a hide. Unlike a delete for
          // everyone, nothing comes back to say it happened except the ack, and
          // waiting on a socket round-trip to make a message go away looks like
          // the tap did not register.
          if (kind === 'me') hideLocally(id);
        },
      },
    ]);
  }

  /**
   * Drop a hidden message out of this screen's copy of the chat.
   *
   * Also used when another device of the same user hides one, which arrives as
   * `message_hidden`.
   */
  function hideLocally(id: number | string) {
    setMessages(prev => prev.filter(m => String(m.id) !== String(id)));
  }

  /**
   * Date AND time, for the info panel.
   *
   * fmtTime below gives the time only, which is right on a bubble sitting
   * under a date separator and useless in a list where a row could be from
   * today or from last month. Accepts both shapes the server sends: read
   * marks are epoch milliseconds, created_at is a UTC string.
   */
  // Moved to src/messageInfo.ts when the web grew the same panel, so the two
  // clients cannot end up printing different times for one message.
  const fullWhen = messageInfo.fullWhen;

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
      if (tok.kind === 'mention') {
        const name = tok.text.slice(1);
        const isMe = name.toLowerCase() === (me || '').toLowerCase();
        return (
          <Text key={i} style={[s.mention, isMe && s.mentionMe]}
            onPress={() => tokenPress(() => openMentionedUser(name))}>{tok.text}</Text>
        );
      }
      if (tok.kind === 'number') {
        return (
          <Text key={i} style={s.copyableNumber}
            onPress={() => tokenPress(() => copy(tok.text, 'number'))}>{tok.text}</Text>
        );
      }
      return (
        <Text
          key={i}
          style={tok.kind === 'url' ? s.link : s.copyablePhone}
          onPress={() => tokenPress(
            () => setTokenAction({ kind: tok.kind as 'url' | 'phone', text: tok.text }))}
        >{tok.text}</Text>
      );
    });
  }

  // Tapping an @name opens a direct chat with that person. The username in a
  // message is just text, so it has to be resolved to an account first — and
  // if no such account exists we say so rather than opening an empty chat.
  async function openMentionedUser(name: string) {
    if (name.toLowerCase() === (me || '').toLowerCase()) return;
    const res = await apiFetch(`/search?q=${encodeURIComponent(name)}`);
    const user = (res?.users || []).find(
      (u: any) => String(u.username).toLowerCase() === name.toLowerCase(),
    );
    if (!user) { toast(`No user @${name}`); return; }
    const dm = await apiFetch(`/dm/${user.id}`, 'POST');
    if (dm.error) { Alert.alert('Error', dm.error); return; }
    onOpenDM({ id: dm.id, name: dm.name, is_dm: 1, other_username: dm.otherUsername || user.username });
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

  /**
   * Ask the server who has seen a message.
   *
   * The panel opens immediately in a loading state. Waiting for the round
   * trip before showing anything makes a long press look like it did nothing
   * on exactly the connections this app runs on.
   */
  async function openMessageInfo(msg: Message) {
    setMsgInfo({ loading: true });
    try {
      const sock = await getSocket();
      sock.timeout(8000).emit('message_info', { messageId: msg.id }, (err: any, res: any) => {
        if (err || !res || res.error) {
          setMsgInfo({ loading: false, error: res?.error || 'Could not reach the server' });
          return;
        }
        setMsgInfo({
          loading: false, sentAt: res.sentAt,
          seen: res.seen || [], notSeen: res.notSeen || [],
        });
      });
    } catch {
      setMsgInfo({ loading: false, error: 'Could not reach the server' });
    }
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
      : messagesRef.current.filter(m => selection.has(m.id)).map(m => m.id);
    if (!ids.length) return;
    // Sequentially, waiting for each ack: firing them all at once let the
    // server insert them in whatever order they happened to arrive, so a
    // forwarded conversation could land shuffled in the destination chat.
    (async () => {
      let sent = 0;
      for (const id of ids) {
        const err = await new Promise<string | null>(resolve => {
          socketRef.current?.emit('forward_message', { messageId: id, toRoomId: target.id },
            (res: any) => resolve(res?.error || null));
          setTimeout(() => resolve(null), 6000);   // never hang the loop
        });
        if (err) { Alert.alert('Cannot forward', err); break; }
        sent++;
      }
      // Say so, and say WHERE. Reported as: after forwarding, tell the user.
      // Until now the only difference between "sent to the right person" and
      // "the tap missed" was silence.
      if (sent) toast(forwardedTo(target._label || target.other_username || target.name, sent));
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

  /**
   * Delete a multi-selection, which is very often a mix of both sides.
   *
   * This used to send `delete_message` for every id in the selection. The
   * server refused the ones that were not the user's own, so a selection
   * spanning a conversation half-vanished and nothing said why. Now each id
   * gets the delete that applies to it, and the confirmation says what will
   * happen to each half.
   */
  function deleteSelected() {
    const ids = selection.all();
    if (!ids.length) return;
    const byId = new Map(messages.map(m => [String(m.id), m]));
    const split = splitForDeletion(ids, id => {
      const m = byId.get(String(id));
      return !!m && isMine(m, me);
    });
    const { title, body } = splitConfirm(split);
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => {
          split.forEveryone.forEach(id => socketRef.current?.emit('delete_message', { messageId: id }));
          split.forMe.forEach(id => {
            socketRef.current?.emit('hide_message', { messageId: id });
            hideLocally(id);
          });
          exitSelectMode();
        },
      },
    ]);
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

  const roomLink = `${BASE_URL}/join/${room.id}`;
  // Server-rendered, disk-cached thumbnail for an /uploads path. Media paths
  // now carry a signature (?e=&s=); /thumb checks the same one, so it has to
  // be carried across rather than dropped with the rest of the path.
  // useCallback because the gallery's thumbnails are memoised on it: a new
  // function every render would re-render every tile in the grid on every
  // render of the chat, which is most of what made the gallery lag.
  const thumbUrl = useCallback((uploadPath: string, w: number) => {
    const [bare, query] = String(uploadPath).split('?');
    const name = encodeURIComponent(bare.replace(/^\/uploads\//, ''));
    return `${BASE_URL}/thumb/${name}?w=${w}${query ? '&' + query : ''}`;
  }, []);
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

  function selectionEvent(ev: Parameters<typeof reduceSelection>[2]) {
    const r = reduceSelection(selState.current, selLast.current, ev);
    selState.current = r.state;
    selLast.current = r.last;
    // The reducer says which message to wipe, and it is not always the one the
    // event was about: a touch on message B is what clears a leftover
    // selection on message A. Doing it here means every caller gets it,
    // instead of each one having to remember the id from before the event.
    if (r.clearId !== null) dismissTextSelection(r.clearId);
    return r.action;
  }

  /** A touch went down on a selectable text bubble (observed, not claimed). */
  function noteTextTouch(id: MsgId, e?: any) {
    clearTimeout(holdTimer.current);
    clearTimeout(tapTimer.current);
    // A fresh touch: whatever the last one was spent on is over. Not cleared
    // outright — a press still on its way from the PREVIOUS touch would then
    // find nothing to explain the menu it is about to see.
    if (!menuSpentByToken()) tokenPressedAt.current = null;
    // A finger landing on a list that is still gliding is spent stopping it:
    // Android never delivers that touch as a tap and starts no selection from
    // it. Told to the reducer so it is not counted as half of a double-tap.
    const settling = stillMoving({ lastScrollAt: lastScrollAt.current, now: Date.now() });
    textTouchAt.current = Date.now();
    textTouchFrom.current = {
      x: e?.nativeEvent?.pageX ?? 0, y: e?.nativeEvent?.pageY ?? 0,
    };
    textTouchMoved.current = false;
    selectionEvent({ type: 'down', id, at: textTouchAt.current, settling });
    // Did that touch COMPLETE a double-tap?
    //
    // If so the OS is selecting a word right now and this touch is spent. The
    // release must not go on to schedule a tap — which is exactly what it did,
    // and 300ms later that tap was read as "a tap while something is selected"
    // and dismissed the selection. That is the reported "the word is selected
    // and then deselected".
    spentByDoubleTap.current = String(selState.current.selecting ?? '') === String(id);
    // No tap within the long-press window means the finger was held, which is
    // the other way the OS starts a selection. Not while the list is still
    // gliding: that finger is stopping a fling, not resting on a word.
    if (!settling) {
      holdTimer.current = setTimeout(() => selectionEvent({ type: 'held', id }), LONG_PRESS_MS);
    }
  }

  /** When the finger that landed on a text bubble went down, and where. */
  const textTouchAt = useRef(0);
  const textTouchFrom = useRef({ x: 0, y: 0 });
  /** Did that finger travel far enough to be a scroll rather than a tap? */
  const textTouchMoved = useRef(false);
  /** Was the touch spent completing a double-tap? */
  const spentByDoubleTap = useRef(false);
  /**
   * Was the touch spent on something INSIDE the message?
   *
   * Reported as: tapping a number copies it and then the message menu pops up
   * on top of the confirmation — and reported AGAIN, for links and numbers,
   * after a first fix that depended on the two handlers running in a
   * particular order. They do not. See src/tokenTap.ts: the question is now
   * about time, and it is asked at every point that could open a menu — plus
   * one that can close a menu the same touch already opened.
   */

  /**
   * Run a token's action, and mark the touch as spent.
   *
   * Everything tappable inside a message goes through here rather than each
   * one remembering to do it — the next one added would forget, and the
   * symptom (a menu appearing over what you just tapped) is subtle enough to
   * ship.
   */
  function tokenPress(action: () => void) {
    const now = Date.now();
    tokenPressedAt.current = now;
    clearTimeout(tapTimer.current);
    // The press may be arriving AFTER the menu it was never meant to open —
    // Android dispatches a Text press separately from the touch that carried
    // it, and on a busy list that can be later than the 300 ms the menu waits
    // out. Nothing but this touch can have opened a menu that appeared a
    // moment ago, so take it back.
    if (menuWasStrayTap({ menuOpenedAt: menuOpenedAt.current, now })) {
      menuOpenedAt.current = null;
      setActionsMsg(null);
    }
    action();
  }
  /** When a token was last pressed, and when a menu last opened. */
  const tokenPressedAt = useRef<number | null>(null);
  const menuOpenedAt = useRef<number | null>(null);
  /** Would opening the menu right now be overriding what the user just tapped? */
  function menuSpentByToken() {
    return spentByToken({ pressedAt: tokenPressedAt.current, now: Date.now() });
  }
  /**
   * When the list was last seen moving, or null once it has definitely
   * stopped. A timestamp rather than a flag — see SETTLE_MS for why a flag
   * left double-tap broken for the rest of the session after scrolling up.
   */
  const lastScrollAt = useRef<number | null>(null);
  /** Beyond this many pixels it is a drag, not a tap. */
  const TAP_SLOP = 10;

  /**
   * The finger came off a text bubble.
   *
   * This did not exist, and its absence was the whole of the double-tap bug.
   * A tap on the text lands on the <Text>, not on the press-catcher behind the
   * bubble, so NOTHING was told the touch had ended: the long-press timer was
   * never cancelled and fired 450ms later, marking a message as "selected"
   * that the user had merely tapped once. From then on our idea of what the OS
   * was showing and what it was actually showing had come apart, and the next
   * double-tap went to dismissing a selection instead of making one.
   *
   * It is also, for free, the tap that opens the message menu — which is what
   * a single tap on a message ought to do and previously did nothing at all.
   */
  function noteTextRelease(msg: Message) {
    clearTimeout(holdTimer.current);
    // That touch made a selection. It is spent; anything else it went on to
    // do would be undoing what the user just asked for.
    if (spentByDoubleTap.current) { spentByDoubleTap.current = false; return; }
    // It landed on a number, a link or an @name, which has already answered
    // it. Opening the menu as well would put a sheet over the confirmation of
    // what the user just did.
    if (menuSpentByToken()) return;
    // The finger travelled: this was a scroll or a swipe that happened to
    // start on some text. Treating it as a tap opened the message menu at the
    // end of every flick — and THAT is why double-tap "did not work after
    // scrolling up" until you tapped elsewhere: the elsewhere-tap was
    // dismissing a menu nobody meant to open.
    if (textTouchMoved.current) return;
    const now = Date.now();
    const held = now - textTouchAt.current;
    // The gap to the NEXT tap is measured from here, the way Android measures
    // it. Recorded before the early return below, because a press that became
    // a selection is still the start of the window for whatever follows.
    selectionEvent({ type: 'release', id: msg.id, at: now });
    // Long enough to be a press, not a tap: the OS is selecting a word, and
    // the hold timer has already said so. Nothing to do.
    if (held >= LONG_PRESS_MS) return;
    // Wait to find out whether a second tap is coming. A double-tap is how the
    // OS starts a word selection, so opening the menu on the first tap would
    // make selecting text by double-tap impossible. noteTextTouch cancels this
    // timer, so a second tap simply prevents the menu.
    clearTimeout(tapTimer.current);
    tapTimer.current = setTimeout(() => {
      // Asked again HERE rather than only above: the press that answers this
      // touch may have landed in the 300 ms since.
      if (menuSpentByToken()) return;
      const action = selectionEvent({ type: 'tap' });
      if (action === 'dismiss') return;
      if (selectMode) { toggleSelected(msg); return; }
      openMenuFor(msg);
    }, DOUBLE_TAP_MS);
  }

  /** Wipe the on-screen selection by remounting that message's Text. */
  function dismissTextSelection(id: MsgId) {
    clearSelectionOf(id);
  }

  /**
   * Load what I have decided about a person, without showing anything.
   *
   * Separate from opening the sheet because the profile needs it too: the ⋮
   * has to know whether it is offering "Block" or "Unblock" before it is
   * tapped, not after.
   */
  async function loadPeer(username: string) {
    if (!username || username === meRef.current) return null;
    setPeer(prev => prev?.username === username ? prev : { username, muted: false, blocked: false });
    const p = await apiFetch(`/user-profile/${encodeURIComponent(username)}`);
    if (p && !p.error) {
      const view = {
        username: p.username, avatar: p.avatar,
        muted: !!p.muted, blocked: !!p.blocked, isSelf: !!p.isSelf,
      };
      setPeer(view);
      peerIdRef.current = p.id;
      return view;
    }
    return null;
  }

  /** Load and show the actions sheet. */
  async function openPeer(username: string) {
    if (!username || username === meRef.current) return;
    setPeerOpen(true);
    await loadPeer(username);
  }
  const peerIdRef = useRef<number | null>(null);

  async function setPeerFlag(kind: 'mute' | 'block', on: boolean, forHow?: peerActions.MuteFor) {
    const id = peerIdRef.current;
    if (!id) return;
    const r = await apiFetch(`/${kind}/${id}`, on ? 'POST' : 'DELETE',
      on && kind === 'mute' ? { for: forHow } : undefined);
    if (r?.error) { toast(r.error); return; }
    setPeer(prev => prev && {
      ...prev,
      [kind === 'mute' ? 'muted' : 'blocked']: on,
      ...(kind === 'mute' ? { mutedUntil: r?.until ?? null } : {}),
    });
    toast(kind === 'mute'
      ? (on ? (forHow === '2h' ? 'Muted for 2 hours' : 'Notifications muted') : 'Notifications on')
      : (on ? 'Blocked' : 'Unblocked'));
  }

  /**
   * Mute a person, having asked for how long.
   *
   * Unmuting asks nothing: there is only one way to stop being quiet.
   */
  function askMutePeer(on: boolean) {
    if (!on) return setPeerFlag('mute', false);
    Alert.alert('Mute notifications', 'How long should this chat stay quiet?', [
      { text: 'Cancel', style: 'cancel' },
      ...peerActions.MUTE_CHOICES.map(c => ({
        text: peerActions.muteChoiceLabel(c),
        onPress: () => { setPeerFlag('mute', true, c); },
      })),
    ]);
  }

  /**
   * Empty this conversation.
   *
   * The screen is emptied straight away rather than waiting for the server:
   * clearing is the one action where a delay looks exactly like it did not
   * work, and the request that follows either confirms it or the messages
   * come back on the next load.
   */
  async function clearHistory(scope: ClearScope) {
    setPeerOpen(false);
    const r = await apiFetch(`/clear-history/${room.id}`, 'POST', { scope });
    if (r?.error) { toast(r.error); return; }
    applyWindow({ messages: [], hasOlder: false, hasNewer: false });
    rm.forgetCached(room.id);
    toast(scope === 'both' ? 'Cleared for both' : 'Cleared');
    // Nothing left to be in: the chat has also left the chat list.
    onBack();
  }

  function openMenuFor(msg: Message, e?: any) {
    // Not while it is still uploading. Everything in the menu is a lie at that
    // moment: the bubble is a local placeholder with no id, so Reply, Forward,
    // Edit, Comment and Delete all name something the server has never heard
    // of. One place decides it, so the tap, the long press and the ⋮ cannot
    // disagree — see src/messageMenu.ts.
    if (!canOpenMenu(msg as any)) return;
    menuOpenedAt.current = Date.now();
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
    // Unticking the last one leaves select mode, which is the only part of this
    // that the screen as a whole needs to know about.
    if (selection.toggle(msg.id) === 0) setSelectMode(false);
  }
  function enterSelectMode(msg: Message) {
    // A message with no id cannot be selected, forwarded or deleted either.
    if (!canOpenMenu(msg as any)) return;
    clearTimeout(tapTimer.current);
    selection.begin(msg.id);
    setSelectMode(true);
  }
  function exitSelectMode() { selection.clear(); setSelectMode(false); }

  function onMessageLongPress(msg: Message) {
    clearTimeout(holdTimer.current);
    selectionEvent({ type: 'clear' });
    enterSelectMode(msg);
  }

  // Tap on a text bubble, or on the empty space beside any message.
  //
  // No double-tap handling any more: text selection is the platform's job now
  // (long-press or double-tap on a selectable Text), so a tap no longer has to
  // wait to find out whether a second one is coming. The menu opens at once.
  function onMessageTap(msg: Message, e: any, _fromText: boolean) {
    clearTimeout(holdTimer.current);
    // The catcher sits behind the whole row, so a token press that Android
    // routed past the bubble lands here instead. It never asked this before.
    if (menuSpentByToken()) return;
    // selectionEvent does the clearing itself now, from the id the reducer
    // returns.
    const action = selectionEvent({ type: 'tap' });
    // A tap outside a live text selection means "never mind" — it clears the
    // selection and stops there. Opening the message menu on that same tap
    // made dismissing a selection impossible without also being interrupted.
    if (action === 'dismiss') return;
    if (selectMode) { toggleSelected(msg); return; }
    openMenuFor(msg, e);
  }

  useEffect(() => () => {
    clearTimeout(tapTimer.current); clearTimeout(holdTimer.current); cancelSettling();
  }, []);

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

  // Hardware back leaves the THREAD before it leaves the chat.
  //
  // Without this, back went straight out to the room list from inside a
  // comments screen — losing both the thread and the conversation in one
  // press, when what was wanted was the step the ← in the header takes.
  useEffect(() => {
    if (!commentParent) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // To the MESSAGE, not to the end of the chat. Reported as: back drops
      // you at the bottom of the conversation, having lost the place you were
      // reading — and the thread was opened from a message that may be a
      // hundred messages up.
      jumpToParentMessage();
      return true;
    });
    return () => sub.remove();
  }, [commentParent]);

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
    if (!selectMode) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectMode) { exitSelectMode(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [selectMode]);

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
    const prep = async (onProgress: (p: number) => void, clientId: string) => {
      let uri = choice.uri;
      let name = pending.item.name;
      if (choice.quality !== 'original') {
        uri = await compressVideo(
          choice.uri, choice.quality, choice.size, onProgress, pending.bytes, choice.seconds,
          // A transcode cannot be paused — the encoder offers no such thing —
          // but it must be stoppable, because it is the slowest part of
          // sending a video and the one people give up on.
          (stop) => up.attach(clientId, { cancel: stop }),
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
  /**
   * Full-size photos the device must NOT keep.
   *
   * The fullscreen viewer is handed bare URLs, with no message attached, so
   * the rule has to be resolved into a set beforehand — from the messages we
   * have loaded, and from the media browser's own listing, which the server
   * marks because it covers history the chat never loaded.
   */
  /** Drop every cached file belonging to a message that no longer exists. */
  function forgetCachedMedia(m: any) {
    const paths: string[] = [];
    if (m?.file_path && typeof m.file_path === 'string') {
      if (m.file_path.startsWith('[')) {
        try { paths.push(...JSON.parse(m.file_path)); } catch {}
      } else {
        paths.push(m.file_path);
      }
    }
    paths.forEach(p => mediaCache.forget(`${BASE_URL}${p}`).catch(() => {}));
  }

  function noCacheUrls(): Set<string> {
    const out = new Set<string>();
    messagesRef.current.forEach((m: any) => {
      if (canTakeContent(m)) return;
      if (m.type === 'image' && m.file_path) out.add(`${BASE_URL}${m.file_path}`);
      if (m.type === 'gallery' && m.file_path) {
        try { JSON.parse(m.file_path).forEach((u: string) => out.add(`${BASE_URL}${u}`)); } catch {}
      }
    });
    (mediaState?.images || []).forEach((x) => {
      if (x.cacheable === false) out.add(`${BASE_URL}${x.url}`);
    });
    return out;
  }

  function openViewerActions() {
    if (!viewerUrl) return;
    const rel = viewerUrl.startsWith(BASE_URL) ? viewerUrl.slice(BASE_URL.length) : viewerUrl;
    const found = (mediaState?.images || []).find((x) => x.url === rel);
    setViewerActions(found || { url: rel, name: rel.split('/').pop() || 'photo' });
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
      const images = (mediaState?.images || []).map(i => i.url);
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

  // Where the phone thinks we are, kept while the picker is open so a fix that
  // arrives late can still centre the map.
  const [locFix, setLocFix] = useState<pick.Fix>(null);
  const [locating, setLocating] = useState(false);
  const [showLocationPicker, setShowLocationPicker] = useState(false);

  /** Ask the phone where it is, and remember the answer. */
  async function refreshFix(): Promise<pick.Fix> {
    setLocating(true);
    try {
      const pos = await locationManager.currentPosition();
      setLocFix(pos);
      return pos;
    } finally {
      setLocating(false);
    }
  }

  /**
   * Open the map so the pin can be placed by hand.
   *
   * The map goes up FIRST and the fix arrives into it, rather than the other
   * way round. Waiting for a fix before showing anything meant staring at a
   * closed sheet for however long the phone took, and a phone that never got
   * a fix used to mean no location could be shared at all — which is the worst
   * possible outcome for someone who knows perfectly well where they are.
   */
  async function openLocationPicker() {
    setShowLocationMenu(false);
    if (!(await locationManager.ensurePermission())) {
      Alert.alert('Location needed', 'Allow location access to share where you are.');
      return;
    }
    setLocFix(null);
    setShowLocationPicker(true);
    refreshFix();
  }

  // Post a location. `liveMinutes` 0 = a one-off pin; anything else starts a
  // live share that keeps updating the SAME message.
  //
  // `chosen` is where the user put the pin. A live share ignores it: live
  // means "follow me", and the tracker overwrites the coordinates within
  // seconds — see locationPayload for why placing one by hand would be a lie
  // that quietly corrects itself.
  async function sendLocation(liveMinutes: number, chosen?: LatLng) {
    setShowLocationMenu(false);
    setShowLocationPicker(false);
    if (!(await locationManager.ensurePermission())) {
      Alert.alert('Location needed', 'Allow location access to share where you are.');
      return;
    }
    const fix = chosen ? locFix : await refreshFix();
    const at = chosen || (fix ? { lat: fix.lat, lng: fix.lng } : null);
    if (!at) { Alert.alert('No position', 'Could not get your location. Try again outdoors.'); return; }

    const liveUntil = liveMinutes > 0 ? Date.now() + liveMinutes * 60_000 : null;
    const payload = pick.locationPayload({ chosen: at, fix, liveUntil, now: Date.now() });

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
    // A static pin is still worth showing unless that person is live — EXCEPT
    // the one being opened. Dropping that one was reported as a map that does
    // nothing: tap an older pin from somebody who is sharing live now and the
    // fullscreen map could not find the message it was opened for, so it fell
    // back to whatever pin happened to be first (or, with none, drew nothing
    // at all and left the still preview on screen looking like a picture).
    return [...byUser.values(), ...loose.filter(p =>
      !byUser.has(p.username) || String(p.id) === String(openLocationId))];
  }, [messages, me, clockTick, openLocationId]);

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
    const onOneTime = ({ roomId, allowed }: any) => {
      if (String(roomId) !== String(room.id)) return;
      setOneTimeAllowed(!!allowed);
      if (!allowed) setOneTimeSecs(null);
    };
    sock.on('disappearing_changed', onChanged);
    sock.on('one_time_allowed_changed', onOneTime);
    return () => {
      sock.off('disappearing_changed', onChanged);
      sock.off('one_time_allowed_changed', onOneTime);
    };
  }, [room.id, socketRef.current]);

  // ── A message goes when its time is up, not when the server gets round to
  //    saying so ──
  //
  // Reported as: disappearing messages do not disappear exactly after the set
  // time. Half of that was the server sweeping on a thirty-second interval —
  // fixed there — and half was this end waiting to be told: the bubble stayed
  // on screen until the delete event arrived, which on a slow connection is a
  // pause and on a dropped socket is forever.
  //
  // Both ends know the deadline. The server still destroys the message; this
  // just stops showing something it knows has gone.
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      setMessages(prev => {
        const kept = dropExpired(prev, now);
        return kept.length === prev.length ? prev : kept;
      });
    };
    tick();
    const wait = msUntilNextExpiry(messages);
    if (wait === null) return;
    // One timer, for the EARLIEST deadline in the list. It re-arms from the
    // state change the removal causes, so a chat full of countdowns still only
    // ever holds one.
    const t = setTimeout(tick, Math.min(wait, 60_000));
    return () => clearTimeout(t);
  }, [messages]);

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

  /**
   * A copy with its body in plain text.
   *
   * Decryption happened where a message was DRAWN and nowhere else, so the
   * comments heading — which describes a message without drawing it — printed
   * the base64 it was handed. Reported as: the preview is "some hash".
   */
  function decrypted(msg: Message): Message {
    if (!e2eIsEncrypted(msg.content) && !e2eIsEncrypted(msg.reply_content)) return msg;
    const copy: Message = { ...msg };
    if (e2eIsEncrypted(copy.content)) {
      const dec = e2eDecrypt(copy.content, dmPeerPk.current);
      // "Cannot decrypt on this device" is the wrong sentence while the peer's
      // key is still on its way — it announces a permanent loss during a wait
      // of a second or two, across every bubble in the chat.
      copy.content = dec !== null ? dec : undecryptedBody(e2ePhase);
    }
    if (e2eIsEncrypted(copy.reply_content)) {
      const decR = e2eDecrypt(copy.reply_content ?? null, dmPeerPk.current);
      copy.reply_content = decR !== null ? decR : undecryptedQuote(e2ePhase);
    }
    return copy;
  }

  function renderMessage({ item: msg }: { item: Message }) {
    msg = decrypted(msg);
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
              : d.kind === 'one_time_on' || d.kind === 'one_time_off'
              ? <Text>{' '}{oneTimePredicate(d.kind === 'one_time_on')}</Text>
              : d.kind === 'removed'
              ? <Text>{' '}{isMe ? 'were' : 'was'} removed from the room{d.byUsername ? ` by ${d.byUsername}` : ''}</Text>
              : d.kind === 'left'
              ? <Text>{' '}left the room</Text>
              : <Text>{' '}joined the room</Text>}
          </Text>
        </View>
      );
    }
    const mine = isMine(msg, me);
    const hiddenOneTime = !!msg.one_time_seconds && !revealedOneTime.has(msg.id) && !msg._uploading;
    const rxns = reactions[msg.id] || [];
    const grouped: Record<string, { count: number; mine: boolean }> = {};
    rxns.forEach(r => {
      if (!grouped[r.emoji]) grouped[r.emoji] = { count: 0, mine: false };
      grouped[r.emoji].count++;
      if (r.username === me) grouped[r.emoji].mine = true;
    });

    return (
      <>
      {/* Where this visit's unread messages begin. Drawn inside the row rather
          than as a list item of its own: the list is inverted and its data is
          the messages, so an injected item would have to be kept out of every
          index calculation in this file. */}
      {!!unreadInfo && unreadInfo.anchorId === String(msg.id) && (
        <View style={s.unreadDivider}>
          <View style={s.unreadDividerLine} />
          <Text style={s.unreadDividerText}>{unreadLabel(unreadInfo.count)}</Text>
          <View style={s.unreadDividerLine} />
        </View>
      )}
      <SelectedRow id={msg.id} base={s.msgRow} picked={s.msgRowPicked}>
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
            <TouchableOpacity style={s.senderChip} onPress={() => openPeer(msg.username)} activeOpacity={0.6}>
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
          enabled={!selectMode}
          // The swipe has won the gesture, so anything the OS started under the
          // finger on its way here — a long-press that selected a word — is
          // undone. It also spends the touch, so the finger lifting at the end
          // of the swipe is not read as a tap on the message.
          onSwipeStart={() => {
            clearTimeout(holdTimer.current);
            selectionEvent({ type: 'swipe', id: msg.id });
          }}
          onSwipeRight={() => { setReplyTo({ id: msg.id, username: msg.username, content: msg.content, type: msg.type }); composerRef.current?.focus(); }}
          onSwipeLeft={mine ? () => deleteMsg(msg.id, true) : undefined}
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
          ? {
              // Capture phase, always returning false: this WATCHES the touch
              // going down without claiming it, so native text selection still
              // works exactly as before. It is the only signal available for
              // guessing that a selection is about to start.
              onStartShouldSetResponderCapture: (e: any) => {
                if (canTakeContent(msg)) noteTextTouch(msg.id, e);
                return false;
              },
              // The other half of the same observation. Touch handlers on a
              // View are delivered whether or not it owns the responder, which
              // is the only way to see a tap that landed on selectable text.
              onTouchEnd: () => { if (canTakeContent(msg)) noteTextRelease(msg); },
              // Measured against where the finger LANDED, not against the
              // previous move: a slow drag never moves far between two events
              // and would never trip a per-event threshold.
              onTouchMove: (e: any) => {
                const dx = (e?.nativeEvent?.pageX ?? 0) - textTouchFrom.current.x;
                const dy = (e?.nativeEvent?.pageY ?? 0) - textTouchFrom.current.y;
                if (dx * dx + dy * dy > TAP_SLOP * TAP_SLOP && !textTouchMoved.current) {
                  textTouchMoved.current = true;
                  clearTimeout(tapTimer.current);
                  clearTimeout(holdTimer.current);
                  // The timers were already cancelled here; the STATE was not,
                  // so the finger stayed "pending" and its touch-down stayed on
                  // the clock as half of a double-tap. A tap landing shortly
                  // after a flick was then read as completing a double-tap that
                  // the OS had never seen, and from then on our idea of what was
                  // selected was wrong.
                  selectionEvent({ type: 'moved', id: msg.id });
                }
              },
            }
          : {
              onPress: selectMode ? () => toggleSelected(msg) : undefined,
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
                  // Faded, dashed, and never marked as delivered. Enough to
                  // feel that something is wrong without being told what —
                  // announcing the block outright turns a quiet decision into
                  // a confrontation with the person who made it. The rule
                  // comes from peerActions so the drawn version and the tested
                  // version cannot drift apart.
                  vanishedStyle(msg.blocked_delivery).faded && s.bubbleVanished,
                  ]}
        >
          {/* Reply quote */}
          {msg.reply_to_id && msg.reply_username && (
            // Through tokenPress, like every other thing inside a bubble.
            // Reported as: tapping a reply to go to the original scrolls to it
            // and then opens the message menu on top. Same fault as tapping a
            // number: the quote answers the touch, and the bubble — which
            // cannot see that — went on treating it as an ordinary tap.
            <TouchableOpacity style={s.replyQuote}
              onPress={() => tokenPress(() => jumpToMessage(msg.reply_to_id!))}>
              <Text style={s.replyQuoteUser}>{msg.reply_username}</Text>
              {/* Isolated: a preview is a fragment dropped into a line of its
                  own, and without a fence a Persian one drags that line's
                  punctuation around with it. */}
              <Text style={s.replyQuoteText} numberOfLines={1}>{bidiIsolate(replyPreview(msg))}</Text>
            </TouchableOpacity>
          )}

          {msg.forwarded_from ? (
            <Text style={s.forwardedLabel}>↪ Forwarded from {msg.forwarded_from}</Text>
          ) : null}
          {hiddenOneTime && (
            <TouchableOpacity onPress={() => tokenPress(() => revealOneTime(msg))}>
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
            <SelectableText
              // Subscribes to clears aimed at itself and remounts, which is
              // the only way to drop a native selection. It used to be done by
              // putting the cleared id into the list's extraData, which
              // re-rendered every mounted row to remount one — including,
              // between the two taps of a double-tap, the message being
              // tapped. That is why double-tap was unreliable until you tapped
              // some other message first.
              msgId={msg.id}
              // WHICH WAY ROUND this paragraph goes, decided from what it
              // says. A Persian sentence with English terms in it laid out
              // against an LTR base keeps its words but hangs every neutral
              // character off the wrong end — brackets closing around the
              // wrong clause, a full stop on the left of its own sentence.
              style={[s.msgText, msgDirStyle(msg.content || '')]}
              selectable={canTakeContent(msg)}
            >{renderTextWithLinks(shownText(msg.content || '', expandedIds.has(msg.id)))}{msg.edited ? <Text style={s.edited}> (edited)</Text> : null}{msg.one_time_seconds ? <Text style={s.oneTimeTag}> 🔥{msg.one_time_seconds}s</Text> : null}</SelectableText>
          )}
          {/* A pasted article or a forwarded poem fills the screen and pushes
              every other message out of the chat. Past a certain size it is
              folded — the whole text is still what gets copied, forwarded and
              searched; this is only how it is drawn. */}
          {!hiddenOneTime && msg.type === 'text' && showsToggle(msg.content || '') && (
            <TouchableOpacity onPress={() => tokenPress(() => toggleExpanded(msg.id))}>
              <Text style={s.foldToggle}>{toggleLabel(expandedIds.has(msg.id))}</Text>
            </TouchableOpacity>
          )}
          {/* The cover and title of the first link in the message. Draws
              nothing at all until there is something to draw, so a bubble
              never grows a grey box under it. */}
          {msg.type === 'text' && !!msg.content && (
            <LinkCard content={msg.content} onPress={run => tokenPress(run)} />
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
                  <TouchableOpacity style={s.inviteBtn}
                    onPress={() => tokenPress(() => acceptInvite(msg.content))}>
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
                  if (selectMode) { toggleSelected(msg); return; }
                  if (!msg._uploading) openViewer(uri);
                }}
                onLongPress={() => onMessageLongPress(msg)}
                delayLongPress={350}
                disabled={msg._uploading}>
                {msg._uploading
                  ? <Image source={{ uri }} style={s.msgImage} resizeMode="cover" />
                  : <ImageWithSpinner uri={uri} cache={canTakeContent(msg)} style={s.msgImage} resizeMode="cover" onLoaded={onLoaded} />}
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
                cache={canTakeContent(msg)}
                onLongPress={() => onMessageLongPress(msg)}
                onOpen={(i) => { if (selectMode) toggleSelected(msg); else openViewer(full[i]); }}
                onFirstLoaded={msg.one_time_seconds && !mine ? () => startOneTimeClock(msg) : undefined}
              />
            );
          })()}
          {!hiddenOneTime && msg.type === 'audio' && !msg._uploading && (
            <VoicePlayer url={`${BASE_URL}${msg.file_path}`} peaks={msg.file_name || ''} mine={mine} msgId={msg.id} roomId={room.id} roomMeta={room} cache={canTakeContent(msg)} label={`🎙 ${msg.username} · voice message`}
              played={!!msg.played}
              // The whole row plays; the menu stays where every other message
              // keeps it, on the long press and on the space beside the bubble.
              onLongPress={() => onMessageLongPress(msg)}
              selectMode={selectMode}
              onSelect={() => toggleSelected(msg)}
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
            <MusicPlayer url={`${BASE_URL}${msg.file_path}`} fileName={msg.file_name || 'Audio'} mine={mine} msgId={msg.id} roomId={room.id} roomMeta={room} cache={canTakeContent(msg)}
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
                  if (selectMode) { toggleSelected(msg); return; }
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
                  if (selectMode) { toggleSelected(msg); return; }
                  setOpenLocationId(msg.id);
                }}
                onLongPress={() => onMessageLongPress(msg)}
                delayLongPress={350}
              >
                <View style={s.locCard}>
                  {/* A still preview: not interactive, so the tap opens the
                      fullscreen map instead of being eaten by a map drag.
                      Reported as "the map is a solid image and cannot be
                      pinched" — which it is, so it now says so: the badge is
                      the only thing that tells you the real map is one tap
                      away. */}
                  <View style={s.locExpand} pointerEvents="none">
                    <Ionicons name="expand" size={13} color="#fff" />
                  </View>
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
            const fileKind = kindOf(fname, null);
            // A real card per file type — the icon distinguishes PDFs, docs,
            // sheets and archives. The line under the name says what the next
            // tap will do, and the download is a step of its own: it used to
            // happen invisibly inside "open", so a 40 MB file on a slow
            // connection was a card that looked inert for minutes.
            const url = msg.file_path ? `${BASE_URL}${msg.file_path}` : '';
            const dl = url ? attachments.get(url) : null;
            const downloading = dl?.status === 'downloading';
            // A file downloaded before this app was last opened is still on
            // the device; asking the store makes it say so (and redraw).
            if (url && !dl) noteFileOnDisk(url);
            const downloaded = dl?.status === 'done';
            const meta = cardMeta({
              kind: fileKind,
              ext: extOf(fname),
              downloaded,
              downloading,
              percent: dl ? progressPercent(dl.written, dl.total) : 0,
              failed: dl?.status === 'failed',
              uploading: !!msg._uploading,
            });
            return (
              <TouchableOpacity
                style={s.fileCard}
                disabled={!!msg._uploading}
                onPress={() => openFile(msg)}>
                <Text style={s.fileCardIcon}>{icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.fileCardName} numberOfLines={2}>{fname}</Text>
                  <Text style={s.fileCardMeta}>{meta}</Text>
                </View>
                {downloading && (
                  <ActivityIndicator size="small" color={C.accent} />
                )}
                {showsDownloadButton({ downloaded, downloading, uploading: !!msg._uploading }) && (
                  <Ionicons name="download-outline" size={22} color={C.accent} />
                )}
              </TouchableOpacity>
            );
          })()}
          {!hiddenOneTime && msg.type !== 'text' && msg.type !== 'invite' && msg.type !== 'call'
            && msg.type !== 'location' && msg.content ? (
            <Text style={[s.msgText, s.caption, msgDirStyle(msg.content || '')]} selectable>{renderTextWithLinks(msg.content)}</Text>
          ) : null}
          {msg.one_time_seconds && !hiddenOneTime && !msg._uploading ? (
            <TouchableOpacity onPress={() => hideOneTime(msg)}>
              <Text style={s.oneTimeHideBtn}>🙈 Hide</Text>
            </TouchableOpacity>
          ) : null}
          {msg._uploading && <UploadOverlay msgId={msg.id} />}
          {msg._uploadFailed && (
            <View style={s.failedRow}>
              <TouchableOpacity onPress={() => retryUpload(msg, true)}>
                <Text style={s.uploadRetryText}>⚠️ Failed — tap to retry</Text>
              </TouchableOpacity>
            </View>
          )}
        {/* Telegram's comments strip: full width along the bottom of the
            message, inside its outline and separated by a hairline, in the
            app's own accent. It replaced a green circle on the corner — that
            is how a LAUNCHER badges an app icon, and it shouts because it
            competes with a screenful of icons; sitting on somebody's words it
            just fought the text. This says what it is rather than leaving a
            number to be decoded, and the whole strip is the tap target. */}
        {!msg._uploading && canComment(msg) && showsBadge(commentCountOf(msg)) && (
          // Through tokenPress, like every other control inside a bubble.
          //
          // Reported as: tapping the strip ALSO opens the message menu. A text
          // bubble watches its own touches (that is how a tap on selectable
          // text is seen at all) and those handlers fire whether or not the
          // bubble owns the responder — so the tap that opened the thread went
          // on to open the menu over it. tokenPress is how this file says
          // "this touch has already been answered".
          <TouchableOpacity style={s.commentBar}
            onPress={() => tokenPress(() => openComments(msg))}
            accessibilityLabel={commentsTitle(commentCountOf(msg))}>
            <Text style={s.commentBarIcon}>💬</Text>
            <Text style={s.commentBarLabel} numberOfLines={1}>
              {commentsBarLabel(commentCountOf(msg))}
            </Text>
            {/* What is NEW in there, where somebody looking at this message
                would look for it. */}
            {!!unreadBadge(msg.id) && (
              <View style={s.commentBarBadge}>
                <Text style={s.commentBarBadgeText}>{unreadBadge(msg.id)}</Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={14} color={C.accent} />
          </TouchableOpacity>
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
          {/* No tick on a message that never arrived. A ✓ claiming delivery
              for something the server deliberately withheld would be the one
              outright lie in this design. */}
          {mine && !msg._uploading && !msg._uploadFailed
            && vanishedStyle(msg.blocked_delivery).showTicks && (
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
      </SelectedRow>
      </>
    );
  }

  return (
    // Swipe in from either side edge to leave the chat, like the device's back
    // button. Suspended whenever something is on top or the user is in the
    // middle of something modal — going back from under a fullscreen video or
    // out of a half-finished selection would be a surprise.
    <EdgeBack
      onBack={onBack}
      // Never while a MAP is on screen. A map wants every drag it can get —
      // and the one gesture it must never lose is a horizontal one, which is
      // both how you move a map sideways and how this goes back. The picker is
      // in a Modal, so its touches cannot reach here anyway; it is named all
      // the same, because relying on that is relying on a detail of how
      // Android windows work rather than on a rule anyone can read.
      enabled={
        !videoItem && openLocationId == null && !showLocationPicker && !cameraMode
        && !selectMode && !searching
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
            ⏳  Disappearing messages on · {disappearingLabel(disappearing)} after reading
          </Text>
        </View>
      )}
      {/* Multi-select action bar. Replaces the header while messages are
          picked, the way every chat app does it, so the count and the actions
          sit where the user is already looking. */}
      {selectMode && (
        <View style={s.selBar}>
          <TouchableOpacity onPress={exitSelectMode} style={s.selBarBtn} hitSlop={hitSlop10}>
            <Ionicons name="close" size={24} color={C.text} />
          </TouchableOpacity>
          <SelectionCount>{n => <Text style={s.selBarCount}>{n} selected</Text>}</SelectionCount>
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
      {!selectMode && searching && (
        <ChatSearch
          onClose={() => { setSearching(false); setHighlightId(null); }}
          onSearch={async (q) => {
            const r = await apiFetch(`/search-messages/${room.id}?q=${encodeURIComponent(q)}`);
            const server = r && !r.error ? (r.results || []) : [];
            const skipped = r && !r.error ? (r.encryptedSkipped || 0) : 0;

            // Encrypted messages are searched HERE, on the device.
            //
            // The server holds ciphertext and no key, so it cannot match them
            // and reported how many it had skipped instead — honest, but the
            // user still could not find their own messages. So it hands the
            // ciphertext over and we decrypt it in memory: no plaintext and no
            // search term leaves the phone. Same arrangement Telegram uses for
            // Secret Chats.
            if (!skipped || !dmPeerPk.current) {
              return { results: server, encryptedSkipped: skipped };
            }
            try {
              const enc = await apiFetch(`/encrypted-messages/${room.id}`);
              const rows: any[] = enc && !enc.error && Array.isArray(enc.messages) ? enc.messages : [];
              const plain = rows.map(m => ({
                ...m,
                content: e2eIsEncrypted(m.content)
                  ? (e2eDecrypt(m.content, dmPeerPk.current) ?? '')
                  : String(m.content || ''),
              }));
              const local = searchLocal(plain, q);
              return {
                results: mergeResults(server, local),
                // Only what we could NOT reach: anything beyond the server's
                // handover cap. Reporting the whole encrypted count here would
                // warn about messages that were, in fact, searched.
                encryptedSkipped: Math.max(0, (enc?.total || 0) - rows.length),
              };
            } catch {
              return { results: server, encryptedSkipped: skipped };
            }
          }}
          onJump={(id) => jumpToMessage(id)}
        />
      )}

      {/* Header.
          NOT while a thread is open: the room's header belongs to the
          conversation, the thread has its own with a back arrow, and two
          stacked headers were most of what made that screen feel cramped. */}
      {!selectMode && !searching && !commentParent && (
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.backBtn} activeOpacity={0.6}
          hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}>
          <Text style={s.backText}>‹</Text>
          <Text style={s.backLabel}>Chats</Text>
          {otherUnread && <View style={s.unreadDot} />}
        </TouchableOpacity>
        <TouchableOpacity style={s.headerCenter} activeOpacity={0.7}
          onPress={() => {
            // A direct chat's header opens that person's PROFILE, which is the
            // shared media with a ⋮ in the corner — media is what somebody
            // opening a profile came to look at, and mute/block/clear are not.
            if (room.is_dm) { openMediaBrowser('images'); loadPeer(room.other_username || ''); return; }
            setShowRoomInfo(true);
            loadRoomInfo();
          }}>
          <View style={s.roomAvatar}>
            {/* The person's own emoji, not a generic speech bubble: a chat with
                somebody should look like that person. */}
            <Text style={s.roomAvatarText}>
              {room.is_dm
                ? (room.other_avatar || '💬')
                : room.is_private ? '🔒' : '#'}
            </Text>
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
            {/* The live count. Without it the button looks identical whether
                a call is happening or not, which is how room calls came to
                be reported as not working at all: the first person to tap it
                waited alone, because nothing on anybody else's phone said a
                thing. */}
            {voiceIn && voiceIn.count > 0 ? (
              <View style={s.voiceDot}><Text style={s.voiceDotText}>{voiceIn.count}</Text></View>
            ) : null}
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

      {/* ── A voice chat is happening in this room ──────────────────────────
          One tap to join. The badge on the call button says a call exists;
          this says who is in it and makes joining the obvious next move.
          Hidden once you are in it yourself — the call window is the UI then. */}
      {!room.is_dm && voiceIn && voiceIn.count > 0 && !callManager.inRoomVoice(room.id) ? (
        <TouchableOpacity
          style={s.voiceBanner}
          onPress={() => callManager.toggleRoomVoice(room.id, room.name)}
        >
          <Ionicons name="call" size={16} color="#fff" />
          <Text style={s.voiceBannerText} numberOfLines={1}>
            {voiceIn.usernames && voiceIn.usernames.length
              ? `${voiceIn.usernames.slice(0, 3).join(', ')}${voiceIn.count > 3 ? ` +${voiceIn.count - 3}` : ''} in voice chat`
              : `Voice chat · ${voiceIn.count} in`}
          </Text>
          <Text style={s.voiceBannerJoin}>JOIN</Text>
        </TouchableOpacity>
      ) : null}

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
      {/* animationType="none", not "fade".
          Reported as: swiping an image down to close it takes too long.

          The gallery is not the slow part — it calls onSwipeToClose the
          instant the gesture ends, and animates the picture away on the UI
          thread in parallel. The delay was the Modal's own fade playing on top
          of that: a second, redundant animation of the same disappearance,
          which cannot start until the first has handed over. Dropping it means
          the picture leaves with the finger. */}
      <Modal visible={!!viewer} transparent animationType="none" onRequestClose={closeViewer}>
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
                  <GalleryImage
                    uri={item}
                    cache={!viewerNoCache.has(item)}
                    setImageDimensions={setImageDimensions}
                  />
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
                  <Ionicons name="ellipsis-vertical" size={19} color="#fff" />
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
            clipboard={clipboardHas}
            onClose={() => setCameraMode(null)}
            onDone={(shots) => {
              setCameraMode(null);
              setPendingMedia(prev => [...prev, ...shots]);
            }}
            onPick={(action) => {
              // The camera closes first, always: a picker the user may spend a
              // minute in should not hold the preview — and the phone's camera
              // — open behind it.
              setCameraMode(null);
              setTimeout(() => runAttachAction(action), 250);
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

      {/* ── A message's comments ──
          In the place the conversation had, with the SAME composer below it —
          not a Modal over the top, because a Modal would cover the composer,
          and the composer is what writes the comments. The conversation stays
          mounted behind this, keeping its scroll position, its loaded history
          and any upload in flight, so closing the thread puts it back exactly
          as it was instead of reloading the room. */}
      {commentParent && (
        <View style={{ flex: 1 }} {...commentsSwipe.panHandlers}>
          {/* One line, stuck to the top: back, a thumbnail when there is a
              picture, a few words of the message, and the count. The strip
              opens the original.

              The message used to be pinned here in full, rendered exactly as
              in the chat and capped at a share of the panel. That is fine on a
              whole screen and useless on what is left when a keyboard takes
              half of it — a photo filled the space and the comments, the
              reason for the screen, had none. It is context, not content. */}
          <View style={s.commentsHead}>
            <TouchableOpacity onPress={closeComments} hitSlop={hit}
              accessibilityLabel="Back to the conversation">
              <Ionicons name="arrow-back" size={22} color={C.text} />
            </TouchableOpacity>
            <TouchableOpacity style={s.commentsParentLink} onPress={jumpToParentMessage}
              accessibilityLabel="Go to the original message">
              {parentPreview(decrypted(commentParent)).thumb && !!parentThumb(commentParent) && (
                <Image source={{ uri: parentThumb(commentParent) }} style={s.commentsParentThumb} />
              )}
              <View style={s.commentsParentText}>
                <Text style={s.commentsParentPreview} numberOfLines={1}>
                  {bidiIsolate(parentPreview(decrypted(commentParent)).text)}
                </Text>
                <Text style={s.commentsTitle} numberOfLines={1}>
                  {commentsTitle(commentCountOf(commentParent))}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={C.muted} />
            </TouchableOpacity>
          </View>
          {commentsLoading ? (
            <View style={s.loadingContainer}><ActivityIndicator color={C.accent} /></View>
          ) : (
            <View style={{ flex: 1 }}>
              <FlatList
                ref={commentsListRef}
                data={comments}
                keyExtractor={keyExtractor}
                renderItem={renderMessage}
                // The same room the conversation gets. It had none, so every
                // comment sat hard against the edge of the screen and the
                // thread read as a cramped copy of the chat.
                contentContainerStyle={s.commentsListContent}
                ListEmptyComponent={<Text style={s.commentsEmpty}>{EMPTY_HINT}</Text>}
                keyboardShouldPersistTaps="handled"
                onScroll={onCommentsScroll}
                scrollEventThrottle={100}
                // Follows the newest comment, and follows the keyboard opening
                // — but only for somebody already at the end. Dragging a
                // reader out of the middle of a thread is worse than making
                // them tap the button below.
                onContentSizeChange={() => { if (commentsAtBottom.current) scrollCommentsToEnd(false); }}
              />
              {commentsJump && (
                <TouchableOpacity style={s.commentsFab} onPress={() => scrollCommentsToEnd(true)}
                  accessibilityLabel="Go to the newest comment">
                  <Ionicons name="arrow-down" size={20} color="#fff" />
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      )}

      {/* Messages */}
      {commentParent ? null : loading ? (
        <View style={s.loadingContainer}>
          <ActivityIndicator color={C.accent} size="large" />
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={invertedMessages}
          inverted
          // Anchor what the user is looking at — but ONLY while parked in the
          // middle of the history.
          //
          // There, newer pages are inserted at the top of the content as the
          // user scrolls down, and without an anchor the view slides by however
          // wrong the list's estimate of the new rows was.
          //
          // At the present it is the opposite. The list is inverted, so a new
          // message is inserted at index 0 — and anchoring did exactly what it
          // promises: it held the view still and left the arriving message just
          // off the bottom edge. That is "on new message arrival the auto
          // scroll down is not happening".
          maintainVisibleContentPosition={
            win.anchorsContent({ hasNewer: hasMoreNewer }) ? { minIndexForVisible: 1 } : undefined
          }
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
          // Scrolling wipes a native text selection — the OS does that itself,
          // without telling us. Our belief that a message is still selected
          // then outlives the selection, and the next tap gets eaten as a
          // "dismiss" that has nothing to dismiss. That is why double-tapping
          // another message stopped working after a scroll and only came back
          // after tapping around a few times.
          onScrollBeginDrag={() => {
            userDraggedRef.current = true;
            cancelSettling();
            selectionEvent({ type: 'clear' });
          }}
          onScroll={(e: any) => {
            // Every sign of movement, throttled: while the list glides these
            // keep arriving, and when it stops they simply stop. That silence
            // is what ends the settling window, so no missing end-event can
            // strand it.
            lastScrollAt.current = Date.now();
            onMessagesScroll(e);
          }}
          scrollEventThrottle={100}
          onMomentumScrollBegin={() => { lastScrollAt.current = Date.now(); }}
          // These two are exact when they arrive, so they end it outright
          // rather than waiting for the window to lapse. What they can no
          // longer do is fail to arrive and leave it set forever.
          onScrollEndDrag={() => { lastScrollAt.current = null; }}
          onMomentumScrollEnd={(e: any) => {
            lastScrollAt.current = null;
            applyScrollPosition(e.nativeEvent.contentOffset.y);
          }}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfigRef}
          onEndReached={loadOlderMessages}
          onEndReachedThreshold={1.5}
          // The list is inverted, so its START is the NEWEST end. This is the
          // way back to the present after jumping to an old message, and it
          // fetches one screenful at a time rather than everything in between.
          onStartReached={loadNewerMessages}
          // Small on purpose: a screenful and a half reaches back past the
          // message a jump just landed on.
          onStartReachedThreshold={0.1}
          ListFooterComponent={loadingOlder ? (
            <ActivityIndicator color={C.accent} size="small" style={{ marginVertical: 10 }} />
          ) : null}
          // Inverted, so the header sits at the newest end.
          ListHeaderComponent={loadingNewer ? (
            <ActivityIndicator color={C.accent} size="small" style={{ marginVertical: 10 }} />
          ) : null}
          // Only while a jump is actually trying to reach something.
          //
          // It used to retry unconditionally, 100ms later, with an animated
          // scroll that centred whatever index it had been given. During
          // ordinary scrolling through history that is a view being yanked
          // somewhere for no reason the user can see — the "suddenly goes too
          // much down or up" in the report.
          onScrollToIndexFailed={info => {
            if (!settleTimers.current.length) return;
            // Retried against the list as it is A HUNDRED MILLISECONDS LATER,
            // not as it was when the scroll failed. In between, a jump can
            // replace the whole window with a shorter one — and asking
            // FlatList for an index past the end of its data throws, which is
            // the crash that showed up while searching. Clamped, and dropped
            // entirely if there is nothing left to scroll to.
            setTimeout(() => {
              const len = messagesRef.current.length;
              if (!len) return;
              const index = Math.max(0, Math.min(info.index, len - 1));
              try {
                flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
              } catch {}
            }, 100);
          }}
        />
      )}

      {/* Jump to the oldest mention of me that I have not looked at yet. */}
      {mentionIds.length > 0 && (
        <TouchableOpacity
          // Above the go-to-newest button, wherever that has been lifted to.
          style={[s.mentionFab, { bottom: fabBottom({
            banner: !!(replyTo || editingId),
            activity: someoneIsBusy,
            // Reported with a screenshot: this button sitting on the live
            // bar's Stop, so the tap that looks like Stop scrolled the chat
            // and the location kept broadcasting.
            liveBar: !!liveShare,
          }) + 52 }]}
          onPress={() => {
            const [next, ...rest] = mentionIds;
            setMentionIds(rest);
            jumpToMessage(next);
          }}
        >
          <Text style={s.mentionFabIcon}>@</Text>
          {mentionIds.length > 1 && (
            <View style={s.scrollFabBadge}>
              <Text style={s.scrollFabBadgeText}>{mentionIds.length > 99 ? '99+' : mentionIds.length}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* New comments, in ONE place: directly above the composer, centred.
          It used to hop between the top and bottom edges depending on which
          way it pointed, and a control that moves is one the eye has to hunt
          for. The direction is something it SAYS now — in words, because a
          bare arrow beside a number was two symbols to decode. */}
      {!commentParent && !!commentJump && (
        <TouchableOpacity
          // ABOVE the go-to-newest button, never below it. Reported: the
          // chip ended up behind the composer — it was placed by subtracting
          // 60 from that button's offset, and that offset is precisely the
          // height that clears the composer, so anything less is inside it.
          style={[s.commentJump, { bottom: chipBottom({
            banner: !!(replyTo || editingId),
            activity: someoneIsBusy,
            liveBar: !!liveShare,
          }) }]}
          onPress={goToUnreadComments}
          accessibilityLabel={`${jumpLabel(commentJump)}, ${commentJump.dir === 'up' ? 'above' : 'below'}`}
        >
          <Text style={s.commentJumpIcon}>💬</Text>
          <Text style={s.commentJumpText}>{jumpLabel(commentJump)}</Text>
          <Text style={s.commentJumpArrow}>{jumpArrow(commentJump)}</Text>
        </TouchableOpacity>
      )}

      {/* Saying so, rather than letting saved history pass for live history. */}

      {fabVisible && (
        <TouchableOpacity
          // Lifted clear of whatever is stacked under it. Reported as: while
          // "… is typing" is showing, this button does not work — the typing
          // line is drawn AFTER it and lands on top of a button pinned a fixed
          // distance from the bottom of the screen, so the tap goes to the
          // text. The banners had a lift already; the typing line never did.
          style={[s.scrollFab, { bottom: fabBottom({
            banner: !!(replyTo || editingId),
            activity: someoneIsBusy,
            // Reported with a screenshot: this button sitting on the live
            // bar's Stop, so the tap that looks like Stop scrolled the chat
            // and the location kept broadcasting.
            liveBar: !!liveShare,
          }) }]}
          onPress={handleScrollFabPress}
        >
          <Text style={s.scrollFabIcon}>↓</Text>
          {missedCount > 0 && (
            <View style={s.scrollFabBadge}>
              <Text style={s.scrollFabBadgeText}>{missedCount > 99 ? '99+' : missedCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* Recording / sending / typing, in that order of priority. The wording
          and the priority live in src/activityBar.ts so this line and the
          web's cannot drift — they already had, before "is sending" was added
          to both. someoneIsBusy above is derived from the same rule, so the
          button's lift and the line's presence cannot disagree. */}
      {(() => {
        const bar = activityBar({ typing, recording: recordingUsers, sending: sendingUsers, me });
        if (!bar) return null;
        return (
          <Text style={bar.kind === 'typing' ? s.typingBar : s.recordingBar}>
            {bar.icon ? `${bar.icon} ` : ''}{bar.text}…
          </Text>
        );
      })()}

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
      <Modal visible={showAttachMenu} transparent animationType="slide"
        onShow={checkClipboard}
        onRequestClose={() => setShowAttachMenu(false)}>
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
            {/* Only when there is something on the clipboard: an option that
                does nothing is worse than no option. */}
            {clipboardHas && (
              <TouchableOpacity style={s.attachOption} onPress={pasteFromClipboard}>
                <Text style={s.attachOptionIcon}>📋</Text>
                <Text style={s.attachOptionText}>
                  {clipboardHas === 'image' ? 'Paste image' : 'Paste file'}
                </Text>
              </TouchableOpacity>
            )}
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
            // Ionicons outline set rather than emoji. Emoji are drawn by the
            // system font, so they arrive in whatever colour and weight the
            // device feels like — full-colour glyphs of wildly different
            // widths sitting in a column that is meant to read as one control
            // surface. An icon font inherits size and colour, so the whole
            // menu is one family at one weight.
            const Row = ({ icon, label, onPress, danger }: any) => (
              <Pressable
                style={({ pressed }) => [s.sheetRow, pressed && s.sheetRowPressed]}
                android_ripple={{ color: 'rgba(128,128,128,0.18)' }}
                onPress={onPress}
              >
                <Ionicons
                  name={icon}
                  size={20}
                  color={danger ? '#ef4444' : C.text}
                  style={s.sheetRowIcon}
                />
                <Text style={[s.sheetRowText, danger && s.sheetRowDanger]}>{label}</Text>
              </Pressable>
            );

            // A failed (never-sent) message only supports local actions.
            if (m._uploadFailed) {
              return (
                <View style={s.actionSheet}>
                  <View style={s.sheetGrip} />
                  <Row icon="refresh-outline" label="Retry" onPress={() => { close(); retryUpload(m, true); }} />
                  <Row icon="trash-outline" label="Delete" danger onPress={() => {
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

                <Row icon="arrow-undo-outline" label="Reply" onPress={() => {
                  close();
                  setReplyTo({ id: m.id, username: m.username, content: m.content, type: m.type });
                  composerRef.current?.focus();
                }} />
                {/* Comments. A message's own thread — the one place where a
                    reply is kept WITH what it replies to, rather than
                    scrolling away from it. Not offered on a comment: one
                    level, and the server refuses a second one anyway. */}
                {canComment(m) && (
                  <Row icon="chatbubble-ellipses-outline"
                    label={commentsTitle(commentCountOf(m))}
                    onPress={() => { close(); openComments(m); }} />
                )}
                {/* Inline selection is unreliable on any message containing a
                    link, a phone number or even a price: those render as
                    pressable spans and swallow the long-press. This always
                    works, whatever the message contains. */}
                {m.type === 'text' && !hidden && !!m.content && canTakeContent(m) && (
                  <Row icon="text-outline" label="Select text" onPress={() => {
                    close();
                    setSelectTextOf(m.content || '');
                  }} />
                )}
                {(m.type === 'text' || (m.file_path && !m.one_time_seconds)) && !hidden && canTakeContent(m) && (
                  <Row icon="copy-outline" label="Copy" onPress={() => {
                    let fp = m.file_path || '';
                    if (m.type === 'gallery') { try { fp = JSON.parse(fp)[0] || ''; } catch {} }
                    const t = m.type === 'text' ? (m.content || '') : `${BASE_URL}${fp}`;
                    if (t) copy(t, m.type === 'text' ? 'message' : 'link');
                    close();
                  }} />
                )}
                {m.type !== 'invite' && !m.one_time_seconds && (
                  <Row icon="arrow-redo-outline" label="Forward" onPress={() => { close(); openForwardPicker(m); }} />
                )}
                {m.file_path && !hidden && !m.one_time_seconds && canTakeContent(m) && (
                  <Row icon="download-outline" label="Download" onPress={() => { close(); downloadMedia(m); }} />
                )}
                {m.file_path && !hidden && !m.one_time_seconds && canTakeContent(m) && (
                  <Row icon="share-outline" label="Share" onPress={() => { close(); shareOut(m); }} />
                )}
                {mineMsg && m.type === 'text' && (
                  <Row icon="create-outline" label="Edit" onPress={() => {
                    close();
                    composerRef.current?.setText(m.content || ''); setEditingId(m.id);
                  }} />
                )}
                {/* Who has seen it, and when. Asked for on ANY message, so
                    there is no `mineMsg` guard: knowing whether the person you
                    are talking to has read you is the point, and it is the
                    same question either way. Only a real, sent message has an
                    id the server knows. */}
                {messageInfo.canShowInfo(m) && (
                  <Row icon="information-circle-outline" label="Info" onPress={() => {
                    close();
                    openMessageInfo(m);
                  }} />
                )}
                {/* Delete is offered on BOTH sides now, and it is not the same
                    delete on each: yours goes for everyone, theirs disappears
                    from your copy only. The label says which, because the two
                    are not interchangeable. See src/messageDelete.ts. */}
                <Row
                  icon="trash-outline"
                  label={deleteLabel(deleteKind({ mine: mineMsg }))}
                  danger
                  onPress={() => { close(); deleteMsg(m.id, mineMsg); }}
                />
                <TouchableOpacity style={s.sheetCancel} onPress={close}>
                  <Text style={s.sheetCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            );
          })()}
        </View>
      </Modal>

      {/* ── Who has seen this message ──────────────────────────────────────
          Names, not a count: "3 of 5" is not an answer to "who has seen it".
          The time comes from read-mark history — the earliest mark that
          passed this message — rather than from a single "last read"
          timestamp, which would report the time of somebody's most recent
          read and so be wrong for every message but the newest. */}
      <Modal visible={!!msgInfo} transparent animationType="slide"
             onRequestClose={() => setMsgInfo(null)}>
        <TouchableOpacity style={s.sheetOverlay} activeOpacity={1} onPress={() => setMsgInfo(null)}>
          <TouchableOpacity activeOpacity={1} style={s.actionSheet} onPress={() => {}}>
            <View style={s.sheetGrip} />
            <Text style={s.infoTitle}>Message info</Text>
            {msgInfo?.loading ? (
              <View style={s.infoBusy}>
                <ActivityIndicator color={C.accent} />
              </View>
            ) : msgInfo?.error ? (
              <Text style={s.infoEmpty}>{msgInfo.error}</Text>
            ) : (
              <ScrollView style={s.infoScroll}>
                {!!msgInfo?.sentAt && (
                  <Text style={s.infoSent}>Sent {fullWhen(msgInfo.sentAt)}</Text>
                )}
                <Text style={s.infoHeading}>
                  {messageInfo.seenHeading((msgInfo?.seen || []).length)}
                </Text>
                {(msgInfo?.seen || []).length === 0 ? (
                  <Text style={s.infoEmpty}>{messageInfo.emptySeenText()}</Text>
                ) : (msgInfo?.seen || []).map((p: any) => (
                  <View key={`s${p.userId}`} style={s.infoRow}>
                    <Text style={s.infoName}>{p.avatar ? `${p.avatar} ` : ''}{p.username}</Text>
                    <Text style={s.infoWhen}>{fullWhen(p.at)}</Text>
                  </View>
                ))}
                {(msgInfo?.notSeen || []).length > 0 && (
                  <>
                    <Text style={s.infoHeading}>
                      {messageInfo.notSeenHeading((msgInfo?.notSeen || []).length)}
                    </Text>
                    {(msgInfo?.notSeen || []).map((p: any) => (
                      <View key={`n${p.userId}`} style={s.infoRow}>
                        <Text style={[s.infoName, s.infoNameDim]}>
                          {p.avatar ? `${p.avatar} ` : ''}{p.username}
                        </Text>
                      </View>
                    ))}
                  </>
                )}
              </ScrollView>
            )}
            <TouchableOpacity style={s.sheetCancel} onPress={() => setMsgInfo(null)}>
              <Text style={s.sheetCancelText}>Close</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Shared media browser — fullscreen, and it keeps your place. */}
      <MediaBrowser
        visible={showMedia}
        title={room.other_username || room.name}
        avatar={room.is_dm ? (peer?.avatar ?? room.other_avatar ?? null) : undefined}
        onMenu={room.is_dm ? () => setPeerOpen(true) : undefined}
        state={mediaState}
        tab={mediaTab}
        onTab={setMediaTab}
        onClose={() => setShowMedia(false)}
        onLoadMore={loadMoreMedia}
        loadingMore={mediaLoadingMore}
        thumbUrl={thumbUrl}
        baseUrl={BASE_URL}
        focusIndex={mediaFocusIndex}
        openId={mediaOpenId}
        onOpenImage={(i, all) => {
          // The grid stays mounted underneath; the viewer opens on top of it.
          // See closeViewer for why closing it here was the flash of chat.
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
            {oneTimeAllowed ? (
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
            ) : (
              <Text style={s.fireHint}>Turned off for this chat.</Text>
            )}
            {/* The switch itself: off for everyone here, not just for me. */}
            <TouchableOpacity
              style={s.fireToggle}
              onPress={() => chooseOneTimeAllowed(!oneTimeAllowed)}
            >
              <Ionicons
                name={oneTimeAllowed ? 'checkbox' : 'square-outline'}
                size={18}
                color={oneTimeAllowed ? C.accent : C.muted}
              />
              <Text style={s.fireToggleText}>Allow one-time messages in this chat</Text>
            </TouchableOpacity>

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
                    {chipLabel(secs)}
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
          <Text style={s.transcodeText}>
            {jumping === 'latest' ? 'Going to the latest messages…' : 'Finding that message…'}
          </Text>
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

      {/* Says a download has started, and how far along it is. */}
      <SaveOverlay />

      {/* One person, and what you can do about them. */}
      <PeerSheet
        visible={peerOpen}
        peer={peer}
        isDm={!!room.is_dm && peer?.username === room.other_username}
        onClose={() => setPeerOpen(false)}
        onToggleMute={(next) => askMutePeer(next)}
        onToggleBlock={(next) => setPeerFlag('block', next)}
        onClear={clearHistory}
        // Only when this is someone else's chat — in a direct chat you are
        // already in the conversation the button would open.
        onOpenChat={room.is_dm ? undefined : () => openDM(peer?.username || '')}
      />

      {/* Placing the pin by hand, because the phone's own answer is sometimes
          a neighbourhood rather than a street. */}
      <LocationPicker
        visible={showLocationPicker}
        fix={locFix}
        locating={locating}
        // Somewhere sensible to open when the phone cannot say where it is:
        // the last place anyone pinned in this chat.
        nearby={locationPins.map(p => ({ lat: p.payload.lat, lng: p.payload.lng }))}
        onCancel={() => setShowLocationPicker(false)}
        onRecentre={refreshFix}
        onSend={(chosen) => sendLocation(0, chosen)}
      />

      {/* Share location */}
      <Modal visible={showLocationMenu} transparent animationType="slide" onRequestClose={() => setShowLocationMenu(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowLocationMenu(false)} />
          <View style={s.attachSheet}>
            <View style={s.sheetHandle} />
            <Text style={s.forwardTitle}>📍 Share location</Text>
            {/* The map, not a straight send. A phone's fix is a guess with an
                error bar, and indoors that error is a neighbourhood. It opens
                centred on the fix, so when the fix is right this is one tap
                more than it used to be and nothing else. */}
            <TouchableOpacity style={s.attachOption} onPress={openLocationPicker}>
              {/* The row is laid out horizontally, so the two lines need their
                  own column inside it. */}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.attachOptionText}>Choose on map & send</Text>
                <Text style={s.attachOptionHint}>Opens where your phone thinks you are</Text>
              </View>
              <Ionicons name="map-outline" size={19} color={C.accent} />
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

      {/* A staged photo, before it is sent. Close, keep a copy, or edit —
          nothing about a chat message, because it is not one yet. */}
      <Modal visible={!!pendingPreview} animationType="fade" onRequestClose={() => setPendingPreview(null)}>
        <View style={s.pendingScreen}>
          <Image
            source={{ uri: pendingPreview?.uri || '' }}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
          />
          <View style={s.pendingTop}>
            <TouchableOpacity onPress={() => setPendingPreview(null)} style={s.pendingIcon} hitSlop={hitSlop10}>
              <Ionicons name="close" size={26} color="#fff" />
            </TouchableOpacity>
          </View>
          <View style={s.pendingBar}>
            <TouchableOpacity
              style={s.pendingAction}
              onPress={async () => {
                const uri = pendingPreview?.uri;
                if (!uri) return;
                try {
                  const { status } = await MediaLibrary.requestPermissionsAsync();
                  if (status !== 'granted') { Alert.alert('Permission required', 'Allow media access to save photos.'); return; }
                  await MediaLibrary.saveToLibraryAsync(uri);
                  toast('Saved to your gallery');
                } catch { Alert.alert('Error', 'Could not save this photo.'); }
              }}
            >
              <Ionicons name="download-outline" size={20} color="#fff" />
              <Text style={s.pendingActionText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.pendingAction, s.pendingActionPrimary]}
              onPress={() => {
                const p = pendingPreview;
                setPendingPreview(null);
                if (p) setEditing({ uri: p.uri, index: p.index });
              }}
            >
              <Ionicons name="create-outline" size={20} color="#fff" />
              <Text style={s.pendingActionText}>Edit</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Crop and draw. A photo already in the chat gets a Send button too —
          annotating one is nearly always for someone else. */}
      {editing && (
        <ImageEditor
          uri={editing.uri}
          sendLabel={editing.index === undefined ? 'Send' : undefined}
          onCancel={() => setEditing(null)}
          onDone={async ({ uri: out, action }) => {
            const from = editing;
            setEditing(null);
            if (action === 'save') {
              try {
                const { status } = await MediaLibrary.requestPermissionsAsync();
                if (status !== 'granted') { Alert.alert('Permission required', 'Allow media access to save photos.'); return; }
                await MediaLibrary.saveToLibraryAsync(out);
                toast('Saved to your gallery');
              } catch { Alert.alert('Error', 'Could not save this photo.'); }
              return;
            }
            if (action === 'send') {
              closeViewer();
              uploadFile(out, `edited-${Date.now()}.jpg`, 'image/jpeg', null, undefined);
              return;
            }
            // 'replace': the edited version takes the staged one's place, so
            // the composer shows what will actually be sent.
            if (from?.index !== undefined) {
              setPendingMedia(prev => prev.map((m, i) => (
                i === from.index ? { ...m, uri: out, name: `edited-${Date.now()}.jpg`, mime: 'image/jpeg' } : m
              )));
            }
          }}
        />
      )}

      <Modal visible={!!viewerActions} transparent animationType="fade" onRequestClose={() => setViewerActions(null)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewerActions(null)} />
          <View style={s.attachSheet}>
            <View style={s.sheetHandle} />
            {/* Same rows, same icon family and same weights as the message
                menu — the two are the same kind of thing and used to look like
                two different apps, one drawn in emoji and one in icons. */}
            {(([
              // Editing a one-time photo would produce a permanent copy of
              // something meant to vanish, so it is offered on nothing else.
              ...(isOneTimeUrl(viewerUrl) ? [] : [['edit', 'create-outline', 'Edit']]),
              // Only when the photo was opened from the media browser. Opening
              // it from the chat means the message is already on screen behind
              // the viewer, so "Show in chat" closes the picture to reveal
              // what was there all along.
              ...(viewerFromMedia ? [['showInChat', 'chatbubble-outline', 'Show in chat']] : []),
              // Saving or sharing a one-time photo would defeat it.
              ...(isOneTimeUrl(viewerUrl) ? [] : [['download', 'download-outline', 'Download']]),
              ...(isOneTimeUrl(viewerUrl) ? [] : [['share', 'share-outline', 'Share']]),
              // No "Close photo" row. The sheet's own Cancel dismisses the
              // sheet, the ✕ and the back gesture close the photo, and a menu
              // entry that repeats what two other controls already do is one
              // more thing to read past.
            ] as [string, string, string][])).map(([action, icon, label]) => (
              <Pressable
                key={action}
                style={({ pressed }) => [s.sheetRow, pressed && s.sheetRowPressed]}
                android_ripple={{ color: 'rgba(128,128,128,0.18)' }}
                onPress={() => {
                  const it = viewerActions;
                  setViewerActions(null);
                  if (action === 'edit') { if (viewerUrl) setEditing({ uri: viewerUrl }); return; }
                  if (!it) return;
                  setViewer(null);
                  onMediaAction(action as MediaAction, it);
                }}
              >
                <Ionicons name={icon as any} size={20} color={C.text} style={s.sheetRowIcon} />
                <Text style={s.sheetRowText}>{label}</Text>
              </Pressable>
            ))}
            <TouchableOpacity style={s.sheetCancel} onPress={() => setViewerActions(null)}>
              <Text style={s.sheetCancelText}>Cancel</Text>
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

      {/* Renaming a staged file, before it is sent. */}
      <Modal visible={!!renaming} transparent animationType="fade" onRequestClose={() => setRenaming(null)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setRenaming(null)} />
          <View style={s.renameCard}>
            <Text style={s.renameTitle}>Rename file</Text>
            <TextInput
              style={s.renameInput}
              value={renaming?.value ?? ''}
              onChangeText={(v) => setRenaming(r => (r ? { ...r, value: v } : r))}
              autoFocus
              selectTextOnFocus
              placeholder="File name"
              placeholderTextColor={C.muted}
              returnKeyType="done"
              onSubmitEditing={commitRename}
            />
            {/* What it will actually be called, extension and all, before the
                decision is made rather than after. */}
            <Text style={s.renameHint} numberOfLines={1}>
              {renamed(renaming?.of, renaming?.value)}
            </Text>
            <View style={s.renameRow}>
              <TouchableOpacity onPress={() => setRenaming(null)} style={s.renameBtn}>
                <Text style={s.renameCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={commitRename} style={s.renameBtn}>
                <Text style={s.renameOkText}>Rename</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Forward picker */}
      <Modal visible={forwardOpen} transparent animationType="slide" onRequestClose={() => { setForwardOpen(false); setForwardMsg(null); }}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => { setForwardOpen(false); setForwardMsg(null); }} />
          <View style={s.attachSheet}>
            <View style={s.sheetHandle} />
            <SelectionCount>{n => (
              <Text style={s.forwardTitle}>{forwardMsg ? 'Forward to…' : `Forward ${n} message${n > 1 ? 's' : ''} to…`}</Text>
            )}</SelectionCount>
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
              {/* The gallery was reachable only from a direct chat's header,
                  so in a group there was no way into it at all. */}
              <TouchableOpacity
                style={s.infoAction}
                onPress={() => { setShowRoomInfo(false); openMediaBrowser('images'); }}
              >
                <Ionicons name="images-outline" size={19} color={C.accent} />
                <Text style={s.infoActionText}>Shared photos & files</Text>
                <View style={{ flex: 1 }} />
                <Ionicons name="chevron-forward" size={17} color={C.muted} />
              </TouchableOpacity>

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
      {liveShare ? (() => {
        // Tapping the bar goes to the message it is about — the bar names a
        // specific live share, so the obvious thing to do with it is look at
        // it.
        //
        // From ANY chat, as asked for. It used to jump only when the share
        // happened to be in the chat already open, which is the one case where
        // the message is easiest to find by hand; from anywhere else the bar
        // was a dead label. Now it opens the conversation the share is in and
        // lands on the message there.
        const here = String(liveShare.roomId) === String(room.id);
        const target = Number(liveShare.messageId);
        const canJump = Number.isFinite(target) && (here || !!(liveShare.room && onOpenRoom));
        return (
        <View style={s.liveBar}>
          <Ionicons name="navigate" size={15} color="#22c55e" />
          {/* Only the label is pressable. Wrapping the whole bar would put the
              Stop button inside the jump target. */}
          <TouchableOpacity
            style={{ flex: 1, minWidth: 0 }}
            disabled={!canJump}
            onPress={() => {
              if (!canJump) return;
              if (here) jumpToMessage(target);
              else onOpenRoom!(liveShare.room, target);
            }}
          >
            <Text style={s.liveBarText} numberOfLines={1}>
              {here
                ? `Sharing your live location · ${formatRemaining(liveShare.until)}`
                : `Sharing live location in ${liveShare.room?.is_dm
                    ? (liveShare.room?.other_username || liveShare.room?.name || 'another chat')
                    : (liveShare.room?.name || 'another chat')} · ${formatRemaining(liveShare.until)}`}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={stopLiveShare} hitSlop={hitSlop10}>
            <Text style={s.liveBarStop}>Stop</Text>
          </TouchableOpacity>
        </View>
        );
      })() : null}

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
          onRenameMedia={renameStaged}
          oneTimeSecs={oneTimeSecs}
          quickEmoji={quickEmoji}
          editing={!!editingId}
          onTyping={emitTyping}
          // Typing anything and leaving the chat keeps it. The text lives in
          // the composer's own state so that a keystroke does not re-render
          // this list; this is how it reaches storage without moving.
          onDraftChange={onDraftChange}
          onSend={sendText}
          clipboard={clipboardHas}
          onPaste={pasteFromClipboard}
          // Straight to the camera. A photo of what is in front of you is by
          // far the commonest attachment, and it used to cost two taps and a
          // sheet before the camera even began warming up. The other four ways
          // to attach something now live around the shutter.
          onAttach={() => {
            // Not a member yet: the composer already says so, and opening a
            // camera for somebody who cannot send the photo is a small
            // cruelty. The old sheet still opens, so nothing is unreachable.
            if (!opensCamera({ canPost: !notMember })) { setShowAttachMenu(true); return; }
            checkClipboard();
            setCameraMode(OPENS_IN);
          }}
          onRecord={() => startRecordingUI()}
          onRecordPressIn={warmMic}
          onOneTime={() => setShowOneTimeMenu(true)}
          onLocation={() => setShowLocationMenu(true)}
          liveLocation={!!liveShare}
          disappearing={disappearing}
          sendQuality={sendQuality}
          onQuality={chooseQuality}
          mentionables={mentionables}
          onToggleQuickEmoji={setQuickEmoji}
          onRemoveMedia={(i) => setPendingMedia(prev => prev.filter((_, j) => j !== i))}
          onPreviewMedia={(uri, index) => setPendingPreview({ uri, index })}
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

/**
 * A finger-sized margin around the small icon buttons.
 *
 * Every other component in this app defines its own; this file did NOT, and
 * `hitSlop={hit}` was copied in here from one that does. `hit` was therefore
 * simply undefined, and rendering it threw — which is the whole of "tapping
 * the comment button crashes the app": opening a thread draws its header, the
 * header touches `hit`, and ChatScreen dies.
 */
const hit = { top: 10, bottom: 10, left: 10, right: 10 };


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
  // The live voice-chat count, on the room's call button.
  voiceDot: {
    position: 'absolute', top: 0, right: 0, minWidth: 16, height: 16,
    borderRadius: 8, backgroundColor: '#2fbf5f', alignItems: 'center',
    justifyContent: 'center', paddingHorizontal: 3,
  },
  voiceDotText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  voiceBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#2fbf5f', paddingHorizontal: 14, paddingVertical: 9,
  },
  voiceBannerText: { color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 },
  voiceBannerJoin: { color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
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
  infoAction: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 14, marginBottom: 10, paddingHorizontal: 14, paddingVertical: 13,
    borderRadius: 12, backgroundColor: 'rgba(59,125,216,0.08)',
  },
  infoActionText: { color: C.text, fontSize: 14.5, fontWeight: '700' },
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
  locExpand: {
    position: 'absolute', right: 6, top: 6, zIndex: 2,
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  locFoot: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 9 },
  locTitle: { color: C.text, fontSize: 13.5, fontWeight: '700' },
  locSub: { color: C.muted, fontSize: 11.5, marginTop: 1 },

  renameCard: {
    alignSelf: 'center', width: '86%', maxWidth: 420, borderRadius: 14, padding: 16,
    backgroundColor: C.sidebar, borderWidth: 1, borderColor: C.border, gap: 10,
  },
  renameTitle: { color: C.text, fontSize: 15, fontWeight: '800' },
  renameInput: {
    color: C.text, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: C.inputBg, borderRadius: 10, borderWidth: 1, borderColor: C.border,
  },
  renameHint: { color: C.muted, fontSize: 11.5 },
  renameRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 18, marginTop: 2 },
  renameBtn: { paddingVertical: 6, paddingHorizontal: 8 },
  renameCancelText: { color: C.muted, fontSize: 14, fontWeight: '700' },
  renameOkText: { color: C.accent, fontSize: 14, fontWeight: '800' },
  liveBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: 'rgba(34,197,94,0.14)',
    borderTopWidth: 1, borderTopColor: 'rgba(34,197,94,0.3)',
  },
  // The pressable wrapper owns the flex now, so the text must not also
  // claim it — inside a column it would stretch vertically instead.
  liveBarText: { color: C.text, fontSize: 12.5, fontWeight: '600' },
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
  infoTitle: { color: C.text, fontSize: 16, fontWeight: '700', textAlign: 'center', paddingVertical: 10 },
  infoScroll: { maxHeight: 360 },
  infoBusy: { paddingVertical: 28, alignItems: 'center' },
  infoSent: { color: C.muted, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
  infoHeading: { color: C.muted, fontSize: 12, fontWeight: '700', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  infoRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 9 },
  infoName: { color: C.text, fontSize: 15, flexShrink: 1 },
  infoNameDim: { color: C.muted },
  infoWhen: { color: C.muted, fontSize: 12, marginLeft: 12 },
  infoEmpty: { color: C.muted, fontSize: 13, paddingHorizontal: 16, paddingVertical: 12 },
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
  fireToggle: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10 },
  fireToggleText: { color: C.muted, fontSize: 13 },
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
  sheetRowIcon: { width: 26, textAlign: 'center' },
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
  // A message that was accepted and never arrived.
  bubbleVanished: {
    opacity: 0.45,
    borderWidth: 1, borderStyle: 'dashed', borderColor: C.muted,
    backgroundColor: 'transparent',
  },
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
  foldToggle: { color: C.accent, fontSize: 12.5, fontWeight: '700', marginTop: 4 },
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
  commentBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    // Negative margins undo the bubble's padding so the strip runs edge to
    // edge; the bubble's rounded corners clip it into shape.
    marginTop: 8, marginHorizontal: -10, marginBottom: -10,
    paddingHorizontal: 10, paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(128,128,128,0.35)',
    // Tinted rather than transparent: asked for as "slightly more
    // highlighted". Enough of a wash to read as a control instead of a
    // footnote, without competing with the message above it.
    backgroundColor: 'rgba(59,125,216,0.12)',
  },
  unreadDivider: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginVertical: 10, paddingHorizontal: 12,
  },
  unreadDividerLine: { flex: 1, height: 1, backgroundColor: C.accent, opacity: 0.5 },
  unreadDividerText: {
    color: C.accent, fontSize: 11, fontWeight: '800',
    letterSpacing: 0.5, textTransform: 'uppercase',
  },
  commentBarIcon: { fontSize: 12 },
  commentBarLabel: { flex: 1, color: C.accent, fontSize: 12.5, fontWeight: '700' },
    commentsHead: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 8, paddingVertical: 6,
    backgroundColor: C.header,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  commentsParentLink: {
    flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 4, paddingVertical: 2,
  },
  commentsParentThumb: { width: 32, height: 32, borderRadius: 6 },
  commentsParentText: { flex: 1, minWidth: 0 },
  commentsParentPreview: { color: C.text, fontSize: 13.5, fontWeight: '600' },
  commentsTitle: { color: C.muted, fontSize: 11, fontWeight: '500' },
  commentsListContent: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  commentsFab: {
    position: 'absolute', right: 14, bottom: 14,
    width: 38, height: 38, borderRadius: 19, backgroundColor: C.accent,
    alignItems: 'center', justifyContent: 'center', elevation: 4,
  },
  commentsEmpty: { color: C.muted, textAlign: 'center', paddingVertical: 28, paddingHorizontal: 24 },
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
  pendingScreen: { flex: 1, backgroundColor: '#000' },
  pendingTop: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 42, paddingHorizontal: 10 },
  pendingIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pendingBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  pendingAction: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, paddingVertical: 13, backgroundColor: 'rgba(255,255,255,0.14)',
  },
  pendingActionPrimary: { backgroundColor: C.accent },
  pendingActionText: { color: '#fff', fontSize: 14.5, fontWeight: '700' },
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
  commentJump: {
    position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center',
    gap: 8, paddingLeft: 14, paddingRight: 8, paddingVertical: 7, borderRadius: 999,
    // Its own surface rather than a block of accent: this sits over the
    // conversation and has to be legible without shouting over it.
    backgroundColor: C.sidebar, borderWidth: 1, borderColor: C.accent,
    elevation: 6, shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 9, shadowOffset: { width: 0, height: 4 },
  },
  commentJumpIcon: { fontSize: 13 },
  commentJumpText: { color: C.accent, fontSize: 12.5, fontWeight: '700' },
  // The arrow in its own disc: the direction reads as the ACTION the chip
  // performs rather than as decoration on the sentence.
  commentJumpArrow: {
    width: 22, height: 22, borderRadius: 11, overflow: 'hidden',
    backgroundColor: C.accent, color: '#fff',
    fontSize: 12, fontWeight: '800', textAlign: 'center', lineHeight: 22,
  },
  commentBarBadge: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5,
    backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center',
  },
  commentBarBadgeText: { color: '#fff', fontSize: 10.5, fontWeight: '800' },
  // Sits above the scroll-to-bottom button so the two never overlap.
  mentionFab: {
    position: 'absolute', end: 16, bottom: 200, width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
  },
  mentionFabIcon: { color: '#fff', fontSize: 20, fontWeight: '800' },
  lightboxOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  attachSheet: { backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 24 },
  attachOption: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 22, paddingVertical: 14 },
  attachOptionIcon: { fontSize: 22, width: 28, textAlign: 'center' },
  attachOptionHint: { color: C.muted, fontSize: 11.5, marginTop: 2 },
  attachOptionText: { color: C.text, fontSize: 16, fontWeight: '500' },
  attachCancel: { marginTop: 8, marginHorizontal: 16, backgroundColor: C.inputBg, borderRadius: 12, padding: 14, alignItems: 'center' },
  attachCancelText: { color: C.muted, fontSize: 15, fontWeight: '600' },
  forwardTitle: { color: C.text, fontWeight: '700', fontSize: 16, paddingHorizontal: 20, paddingVertical: 10 },
  link: { color: C.accent, textDecorationLine: 'underline' },
  mention: { color: C.accent, fontWeight: '700' },
  // Being addressed by name should stand out from mentioning someone else.
  mentionMe: { backgroundColor: 'rgba(88,101,242,0.22)' },
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
  // Top RIGHT corner. It used to sit at end:108 — a legacy of the two
  // buttons that were once beside it — which left it stranded in the middle
  // of the top edge with nothing either side of it.
  lightboxMore: {
    position: 'absolute', top: 46, end: 12, width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(18,20,26,0.55)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center', justifyContent: 'center', zIndex: 10,
  },
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
