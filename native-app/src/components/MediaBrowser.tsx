// ── Shared media browser ─────────────────────────────────────────────────────
//
// Rebuilt. The old one was reported as lagging constantly, scrolling by itself,
// and reloading the whole room every time it was opened. The rules behind the
// rebuild live in ../roomMedia.ts, with the reasoning; this file is what they
// look like on screen. Three things are different in kind, not degree:
//
//  • ONE TAB IS ALIVE AT A TIME. The four tabs used to be four lists built
//    fresh on every render — including every render caused by opening the
//    little action menu — and all four stayed mounted whether or not they had
//    ever been looked at. Now the pager holds four slots, a slot builds its
//    list the first time it is visited, and each is memoised so a re-render of
//    the browser is not a re-render of hundreds of thumbnails.
//
//  • THE GRID IS ROWS. `numColumns` leaves the list measuring as it scrolls.
//    Rows of three have one known height, so `getItemLayout` is exact: no
//    measuring, no drift, and scrolling to a photo lands ON that photo.
//
//  • PHOTOS ARRIVE A PAGE AT A TIME, and what has arrived is remembered
//    between opens.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, FlatList, Image,
  ActivityIndicator, useWindowDimensions, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { fileIcon, extOf } from '../mime';
import {
  MediaItem, MediaTab, MediaState,
  toRows, rowOf, cellSize, shouldLoadMore, restoreToken, shouldRestore,
} from '../roomMedia';

export type { MediaItem, MediaTab } from '../roomMedia';
export type MediaAction = 'open' | 'download' | 'share' | 'showInChat';

const COLS = 3;
const GAP = 2;
const TABS: [MediaTab, string, string][] = [
  ['images', 'Photos', 'image-outline'],
  ['files', 'Files', 'document-outline'],
  ['music', 'Audio', 'musical-notes-outline'],
  ['links', 'Links', 'link-outline'],
];

/**
 * One thumbnail.
 *
 * Memoised on its own so that scrolling, opening the menu, or another page of
 * photos arriving does not re-render the ones already on screen — the single
 * biggest cause of the lag. A plain <Image> over a dark square: at 96px a
 * spinner and a fade cost more than they are worth, and the square is already
 * the placeholder.
 */
const Cell = memo(function Cell({ item, index, size, marginRight, thumb, onOpen, onMenu }: {
  item: MediaItem;
  index: number;
  size: number;
  marginRight: number;
  thumb: (path: string, w: number) => string;
  onOpen: (index: number) => void;
  onMenu: (item: MediaItem) => void;
}) {
  return (
    <Pressable
      onPress={() => onOpen(index)}
      onLongPress={() => onMenu(item)}
      delayLongPress={300}
      style={{ width: size, height: size, marginRight }}
    >
      {/* The SMALLEST thumbnail the server offers: a cell is ~130px, so asking
          for more only makes the grid slower to fill. */}
      <Image
        source={{ uri: thumb(item.url, 96) }}
        style={{ width: size, height: size, backgroundColor: '#0e1116' }}
        resizeMode="cover"
      />
    </Pressable>
  );
});

const Row = memo(function Row({ row, first, size, thumb, onOpen, onMenu }: {
  row: MediaItem[];
  /** Index of this row's first photo in the whole list. */
  first: number;
  size: number;
  thumb: (path: string, w: number) => string;
  onOpen: (index: number) => void;
  onMenu: (item: MediaItem) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', marginBottom: GAP }}>
      {row.map((item, i) => (
        <Cell
          key={item.url}
          item={item}
          index={first + i}
          size={size}
          marginRight={i === COLS - 1 ? 0 : GAP}
          thumb={thumb}
          onOpen={onOpen}
          onMenu={onMenu}
        />
      ))}
    </View>
  );
});

function ListRow({ item, icon, sub, onOpen, onMenu }: {
  item: MediaItem;
  icon: string;
  sub: string;
  onOpen: (i: MediaItem) => void;
  onMenu: (i: MediaItem) => void;
}) {
  return (
    <Pressable style={s.row} onPress={() => onOpen(item)} onLongPress={() => onMenu(item)} delayLongPress={300}>
      <Text style={s.rowIcon}>{icon}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{item.name || item.url}</Text>
        <Text style={s.rowSub} numberOfLines={1}>{sub}</Text>
      </View>
      {/* A real button, not decoration: tapping the dots used to fall through
          to the row and just open the file. */}
      <Pressable onPress={() => onMenu(item)} hitSlop={hit} style={s.rowMore}>
        <Ionicons name="ellipsis-vertical" size={18} color={C.muted} />
      </Pressable>
    </Pressable>
  );
}

