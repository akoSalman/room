import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, ActivityIndicator, Modal, ScrollView, Linking, Platform, Pressable,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import { C, isRTL } from '../theme';
import { apiFetch, getUsername, getUserId, getSocket, setAuth, getAvatar, RELEASE_TAG, RELEASE_FILE } from '../api';
import { BUILD_VERSION } from '../version';

const AVATAR_EMOJIS = ['🦄','🐉','🧙‍♂️','🧚‍♀️','🧛‍♂️','🧞‍♂️','🦊','🐺','🦁','🐯','🐼','🐸','🦉','🐙','🦋','🤖','👽','🐲','🦅','🐬','🔥','⚡','🌙','⭐'];

const LATEST_APK_URL = `https://github.com/akoSalman/room-releases/releases/download/${RELEASE_TAG}/${RELEASE_FILE}`;
const LATEST_RELEASE_API = `https://api.github.com/repos/akoSalman/room-releases/releases/tags/${RELEASE_TAG}`;

type Room = { id: number; name: string; is_dm: number; other_username?: string; created_by?: number };

export default function RoomsScreen({ onSelectRoom, onLogout, openProfileOnMount, onProfileOpened }: {
  onSelectRoom: (room: Room) => void;
  onLogout: () => void;
  openProfileOnMount?: boolean;
  onProfileOpened?: () => void;
}) {
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
  const [curPass, setCurPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [unread, setUnread] = useState<Record<number, number>>({});
  const [latestVersion, setLatestVersion] = useState<number | null>(null);
  const [versionCheckFailed, setVersionCheckFailed] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null); // 0..1 while downloading
  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  const updateDownloadRef = useRef<FileSystem.DownloadResumable | null>(null);

  const load = useCallback(async () => {
    const [r, d, u, id, counts] = await Promise.all([
      apiFetch('/rooms'),
      apiFetch('/dm-rooms'),
      getUsername(),
      getUserId(),
      apiFetch('/unread-counts'),
    ]);
    if (Array.isArray(r)) setRooms(r);
    if (Array.isArray(d)) setDms(d);
    setMe(u || '');
    setMyId(id);
    getAvatar().then(setMyAvatar);
    if (counts && !counts.error) setUnread(counts);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Check for a newer build once on mount: drives the header update badge.
  useEffect(() => { checkLatestVersion(); }, []);

  useEffect(() => {
    if (openProfileOnMount) {
      setShowProfile(true);
      checkLatestVersion();
      onProfileOpened?.();
    }
  }, [openProfileOnMount]);

  useEffect(() => {
    let sock: any;
    (async () => {
      const uname = await getUsername();
      sock = await getSocket();
      sock.on('message_received', (msg: any) => {
        if (msg.username === uname) return; // own messages are never "unread"
        setUnread(prev => ({ ...prev, [msg.room_id]: (prev[msg.room_id] || 0) + 1 }));
      });
      sock.on('dm_activity', () => load());
    })();
    return () => {
      sock?.off('message_received');
      sock?.off('dm_activity');
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
    try {
      const res = await fetch(LATEST_RELEASE_API).then(r => r.json());
      const match = /version:(\d+)/.exec(res.body || '') || /v(\d+)/.exec(res.name || '');
      if (match) setLatestVersion(parseInt(match[1]));
      else setVersionCheckFailed(true);
    } catch {
      setVersionCheckFailed(true);
    }
  }

  async function downloadAndInstallUpdate() {
    if (updateProgress !== null) return; // already downloading
    if (Platform.OS !== 'android') {
      Linking.openURL(LATEST_APK_URL);
      return;
    }
    setUpdateProgress(0);
    const dest = FileSystem.cacheDirectory + 'ChatRoom-update.apk';
    try {
      const dl = FileSystem.createDownloadResumable(
        LATEST_APK_URL, dest, {},
        p => {
          if (p.totalBytesExpectedToWrite > 0) {
            setUpdateProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite);
          }
        }
      );
      updateDownloadRef.current = dl;
      const result = await dl.downloadAsync();
      setUpdateProgress(null);
      if (!result?.uri) { Alert.alert('Update failed', 'Could not download the update.'); return; }
      const contentUri = await FileSystem.getContentUriAsync(result.uri);
      await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
        data: contentUri,
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
      });
    } catch (e) {
      setUpdateProgress(null);
      Alert.alert(
        'Update failed',
        'Could not download or start the installer. You can download the APK manually instead.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Download manually', onPress: () => Linking.openURL(LATEST_APK_URL) },
        ]
      );
    }
  }

  async function setAvatarEmoji(emoji: string | null) {
    const res = await apiFetch('/profile', 'PUT', { avatar: emoji });
    if (res.error) { Alert.alert('Error', res.error); return; }
    await setAuth(res.token, res.username, res.avatar);
    setMyAvatar(res.avatar);
  }

  async function saveProfile() {
    setProfileError('');
    setProfileSuccess('');
    if (!curPass) { setProfileError('Current password is required to save changes'); return; }
    setSavingProfile(true);
    const res = await apiFetch('/profile', 'PUT', {
      newUsername: newUsername.trim() || undefined,
      currentPassword: curPass,
      newPassword: newPass || undefined,
    });
    setSavingProfile(false);
    if (res.error) { setProfileError(res.error); return; }
    await setAuth(res.token, res.username);
    setMe(res.username);
    setNewUsername('');
    setCurPass('');
    setNewPass('');
    setProfileSuccess('Profile updated');
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
        {latestVersion !== null && BUILD_VERSION !== latestVersion ? (
          <TouchableOpacity style={s.updateBadge} onPress={() => { setShowProfile(true); downloadAndInstallUpdate(); }}>
            <Text style={s.updateBadgeText}>⚡ v{latestVersion}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Search users & rooms; + creates a room */}
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
              <Text style={s.searchAction}>Join</Text>
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
              <TouchableOpacity style={s.roomItem} onPress={() => selectRoom(item)}>
                <Text style={s.roomIcon}>{item.is_dm ? '💬' : item.is_private ? '🔒' : '#'}</Text>
                <Text style={s.roomName}>{label}</Text>
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

            <ScrollView showsVerticalScrollIndicator={false} nestedScrollEnabled>
            {/* Avatar + name */}
            <View style={s.profileTop}>
              <View style={s.bigAvatar}>
                {myAvatar
                  ? <Text style={s.bigAvatarEmoji}>{myAvatar}</Text>
                  : <Text style={s.bigAvatarText}>{initials(me)}</Text>}
              </View>
              <Text style={s.profileName}>{me}</Text>
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

            {/* Edit profile */}
            <View style={s.section}>
              <Text style={s.sectionTitle}>EDIT PROFILE</Text>
              <TextInput
                style={s.profileInput} placeholder="New username" placeholderTextColor={C.muted}
                value={newUsername} onChangeText={setNewUsername} autoCapitalize="none"
              />
              <TextInput
                style={s.profileInput} placeholder="Current password (required)" placeholderTextColor={C.muted}
                value={curPass} onChangeText={setCurPass} secureTextEntry
              />
              <TextInput
                style={s.profileInput} placeholder="New password (optional)" placeholderTextColor={C.muted}
                value={newPass} onChangeText={setNewPass} secureTextEntry
              />
              {!!profileError && <Text style={s.profileErrorText}>{profileError}</Text>}
              {!!profileSuccess && <Text style={s.profileSuccessText}>{profileSuccess}</Text>}
              <TouchableOpacity style={s.saveProfileBtn} onPress={saveProfile} disabled={savingProfile}>
                <Text style={s.saveProfileBtnText}>{savingProfile ? 'Saving...' : 'Save changes'}</Text>
              </TouchableOpacity>
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

            {/* App Update */}
            <View style={s.section}>
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
              {latestVersion !== null && BUILD_VERSION === latestVersion ? (
                <View style={s.upToDateBox}>
                  <Text style={s.upToDateText}>✓ You are up to date</Text>
                </View>
              ) : updateProgress !== null ? (
                <View style={s.updateProgressWrap}>
                  <View style={s.updateProgressTrack}>
                    <View style={[s.updateProgressFill, { width: `${Math.round(updateProgress * 100)}%` }]} />
                  </View>
                  <Text style={s.updateProgressText}>Downloading update… {Math.round(updateProgress * 100)}%</Text>
                </View>
              ) : (
                <TouchableOpacity style={s.updateBtn} onPress={downloadAndInstallUpdate}>
                  <Text style={s.updateBtnText}>
                    ⚡ Update {latestVersion !== null ? `to version ${latestVersion}` : 'now'}
                  </Text>
                </TouchableOpacity>
              )}
              {versionCheckFailed && (
                <Text style={s.versionCheckError}>Could not check for updates</Text>
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
  unreadBadge: { backgroundColor: C.online, borderRadius: 10, minWidth: 20, height: 20, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  unreadBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  divider: { color: C.muted, fontSize: 11, fontWeight: '600', padding: 10, paddingTop: 14, letterSpacing: 0.5 },

  // Profile modal
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 20, maxHeight: '88%' },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  sheetTitle: { color: C.text, fontWeight: '700', fontSize: 16 },
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
  section: { paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: C.border },
  sectionTitle: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 10 },
  emptyRooms: { color: C.muted, fontSize: 14 },
  profileInput: { backgroundColor: C.inputBg, borderRadius: 8, padding: 10, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.border, marginBottom: 10, textAlign: isRTL ? 'right' : 'left' },
  profileErrorText: { color: C.danger, fontSize: 12, marginBottom: 8 },
  profileSuccessText: { color: C.online, fontSize: 12, marginBottom: 8 },
  saveProfileBtn: { backgroundColor: C.accent, borderRadius: 10, padding: 12, alignItems: 'center' },
  saveProfileBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
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
  updateProgressText: { color: C.muted, fontSize: 12, textAlign: 'center' },

  // Rename modal
  renameCard: { backgroundColor: C.sidebar, margin: 32, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: C.border },
  renameTitle: { color: C.text, fontWeight: '700', fontSize: 16, marginBottom: 14 },
  renameInput: { backgroundColor: C.inputBg, borderRadius: 8, padding: 12, color: C.text, fontSize: 15, borderWidth: 1, borderColor: C.border, marginBottom: 16, textAlign: isRTL ? 'right' : 'left' },
  renameRow: { flexDirection: 'row', gap: 10 },
  renameCancel: { flex: 1, backgroundColor: C.inputBg, borderRadius: 8, padding: 12, alignItems: 'center' },
  renameCancelText: { color: C.muted, fontWeight: '600' },
  renameSave: { flex: 1, backgroundColor: C.accent, borderRadius: 8, padding: 12, alignItems: 'center' },
  renameSaveText: { color: '#fff', fontWeight: '700' },
});
