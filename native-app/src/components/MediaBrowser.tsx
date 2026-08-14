// ── Shared media browser ─────────────────────────────────────────────────────
//
// Fullscreen, like a phone's own gallery, rather than the half-height sheet it
// used to be.
//
// The important behaviour is keeping your place. Opening a photo from the
// middle of a long gallery and closing it used to drop you back at the very
// top. The old code restored a saved SCROLL OFFSET from onContentSizeChange,
// which fires before the grid has laid out — so the offset was applied to a
// list that was not the right height yet, and the restore silently did
// nothing. This tracks the ITEM you were on instead and scrolls to that index,
// which does not depend on layout timing at all.
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, FlatList,
  ActivityIndicator, Dimensions, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import ImageWithSpinner from './ImageWithSpinner';
import { fileIcon, extOf } from '../mime';

export type MediaTab = 'images' | 'files' | 'music' | 'links';

const COLS = 3;
const GAP = 2;

const TABS: [MediaTab, string, string][] = [
  ['images', 'Photos', 'image-outline'],
  ['files', 'Files', 'document-outline'],
  ['music', 'Audio', 'musical-notes-outline'],
  ['links', 'Links', 'link-outline'],
];

export default function MediaBrowser({
  visible, title, data, tab, onTab, onClose, onOpenImage, thumbUrl, focusIndex, baseUrl,
}: {
  visible: boolean;
  title: string;
  data: any;
  tab: MediaTab;
  onTab: (t: MediaTab) => void;
  onClose: () => void;
  onOpenImage: (index: number, all: string[]) => void;
  thumbUrl: (path: string, w: number) => string;
  /** Which photo to land on — the one last viewed. */
  focusIndex: number;
  baseUrl: string;
}) {
  const win = Dimensions.get('window');
  const cell = Math.floor((win.width - GAP * (COLS - 1)) / COLS);
  const listRef = useRef<FlatList>(null);

  const images: string[] = useMemo(() => data?.images || [], [data]);
  const fullUrls = useMemo(() => images.map(u => `${baseUrl}${u}`), [images, baseUrl]);

  // Land on the photo the viewer was closed from. Done on every open rather
  // than only the first, because the sheet is reopened each time an image is
  // dismissed.
  useEffect(() => {
    if (!visible || tab !== 'images') return;
    const row = Math.floor(focusIndex / COLS);
    if (row <= 0) return;
    const t = setTimeout(() => {
      listRef.current?.scrollToOffset({ offset: row * (cell + GAP), animated: false });
    }, 0);
    return () => clearTimeout(t);
  }, [visible, tab, focusIndex, cell]);

  // Fixed-size cells, so the list can jump to any row without measuring it.
  const getItemLayout = useCallback(
    (_: any, index: number) => ({
      length: cell + GAP, offset: (cell + GAP) * Math.floor(index / COLS), index,
    }),
    [cell],
  );

  const renderImage = useCallback(({ item, index }: { item: string; index: number }) => (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={() => onOpenImage(index, fullUrls)}
      style={{ width: cell, height: cell, marginRight: (index + 1) % COLS ? GAP : 0, marginBottom: GAP }}
    >
      <ImageWithSpinner
        uri={thumbUrl(item, 300)}
        style={{ width: cell, height: cell, backgroundColor: '#111' }}
        resizeMode="cover"
      />
    </TouchableOpacity>
  ), [cell, fullUrls, onOpenImage, thumbUrl]);

  const rows = (list: any[], render: (x: any, i: number) => React.ReactNode) => (
    <FlatList
      data={list}
      keyExtractor={(_, i) => String(i)}
      renderItem={({ item, index }) => <>{render(item, index)}</>}
      ListEmptyComponent={<Text style={s.empty}>Nothing here yet</Text>}
      contentContainerStyle={{ paddingBottom: 30 }}
    />
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.screen}>
        <View style={s.header}>
          <TouchableOpacity onPress={onClose} style={s.iconBtn} hitSlop={hit}>
            <Ionicons name="arrow-back" size={24} color={C.text} />
          </TouchableOpacity>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.title} numberOfLines={1}>{title}</Text>
            <Text style={s.sub}>
              {tab === 'images' ? `${images.length} photos`
                : tab === 'files' ? `${(data?.files || []).length} files`
                : tab === 'music' ? `${(data?.music || []).length} audio files`
                : `${(data?.links || []).length} links`}
            </Text>
          </View>
        </View>

        <View style={s.tabs}>
          {TABS.map(([key, label, icon]) => (
            <TouchableOpacity
              key={key}
              style={[s.tab, tab === key && s.tabActive]}
              onPress={() => onTab(key)}
            >
              <Ionicons name={icon as any} size={16} color={tab === key ? C.accent : C.muted} />
              <Text style={[s.tabText, tab === key && s.tabTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {!data ? (
          <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} />
        ) : tab === 'images' ? (
          <FlatList
            ref={listRef}
            data={images}
            key={`grid-${cell}`}
            numColumns={COLS}
            keyExtractor={(_, i) => String(i)}
            renderItem={renderImage}
            getItemLayout={getItemLayout}
            initialNumToRender={21}
            windowSize={7}
            ListEmptyComponent={<Text style={s.empty}>No photos yet</Text>}
          />
        ) : tab === 'files' ? (
          rows(data.files || [], (f: any, i: number) => (
            <TouchableOpacity key={i} style={s.row} onPress={() => Linking.openURL(`${baseUrl}${f.url}`)}>
              <Text style={s.rowIcon}>{fileIcon(f.name, null)}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.rowTitle} numberOfLines={1}>{f.name}</Text>
                <Text style={s.rowSub}>{(extOf(f.name) || 'file').toUpperCase()}</Text>
              </View>
            </TouchableOpacity>
          ))
        ) : tab === 'music' ? (
          rows(data.music || [], (f: any, i: number) => (
            <TouchableOpacity key={i} style={s.row} onPress={() => Linking.openURL(`${baseUrl}${f.url}`)}>
              <Text style={s.rowIcon}>🎵</Text>
              <Text style={[s.rowTitle, { flex: 1 }]} numberOfLines={1}>{f.name}</Text>
            </TouchableOpacity>
          ))
        ) : (
          rows(data.links || [], (l: string, i: number) => (
            <TouchableOpacity key={i} style={s.row} onPress={() => Linking.openURL(l)}>
              <Text style={s.rowIcon}>🔗</Text>
              <Text style={[s.rowLink, { flex: 1 }]} numberOfLines={2}>{l}</Text>
            </TouchableOpacity>
          ))
        )}
      </View>
    </Modal>
  );
}

const hit = { top: 10, bottom: 10, left: 10, right: 10 };

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingTop: 42, paddingBottom: 12, paddingHorizontal: 10,
    backgroundColor: C.header,
  },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: C.text, fontSize: 16, fontWeight: '800' },
  sub: { color: C.muted, fontSize: 11.5, marginTop: 1 },
  tabs: {
    flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
    backgroundColor: C.sidebar,
  },
  tab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: 11, borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: C.accent },
  tabText: { color: C.muted, fontSize: 12.5, fontWeight: '700' },
  tabTextActive: { color: C.accent },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  rowIcon: { fontSize: 22 },
  rowTitle: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  rowSub: { color: C.muted, fontSize: 11.5, marginTop: 1 },
  rowLink: { color: C.accent, fontSize: 13.5 },
  empty: { color: C.muted, fontSize: 13.5, textAlign: 'center', marginTop: 40 },
});
