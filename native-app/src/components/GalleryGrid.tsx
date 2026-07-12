// A polished multi-image layout for gallery messages: 1 big, 2 side-by-side,
// 3 with one tall + two stacked, 4 as a 2x2, and 5+ as a 2x2 with a "+N" tile.
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import ImageWithSpinner from './ImageWithSpinner';

const GAP = 3;
const MAX = 250; // overall width of the mosaic

export default function GalleryGrid({ uris, onOpen, onFirstLoaded }: {
  uris: string[];
  onOpen: (index: number) => void;
  onFirstLoaded?: () => void;
}) {
  const n = uris.length;
  const cell = (idx: number, w: number, h: number, extra?: number) => (
    <TouchableOpacity key={idx} activeOpacity={0.85} onPress={() => onOpen(idx)} style={{ width: w, height: h }}>
      <ImageWithSpinner
        uri={uris[idx]}
        style={{ width: w, height: h, borderRadius: 10 }}
        resizeMode="cover"
        onLoaded={idx === 0 ? onFirstLoaded : undefined}
      />
      {extra ? (
        <View style={[s.moreOverlay, { width: w, height: h }]}>
          <Text style={s.moreText}>+{extra}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );

  if (n === 1) {
    return <View style={s.wrap}>{cell(0, MAX, MAX * 0.75)}</View>;
  }
  if (n === 2) {
    const w = (MAX - GAP) / 2;
    return <View style={[s.wrap, s.row]}>{cell(0, w, w)}<View style={{ width: GAP }} />{cell(1, w, w)}</View>;
  }
  if (n === 3) {
    const big = (MAX - GAP) * 0.62, small = MAX - GAP - big;
    return (
      <View style={[s.wrap, s.row]}>
        {cell(0, big, big)}
        <View style={{ width: GAP }} />
        <View>{cell(1, small, (big - GAP) / 2)}<View style={{ height: GAP }} />{cell(2, small, (big - GAP) / 2)}</View>
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
});
