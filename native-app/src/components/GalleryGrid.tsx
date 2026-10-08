// A polished multi-image layout for gallery messages: 1 big, 2 side-by-side,
// 3 with one tall + two stacked, 4 as a 2x2, and 5+ as a 2x2 with a "+N" tile.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import ImageWithSpinner from './ImageWithSpinner';
import { BLUR_RADIUS, BLUR_BUTTON, buttonCorner } from '../imageBlur';

const GAP = 3;
const MAX = 250; // overall width of the mosaic

export default function GalleryGrid({
  uris, onOpen, onFirstLoaded, onLongPress, cache, blurred, onToggleBlur, mine,
}: {
  uris: string[];
  onOpen: (index: number) => void;
  onLongPress?: () => void;   // opens the message menu, like any other bubble
  onFirstLoaded?: () => void;
  /** False for content that must not be kept on the device. */
  cache?: boolean;
  /**
   * The whole mosaic is covered or not, as one.
   *
   * A gallery is one message: the photos arrived together and are looked at
   * together. Covering them individually would mean several buttons on one
   * bubble and a tap that clears a corner of a picture, which is noise rather
   * than privacy.
   */
  blurred?: boolean;
  onToggleBlur?: () => void;
  mine?: boolean;
}) {
  const n = uris.length;
  const cell = (idx: number, w: number, h: number, extra?: number) => (
    <TouchableOpacity key={idx} activeOpacity={0.85}
        // Covered: a tap clears the whole mosaic and opens nothing.
        onPress={() => (blurred ? onToggleBlur?.() : onOpen(idx))}
        onLongPress={onLongPress} delayLongPress={350} style={{ width: w, height: h }}>
      <ImageWithSpinner
        uri={uris[idx]}
        cache={cache}
        style={{ width: w, height: h, borderRadius: 10 }}
        resizeMode="cover"
        onLoaded={idx === 0 ? onFirstLoaded : undefined}
        blurRadius={blurred ? BLUR_RADIUS : 0}
      />
      {extra ? (
        <View style={[s.moreOverlay, { width: w, height: h }]}>
          <Text style={s.moreText}>+{extra}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );

  /**
   * One button for the whole mosaic, in the bottom corner on the bubble's
   * outer edge — left for your own, right for theirs.
   *
   * Outside every tile's tap target, so blurring never also opens a photo.
   */
  const button = onToggleBlur ? (
    <TouchableOpacity
      style={[s.blurBtn, buttonCorner(mine) === 'left' ? s.blurLeft : s.blurRight]}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={blurred ? 'Show these photos' : 'Blur these photos'}
      onPress={onToggleBlur}>
      <Text style={s.blurBtnText}>{BLUR_BUTTON}</Text>
    </TouchableOpacity>
  ) : null;

  if (n === 1) {
    return <View style={s.wrap}>{cell(0, MAX, MAX * 0.75)}{button}</View>;
  }
  if (n === 2) {
    const w = (MAX - GAP) / 2;
    return <View style={[s.wrap, s.row]}>{cell(0, w, w)}<View style={{ width: GAP }} />{cell(1, w, w)}{button}</View>;
  }
  if (n === 3) {
    const big = (MAX - GAP) * 0.62, small = MAX - GAP - big;
    return (
      <View style={[s.wrap, s.row]}>
        {cell(0, big, big)}
        <View style={{ width: GAP }} />
        <View>{cell(1, small, (big - GAP) / 2)}<View style={{ height: GAP }} />{cell(2, small, (big - GAP) / 2)}</View>
        {button}
      </View>
    );
  }
  // 4+ : 2x2 grid, last tile shows +N when there are more than 4
  const w = (MAX - GAP) / 2;
  const extra = n > 4 ? n - 4 : 0;
  return (
    <View style={s.wrap}>
      <View style={s.row}>{cell(0, w, w)}<View style={{ width: GAP }} />{cell(1, w, w)}</View>
      <View style={{ height: GAP }} />
      <View style={s.row}>{cell(2, w, w)}<View style={{ width: GAP }} />{cell(3, w, w, extra)}</View>
      {button}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { maxWidth: MAX },
  row: { flexDirection: 'row' },
  moreOverlay: {
    position: 'absolute', top: 0, left: 0, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center',
  },
  moreText: { color: '#fff', fontSize: 26, fontWeight: '800' },
  blurBtn: {
    position: 'absolute', bottom: 8,
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  blurLeft: { left: 8 },
  blurRight: { right: 8 },
  blurBtnText: { fontSize: 16, lineHeight: 20 },
});
