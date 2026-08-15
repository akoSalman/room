// ── Shared media browser ─────────────────────────────────────────────────────
//
// Fullscreen, like a phone's own gallery. Four tabs — Photos, Files, Audio,
// Links — which SWIPE between each other as well as responding to the tab bar,
// because a tab strip that cannot be swiped feels broken on a phone.
//
// Keeping your place: opening a photo from the middle of a long gallery and
// closing it used to drop you back at the top. The old code restored a saved
// scroll OFFSET from onContentSizeChange, which fires before the grid has laid
// out, so it was applied to a list that was not its final height yet and did
// nothing. This tracks the ITEM you were on and scrolls to that index, which
// does not depend on layout timing.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, FlatList,
  ActivityIndicator, Dimensions, Linking, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import ImageWithSpinner from './ImageWithSpinner';
import { fileIcon, extOf } from '../mime';

export type MediaTab = 'images' | 'files' | 'music' | 'links';

/** One thing in the browser, whichever tab it came from. */
export type MediaItem = {
  url: string;
  msgId?: number | string;
  name?: string;
  kind?: string;
};

export type MediaAction = 'open' | 'download' | 'share' | 'showInChat';

const COLS = 3;
const GAP = 2;
const TABS: [MediaTab, string, string][] = [
  ['images', 'Photos', 'image-outline'],
  ['files', 'Files', 'document-outline'],
  ['music', 'Audio', 'musical-notes-outline'],
  ['links', 'Links', 'link-outline'],
];

