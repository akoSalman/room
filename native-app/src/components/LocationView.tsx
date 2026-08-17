// Fullscreen map for a location message: the shared pin, everyone else who is
// sharing live in the same chat, and how far away each of them is.
import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions, Linking, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import TileMap, { Marker } from './TileMap';
import {
  LatLng, LocationPayload, distanceMeters, formatDistance, formatCoords,
  formatRemaining, isLiveNow, geoUri, webMapUrl, centerOf, zoomToFit, dedupePins,
} from '../geo';
import { currentPosition, ensurePermission } from '../locationManager';

export type LocationPin = {
  id: number | string;
  username: string;
  payload: LocationPayload;
  mine: boolean;
};

export default function LocationView({
  pins, focusId, onClose,
}: {
  pins: LocationPin[];
  focusId: number | string | null;
  onClose: () => void;
}) {
  const win = Dimensions.get('window');
  const W = win.width;
  const H = win.height;

  const focus = pins.find(p => String(p.id) === String(focusId)) || pins[0];
  const [me, setMe] = useState<LatLng | null>(null);
  const [center, setCenter] = useState<LatLng>(
    focus ? { lat: focus.payload.lat, lng: focus.payload.lng } : { lat: 0, lng: 0 },
  );
  const [zoom, setZoom] = useState(15);
  const [now, setNow] = useState(Date.now());

  // Keep "12m left" honest without re-rendering constantly.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);

  // Where the viewer is, so distances mean something.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!(await ensurePermission())) return;
      const p = await currentPosition();
      if (alive && p) setMe({ lat: p.lat, lng: p.lng });
    })();
    return () => { alive = false; };
  }, []);

  // One pin per person. Without this, every live share the user had ever
  // started left its own frozen "You" behind once it expired, so the map ended
  // up with two or three of them standing in different places.
  const shown = useMemo(
    () => dedupePins(pins, focusId, now),
    [pins, focusId, now],
  );

  const markers: Marker[] = useMemo(() => {
    const list: Marker[] = shown.map(p => ({
      at: { lat: p.payload.lat, lng: p.payload.lng },
      label: p.mine ? 'You' : p.username,
      mine: p.mine,
      live: isLiveNow(p.payload, now),
    }));
    // Where the viewer actually is, which is a different fact from any pin
    // they have shared — but only worth a marker of its own when no live share
    // of theirs is already saying the same thing.
    const liveMine = shown.some(p => p.mine && isLiveNow(p.payload, now));
    if (me && !liveMine) list.push({ at: me, label: 'Your position', mine: true });
    return list;
  }, [shown, me, now]);

  function fitAll() {
    const points = markers.map(m => m.at);
    if (!points.length) return;
    setCenter(centerOf(points));
    setZoom(zoomToFit(points, W, H * 0.7));
  }

  if (!focus) return null;

  const focusAt = { lat: focus.payload.lat, lng: focus.payload.lng };
  const live = isLiveNow(focus.payload, now);

  return (
    <View style={s.full}>
      <TileMap
        center={center}
        zoom={zoom}
        markers={markers}
        width={W}
        height={H}
        onCenterChange={setCenter}
        onZoomChange={setZoom}
      />

      <View style={s.topBar}>
        <TouchableOpacity onPress={onClose} style={s.iconBtn} hitSlop={hit}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.title} numberOfLines={1}>
            {focus.mine ? 'Your location' : `${focus.username}'s location`}
          </Text>
          <Text style={s.sub} numberOfLines={1}>
            {live
              ? `● Live · ${formatRemaining(focus.payload.liveUntil || 0, now)}`
              : formatCoords(focusAt)}
          </Text>
        </View>
        <TouchableOpacity onPress={fitAll} style={s.iconBtn} hitSlop={hit}>
          <Ionicons name="scan-outline" size={22} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { setCenter(focusAt); setZoom(16); }}
          style={s.iconBtn}
          hitSlop={hit}
        >
          <Ionicons name="locate" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <View style={s.sheet}>
        {/* Everyone on this map, and how far away they are. */}
        <ScrollView style={{ maxHeight: 168 }} showsVerticalScrollIndicator={false}>
          {shown.map(p => {
            const at = { lat: p.payload.lat, lng: p.payload.lng };
            const away = me ? distanceMeters(me, at) : null;
            const isLive = isLiveNow(p.payload, now);
            return (
              <TouchableOpacity
                key={String(p.id)}
                style={s.row}
                onPress={() => { setCenter(at); setZoom(16); }}
              >
                <View style={[s.dot, p.mine && s.dotMine, isLive && s.dotLive]} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.rowName} numberOfLines={1}>
                    {p.mine ? 'You' : p.username}
                    {isLive ? '  ·  live' : ''}
                  </Text>
                  <Text style={s.rowSub} numberOfLines={1}>
                    {away != null ? `${formatDistance(away)} away` : formatCoords(at)}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={C.muted} />
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={s.actions}>
          <TouchableOpacity
            style={s.action}
            onPress={() => Linking.openURL(geoUri(focusAt, focus.username)).catch(
              () => Linking.openURL(webMapUrl(focusAt)).catch(() => {}))}
          >
            <Ionicons name="navigate-outline" size={18} color="#fff" />
            <Text style={s.actionText}>Open in Maps</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const hit = { top: 8, bottom: 8, left: 8, right: 8 };

const s = StyleSheet.create({
  full: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000', zIndex: 70 },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingTop: 44, paddingHorizontal: 10, paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  title: { color: '#fff', fontSize: 15, fontWeight: '700' },
  sub: { color: '#94a3b8', fontSize: 11.5, marginTop: 2 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },

  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: C.sidebar, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    paddingTop: 12, paddingBottom: 26, paddingHorizontal: 14,
    borderTopWidth: 1, borderTopColor: C.border,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 10 },
  dot: { width: 11, height: 11, borderRadius: 6, backgroundColor: '#ef4444' },
  dotMine: { backgroundColor: C.accent },
  dotLive: { backgroundColor: '#22c55e' },
  rowName: { color: C.text, fontSize: 14.5, fontWeight: '700' },
  rowSub: { color: C.muted, fontSize: 12, marginTop: 1 },

  actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  action: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12,
  },
  actionText: { color: '#fff', fontSize: 14.5, fontWeight: '700' },
});
