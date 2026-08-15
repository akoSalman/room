// In-chat text search, in the style people already know from Telegram: the
// header turns into a search field, results are counted, and up/down step
// through them oldest-to-newest while the chat scrolls to each one.
//
// The search runs on the SERVER so it covers the whole history. Searching only
// what the client happens to have loaded would miss almost everything in a
// long chat, which is worse than having no search.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';

export type SearchHit = {
  id: number;
  content: string;
  created_at?: string;
  username?: string;
};

export default function ChatSearch({
  onClose, onSearch, onJump,
}: {
  onClose: () => void;
  onSearch: (q: string) => Promise<{ results: SearchHit[]; encryptedSkipped: number }>;
  onJump: (messageId: number) => void;
}) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [idx, setIdx] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [searched, setSearched] = useState(false);
  const timer = useRef<any>(null);
  const input = useRef<TextInput>(null);
  // Guards against an older, slower response overwriting a newer one.
  const runId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 2) {
      setHits([]); setSearched(false); setBusy(false);
      return;
    }
    setBusy(true);
    // Typing a word should not fire a request per keystroke.
    timer.current = setTimeout(async () => {
      const mine = ++runId.current;
      try {
        const r = await onSearch(term);
        if (mine !== runId.current) return;   // superseded
        setHits(r.results || []);
        setSkipped(r.encryptedSkipped || 0);
        setIdx(0);
        setSearched(true);
        // Land on the newest match straight away — that is what someone
        // searching a chat almost always wants.
        if (r.results?.length) onJump(r.results[0].id);
      } finally {
        if (mine === runId.current) setBusy(false);
      }
    }, 350);
    return () => clearTimeout(timer.current);
  }, [q]);

  function step(delta: number) {
    if (!hits.length) return;
    const next = (idx + delta + hits.length) % hits.length;
    setIdx(next);
    Keyboard.dismiss();
    onJump(hits[next].id);
  }

  return (
    <View style={s.wrap}>
      <View style={s.bar}>
        <TouchableOpacity onPress={onClose} style={s.iconBtn} hitSlop={hit}>
          <Ionicons name="arrow-back" size={23} color={C.text} />
        </TouchableOpacity>
        <TextInput
          ref={input}
          style={s.input}
          value={q}
          onChangeText={setQ}
          placeholder="Search in this chat…"
          placeholderTextColor={C.muted}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {busy ? <ActivityIndicator size="small" color={C.accent} style={{ marginRight: 6 }} /> : null}
        {!!q && !busy && (
          <TouchableOpacity onPress={() => setQ('')} style={s.iconBtn} hitSlop={hit}>
            <Ionicons name="close-circle" size={19} color={C.muted} />
          </TouchableOpacity>
        )}
      </View>

      {/* Result counter and stepping, only once a search has actually run. */}
      {searched && (
        <View style={s.results}>
          <Text style={s.count}>
            {hits.length
              ? `${idx + 1} of ${hits.length}`
              : 'No messages found'}
          </Text>
          {/* Honest about what could not be searched, rather than reporting
              "no matches" for a chat whose messages are encrypted. */}
          {!!skipped && (
            <Text style={s.skipped} numberOfLines={1}>
              {skipped} encrypted {skipped === 1 ? 'message' : 'messages'} can’t be searched
            </Text>
          )}
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={() => step(1)} disabled={!hits.length} style={s.stepBtn} hitSlop={hit}>
            <Ionicons name="chevron-up" size={20} color={hits.length ? C.accent : C.muted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => step(-1)} disabled={!hits.length} style={s.stepBtn} hitSlop={hit}>
            <Ionicons name="chevron-down" size={20} color={hits.length ? C.accent : C.muted} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const hit = { top: 10, bottom: 10, left: 8, right: 8 };

const s = StyleSheet.create({
  wrap: { backgroundColor: C.header },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingTop: 42, paddingBottom: 8, paddingHorizontal: 8,
  },
  iconBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1, color: C.text, fontSize: 16, paddingVertical: 6, paddingHorizontal: 4,
  },
  results: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingBottom: 8,
  },
  count: { color: C.muted, fontSize: 12.5, fontWeight: '700' },
  skipped: { color: '#d97706', fontSize: 11, flexShrink: 1 },
  stepBtn: { width: 34, height: 30, alignItems: 'center', justifyContent: 'center' },
});
