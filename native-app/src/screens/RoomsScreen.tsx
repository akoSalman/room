import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { C } from '../theme';
import { apiFetch, getUsername } from '../api';

type Room = { id: number; name: string; is_dm: number; other_username?: string };

export default function RoomsScreen({ onSelectRoom, onLogout }: {
  onSelectRoom: (room: Room) => void;
  onLogout: () => void;
}) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [dms, setDms] = useState<Room[]>([]);
  const [newRoom, setNewRoom] = useState('');
  const [me, setMe] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [r, d, u] = await Promise.all([
      apiFetch('/rooms'),
      apiFetch('/dm-rooms'),
      getUsername(),
    ]);
    if (Array.isArray(r)) setRooms(r);
    if (Array.isArray(d)) setDms(d);
    setMe(u || '');
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createRoom() {
    if (!newRoom.trim()) return;
    const res = await apiFetch('/rooms', 'POST', { name: newRoom.trim() });
    if (res.error) { Alert.alert('Error', res.error); return; }
    setNewRoom('');
    load();
  }

  const initials = (name: string) => name.slice(0, 2).toUpperCase();

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.avatar}><Text style={s.avatarText}>{initials(me)}</Text></View>
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
            return (
              <TouchableOpacity style={s.roomItem} onPress={() => onSelectRoom(item)}>
                <Text style={s.roomIcon}>{item.is_dm ? '💬' : '#'}</Text>
                <Text style={s.roomName}>{label}</Text>
              </TouchableOpacity>
            );
          }}
          refreshing={loading}
          onRefresh={load}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.sidebar },
  header: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  headerTitle: { flex: 1, color: C.text, fontWeight: '600', fontSize: 15 },
  logout: { color: C.muted, fontSize: 20, padding: 4 },
  createRow: { flexDirection: 'row', padding: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  createInput: { flex: 1, backgroundColor: C.inputBg, borderRadius: 8, padding: 8, color: C.text, fontSize: 14, borderWidth: 1, borderColor: C.border },
  createBtn: { backgroundColor: C.accent, borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' },
  createBtnText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  roomItem: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 },
  roomIcon: { fontSize: 16, color: C.muted },
  roomName: { color: C.text, fontSize: 15 },
  divider: { color: C.muted, fontSize: 11, fontWeight: '600', padding: 10, paddingTop: 14, letterSpacing: 0.5 },
});
