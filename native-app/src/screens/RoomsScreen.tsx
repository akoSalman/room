import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, ActivityIndicator, Modal, ScrollView, Linking, Platform, Pressable,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as appUpdate from '../appUpdate';
import * as mediaCache from '../mediaCache';
import * as offline from '../offlineStore';
import { fmtBytes } from '../download';
import * as IntentLauncher from 'expo-intent-launcher';
import { Ionicons } from '@expo/vector-icons';
import { C, isRTL } from '../theme';
import { ClearScope, clearScopes, clearLabel, clearHint, clearConfirm } from '../peerActions';
import { apiFetch, getUsername, getUserId, getSocket, setAuth, getAvatar, RELEASE_TAG, RELEASE_FILE, BASE_URL } from '../api';
import { changesLeftText, renameWorthDoing, renamedText } from '../profileEdit';
import * as upd from '../updateSource';
import { BUILD_VERSION } from '../version';
import * as connection from '../connection';
import { statusLine as updateStatusLine } from '../updateResume';

const AVATAR_EMOJIS = ['🦄','🐉','🧙‍♂️','🧚‍♀️','🧛‍♂️','🧞‍♂️','🦊','🐺','🦁','🐯','🐼','🐸','🦉','🐙','🦋','🤖','👽','🐲','🦅','🐬','🔥','⚡','🌙','⭐'];

// The brand's own server first — it is the one host every user of this brand
// can definitely reach, since they are talking to it right now. GitHub is kept
// as a fallback for a server that has not been given a build yet; for users
// where GitHub is blocked it was the only channel, which is why an update
// could be impossible to see or to fetch.
const SERVER_MANIFEST_URL = `${BASE_URL}/app/latest.json`;
const LATEST_APK_URL = `https://github.com/akoSalman/room-releases/releases/download/${RELEASE_TAG}/${RELEASE_FILE}`;
const LATEST_RELEASE_API = `https://api.github.com/repos/akoSalman/room-releases/releases/tags/${RELEASE_TAG}`;

type Room = { id: number; name: string; is_dm: number; other_username?: string; other_avatar?: string | null; created_by?: number; is_private?: number; disappearing_seconds?: number };

