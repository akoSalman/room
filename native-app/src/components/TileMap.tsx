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
  clampZoom, pinchZoomDelta, zoomAbout, tilesUnavailable,
} from '../geo';

export type Marker = { at: LatLng; label: string; mine?: boolean; live?: boolean };

/** A press that moved less than this is a tap, not a drag. */
const TAP_SLOP = 6;
/** Two taps this far apart on screen are two taps, not a double tap. */
const DOUBLE_TAP_SLOP = 40;
const DOUBLE_TAP_MS = 300;

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
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  // Pinch is shown by scaling what is already drawn; the tiles for the new
  // zoom level are only fetched once the fingers lift. Re-tiling mid-pinch
  // would mean a round trip per frame.
  const [pinch, setPinch] = useState<{ scale: number; fx: number; fy: number } | null>(null);

  // One gesture at a time: a pinch that starts must not turn into a pan when
  // one finger lifts early, which used to fling the map sideways.
  const mode = useRef<'none' | 'pan' | 'pinch'>('none');
  const pinchStart = useRef({ dist: 0, fx: 0, fy: 0 });
  // The PanResponder is built once, so its handlers close over the FIRST
  // render's state forever. Anything they need to read at gesture time lives
  // in a ref instead — reading `pinch` here would always have found null.
  const liveScale = useRef(1);

  // Where the map sits on screen, so a touch's page coordinates can be turned
  // into map coordinates.
  //
  // `locationX` was used for this and is not trustworthy with two fingers: it
  // is measured against whichever view each touch actually landed on, and the
  // map is covered in tile <Image>s, so the two fingers were routinely
  // reporting positions in two different coordinate spaces. The midpoint of
  // those is meaningless, which is why zooming drifted away from the fingers.
  const wrapRef = useRef<View>(null);
  const origin = useRef({ x: 0, y: 0 });
  const measure = () => {
    wrapRef.current?.measureInWindow?.((x: number, y: number) => {
      if (typeof x === 'number' && typeof y === 'number') origin.current = { x, y };
    });
  };

  // What the parent has been told so far during THIS gesture. Props arrive a
  // render later, so `zoomRef`/`centerRef` are stale the moment a pinch
  // commits a level mid-gesture; compounding off stale values sent the map
  // somewhere else entirely.
  const applied = useRef({ zoom, center });
  // The fractional zoom the pinch started from, so the whole gesture is
  // measured from one fixed baseline instead of from wherever it got to.
  const pinchBase = useRef(zoom);
  // The previous tap, for spotting a double tap.
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);

  // Whether the pictures are arriving at all.
  //
  // A map whose tiles never load is a grey rectangle that does not move when
  // you push it — which is indistinguishable from a map that ignores your
  // fingers, and was reported as exactly that three times running. The
  // gestures were never the problem. Saying so on the map is what turns this
  // into something anybody can see at a glance.
  const [tileCounts, setTileCounts] = useState({ loaded: 0, failed: 0 });
  const noTiles = tilesUnavailable(tileCounts);

  const touchDistance = (touches: any[]) => {
    const dx = touches[0].pageX - touches[1].pageX;
    const dy = touches[0].pageY - touches[1].pageY;
    return Math.sqrt(dx * dx + dy * dy) || 1;
  };
  // Focal point in the map's own coordinates, not the screen's.
  const touchFocal = (touches: any[]) => ({
    x: (touches[0].pageX + touches[1].pageX) / 2 - origin.current.x,
    y: (touches[0].pageY + touches[1].pageY) / 2 - origin.current.y,
  });

  /**
   * Move to a new zoom level immediately, keeping `focal` over the same place.
   *
   * Zoom used to be applied only when the fingers lifted, so during the pinch
   * the user was looking at a stretched copy of the old tiles and the real
   * detail appeared as a jump at the end. Committing as each level is crossed
   * means the map sharpens as the fingers move, which is what a map is
   * expected to do.
   */
  const applyZoom = (next: number, focal: { x: number; y: number }) => {
    const { width: w, height: h } = sizeRef.current;
    const from = applied.current;
    if (next === from.zoom) return;
    const c = zoomAbout(from.center, from.zoom, next, focal, w, h);
    applied.current = { zoom: next, center: c };
    onCenterChange?.(c);
    onZoomChange?.(next);
  };

  const pan = useRef(
    PanResponder.create({
      // Two fingers down is a pinch immediately — waiting for movement lets
      // an ancestor list claim the gesture first.
      onStartShouldSetPanResponderCapture: (e) =>
        interactive && e.nativeEvent.touches.length === 2,
      onMoveShouldSetPanResponderCapture: (e, g) =>
        interactive && (e.nativeEvent.touches.length === 2
          || Math.abs(g.dx) > 3 || Math.abs(g.dy) > 3),
      // Once the map has the gesture it keeps it. Without this the message
      // list underneath reclaims the drag and the map never moves — which is
      // exactly why dragging appeared to do nothing.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,

      onPanResponderGrant: (e) => {
        measure();
        applied.current = { zoom: zoomRef.current, center: centerRef.current };
        const t = e.nativeEvent.touches;
        if (t.length === 2) {
          mode.current = 'pinch';
          const f = touchFocal(t);
          pinchStart.current = { dist: touchDistance(t), fx: f.x, fy: f.y };
          pinchBase.current = zoomRef.current;
          liveScale.current = 1;
          setPinch({ scale: 1, fx: f.x, fy: f.y });
        } else {
          mode.current = 'pan';
        }
      },

      onPanResponderMove: (e, g) => {
        const t = e.nativeEvent.touches;
        if (t.length >= 2) {
          // A second finger landing mid-drag switches to pinching.
          if (mode.current !== 'pinch') {
            mode.current = 'pinch';
            const f = touchFocal(t);
            pinchStart.current = { dist: touchDistance(t), fx: f.x, fy: f.y };
            pinchBase.current = applied.current.zoom;
            liveScale.current = 1;
            setDragOffset({ x: 0, y: 0 });
          }
          const p = pinchStart.current;
          const scale = touchDistance(t) / p.dist;
          liveScale.current = scale;

          // Cross a zoom level and take it NOW, rather than saving the whole
          // gesture for the release. Small pinches used to do nothing at all,
          // because the level was rounded and anything short of a full 2x
          // rounded back to where it started.
          const want = clampZoom(pinchBase.current + pinchZoomDelta(scale));
          if (want !== applied.current.zoom) {
            applyZoom(want, { x: p.fx, y: p.fy });
          }
          // Whatever is left over after the levels already taken. Keeping this
          // as the visible scale is what stops the map jumping each time a
          // level commits — the tiles get sharper, nothing moves.
          const residual = scale / Math.pow(2, applied.current.zoom - pinchBase.current);
          setPinch({ scale: residual, fx: p.fx, fy: p.fy });
          return;
        }
        if (mode.current === 'pan') setDragOffset({ x: g.dx, y: g.dy });
      },

      onPanResponderRelease: (e, g) => {
        // Double tap zooms in, about the spot that was tapped — the ordinary
        // one-handed way to zoom a map, and the only one available while
        // holding a phone in one hand.
        //
        // Recognised here rather than with a Touchable, because the map has to
        // keep the responder for panning; a Touchable layered over it would
        // take the drag away.
        const moved = Math.abs(g.dx) > TAP_SLOP || Math.abs(g.dy) > TAP_SLOP;
        if (mode.current === 'pan' && !moved) {
          const now = Date.now();
          const at = {
            x: e.nativeEvent.pageX - origin.current.x,
            y: e.nativeEvent.pageY - origin.current.y,
          };
          const prev = lastTap.current;
          const near = prev
            && Math.abs(at.x - prev.x) < DOUBLE_TAP_SLOP
            && Math.abs(at.y - prev.y) < DOUBLE_TAP_SLOP;
          if (prev && near && now - prev.at < DOUBLE_TAP_MS) {
            lastTap.current = null;
            applyZoom(clampZoom(applied.current.zoom + 1), at);
            mode.current = 'none';
            setDragOffset({ x: 0, y: 0 });
            return;
          }
          lastTap.current = { x: at.x, y: at.y, at: now };
          mode.current = 'none';
          setDragOffset({ x: 0, y: 0 });
          return;
        }
        if (mode.current === 'pinch') {
          // Any final part-level is decided here: half a level up rounds up,
          // so a deliberate small pinch is not silently discarded.
          const p = pinchStart.current;
          const want = clampZoom(pinchBase.current + pinchZoomDelta(liveScale.current));
          if (want !== applied.current.zoom) applyZoom(want, { x: p.fx, y: p.fy });
        } else if (mode.current === 'pan') {
          onCenterChange?.(panCenter(applied.current.center, applied.current.zoom, g.dx, g.dy));
        }
        mode.current = 'none';
        liveScale.current = 1;
        setDragOffset({ x: 0, y: 0 });
        setPinch(null);
      },

      onPanResponderTerminate: () => {
        mode.current = 'none';
        liveScale.current = 1;
        setDragOffset({ x: 0, y: 0 });
        setPinch(null);
      },
    }),
  ).current;

  // Scaling about the fingers rather than the middle of the view: shift the
  // focal point to the centre, scale, shift it back.
  const pinchTransform: any[] | undefined = pinch
    ? [
        { translateX: pinch.fx - width / 2 },
        { translateY: pinch.fy - height / 2 },
        { scale: pinch.scale },
        { translateX: -(pinch.fx - width / 2) },
        { translateY: -(pinch.fy - height / 2) },
      ]
    : undefined;

  const tiles = useMemo(
    () => tilesForViewport(center, zoom, width, height),
    [center.lat, center.lng, zoom, width, height],
  );

  return (
    <View
      ref={wrapRef}
      onLayout={measure}
      style={[s.wrap, { width, height }]}
      {...(interactive ? pan.panHandlers : {})}
    >
      {/* Tiles and markers scale together during a pinch, so the pins stay on
          the streets they belong to while the fingers are still moving. */}
      <View style={[StyleSheet.absoluteFill, pinchTransform ? { transform: pinchTransform } : null]}>
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
            onLoad={() => setTileCounts(c => (c.loaded > 0 ? c : { ...c, loaded: c.loaded + 1 }))}
            onError={() => setTileCounts(c => ({ ...c, failed: c.failed + 1 }))}
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
      </View>

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

      {/* Said plainly, over the map, when no picture has arrived. Without
          this the map is a grey rectangle that does not respond to being
          pushed — which is not what is wrong with it, and is the wrong thing
          to go looking for. It takes no touches, so the map underneath can
          still be panned while it is up. */}
      {noTiles && (
        <View style={s.noTiles} pointerEvents="none">
          <Ionicons name="cloud-offline-outline" size={22} color="#334155" />
          <Text style={s.noTilesText}>Map images could not be loaded</Text>
          <Text style={s.noTilesHint}>The map still moves — it just has nothing to draw.</Text>
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
  noTiles: {
    position: 'absolute', left: 16, right: 16, top: '40%',
    alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 10, padding: 12,
  },
  noTilesText: { fontSize: 13, fontWeight: '700', color: '#0f172a', textAlign: 'center' },
  noTilesHint: { fontSize: 11.5, color: '#475569', textAlign: 'center' },
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
