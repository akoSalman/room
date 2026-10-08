// ── Choosing where the pin goes, on a map ────────────────────────────────────
//
// Reported as: the location the app picks is sometimes not accurate.
//
// A phone's fix is a guess with an error bar, and indoors or on cell towers
// that error runs to hundreds of metres. So the pin is placed here, by hand,
// before anything is sent — starting on the fix, so that when the fix is fine
// the whole thing costs one tap.
//
// The pin does not move; the MAP does. A marker you drag with a finger is a
// marker your finger is covering at the moment you need to see it, and on a
// small screen it is fiddly to land precisely. A fixed crosshair in the middle
// of a map you push around is the pattern every map app settled on, and it
// gets more accurate the further you zoom in rather than less.
import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { C } from '../theme';
import TileMap from './TileMap';
import { LatLng, MAX_ZOOM } from '../geo';
import {
  Fix, PICK_ZOOM, openingView, chosenLabel, pinMoved,
} from '../locationPick';

export default function LocationPicker({
  visible, fix, locating, nearby, onCancel, onSend, onRecentre,
}: {
  visible: boolean;
  /** Where the phone thinks we are, or null if it could not say. */
  fix: Fix;
  /** Still waiting for a first fix. */
  locating: boolean;
  /** Places already pinned in this chat, to open near when there is no fix. */
  nearby?: LatLng[];
  onCancel: () => void;
  onSend: (chosen: LatLng) => void;
  /** Ask for a fresh fix. */
  onRecentre: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [center, setCenter] = useState<LatLng>(() => openingView(fix, nearby).center);
  const [zoom, setZoom] = useState(() => openingView(fix, nearby).zoom);
  // Once the user has pushed the map, a fix arriving late must not yank it
  // out from under them. Before that, the first fix is exactly what they are
  // waiting for.
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!visible) { setTouched(false); return; }
    const v = openingView(fix, nearby);
    setCenter(v.center);
    setZoom(v.zoom);
    // Only on opening: `fix` updates as the phone refines its position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible || touched || !fix) return;
    setCenter({ lat: fix.lat, lng: fix.lng });
    setZoom(z => (z < PICK_ZOOM ? PICK_ZOOM : z));
  }, [fix, visible, touched]);

  const moved = pinMoved(fix, center);
  const mapHeight = Math.max(200, height - 190);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      {/* A Modal is a separate window on Android, and the root one at the top
          of the app does not reach inside it — so gestures in here need their
          own. Without it the map could not be dragged or pinched at all,
          which is what was reported four times. The photo viewer's Modal has
          had one all along, which is why pinching a photo has always worked
          and pinching the map never has. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={s.screen}>
        <View style={s.header}>
          <TouchableOpacity onPress={onCancel} style={s.iconBtn} hitSlop={hit}>
            <Ionicons name="close" size={24} color={C.text} />
          </TouchableOpacity>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.title}>Choose a location</Text>
            <Text style={s.sub}>Move the map to place the pin</Text>
          </View>
        </View>

        <View style={{ width, height: mapHeight }}>
          <TileMap
            center={center}
            zoom={zoom}
            width={width}
            height={mapHeight}
            // The fix is drawn as an ordinary marker so the two can be told
            // apart: the blue dot is where the phone thinks you are, the
            // crosshair is where the pin will land.
            markers={fix ? [{ at: { lat: fix.lat, lng: fix.lng }, label: 'You', mine: true }] : []}
            // The crosshair is the answer, so the crosshair is what must stay
            // still while zooming — otherwise a pinch moves the pin off the
            // place that was being aimed at.
            pinAtCentre
            onCenterChange={(c) => { setTouched(true); setCenter(c); }}
            onZoomChange={(z) => { setTouched(true); setZoom(z); }}
          />

          {/* The crosshair, dead centre and untouchable — the map slides under
              it. pointerEvents none, or it would eat the drags meant for the
              map beneath it. */}
          <View style={s.crossWrap} pointerEvents="none">
            <Ionicons name="location" size={40} color={C.danger} />
            {/* A dot at the exact point, because the pin's tip is what counts
                and a teardrop icon is drawn above its own anchor. */}
            <View style={s.crossDot} />
          </View>

          <TouchableOpacity style={s.recentre} onPress={() => { setTouched(false); onRecentre(); }}>
            {locating
              ? <ActivityIndicator size="small" color={C.accent} />
              : <Ionicons name="locate" size={20} color={moved ? C.accent : C.muted} />}
          </TouchableOpacity>
        </View>

        <View style={s.footer}>
          <Text style={s.label} numberOfLines={2}>{chosenLabel(fix, center)}</Text>
          {!fix && !locating && (
            <Text style={s.warn}>
              Your position is unknown, so the map could not start near you. Pan to the
              right place and send.
            </Text>
          )}
          <TouchableOpacity style={s.send} onPress={() => onSend(center)}>
            <Ionicons name="paper-plane" size={17} color="#fff" />
            <Text style={s.sendText}>Send this location</Text>
          </TouchableOpacity>
        </View>
      </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const hit = { top: 12, bottom: 12, left: 12, right: 12 };

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingTop: 42, paddingBottom: 12, paddingHorizontal: 10, backgroundColor: C.header,
  },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: C.text, fontSize: 16, fontWeight: '800' },
  sub: { color: C.muted, fontSize: 11.5, marginTop: 1 },
  crossWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
  },
  // The icon sits above its anchor point, so it is nudged up by half its own
  // height and the dot marks the spot it actually refers to.
  crossDot: {
    position: 'absolute', width: 8, height: 8, borderRadius: 4,
    backgroundColor: C.danger, borderWidth: 1.5, borderColor: '#fff',
    marginTop: 20,
  },
  recentre: {
    position: 'absolute', right: 14, bottom: 14, width: 44, height: 44, borderRadius: 22,
    backgroundColor: C.sidebar, borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center', elevation: 3,
  },
  footer: {
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 26, gap: 10,
    backgroundColor: C.header, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border,
  },
  label: { color: C.text, fontSize: 13.5, fontWeight: '600' },
  warn: { color: '#d97706', fontSize: 11.5 },
  send: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13,
  },
  sendText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