export default function RoomsScreen({ onSelectRoom, onLogout, openProfileOnMount, onProfileOpened }: {
  onSelectRoom: (room: Room) => void;
  onLogout: () => void;
  openProfileOnMount?: boolean;
  onProfileOpened?: () => void;
}) {
  // The chat a long press is offering to clear.
  const [clearing, setClearing] = useState<Room | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [dms, setDms] = useState<Room[]>([]);
  const [newRoom, setNewRoom] = useState('');
  const [newRoomPrivate, setNewRoomPrivate] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<{ users: any[]; rooms: any[] } | null>(null);
  const [showAllEmojis, setShowAllEmojis] = useState(false);
  const [me, setMe] = useState('');
  const [myId, setMyId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [showProfile, setShowProfile] = useState(false);
  const [renamingRoom, setRenamingRoom] = useState<Room | null>(null);
  const [renameText, setRenameText] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [editingUsername, setEditingUsername] = useState(false);
  // null while unknown — the dialog waits for /me rather than guessing a
  // number of remaining changes at the user.
  const [changesLeft, setChangesLeft] = useState<number | null>(null);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [unread, setUnread] = useState<Record<number, number>>({});
  // Rooms where someone @mentioned me and I have not opened the chat yet.
  // Kept apart from the unread count so a mention can be marked louder than
  // ordinary traffic — being addressed by name is not the same as a busy room.
  const [mentions, setMentions] = useState<Record<number, boolean>>({});
  const [latestVersion, setLatestVersion] = useState<number | null>(null);
  /** Where the newest build will be fetched from, once a check has answered. */
  const [apkUrl, setApkUrl] = useState<string | null>(null);
  /** How big that build is, when the manifest said — see appUpdate.start. */
  const [apkSize, setApkSize] = useState<number | null>(null);
  // An APK already on the phone that was downloaded but never installed —
  // backing out of Android's installer is easy to do and easy not to notice.
  const [downloadedUpdate, setDownloadedUpdate] =
    useState<{ version: number; uri: string } | null>(null);
  const [versionCheckFailed, setVersionCheckFailed] = useState(false);
  // Mirrors the module-scope download, so re-opening this screen mid-download
  // shows the real progress instead of starting again.
  // A PAUSED download is still a download in progress as far as this screen is
  // concerned: it is waiting for the network and will carry on by itself, so
  // hiding the bar and offering "Update" again is how somebody ends up
  // starting forty megabytes over.
  const running = (st: appUpdate.UpdateState) =>
    st.status === 'downloading' || st.status === 'paused';
  const [updateState, setUpdateState] = useState<appUpdate.UpdateState>(() => appUpdate.current());
  // Whether the phone can reach OUR server, which is the only sense in which
  // "online" matters to a download from it.
  const [online, setOnline] = useState(connection.isOnline());
  useEffect(() => connection.subscribe(st => setOnline(st === 'online')), []);
  const updateProgress = running(updateState) ? updateState.progress : null;
  useEffect(() => appUpdate.subscribe(() => {
    const st = appUpdate.current();
    setUpdateState(st);
    // A finished download becomes an offer to install it.
    if (!running(st)) appUpdate.downloaded().then(setDownloadedUpdate);
  }), []);
  useEffect(() => { appUpdate.downloaded().then(setDownloadedUpdate).catch(() => {}); }, []);
  const updateChoice = appUpdate.installChoice({
    downloadedVersion: downloadedUpdate?.version ?? null,
    latestVersion,
    currentVersion: BUILD_VERSION,
  });
  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  // What the kept media actually costs, so the number is visible rather than
  // something the user has to guess at from the phone's storage screen.
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  // Used to scroll the profile sheet straight to the APP UPDATE section when
  // the user arrives via the update badge — otherwise the sheet opened at the
  // top and the update controls sat off-screen below the fold.
  const profileScrollRef = useRef<ScrollView>(null);
  const updateSectionY = useRef(0);
  const scrollToUpdate = useCallback(() => {
    // Two passes: the section's onLayout may not have fired on the first frame
    // the sheet is mounted.
    const go = () => profileScrollRef.current?.scrollTo({ y: Math.max(0, updateSectionY.current - 12), animated: true });
    setTimeout(go, 350);
    setTimeout(go, 700);
  }, []);

  /**
   * Clear a chat from the list.
   *
   * Both options take the chat off this list — that is what makes it feel
   * cleared rather than merely emptied. "Just for me" hides it until the
   * conversation resumes; "for both" deletes the messages, so it is gone for
   * the other person's list too.
   */
  async function confirmClear(room: Room, scope: ClearScope) {
    const name = room.is_dm ? (room.other_username || 'this chat') : room.name;
    const c = clearConfirm(scope, name);
    const go = async () => {
      setClearing(null);
      const r = await apiFetch(`/clear-history/${room.id}`, 'POST', { scope });
      if (r?.error) { Alert.alert('Could not clear', r.error); return; }
      // Off the list immediately; `load` then confirms it from the server.
      setDms(prev => prev.filter(d => d.id !== room.id));
      setRooms(prev => prev.filter(x => x.id !== room.id));
      load();
    };
    if (!c) { go(); return; }
    Alert.alert(c.title, c.body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: go },
    ]);
  }

  /**
   * Clear a chat's badge from the list, without opening it.
   *
   * The new count comes from the SERVER's answer: marking a room read also
   * marks its threads read, and a client that assumed zero would disagree with
   * the list the moment anything else was unread.
   */
  async function markRoomRead(room: Room) {
    setClearing(null);
    const sock = await getSocket().catch(() => null);
    if (!sock) { Alert.alert('Not connected', 'Try again once the app is back online.'); return; }
    sock.emit('mark_room_read', { roomId: room.id }, (res: any) => {
      if (!res || !res.ok) { Alert.alert('Could not mark it read'); return; }
      setUnread(u => ({ ...u, [res.roomId]: res.unread }));
    });
  }

  const load = useCallback(async () => {
    const [r, d, u, id, counts] = await Promise.all([
      apiFetch('/rooms'),
      apiFetch('/dm-rooms'),
      getUsername(),
      getUserId(),
      apiFetch('/unread-counts'),
    ]);
    // Only overwrite what the server actually answered. Offline, apiFetch
    // returns an error value, and the lists already on screen — restored from
    // the device — must survive rather than being blanked.
    if (Array.isArray(r)) setRooms(r);
    if (Array.isArray(d)) setDms(d);
    setMe(u || '');
    setMyId(id);
    getAvatar().then(setMyAvatar);
    if (counts && !counts.error) setUnread(counts);
    setLoading(false);
    if (Array.isArray(r) && Array.isArray(d)) offline.saveRooms(r, d);
  }, []);

  // The device's copy first, so the list is on screen before any request is
  // made — then the network refreshes it. Opening the app should never mean
  // staring at a spinner for something that was already here.
  useEffect(() => {
    let alive = true;
    offline.loadRooms().then(cached => {
      if (!alive || !cached) return;
      // A response that has already arrived always wins over the cache.
      setRooms(prev => (prev.length ? prev : cached.rooms));
      setDms(prev => (prev.length ? prev : cached.dms));
      setLoading(false);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => { load(); }, [load]);

  // Check for a newer build once on mount: drives the header update badge.
  useEffect(() => { checkLatestVersion(); }, []);

  // Measured when the sheet opens; walking the directory on every render
  // would be pointless work.
  useEffect(() => {
    if (!showProfile) return;
    let alive = true;
    mediaCache.usage().then(b => { if (alive) setCacheBytes(b); }).catch(() => {});
    return () => { alive = false; };
  }, [showProfile]);

  useEffect(() => {
    if (openProfileOnMount) {
      setShowProfile(true);
      checkLatestVersion();
      scrollToUpdate();
      onProfileOpened?.();
    }
  }, [openProfileOnMount]);

  useEffect(() => {
    let sock: any;
    (async () => {
      const uname = await getUsername();
      sock = await getSocket();
      sock.on('message_received', (msg: any) => {
        // Float the room that just received a message to the top of its list,
        // so the ordering tracks activity live instead of only on reload.
        const bump = (list: Room[]) => {
          const i = list.findIndex(r => r.id === msg.room_id);
          if (i <= 0) return list; // absent, or already first
          const next = list.slice();
          const [hit] = next.splice(i, 1);
          return [hit, ...next];
        };
        setRooms(prev => bump(prev));
        setDms(prev => bump(prev));
        if (msg.username === uname) return; // own messages are never "unread"
        setUnread(prev => ({ ...prev, [msg.room_id]: (prev[msg.room_id] || 0) + 1 }));
      });
      sock.on('dm_activity', () => load());
      // Cleared elsewhere — by the other person, or on another device. The
      // list has to lose the chat here too, or it stays on screen showing a
      // last message that is gone.
      sock.on('history_cleared', ({ roomId }: any) => {
        setDms(prev => prev.filter(d => d.id !== roomId));
        load();
      });
      // Membership changed elsewhere (joined by link, left, removed by an
      // owner) — the room list is no longer accurate.
      sock.on('room_created', () => load());
      sock.on('left_room', () => load());
      // The mode changed in some chat — refresh so its marker appears or goes,
      // for whichever of the two people is looking at this list.
      sock.on('disappearing_changed', () => load());
      sock.on('removed_from_room', () => load());
      // Someone wrote my @name somewhere. If the chat is not open, the room
      // list is where I should be able to see it.
      sock.on('mentioned', (m: any) => {
        if (!m?.roomId) return;
        setMentions(prev => ({ ...prev, [m.roomId]: true }));
      });
    })();
    return () => {
      sock?.off('message_received');
      sock?.off('dm_activity');
      sock?.off('room_created');
      sock?.off('left_room');
      sock?.off('disappearing_changed');
      sock?.off('removed_from_room');
      sock?.off('mentioned');
    };
  }, [load]);

  const searchTimer = useRef<any>(null);
  function onSearchChange(q: string) {
    setSearch(q);
    clearTimeout(searchTimer.current);
    if (!q.trim()) { setSearchResults(null); return; }
    searchTimer.current = setTimeout(async () => {
      const res = await apiFetch(`/search?q=${encodeURIComponent(q.trim())}`);
      if (res && !res.error) setSearchResults(res);
    }, 300);
  }

  async function openDMWithUser(user: any) {
    const res = await apiFetch(`/dm/${user.id}`, 'POST');
    if (res.error) { Alert.alert('Error', res.error); return; }
    setSearch(''); setSearchResults(null);
    onSelectRoom({ id: res.id, name: res.name, is_dm: 1, other_username: res.otherUsername || user.username });
  }

  function openFoundRoom(r: any) {
    setSearch(''); setSearchResults(null);
    onSelectRoom({ id: r.id, name: r.name, is_dm: 0 });
  }

  function selectRoom(room: Room) {
    setUnread(prev => ({ ...prev, [room.id]: 0 }));
    setMentions(prev => (prev[room.id] ? { ...prev, [room.id]: false } : prev));
    onSelectRoom(room);
  }

  async function createRoom() {
    if (!newRoom.trim()) return;
    const res = await apiFetch('/rooms', 'POST', { name: newRoom.trim(), isPrivate: newRoomPrivate });
    if (res.error) { Alert.alert('Error', res.error); return; }
    setNewRoom('');
    setNewRoomPrivate(false);
    setShowCreate(false);
    load();
  }

  async function deleteRoom(room: Room) {
    Alert.alert(`Delete "${room.name}"?`, 'All messages will be lost.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          const sock = await getSocket();
          sock.emit('delete_room', { roomId: room.id });
          setRooms(prev => prev.filter(r => r.id !== room.id));
        },
      },
    ]);
  }

  function startRename(room: Room) {
    setRenamingRoom(room);
    setRenameText(room.name);
  }

  async function saveRename() {
    if (!renamingRoom || !renameText.trim()) return;
    const sock = await getSocket();
    sock.emit('edit_room', { roomId: renamingRoom.id, name: renameText.trim() });
    setRooms(prev => prev.map(r => r.id === renamingRoom.id ? { ...r, name: renameText.trim() } : r));
    setRenamingRoom(null);
  }

  const myRooms = rooms.filter(r => r.created_by !== undefined && r.created_by === myId);
  const initials = (name: string) => name.slice(0, 2).toUpperCase();

  async function checkLatestVersion() {
    setVersionCheckFailed(false);
    // Our own server, then GitHub. Each is wrapped on its own so an
    // unreachable GitHub — which is the normal case for many of these users —
    // cannot stop the server's answer from being used.
    let server: upd.Manifest | null = null;
    try {
      const r = await fetch(SERVER_MANIFEST_URL);
      if (r.ok) server = upd.parseServerManifest(await r.json());
    } catch {}
    let github: number | null = null;
    if (!server) {
      try { github = upd.parseGithubRelease(await fetch(LATEST_RELEASE_API).then(r => r.json())); }
      catch {}
    }
    const info = upd.chooseSource({
      server, github, baseUrl: BASE_URL, githubUrl: LATEST_APK_URL,
    });
    setLatestVersion(info.latestVersion);
    setApkUrl(info.apkUrl);
    setApkSize(info.sizeBytes ?? null);
    setApkSize(info.sizeBytes ?? null);
    setVersionCheckFailed(info.failed);
  }

  async function downloadAndInstallUpdate() {
    const from = apkUrl || LATEST_APK_URL;
    if (Platform.OS !== 'android') { Linking.openURL(from); return; }
    // Owned by appUpdate at module scope: closing this screen, or the app,
    // no longer cancels the download.
    // The version travels with it so a download the user never installs can be
    // offered as Install next time instead of being fetched all over again.
    // The size travels with it: without a Content-Length the download cannot
    // work out a percentage on its own, and the manifest has always known.
    appUpdate.start(from, latestVersion ?? undefined, apkSize).catch(() => {});
  }

  /** Hand the already-downloaded APK back to Android's installer. */
  async function installDownloadedUpdate() {
    const rec = downloadedUpdate;
    if (!rec) return;
    try {
      await appUpdate.install(rec.uri);
    } catch {
      // The file may have been swept out of the cache since it was checked, in
      // which case downloading is the only way forward.
      await appUpdate.forgetDownloaded();
      setDownloadedUpdate(null);
      Alert.alert('Could not install', 'The downloaded file is no longer available.');
    }
  }

  async function setAvatarEmoji(emoji: string | null) {
    const res = await apiFetch('/profile', 'PUT', { avatar: emoji });
    if (res.error) { Alert.alert('Error', res.error); return; }
    await setAuth(res.token, res.username, res.avatar);
    setMyAvatar(res.avatar);
  }

  // A username is how other people find and @mention you, so it is not a
  // free-form setting: the server allows two changes and the dialog says so
  // BEFORE the change, not after it has been spent.
  async function openUsernameEditor() {
    setProfileError('');
    setProfileSuccess('');
    setNewUsername(me);
    setChangesLeft(null);
    setEditingUsername(true);
    const res = await apiFetch('/me');
    if (typeof res?.usernameChangesLeft === 'number') setChangesLeft(res.usernameChangesLeft);
  }

  async function saveUsername() {
    const name = newUsername.trim();
    setProfileError('');
    setProfileSuccess('');
    // The same name back is not a change, and spending one of two on a no-op
    // would be the worst thing this dialog could do.
    if (!renameWorthDoing(me, name)) { setEditingUsername(false); return; }
    setSavingProfile(true);
    const res = await apiFetch('/profile', 'PUT', { newUsername: name });
    setSavingProfile(false);
    if (res.error) { setProfileError(res.error); return; }
    await setAuth(res.token, res.username, res.avatar ?? myAvatar);
    setMe(res.username);
    setChangesLeft(res.usernameChangesLeft ?? null);
    setEditingUsername(false);
    setProfileSuccess(renamedText(res.usernameChangesLeft ?? null));
  }

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => { setShowProfile(true); checkLatestVersion(); }}>
          <View style={s.avatar}>
            {myAvatar
              ? <Text style={s.avatarEmoji}>{myAvatar}</Text>
              : <Text style={s.avatarText}>{initials(me)}</Text>}
          </View>
        </TouchableOpacity>
        <Text style={s.headerTitle}>{me}</Text>
        {/* One rule, shared with the profile sheet. This used to be its own
            comparison — "different from what is running" — which advertised
            an update to anyone on a build AHEAD of the server's, and which
            hid the badge whenever the check failed even though the profile
            went on offering a confident Update button. That mismatch is the
            reported "active in the profile but not in the header". */}
        {upd.updateAvailable({ latestVersion, currentVersion: BUILD_VERSION }) ? (
          <TouchableOpacity style={s.updateBadge} onPress={() => { setShowProfile(true); checkLatestVersion(); scrollToUpdate(); }}>
            <Text style={s.updateBadgeText}>⚡ v{latestVersion}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Search users & rooms; + creates a room */}
      {/* Offline is not the same as empty, and the two look identical unless
          one of them says so — and coming back is worth saying too. */}

      <View style={s.createRow}>
        <TextInput
          style={s.createInput} placeholder="Search users or rooms…" placeholderTextColor={C.muted}
          value={search} onChangeText={onSearchChange} autoCapitalize="none"
        />
        <TouchableOpacity style={s.createBtn} onPress={() => setShowCreate(true)}>
          <Text style={s.createBtnText}>+</Text>
        </TouchableOpacity>
      </View>

      {/* Search results */}
      {searchResults && (
        <ScrollView style={s.searchResults} keyboardShouldPersistTaps="handled">
          {searchResults.users.length === 0 && searchResults.rooms.length === 0 && (
            <Text style={s.searchEmpty}>No users or rooms found</Text>
          )}
          {searchResults.users.map(u => (
            <TouchableOpacity key={'u' + u.id} style={s.searchRow} onPress={() => openDMWithUser(u)}>
              <Text style={s.searchIcon}>{u.avatar || '👤'}</Text>
              <Text style={s.searchName}>{u.username}</Text>
              <Text style={s.searchAction}>Message</Text>
            </TouchableOpacity>
          ))}
          {searchResults.rooms.map(r => (
            <TouchableOpacity key={'r' + r.id} style={s.searchRow} onPress={() => openFoundRoom(r)}>
              <Text style={s.searchIcon}>#</Text>
              <Text style={s.searchName}>{r.name}</Text>
              {/* Opens the room to read; the Join bar inside it does the joining. */}
              <Text style={s.searchAction}>Open</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {loading ? (
        <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={[
            ...rooms.map(r => ({ ...r, _type: 'room' })),
            dms.length ? { id: -1, name: '──  Direct Messages  ──', is_dm: -1, _type: 'divider' } : null,
            ...dms.map(d => ({ ...d, _type: 'dm' })),
          ].filter(Boolean) as any[]}
          keyExtractor={item => String(item.id)}
          renderItem={({ item }) => {
            if (item._type === 'divider') return (
              <Text style={s.divider}>{item.name}</Text>
            );
            const label = item.is_dm ? (item.other_username || item.name) : item.name;
            const count = unread[item.id] || 0;
            return (
              <TouchableOpacity
                style={s.roomItem}
                onPress={() => selectRoom(item)}
                onLongPress={() => setClearing(item)}
                delayLongPress={400}
              >
                {/* A direct chat shows the person's own emoji. A row of
                    identical speech bubbles tells you nothing about which
                    conversation is which. */}
                <Text style={s.roomIcon}>
                  {item.is_dm ? (item.other_avatar || '💬') : item.is_private ? '🔒' : '#'}
                </Text>
                <Text style={s.roomName}>{label}</Text>
                {/* Both people see that a chat destroys its messages without
                    having to open it — the mode belongs to the chat, not to
                    whoever switched it on. */}
                {item.disappearing_seconds > 0 && (
                  <Text style={s.roomDisappearing}>⏳</Text>
                )}
                {mentions[item.id] && (
                  <View style={s.mentionBadge}><Text style={s.mentionBadgeText}>@</Text></View>
                )}
                {count > 0 && (
                  <View style={s.unreadBadge}>
                    <Text style={s.unreadBadgeText}>{count > 99 ? '99+' : count}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
          refreshing={loading}
          onRefresh={load}
        />
      )}

      {/* Long press on a chat: clear it, and take it off this list. */}
      <Modal visible={!!clearing} transparent animationType="slide" onRequestClose={() => setClearing(null)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setClearing(null)} />
          <View style={s.sheet}>
            <View style={s.sheetHandle} />
            <Text style={s.sheetTitle} numberOfLines={1}>
              {clearing?.is_dm ? (clearing?.other_username || '') : clearing?.name}
            </Text>
            {/* Mark as read, asked for so a chat can be cleared from the list
                without opening it. First, because it is the harmless one and
                everything below it destroys messages. */}
            {clearing && (unread[clearing.id] || 0) > 0 && (
              <TouchableOpacity style={s.sheetRow} onPress={() => markRoomRead(clearing)}>
                <Ionicons name="checkmark-done-outline" size={19} color={C.text} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.sheetRowText}>Mark as read</Text>
                  <Text style={s.sheetRowHint}>
                    Clears the badge, including anything new in this chat's comments.
                  </Text>
                </View>
              </TouchableOpacity>
            )}
            {clearing && clearScopes(!!clearing.is_dm).map(scope => (
              <TouchableOpacity
                key={scope}
                style={s.sheetRow}
                onPress={() => confirmClear(clearing, scope)}
              >
                <Ionicons
                  name={scope === 'both' ? 'trash-outline' : 'eye-off-outline'}
                  size={19}
                  color={scope === 'both' ? C.danger : C.text}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[s.sheetRowText, scope === 'both' && { color: C.danger }]}>
                    {clearLabel(scope)}
                  </Text>
                  <Text style={s.sheetRowHint}>
                    {clearHint(scope, clearing.is_dm ? (clearing.other_username || 'they') : 'everyone else')}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={s.sheetCancel} onPress={() => setClearing(null)}>
              <Text style={s.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Profile Modal */}
      <Modal visible={showProfile} transparent animationType="slide" onRequestClose={() => setShowProfile(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowProfile(false)} />
          <View style={s.sheet}>
            <View style={s.sheetHandle} />
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>Profile</Text>
              <TouchableOpacity onPress={() => setShowProfile(false)} style={s.closeBtnTouch}>
                <Text style={s.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView ref={profileScrollRef} showsVerticalScrollIndicator={false} nestedScrollEnabled>
            {/* Avatar + name */}
            <View style={s.profileTop}>
              <View style={s.bigAvatar}>
                {myAvatar
                  ? <Text style={s.bigAvatarEmoji}>{myAvatar}</Text>
                  : <Text style={s.bigAvatarText}>{initials(me)}</Text>}
              </View>
              <View style={s.profileNameRow}>
                <Text style={s.profileName}>{me}</Text>
                <TouchableOpacity onPress={openUsernameEditor} style={s.pencilBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Text style={s.pencilIcon}>✏️</Text>
                </TouchableOpacity>
              </View>
              {!!profileSuccess && <Text style={s.profileSuccessText}>{profileSuccess}</Text>}
            </View>

            {/* Profile picture (emoji) picker: one row + expandable sheet */}
            <View style={s.section}>
              <Text style={s.sectionTitle}>PROFILE PICTURE</Text>
              <View style={s.emojiGrid}>
                {AVATAR_EMOJIS.slice(0, 6).map(e => (
                  <TouchableOpacity
                    key={e}
                    style={[s.emojiCell, myAvatar === e && s.emojiCellActive]}
                    onPress={() => setAvatarEmoji(e)}
                  >
                    <Text style={s.emojiCellText}>{e}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity style={s.emojiCell} onPress={() => setShowAllEmojis(true)}>
                  <Text style={s.emojiMoreText}>⋯</Text>
                </TouchableOpacity>
              </View>
              {myAvatar && (
                <TouchableOpacity style={s.removeAvatarBtn} onPress={() => setAvatarEmoji(null)}>
                  <Text style={s.removeAvatarText}>Remove profile picture</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* My Rooms */}
            <View style={s.section}>
              <Text style={s.sectionTitle}>MY ROOMS</Text>
              {myRooms.length === 0 ? (
                <Text style={s.emptyRooms}>No rooms created yet</Text>
              ) : (
                <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator={false} nestedScrollEnabled>
                  {myRooms.map(r => (
                    <View key={r.id} style={s.myRoomRow}>
                      <Text style={s.myRoomName}># {r.name}</Text>
                      <TouchableOpacity onPress={() => startRename(r)} style={s.roomActionBtn}>
                        <Text style={s.roomActionIcon}>✏️</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => { setShowProfile(false); deleteRoom(r); }} style={s.roomActionBtn}>
                        <Text style={s.roomActionIcon}>🗑</Text>
                      </TouchableOpacity>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>

            {/* Downloaded media */}
            <View style={s.section}>
              <Text style={s.sectionTitle}>DOWNLOADED MEDIA</Text>
              <Text style={s.cacheHint}>
                Photos, voice messages and files are kept after the first
                download, so opening them again costs nothing. Older ones are
                removed automatically once this passes 2 GB.
              </Text>
              <View style={s.cacheRow}>
                <Text style={s.cacheSize}>
                  {cacheBytes === null ? 'Measuring…' : fmtBytes(cacheBytes)}
                </Text>
                <TouchableOpacity
                  style={s.clearCacheBtn}
                  onPress={() => Alert.alert(
                    'Clear downloaded media?',
                    'Your messages are not affected. Photos and files will be downloaded again the next time you open them.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Clear', style: 'destructive',
                        onPress: async () => { await mediaCache.clear(); setCacheBytes(0); },
                      },
                    ],
                  )}
                >
                  <Text style={s.clearCacheText}>Clear</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* App Update */}
            <View style={s.section} onLayout={e => { updateSectionY.current = e.nativeEvent.layout.y; }}>
              <Text style={s.sectionTitle}>APP UPDATE</Text>
              <View style={s.versionRow}>
                <View style={s.versionBox}>
                  <Text style={s.versionLabel}>CURRENT</Text>
                  <Text style={s.versionValue}>{BUILD_VERSION ? `v${BUILD_VERSION}` : 'dev'}</Text>
                </View>
                <Text style={s.versionArrow}>→</Text>
                <View style={s.versionBox}>
                  <Text style={s.versionLabel}>LATEST</Text>
                  <Text style={s.versionValue}>{latestVersion !== null ? `v${latestVersion}` : '…'}</Text>
                </View>
              </View>
              {/* A download in progress always wins; otherwise the choice is
                  decided by installChoice, which offers an APK already on the
                  phone rather than fetching it a second time. */}
              {updateProgress !== null ? (
                <View style={s.updateProgressWrap}>
                  <View style={s.updateProgressTrack}>
                    {/* Indeterminate when nothing knows the size: a bar
                        frozen at 0% reads as "stuck", which is exactly what
                        was reported. */}
                    <View style={[
                      s.updateProgressFill,
                      updateState.knowsTotal === false
                        ? s.updateProgressUnknown
                        : { width: `${Math.round(updateProgress * 100)}%` },
                    ]} />
                  </View>
                  <Text style={s.updateProgressText}>
                    {updateStatusLine({
                      phase: updateState.status,
                      percent: updateProgress * 100,
                      online: online,
                      canContinue: !!updateState.continues,
                      written: updateState.written,
                      knowsTotal: updateState.knowsTotal !== false,
                    })}
                  </Text>
                </View>
              ) : updateChoice === 'up-to-date' ? (
                <View style={s.upToDateBox}>
                  <Text style={s.upToDateText}>✓ You are up to date</Text>
                </View>
              ) : updateChoice === 'install' ? (
                <>
                  <TouchableOpacity style={s.updateBtn} onPress={installDownloadedUpdate}>
                    <Text style={s.updateBtnText}>
                      ⬇ Install version {downloadedUpdate?.version}
                    </Text>
                  </TouchableOpacity>
                  <Text style={s.alreadyDownloadedHint}>
                    Already downloaded — no data needed to install it.
                  </Text>
                </>
              ) : updateChoice === 'unknown' ? (
                // Not knowing is its OWN state. This used to fall through to a
                // confident "Update now", which is how the profile came to
                // offer an update while the header — which required a known
                // version — showed nothing at all. Trying again is the useful
                // thing to offer; downloading whatever GitHub last published
                // is still there for anyone who wants it.
                <>
                  <TouchableOpacity style={s.updateBtn} onPress={checkLatestVersion}>
                    <Text style={s.updateBtnText}>↻ Check again</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.updateGhostBtn} onPress={downloadAndInstallUpdate}>
                    <Text style={s.updateGhostText}>Download the latest build anyway</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity style={s.updateBtn} onPress={downloadAndInstallUpdate}>
                  <Text style={s.updateBtnText}>
                    ⚡ Update {latestVersion !== null ? `to version ${latestVersion}` : 'now'}
                  </Text>
                </TouchableOpacity>
              )}
              {versionCheckFailed && (
                <Text style={s.versionCheckError}>
                  Could not reach this server or GitHub to check for updates.
                </Text>
              )}
            </View>

            {/* Logout */}
            <View style={s.section}>
              <TouchableOpacity style={s.logoutBtn} onPress={() => { setShowProfile(false); onLogout(); }}>
                <Text style={s.logoutBtnText}>Sign out</Text>
              </TouchableOpacity>
            </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* All-emojis picker */}
      <Modal visible={showAllEmojis} transparent animationType="fade" onRequestClose={() => setShowAllEmojis(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowAllEmojis(false)} />
          <View style={s.renameCard}>
            <Text style={s.renameTitle}>Choose a profile picture</Text>
            <View style={s.emojiGrid}>
              {AVATAR_EMOJIS.map(e => (
                <TouchableOpacity
                  key={e}
                  style={[s.emojiCell, myAvatar === e && s.emojiCellActive]}
                  onPress={() => { setAvatarEmoji(e); setShowAllEmojis(false); }}
                >
                  <Text style={s.emojiCellText}>{e}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={s.renameCancel} onPress={() => setShowAllEmojis(false)}>
              <Text style={s.renameCancelText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Create Room Modal */}
      <Modal visible={showCreate} transparent animationType="fade" onRequestClose={() => setShowCreate(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowCreate(false)} />
          <View style={s.renameCard}>
            <Text style={s.renameTitle}>Create Room</Text>
            <TextInput
              style={s.renameInput} value={newRoom} onChangeText={setNewRoom}
              placeholder="Room name" placeholderTextColor={C.muted} autoFocus
              onSubmitEditing={createRoom}
            />
            <TouchableOpacity style={s.privacyRow} onPress={() => setNewRoomPrivate(p => !p)}>
              <View style={[s.checkbox, newRoomPrivate && s.checkboxOn]}>
                {newRoomPrivate && <Text style={s.checkboxTick}>✓</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.privacyLabel}>Private room</Text>
                <Text style={s.privacyHint}>Only invited members can see and join it</Text>
              </View>
            </TouchableOpacity>
            <View style={s.renameRow}>
              <TouchableOpacity style={s.renameCancel} onPress={() => setShowCreate(false)}>
                <Text style={s.renameCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.renameSave} onPress={createRoom}>
                <Text style={s.renameSaveText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Rename Modal */}
      <Modal visible={!!renamingRoom} transparent animationType="fade" onRequestClose={() => setRenamingRoom(null)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setRenamingRoom(null)} />
          <View style={s.renameCard}>
            <Text style={s.renameTitle}>Rename Room</Text>
            <TextInput
              style={s.renameInput} value={renameText} onChangeText={setRenameText}
              placeholderTextColor={C.muted} autoFocus onSubmitEditing={saveRename}
            />
            <View style={s.renameRow}>
              <TouchableOpacity style={s.renameCancel} onPress={() => setRenamingRoom(null)}>
                <Text style={s.renameCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.renameSave} onPress={saveRename}>
                <Text style={s.renameSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Change username */}
      <Modal visible={editingUsername} transparent animationType="fade" onRequestClose={() => setEditingUsername(false)}>
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setEditingUsername(false)} />
          <View style={s.renameCard}>
            <Text style={s.renameTitle}>Change username</Text>
            <Text style={s.usernameWarn}>{changesLeftText(changesLeft)}</Text>
            <TextInput
              style={s.renameInput} value={newUsername} onChangeText={setNewUsername}
              placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false}
              editable={changesLeft !== 0} onSubmitEditing={saveUsername}
            />
            {!!profileError && <Text style={s.profileErrorText}>{profileError}</Text>}
            <View style={s.renameRow}>
              <TouchableOpacity style={s.renameCancel} onPress={() => setEditingUsername(false)}>
                <Text style={s.renameCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.renameSave, (savingProfile || changesLeft === 0 || changesLeft === null) && s.renameSaveOff]}
                onPress={saveUsername}
                disabled={savingProfile || changesLeft === 0 || changesLeft === null}
              >
                <Text style={s.renameSaveText}>{savingProfile ? 'Saving…' : 'Change'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.sidebar },
  header: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  avatarEmoji: { fontSize: 20 },
  headerTitle: { flex: 1, color: C.text, fontWeight: '600', fontSize: 15 },
  logout: { color: C.danger, fontSize: 20, padding: 4 },
  updateGhostBtn: {
    marginTop: 8, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, borderColor: C.border, alignItems: 'center',
  },
  updateGhostText: { color: C.muted, fontSize: 13, fontWeight: '600' },
  updateBadge: {
    backgroundColor: 'rgba(74,222,128,0.15)', borderWidth: 1, borderColor: C.online,
    borderRadius: 16, paddingHorizontal: 10, paddingVertical: 4,
  },
  updateBadgeText: { color: C.online, fontSize: 13, fontWeight: '700' },
  createRow: { flexDirection: 'row', padding: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  createInput: { flex: 1, backgroundColor: C.inputBg, borderRadius: 8, padding: 8, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.border, textAlign: isRTL ? 'right' : 'left' },
  createBtn: { backgroundColor: C.accent, borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' },
  createBtnText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  roomItem: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  roomIcon: { fontSize: 16, color: C.muted },
  roomName: { flex: 1, color: C.text, fontSize: 15 },
  roomDisappearing: { fontSize: 13, marginRight: 6, opacity: 0.85 },
  unreadBadge: { backgroundColor: C.online, borderRadius: 10, minWidth: 20, height: 20, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  unreadBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  divider: { color: C.muted, fontSize: 11, fontWeight: '600', padding: 10, paddingTop: 14, letterSpacing: 0.5 },

  // Profile modal
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 20, maxHeight: '88%' },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  sheetTitle: { color: C.text, fontWeight: '700', fontSize: 16 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 13 },
  sheetRowText: { color: C.text, fontSize: 15, fontWeight: '700' },
  sheetRowHint: { color: C.muted, fontSize: 11.5, marginTop: 2 },
  sheetCancel: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  sheetCancelText: { color: C.muted, fontSize: 14.5, fontWeight: '700' },
  closeBtn: { color: C.muted, fontSize: 18 },
  closeBtnTouch: { padding: 8, margin: -4 },
  profileTop: { alignItems: 'center', paddingVertical: 20 },
  bigAvatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  bigAvatarText: { color: '#fff', fontWeight: '700', fontSize: 26 },
  bigAvatarEmoji: { fontSize: 42 },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emojiCell: { width: 44, height: 44, borderRadius: 10, backgroundColor: C.inputBg, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  emojiCellActive: { borderColor: C.accent, backgroundColor: 'rgba(59,125,216,0.12)' },
  emojiCellText: { fontSize: 24 },
  emojiMoreText: { fontSize: 22, color: C.muted, fontWeight: '700' },
  searchResults: { maxHeight: 240, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.sidebar },
  searchEmpty: { color: C.muted, fontSize: 13, textAlign: 'center', padding: 14 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.border },
  searchIcon: { fontSize: 17, width: 24, textAlign: 'center' },
  searchName: { flex: 1, color: C.text, fontSize: 14.5, fontWeight: '600' },
  searchAction: { color: C.accent, fontSize: 12.5, fontWeight: '700' },
  privacyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: C.accent, borderColor: C.accent },
  checkboxTick: { color: '#fff', fontSize: 13, fontWeight: '700' },
  privacyLabel: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  privacyHint: { color: C.muted, fontSize: 12 },
  removeAvatarBtn: { marginTop: 12, alignItems: 'center', padding: 8 },
  removeAvatarText: { color: C.danger, fontSize: 13, fontWeight: '600' },
  profileName: { color: C.text, fontWeight: '600', fontSize: 17 },
  profileNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pencilBtn: { padding: 2 },
  pencilIcon: { fontSize: 15 },
  usernameWarn: { color: '#d97706', fontSize: 12.5, lineHeight: 18, marginBottom: 10 },
  section: { paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: C.border },
  sectionTitle: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 10 },
  emptyRooms: { color: C.muted, fontSize: 14 },
  profileErrorText: { color: C.danger, fontSize: 12, marginBottom: 8 },
  profileSuccessText: { color: C.online, fontSize: 12, marginBottom: 8 },
  myRoomRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.border, gap: 6 },
  myRoomName: { flex: 1, color: C.text, fontSize: 15 },
  roomActionBtn: { padding: 6 },
  roomActionIcon: { fontSize: 18 },
  logoutBtn: { backgroundColor: C.danger, borderRadius: 10, padding: 13, alignItems: 'center' },
  logoutBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  updateHint: { color: C.muted, fontSize: 13, marginBottom: 10 },
  updateBtn: { backgroundColor: C.accent, borderRadius: 10, padding: 13, alignItems: 'center' },
  updateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  upToDateBox: { backgroundColor: 'rgba(22,163,74,0.12)', borderWidth: 1, borderColor: C.success, borderRadius: 10, padding: 13, alignItems: 'center' },
  alreadyDownloadedHint: {
    color: C.muted, fontSize: 11.5, textAlign: 'center', marginTop: 7,
  },
  upToDateText: { color: C.success, fontWeight: '700', fontSize: 15 },
  versionCheckError: { color: C.muted, fontSize: 12, marginTop: 8, textAlign: 'center' },
  versionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 12 },
  versionBox: { alignItems: 'center', backgroundColor: C.inputBg, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 18, borderWidth: 1, borderColor: C.border },
  versionLabel: { color: C.muted, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  versionValue: { color: C.text, fontSize: 16, fontWeight: '700', marginTop: 2 },
  versionArrow: { color: C.muted, fontSize: 18 },
  updateProgressWrap: { gap: 8 },
  updateProgressTrack: { height: 8, borderRadius: 4, backgroundColor: C.inputBg, overflow: 'hidden', borderWidth: 1, borderColor: C.border },
  updateProgressFill: { height: '100%', backgroundColor: C.accent },
  // No percentage to draw: a third of the track, so the bar reads as "working"
  // rather than as "nothing has happened".
  updateProgressUnknown: { width: '35%', opacity: 0.7 },
  updateProgressText: { color: C.muted, fontSize: 12, textAlign: 'center' },

  // Rename modal
  renameCard: { backgroundColor: C.sidebar, margin: 32, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: C.border },
  renameTitle: { color: C.text, fontWeight: '700', fontSize: 16, marginBottom: 14 },
  renameInput: { backgroundColor: C.inputBg, borderRadius: 8, padding: 12, color: C.text, fontSize: 15, borderWidth: 1, borderColor: C.border, marginBottom: 16, textAlign: isRTL ? 'right' : 'left' },
  renameRow: { flexDirection: 'row', gap: 10 },
  renameCancel: { flex: 1, backgroundColor: C.inputBg, borderRadius: 8, padding: 12, alignItems: 'center' },
  renameCancelText: { color: C.muted, fontWeight: '600' },
  renameSave: { flex: 1, backgroundColor: C.accent, borderRadius: 8, padding: 12, alignItems: 'center' },
  renameSaveOff: { opacity: 0.45 },
  cacheHint: { color: C.muted, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  cacheRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cacheSize: { flex: 1, color: C.text, fontSize: 15, fontWeight: '700' },
  clearCacheBtn: {
    borderWidth: 1, borderColor: C.danger, borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  clearCacheText: { color: C.danger, fontSize: 13, fontWeight: '700' },
  mentionBadge: {
    minWidth: 20, height: 20, borderRadius: 10, backgroundColor: C.accent,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5,
  },
  mentionBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  renameSaveText: { color: '#fff', fontWeight: '700' },
});