export default function MediaBrowser({
  visible, title, state, tab, onTab, onClose, onOpenImage, onLoadMore, loadingMore,
  thumbUrl, focusIndex, openId, baseUrl, onAction,
}: {
  visible: boolean;
  title: string;
  /** Null while the first page is still on its way. */
  state: MediaState | null;
  tab: MediaTab;
  onTab: (t: MediaTab) => void;
  onClose: () => void;
  onOpenImage: (index: number, all: string[]) => void;
  /** Ask for the next page of photos. */
  onLoadMore: () => void;
  loadingMore: boolean;
  thumbUrl: (path: string, w: number) => string;
  /** Photo to land on when reopening, and which open this is. */
  focusIndex: number;
  openId: number;
  baseUrl: string;
  onAction: (action: MediaAction, item: MediaItem) => void;
}) {
  const { width: W } = useWindowDimensions();
  const cell = cellSize(W, COLS, GAP);
  const gridRef = useRef<FlatList>(null);
  const pagerRef = useRef<FlatList>(null);
  const [menuFor, setMenuFor] = useState<MediaItem | null>(null);

  const images = state?.images || [];
  const files = state?.files || [];
  const music = state?.music || [];
  const links = state?.links || [];

  const rows = useMemo(() => toRows(images, COLS), [images]);
  const fullUrls = useMemo(() => images.map(i => `${baseUrl}${i.url}`), [images, baseUrl]);

  const tabIndex = Math.max(0, TABS.findIndex(t => t[0] === tab));

  // A tab's list is built the first time that tab is looked at, and kept from
  // then on. Building all four up front is work for three screens nobody has
  // asked to see, on the very open the user is waiting through.
  const [visited, setVisited] = useState<Set<MediaTab>>(() => new Set(['images'] as MediaTab[]));
  useEffect(() => {
    if (!visible) return;
    setVisited(prev => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab, visible]);

  // Keep the pager and the tab bar in step when a tab is TAPPED. Driven by the
  // tab index alone: adding the width or the visibility here is what let a
  // re-render slide the pager under a finger already swiping it.
  const lastPaged = useRef(-1);
  useEffect(() => {
    if (!visible) { lastPaged.current = -1; return; }
    if (lastPaged.current === tabIndex) return;
    lastPaged.current = tabIndex;
    pagerRef.current?.scrollToOffset({ offset: tabIndex * W, animated: true });
  }, [tabIndex, visible]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Land back on the photo the viewer was closed from — exactly once for this
  // open, and never because something else re-rendered.
  const restoreDone = useRef<string | null>(null);
  const token = restoreToken({ visible, openId, tab, focusIndex });
  useEffect(() => {
    if (!shouldRestore(token, restoreDone.current)) return;
    if (!rows.length) return;                      // nothing to scroll yet
    const row = Math.min(rowOf(focusIndex, COLS), rows.length - 1);
    restoreDone.current = token;
    // Row heights are exact, so this lands on the row rather than near it.
    try { gridRef.current?.scrollToIndex({ index: row, animated: false }); } catch {}
  }, [token, rows.length, focusIndex]);

  // Both handlers are STABLE, so that a page of photos arriving does not
  // re-render the rows already on screen. Read through refs rather than
  // closed over, because the whole point is that their identity never changes.
  const openRef = useRef(onOpenImage);
  openRef.current = onOpenImage;
  const urlsRef = useRef(fullUrls);
  urlsRef.current = fullUrls;
  const openImage = useCallback((index: number) => openRef.current(index, urlsRef.current), []);
  const openMenu = useCallback((item: MediaItem) => setMenuFor(item), []);

  const renderRow = useCallback(({ item, index }: { item: MediaItem[]; index: number }) => (
    <Row row={item} first={index * COLS} size={cell} thumb={thumbUrl} onOpen={openImage} onMenu={openMenu} />
  ), [cell, thumbUrl, openImage, openMenu]);   // cell changes only on rotation

  const rowHeight = cell + GAP;
  const getItemLayout = useCallback(
    (_: any, index: number) => ({ length: rowHeight, offset: rowHeight * index, index }),
    [rowHeight],
  );

  const photos = (
    <FlatList
      ref={gridRef}
      data={rows}
      style={{ width: W }}
      // Rows never change identity, so the first photo of a row identifies it.
      keyExtractor={(r) => r[0]?.url || 'empty'}
      renderItem={renderRow}
      getItemLayout={getItemLayout}
      initialNumToRender={8}
      maxToRenderPerBatch={6}
      windowSize={5}
      removeClippedSubviews
      onEndReachedThreshold={1.2}
      onEndReached={() => {
        if (shouldLoadMore({ hasMore: !!state?.imagesHasMore, loading: loadingMore, itemCount: images.length })) {
          onLoadMore();
        }
      }}
      ListEmptyComponent={<Text style={s.empty}>No photos yet</Text>}
      ListFooterComponent={
        loadingMore ? <ActivityIndicator color={C.accent} style={{ marginVertical: 18 }} /> : null
      }
    />
  );

  const simpleList = (items: MediaItem[], icon: (i: MediaItem) => string, sub: (i: MediaItem) => string, empty: string) => (
    <FlatList
      data={items}
      style={{ width: W }}
      keyExtractor={(i, n) => `${i.url}#${n}`}
      renderItem={({ item }) => (
        <ListRow item={item} icon={icon(item)} sub={sub(item)}
          onOpen={(it) => onAction('open', it)} onMenu={openMenu} />
      )}
      initialNumToRender={14}
      windowSize={5}
      removeClippedSubviews
      ListEmptyComponent={<Text style={s.empty}>{empty}</Text>}
      contentContainerStyle={{ paddingBottom: 30 }}
    />
  );

  function page(key: MediaTab) {
    // Not visited yet: an empty slot of the right width so the pager still
    // measures correctly, and nothing rendered into it.
    if (!visited.has(key)) return <View style={{ width: W }} />;
    if (key === 'images') return photos;
    if (key === 'files') {
      return simpleList(files, i => fileIcon(i.name || '', null),
        i => (extOf(i.name || '') || 'file').toUpperCase(), 'No files yet');
    }
    if (key === 'music') return simpleList(music, () => '🎵', () => 'Audio', 'No audio yet');
    return simpleList(links, () => '🔗', i => i.url, 'No links yet');
  }

  const counts: Record<MediaTab, number> = {
    images: images.length, files: files.length, music: music.length, links: links.length,
  };
  // "loaded so far" while there is more to come, rather than a total the
  // gallery has not actually seen.
  const countLabel =
    tab === 'images'
      ? `${images.length}${state?.imagesHasMore ? '+' : ''} photo${images.length === 1 ? '' : 's'}`
      : tab === 'files' ? `${files.length} file${files.length === 1 ? '' : 's'}`
      : tab === 'music' ? `${music.length} audio file${music.length === 1 ? '' : 's'}`
      : `${links.length} link${links.length === 1 ? '' : 's'}`;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.screen}>
        <View style={s.header}>
          <TouchableOpacity onPress={onClose} style={s.iconBtn} hitSlop={hit}>
            <Ionicons name="arrow-back" size={24} color={C.text} />
          </TouchableOpacity>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.title} numberOfLines={1}>{title}</Text>
            <Text style={s.sub}>{countLabel}</Text>
          </View>
        </View>

        <View style={s.tabs}>
          {TABS.map(([key, label, icon]) => (
            <TouchableOpacity key={key} style={[s.tab, tab === key && s.tabActive]} onPress={() => onTab(key)}>
              <Ionicons name={icon as any} size={16} color={tab === key ? C.accent : C.muted} />
              <Text style={[s.tabText, tab === key && s.tabTextActive]}>{label}</Text>
              {counts[key] > 0 && (
                <Text style={[s.tabCount, tab === key && s.tabTextActive]}>{counts[key]}</Text>
              )}
            </TouchableOpacity>
          ))}
        </View>

        {!state ? (
          <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} />
        ) : (
          // The pager: swipe between tabs, and tell the tab bar where we landed.
          <FlatList
            ref={pagerRef}
            data={TABS}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(t) => t[0]}
            renderItem={({ item }) => page(item[0])}
            getItemLayout={(_, index) => ({ length: W, offset: W * index, index })}
            initialScrollIndex={tabIndex}
            onMomentumScrollEnd={(e) => {
              const i = Math.round(e.nativeEvent.contentOffset.x / W);
              const next = TABS[i]?.[0];
              // Record where the swipe landed so the effect above does not
              // then animate the pager to where it already is.
              if (next && next !== tab) { lastPaged.current = i; onTab(next); }
            }}
          />
        )}

        {/* Per-item actions: what you can do with one photo or file. */}
        <Modal visible={!!menuFor} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
          <View style={s.overlay}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuFor(null)} />
            <View style={s.sheet}>
              <Text style={s.sheetTitle} numberOfLines={1}>{menuFor?.name || menuFor?.url || ''}</Text>
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

const hit = { top: 12, bottom: 12, left: 12, right: 12 };

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
  tabCount: { color: C.muted, fontSize: 10.5, fontWeight: '700' },
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
