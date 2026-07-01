import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, ActivityIndicator, Modal, ScrollView,
} from 'react-native';
import { C } from '../theme';
import { apiFetch, getUsername, getUserId, getSocket, setAuth } from '../api';

type Room = { id: number; name: string; is_dm: number; other_username?: string; created_by?: number };

export default function RoomsScreen({ onSelectRoom, onLogout }: {
  onSelectRoom: (room: Room) => void;
  onLogout: () => void;
}) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [dms, setDms] = useState<Room[]>([]);
  const [newRoom, setNewRoom] = useState('');
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

  const load = useCallback(async () => {
    const [r, d, u, id] = await Promise.all([
      apiFetch('/rooms'),
      apiFetch('/dm-rooms'),
      getUsername(),
      getUserId(),
    ]);
    if (Array.isArray(r)) setRooms(r);
    if (Array.isArray(d)) setDms(d);
    setMe(u || '');
    setMyId(id);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let sock: any;
    (async () => {
      sock = await getSocket();
      sock.on('message_received', (msg: any) => {
        setUnread(prev => ({ ...prev, [msg.room_id]: (prev[msg.room_id] || 0) + 1 }));
      });
      sock.on('dm_activity', () => load());
    })();
    return () => {
      sock?.off('message_received');
      sock?.off('dm_activity');
    };
  }, [load]);

  function selectRoom(room: Room) {
    setUnread(prev => ({ ...prev, [room.id]: 0 }));
    onSelectRoom(room);
  }

  async function createRoom() {
    if (!newRoom.trim()) return;
    const res = await apiFetch('/rooms', 'POST', { name: newRoom.trim() });
    if (res.error) { Alert.alert('Error', res.error); return; }
    setNewRoom('');
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
        <TouchableOpacity onPress={() => setShowProfile(true)}>
          <View style={s.avatar}><Text style={s.avatarText}>{initials(me)}</Text></View>
        </TouchableOpacity>
        <Text style={s.headerTitle}>{me}</Text>
        <TouchableOpacity onPress={onLogout}><Text style={s.logout}>⎋</Text></TouchableOpacity>
      </View>

      {/* New room input */}
      <View style={s.createRow}>
        <TextInput
          style={s.createInput} placeholder="New room..." placeholderTextColor={C.muted}
          value={newRoom} onChangeText={setNewRoom}
          onSubmitEditing={createRoom}
        />
        <TouchableOpacity style={s.createBtn} onPress={createRoom}>
          <Text style={s.createBtnText}>+</Text>
        </TouchableOpacity>
      </View>

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
                <Text style={s.roomIcon}>{item.is_dm ? '💬' : '#'}</Text>
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
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setShowProfile(false)}>
          <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={s.sheet}>
            <View style={s.sheetHandle} />
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>Profile</Text>
              <TouchableOpacity onPress={() => setShowProfile(false)}>
                <Text style={s.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Avatar + name */}
            <View style={s.profileTop}>
              <View style={s.bigAvatar}><Text style={s.bigAvatarText}>{initials(me)}</Text></View>
              <Text style={s.profileName}>{me}</Text>
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
                <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator={false}>
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

            {/* Logout */}
            <View style={s.section}>
              <TouchableOpacity style={s.logoutBtn} onPress={() => { setShowProfile(false); onLogout(); }}>
                <Text style={s.logoutBtnText}>Sign out</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Rename Modal */}
      <Modal visible={!!renamingRoom} transparent animationType="fade" onRequestClose={() => setRenamingRoom(null)}>
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setRenamingRoom(null)}>
          <TouchableOpacity activeOpacity={1} onPress={e => e.stopPropagation()} style={s.renameCard}>
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
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.sidebar },
  header: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  headerTitle: { flex: 1, color: C.text, fontWeight: '600', fontSize: 15 },
  logout: { color: C.danger, fontSize: 20, padding: 4 },
  createRow: { flexDirection: 'row', padding: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  createInput: { flex: 1, backgroundColor: C.inputBg, borderRadius: 8, padding: 8, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.border },
  createBtn: { backgroundColor: C.accent, borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' },
  createBtnText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  roomItem: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  roomIcon: { fontSize: 16, color: C.muted },
  roomName: { flex: 1, color: C.text, fontSize: 15 },
  unreadBadge: { backgroundColor: C.accent, borderRadius: 10, minWidth: 20, height: 20, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  unreadBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  divider: { color: C.muted, fontSize: 11, fontWeight: '600', padding: 10, paddingTop: 14, letterSpacing: 0.5 },

  // Profile modal
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 32 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: 'center', marginTop: 10, marginBottom: 6 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  sheetTitle: { color: C.text, fontWeight: '700', fontSize: 16 },
  closeBtn: { color: C.muted, fontSize: 18, padding: 4 },
  profileTop: { alignItems: 'center', paddingVertical: 20 },
  bigAvatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  bigAvatarText: { color: '#fff', fontWeight: '700', fontSize: 26 },
  profileName: { color: C.text, fontWeight: '600', fontSize: 17 },
  section: { paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: C.border },
  sectionTitle: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 10 },
  emptyRooms: { color: C.muted, fontSize: 14 },
  profileInput: { backgroundColor: C.inputBg, borderRadius: 8, padding: 10, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.border, marginBottom: 10 },
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

  // Rename modal
  renameCard: { backgroundColor: C.sidebar, margin: 32, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: C.border },
  renameTitle: { color: C.text, fontWeight: '700', fontSize: 16, marginBottom: 14 },
  renameInput: { backgroundColor: C.inputBg, borderRadius: 8, padding: 12, color: C.text, fontSize: 15, borderWidth: 1, borderColor: C.border, marginBottom: 16 },
  renameRow: { flexDirection: 'row', gap: 10 },
  renameCancel: { flex: 1, backgroundColor: C.inputBg, borderRadius: 8, padding: 12, alignItems: 'center' },
  renameCancelText: { color: C.muted, fontWeight: '600' },
  renameSave: { flex: 1, backgroundColor: C.accent, borderRadius: 8, padding: 12, alignItems: 'center' },
  renameSaveText: { color: '#fff', fontWeight: '700' },
});
