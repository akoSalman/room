// ── One person, and what you can do about them ──────────────────────────────
//
// Tapping somebody opens this. Three actions, each with a line saying what it
// actually does — because "mute", "block" and "clear" all read as "make this
// go away" and mean three very different things. The rules for which are
// offered and how they are worded live in ../peerActions.ts.
import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import {
  ClearScope, PeerView, actionsFor, avatarFor, blockConfirm, blockHint, blockLabel,
  clearConfirm, clearHint, clearLabel, clearScopes, muteHint, muteLabel,
} from '../peerActions';

function Row({ icon, color, label, hint, onPress, busy }: {
  icon: string; color: string; label: string; hint: string;
  onPress: () => void; busy?: boolean;
}) {
  return (
    <TouchableOpacity style={s.row} onPress={onPress} disabled={busy} activeOpacity={0.7}>
      <Ionicons name={icon as any} size={20} color={color} style={{ width: 26 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.rowLabel, { color }]}>{label}</Text>
        <Text style={s.rowHint}>{hint}</Text>
      </View>
      {busy ? <ActivityIndicator size="small" color={C.muted} /> : null}
    </TouchableOpacity>
  );
}

export default function PeerSheet({
  visible, peer, isDm, onClose, onToggleMute, onToggleBlock, onClear, onOpenChat,
}: {
  visible: boolean;
  peer: PeerView | null;
  /** Whether there is a direct chat with this person to clear. */
  isDm: boolean;
  onClose: () => void;
  onToggleMute: (next: boolean) => Promise<void> | void;
  onToggleBlock: (next: boolean) => Promise<void> | void;
  onClear: (scope: ClearScope) => Promise<void> | void;
  /** Offered when this sheet was opened from somewhere other than the chat. */
  onOpenChat?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ClearScope | null>(null);

  useEffect(() => { if (!visible) { setBusy(null); setConfirming(null); } }, [visible]);

  if (!peer) return null;
  const name = peer.username;
  const actions = actionsFor(peer, isDm);

  async function run(key: string, fn: () => Promise<void> | void) {
    setBusy(key);
    try { await fn(); } finally { setBusy(null); }
  }

  function ask(c: { title: string; body: string } | null, go: () => void) {
    if (!c) { go(); return; }
    Alert.alert(c.title, c.body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Continue', style: 'destructive', onPress: go },
    ]);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={s.sheet}>
          <View style={s.handle} />

          <View style={s.head}>
            <View style={s.avatar}>
              <Text style={s.avatarText}>{avatarFor(peer)}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.name} numberOfLines={1}>{name}</Text>
              {peer.blocked ? <Text style={s.blockedTag}>Blocked</Text>
                : peer.muted ? <Text style={s.mutedTag}>Notifications muted</Text> : null}
            </View>
          </View>

          {onOpenChat && (
            <Row icon="chatbubble-ellipses-outline" color={C.accent} label="Send a message"
              hint={`Open your chat with ${name}`}
              onPress={() => { onClose(); onOpenChat(); }} />
          )}

          {actions.includes('mute') && (
            <Row
              icon={peer.muted ? 'notifications-outline' : 'notifications-off-outline'}
              color={C.text}
              label={muteLabel(peer.muted)}
              hint={muteHint(peer.muted, name)}
              busy={busy === 'mute'}
              onPress={() => run('mute', () => onToggleMute(!peer.muted))}
            />
          )}

          {actions.includes('block') && (
            <Row
              icon={peer.blocked ? 'lock-open-outline' : 'ban-outline'}
              color={peer.blocked ? C.text : C.danger}
              label={blockLabel(peer.blocked)}
              hint={blockHint(peer.blocked, name)}
              busy={busy === 'block'}
              onPress={() => ask(blockConfirm(peer.blocked, name),
                () => run('block', () => onToggleBlock(!peer.blocked)))}
            />
          )}

          {actions.includes('clear') && (
            <>
              <View style={s.sep} />
              {clearScopes(isDm).map(scope => (
                <Row
                  key={scope}
                  icon={scope === 'both' ? 'trash-outline' : 'eye-off-outline'}
                  color={scope === 'both' ? C.danger : C.text}
                  label={clearLabel(scope)}
                  hint={clearHint(scope, name)}
                  busy={busy === `clear-${scope}`}
                  onPress={() => ask(clearConfirm(scope, name),
                    () => run(`clear-${scope}`, () => onClear(scope)))}
                />
              ))}
            </>
          )}

          <TouchableOpacity style={s.cancel} onPress={onClose}>
            <Text style={s.cancelText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.sidebar, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 24,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: C.border,
    alignSelf: 'center', marginTop: 10, marginBottom: 8,
  },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 12,
  },
  avatar: {
    width: 46, height: 46, borderRadius: 23, backgroundColor: C.msgBg,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 22, color: C.text, fontWeight: '700' },
  name: { color: C.text, fontSize: 17, fontWeight: '800' },
  mutedTag: { color: C.muted, fontSize: 12, marginTop: 2 },
  blockedTag: { color: C.danger, fontSize: 12, fontWeight: '700', marginTop: 2 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.border, marginVertical: 6, marginHorizontal: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 12,
  },
  rowLabel: { fontSize: 15, fontWeight: '700' },
  rowHint: { color: C.muted, fontSize: 11.5, marginTop: 2 },
  cancel: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  cancelText: { color: C.muted, fontSize: 14.5, fontWeight: '700' },
});
