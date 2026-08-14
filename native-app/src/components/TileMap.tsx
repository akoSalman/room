// ── Map, drawn from raw OpenStreetMap tiles ──────────────────────────────────
//
// No react-native-maps: that needs a Google Maps API key wired into the native
// project, which is configuration that can only be verified by building. Tiles
// are ordinary images, so this works with no native map dependency at all — and
// the maths behind it (src/geo.ts) is unit tested, which a native map view
// never could be from here.
//
// Draggable, with zoom buttons and one marker per person.
import React, { useMemo, useRef, useState } from 'react';
import {
  View, Text, Image, StyleSheet, PanResponder, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import { BASE_URL } from '../api';
import {
  LatLng, TILE_SIZE, MIN_ZOOM, MAX_ZOOM,
  tilesForViewport, pointToScreen, panCenter, tileUrl,
} from '../geo';

export type Marker = { at: LatLng; label: string; mine?: boolean; live?: boolean };

export default function TileMap({
  center, zoom, markers, width, height, interactive = true, onCenterChange, onZoomChange,
}: {
  center: LatLng;
  zoom: number;
  markers: Marker[];
  width: number;
  height: number;
  interactive?: boolean;
  onCenterChange?: (c: LatLng) => void;
  onZoomChange?: (z: number) => void;
}) {
  // The live centre during a drag is kept in a ref: routing every frame through
  // React state would re-request tiles on every pixel of movement.
  const centerRef = useRef(center);
  centerRef.current = center;
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) =>
        interactive && (Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3),
      onPanResponderMove: (_, g) => setDragOffset({ x: g.dx, y: g.dy }),
      onPanResponderRelease: (_, g) => {
        setDragOffset({ x: 0, y: 0 });
        onCenterChange?.(panCenter(centerRef.current, zoom, g.dx, g.dy));
      },
      onPanResponderTerminate: () => setDragOffset({ x: 0, y: 0 }),
    }),
  ).current;

  const tiles = useMemo(
    () => tilesForViewport(center, zoom, width, height),
    [center.lat, center.lng, zoom, width, height],
  );

  return (
    <View style={[s.wrap, { width, height }]} {...(interactive ? pan.panHandlers : {})}>
      {/* Tiles */}
      <View style={StyleSheet.absoluteFill}>
        {tiles.map(t => (
          <Image
            key={`${t.z}/${t.x}/${t.y}`}
            source={{ uri: tileUrl(t.x, t.y, t.z, BASE_URL) }}
            style={{
              position: 'absolute',
              left: t.left + dragOffset.x,
              top: t.top + dragOffset.y,
              width: TILE_SIZE,
              height: TILE_SIZE,
            }}
          />
        ))}
      </View>

      {/* Markers */}
      {markers.map((m, i) => {
        const p = pointToScreen(m.at, center, zoom, width, height);
        const x = p.x + dragOffset.x;
        const y = p.y + dragOffset.y;
        // Skip anything well outside the viewport rather than piling up views.
        if (x < -80 || y < -80 || x > width + 80 || y > height + 80) return null;
        return (
          <View key={i} style={[s.marker, { left: x - 16, top: y - 38 }]} pointerEvents="none">
            <View style={[s.pin, m.mine && s.pinMine, m.live && s.pinLive]}>
              <Ionicons name={m.live ? 'navigate' : 'location'} size={17} color="#fff" />
            </View>
            <View style={[s.pinStem, m.mine && s.pinStemMine, m.live && s.pinStemLive]} />
            {!!m.label && (
              <Text style={s.markerLabel} numberOfLines={1}>{m.label}</Text>
            )}
          </View>
        );
      })}

      {interactive && (
        <View style={s.zoomCol}>
          <TouchableOpacity
            style={s.zoomBtn}
            onPress={() => onZoomChange?.(Math.min(MAX_ZOOM, zoom + 1))}
          >
            <Ionicons name="add" size={20} color={C.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.zoomBtn}
            onPress={() => onZoomChange?.(Math.max(MIN_ZOOM, zoom - 1))}
          >
            <Ionicons name="remove" size={20} color={C.text} />
          </TouchableOpacity>
        </View>
      )}

      {/* OpenStreetMap's licence requires attribution. */}
      <Text style={s.attribution}>© OpenStreetMap</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { overflow: 'hidden', backgroundColor: '#e8e6e1' },
  marker: { position: 'absolute', alignItems: 'center', width: 32 },
  pin: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: '#ef4444',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#fff',
  },
  pinMine: { backgroundColor: C.accent },
  pinLive: { backgroundColor: '#22c55e' },
  pinStem: { width: 2, height: 8, backgroundColor: '#ef4444' },
  pinStemMine: { backgroundColor: C.accent },
  pinStemLive: { backgroundColor: '#22c55e' },
  markerLabel: {
    marginTop: 2, maxWidth: 96, fontSize: 10.5, fontWeight: '700', color: '#0f172a',
    backgroundColor: 'rgba(255,255,255,0.88)', borderRadius: 4,
    paddingHorizontal: 4, paddingVertical: 1, overflow: 'hidden',
  },
  zoomCol: { position: 'absolute', right: 10, top: 10, gap: 6 },
  zoomBtn: {
    width: 34, height: 34, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center', justifyContent: 'center',
  },
  attribution: {
    position: 'absolute', right: 4, bottom: 2,
    fontSize: 8.5, color: '#334155', backgroundColor: 'rgba(255,255,255,0.7)',
    paddingHorizontal: 3, borderRadius: 3, overflow: 'hidden',
  },
});