export default function MediaBrowser({
  visible, title, data, tab, onTab, onClose, onOpenImage, thumbUrl, focusIndex, baseUrl, onAction,
}: {
  visible: boolean;
  title: string;
  data: any;
  tab: MediaTab;
  onTab: (t: MediaTab) => void;
  onClose: () => void;
  onOpenImage: (index: number, all: string[]) => void;
  thumbUrl: (path: string, w: number) => string;
  focusIndex: number;
  baseUrl: string;
  onAction: (action: MediaAction, item: MediaItem) => void;
}) {
  const win = Dimensions.get('window');
  const W = win.width;
  const cell = Math.floor((W - GAP * (COLS - 1)) / COLS);
  const listRef = useRef<FlatList>(null);
  const pagerRef = useRef<FlatList>(null);
  // The item whose action sheet is open.
  const [menuFor, setMenuFor] = useState<MediaItem | null>(null);

  const images: MediaItem[] = useMemo(() => normalise(data?.images), [data]);
  const files: MediaItem[] = useMemo(() => normalise(data?.files), [data]);
  const music: MediaItem[] = useMemo(() => normalise(data?.music), [data]);
  const links: MediaItem[] = useMemo(() => normalise(data?.links), [data]);
  const fullUrls = useMemo(() => images.map(i => `${baseUrl}${i.url}`), [images, baseUrl]);

  const tabIndex = TABS.findIndex(t => t[0] === tab);

  // Keep the pager and the tab bar in step when the tab is changed by tapping.
  useEffect(() => {
    if (!visible || tabIndex < 0) return;
    pagerRef.current?.scrollToOffset({ offset: tabIndex * W, animated: true });
  }, [tabIndex, visible, W]);

  // Land on the photo the viewer was closed from.
  useEffect(() => {
    if (!visible || tab !== 'images') return;
    const row = Math.floor(focusIndex / COLS);
    if (row <= 0) return;
    const t = setTimeout(() => {
      listRef.current?.scrollToOffset({ offset: row * (cell + GAP), animated: false });
    }, 0);
    return () => clearTimeout(t);
  }, [visible, tab, focusIndex, cell]);

  const getItemLayout = useCallback(
    (_: any, index: number) => ({
      length: cell + GAP, offset: (cell + GAP) * Math.floor(index / COLS), index,
    }),
    [cell],
  );

  const renderImage = useCallback(({ item, index }: { item: MediaItem; index: number }) => (
    <Pressable
      onPress={() => onOpenImage(index, fullUrls)}
      onLongPress={() => setMenuFor(item)}
      delayLongPress={300}
      style={{ width: cell, height: cell, marginRight: (index + 1) % COLS ? GAP : 0, marginBottom: GAP }}
    >
      <ImageWithSpinner
        // The SMALLEST thumbnail the server offers. A grid cell is ~130px, so
        // asking for anything bigger just makes the gallery slower to fill —
        // which was the whole complaint.
        uri={thumbUrl(item.url, 96)}
        style={{ width: cell, height: cell, backgroundColor: '#111' }}
        resizeMode="cover"
      />
    </Pressable>
  ), [cell, fullUrls, onOpenImage, thumbUrl]);

  const listOf = (items: MediaItem[], icon: (i: MediaItem) => string, sub: (i: MediaItem) => string) => (
    <FlatList
      data={items}
      style={{ width: W }}
      keyExtractor={(_, i) => String(i)}
      renderItem={({ item }) => (
        <Pressable
          style={s.row}
          onPress={() => onAction('open', item)}
          onLongPress={() => setMenuFor(item)}
          delayLongPress={300}
        >
          <Text style={s.rowIcon}>{icon(item)}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.rowTitle} numberOfLines={1}>{item.name || item.url}</Text>
            <Text style={s.rowSub} numberOfLines={1}>{sub(item)}</Text>
          </View>
          {/* A real button, not decoration. Tapping the dots used to fall
              through to the row and just open the file. */}
          <Pressable
            onPress={() => setMenuFor(item)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={s.rowMore}
          >
            <Ionicons name="ellipsis-vertical" size={18} color={C.muted} />
          </Pressable>
        </Pressable>
      )}
      ListEmptyComponent={<Text style={s.empty}>Nothing here yet</Text>}
      contentContainerStyle={{ paddingBottom: 30 }}
    />
  );

  const pages = [
    <FlatList
      key="images"
      ref={listRef}
      data={images}
      style={{ width: W }}
      numColumns={COLS}
      keyExtractor={(_, i) => String(i)}
      renderItem={renderImage}
      getItemLayout={getItemLayout}
      initialNumToRender={21}
      windowSize={7}
      ListEmptyComponent={<Text style={s.empty}>No photos yet</Text>}
    />,
    <View key="files" style={{ width: W }}>
      {listOf(files, i => fileIcon(i.name || '', null), i => (extOf(i.name || '') || 'file').toUpperCase())}
    </View>,
    <View key="music" style={{ width: W }}>
      {listOf(music, () => '🎵', () => 'Audio')}
    </View>,
    <View key="links" style={{ width: W }}>
      {listOf(links, () => '🔗', i => i.url)}
    </View>,
  ];

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
                : tab === 'files' ? `${files.length} files`
                : tab === 'music' ? `${music.length} audio files`
                : `${links.length} links`}
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
        ) : (
          // The pager: swipe between tabs, and tell the tab bar where we landed.
          <FlatList
            ref={pagerRef}
            data={pages}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(_, i) => String(i)}
            renderItem={({ item }) => item as any}
            getItemLayout={(_, index) => ({ length: W, offset: W * index, index })}
            initialScrollIndex={Math.max(0, tabIndex)}
            onMomentumScrollEnd={(e) => {
              const i = Math.round(e.nativeEvent.contentOffset.x / W);
              const next = TABS[i]?.[0];
              if (next && next !== tab) onTab(next);
            }}
          />
        )}

        {/* Per-item actions: what you can do with one photo or file. */}
        <Modal visible={!!menuFor} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
          <View style={s.overlay}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuFor(null)} />
            <View style={s.sheet}>
              <Text style={s.sheetTitle} numberOfLines={1}>
                {menuFor?.name || menuFor?.url || ''}
              </Text>
              {([
                ['open', 'Open', 'open-outline'],
                ['showInChat', 'Show in chat', 'chatbubble-ellipses-outline'],
                ['download', 'Download', 'download-outline'],
                ['share', 'Share', 'share-social-outline'],
              ] as [MediaAction, string, string][]).map(([action, label, icon]) => (
                <TouchableOpacity
                  key={action}
                  style={s.sheetRow}
                  onPress={() => { const it = menuFor; setMenuFor(null); if (it) onAction(action, it); }}
                >
                  <Ionicons name={icon as any} size={19} color={C.accent} />
                  <Text style={s.sheetRowText}>{label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={s.sheetCancel} onPress={() => setMenuFor(null)}>
                <Text style={s.sheetCancelText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

/** The server used to send bare url strings; accept both shapes. */
function normalise(list: any): MediaItem[] {
  if (!Array.isArray(list)) return [];
  return list.map((x: any) => (typeof x === 'string' ? { url: x } : x)).filter(x => x && x.url);
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
  rowMore: { paddingHorizontal: 6, paddingVertical: 4 },
  rowTitle: { color: C.text, fontSize: 14.5, fontWeight: '600' },
  rowSub: { color: C.muted, fontSize: 11.5, marginTop: 1 },
  empty: { color: C.muted, fontSize: 13.5, textAlign: 'center', marginTop: 40 },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.sidebar, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingTop: 14, paddingBottom: 24, paddingHorizontal: 14,
  },
  sheetTitle: { color: C.muted, fontSize: 12.5, fontWeight: '700', paddingHorizontal: 6, paddingBottom: 8 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 6 },
  sheetRowText: { color: C.text, fontSize: 15, fontWeight: '600' },
  sheetCancel: { alignItems: 'center', paddingVertical: 12, marginTop: 6 },
  sheetCancelText: { color: C.muted, fontSize: 14.5, fontWeight: '700' },
});
