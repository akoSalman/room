// ── Editing a photo: crop, draw, add text ────────────────────────────────────
//
// Two ways out on purpose. A photo you are about to send should be editable and
// then SENT, without going back to find it again; a photo already in a chat
// should be editable and then sent onward or saved, because the reason to
// annotate one is almost always to give it to someone.
//
// How the result is produced depends on what was done to it:
//
//  • Crop only — expo-image-manipulator crops the ORIGINAL file, so an 8
//    megapixel photo stays 8 megapixel.
//  • Drawing or text — those exist only as views on screen, so the composite
//    has to be rasterised with react-native-view-shot, which captures at
//    screen resolution. Some detail is lost, and that is the honest trade for
//    annotation without a native canvas. Cropping is applied first so the
//    capture is of the cropped photo, not of a shrunken whole.
//
// If view-shot is missing from the build, drawing and text are hidden rather
// than offered and then failing at the last step.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, TextInput, TouchableOpacity, StyleSheet,
  PanResponder, ActivityIndicator, Alert, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImageManipulator from 'expo-image-manipulator';
import { C } from '../theme';
import {
  fitRect, clampCrop, toNaturalCrop, isWholeImage, strokeSegments, nextUndo,
  Rect, Size, Stroke, Point,
} from '../imageEditor';

// Loaded defensively: a build without the native module must lose the drawing
// tools, not crash the moment someone opens the editor.
let ViewShot: any = null;
let captureRef: any = null;
try {
  // The JS half of this package imports fine even when the native half is
  // missing — it only warns — so the native module is what actually gets
  // checked. Otherwise the tools would appear and fail at the last step.
  const { NativeModules } = require('react-native');
  if (NativeModules?.RNViewShot) {
    const mod = require('react-native-view-shot');
    ViewShot = mod.default || mod.ViewShot;
    captureRef = mod.captureRef;
  }
} catch {}

type Tool = 'crop' | 'pen' | 'text';

type TextItem = { id: number; text: string; x: number; y: number; color: string; seq: number };

const COLORS = ['#ffffff', '#111827', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6'];
const PEN_WIDTHS = [3, 6, 12];

export default function ImageEditor({
  uri, onCancel, onDone, sendLabel,
}: {
  uri: string;
  onCancel: () => void;
  /** Called with the edited file. `save` is what the user asked to do next. */
  onDone: (result: { uri: string; action: 'send' | 'save' | 'replace' }) => void;
  /** When set, a Send button is offered alongside Save. */
  sendLabel?: string;
}) {
  // Every APPLIED edit produces a real file, and they stack. The last entry is
  // what is on screen and what everything new is applied to.
  //
  // This is the fix for a crop that silently vanished. The picture on screen
  // was always the original, so the moment anything was drawn the export
  // photographed the UNCROPPED view and threw the cropped file away. Applying
  // a crop for real, and drawing on the result, is the only arrangement where
  // "crop, then draw, then crop again" means what it looks like it means.
  const [history, setHistory] = useState<string[]>([uri]);
  const working = history[history.length - 1];

  const [natural, setNatural] = useState<Size | null>(null);
  const [area, setArea] = useState<Size>({ width: 0, height: 0 });
  const [tool, setTool] = useState<Tool>('crop');
  const [busy, setBusy] = useState(false);

  const [crop, setCrop] = useState<Rect | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [texts, setTexts] = useState<TextItem[]>([]);
  const [color, setColor] = useState(COLORS[2]);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1]);
  const [typing, setTyping] = useState('');
  const [askText, setAskText] = useState(false);
  // One counter across strokes and captions, so undo can tell which of the two
  // was actually the most recent.
  const seq = useRef(0);

  const shotRef = useRef<any>(null);
  const drawing = useRef<Point[]>([]);
  const [live, setLive] = useState<Point[]>([]);

  // Re-measured for every applied version: a crop changes the picture's real
  // size, and every screen-to-pixel conversion after it depends on the new one.
  useEffect(() => {
    let alive = true;
    setNatural(null);
    Image.getSize(working,
      (width, height) => { if (alive) setNatural({ width, height }); },
      () => { if (alive) setNatural({ width: 1000, height: 1000 }); });
    return () => { alive = false; };
  }, [working]);

  const displayed = natural ? fitRect(natural, area) : null;

  // The crop box starts as the whole photo, so dragging a corner is the only
  // gesture needed to begin. It resets whenever the picture changes, since a
  // box measured against the previous version means nothing against this one.
  useEffect(() => { setCrop(null); }, [working]);
  useEffect(() => {
    if (displayed && displayed.width > 0 && !crop) setCrop({ ...displayed });
  }, [displayed?.width, displayed?.height, crop]);

  // ── Gestures ───────────────────────────────────────────────────────────────
  // Which corner is being dragged, decided once when the finger lands.
  const grab = useRef<{ corner: string; start: Rect } | null>(null);

  const cropPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const box = cropRef.current;
      const bounds = displayedRef.current;
      if (!box || !bounds) return;
      const { locationX: x, locationY: y } = e.nativeEvent;
      // Nearest corner within reach; otherwise the whole box moves.
      const near = (px: number, py: number) => Math.hypot(x - px, y - py) < 48;
      const corner =
        near(box.x, box.y) ? 'tl'
        : near(box.x + box.width, box.y) ? 'tr'
        : near(box.x, box.y + box.height) ? 'bl'
        : near(box.x + box.width, box.y + box.height) ? 'br'
        : 'move';
      grab.current = { corner, start: { ...box } };
    },
    onPanResponderMove: (_, g) => {
      const held = grab.current;
      const bounds = displayedRef.current;
      if (!held || !bounds) return;
      const s = held.start;
      let next: Rect;
      switch (held.corner) {
        case 'tl': next = { x: s.x + g.dx, y: s.y + g.dy, width: s.width - g.dx, height: s.height - g.dy }; break;
        case 'tr': next = { x: s.x, y: s.y + g.dy, width: s.width + g.dx, height: s.height - g.dy }; break;
        case 'bl': next = { x: s.x + g.dx, y: s.y, width: s.width - g.dx, height: s.height + g.dy }; break;
        case 'br': next = { x: s.x, y: s.y, width: s.width + g.dx, height: s.height + g.dy }; break;
        default: next = { ...s, x: s.x + g.dx, y: s.y + g.dy };
      }
      setCrop(clampCrop(next, bounds));
    },
    onPanResponderRelease: () => { grab.current = null; },
  })).current;

  const penPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      drawing.current = [{ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
      setLive(drawing.current.slice());
    },
    onPanResponderMove: (e) => {
      drawing.current.push({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
      setLive(drawing.current.slice());
    },
    onPanResponderRelease: () => {
      const points = drawing.current;
      drawing.current = [];
      setLive([]);
      if (points.length > 1) {
        seq.current += 1;
        setStrokes(prev => [...prev, {
          color: colorRef.current, width: widthRef.current, points, seq: seq.current,
        }]);
      }
    },
  })).current;

  // The PanResponders are built once, so anything they read at gesture time
  // has to come from a ref rather than from a closed-over render value.
  const cropRef = useRef<Rect | null>(null); cropRef.current = crop;
  const displayedRef = useRef<Rect | null>(null); displayedRef.current = displayed;
  const colorRef = useRef(color); colorRef.current = color;
  const widthRef = useRef(penWidth); widthRef.current = penWidth;

  const annotated = strokes.length > 0 || texts.length > 0;
  const cropped = !!(crop && displayed && !isWholeImage(crop, displayed));
  // Changes made since the last Apply.
  const pending = annotated || cropped;
  // Anything at all to save, applied or not.
  const touched = pending || history.length > 1;

  const step = nextUndo({
    lastStrokeSeq: strokes.length ? strokes[strokes.length - 1].seq : null,
    lastTextSeq: texts.length ? texts[texts.length - 1].seq : null,
    cropped,
    committed: history.length - 1,
  });

  function undo() {
    switch (step) {
      case 'text': setTexts(prev => prev.slice(0, -1)); break;
      case 'stroke': setStrokes(prev => prev.slice(0, -1)); break;
      case 'crop': if (displayed) setCrop({ ...displayed }); break;
      // Step back to the previous applied version. The crop box is dropped
      // with it; the effect on `working` puts a fresh one over the whole of
      // whatever we land on.
      case 'revert': setHistory(h => h.slice(0, -1)); break;
    }
  }

  /**
   * Turn the pending edits into a real image file.
   *
   * Order matters and is the whole point: the crop is applied to the file
   * first, and only then is the result photographed with the drawing on top.
   * Doing it the other way — which is what used to happen by accident —
   * captures the uncropped picture and loses the crop entirely.
   */
  async function rasterise(): Promise<string | null> {
    if (!natural || !displayed || !crop) return null;
    if (!pending) return working;

    // A crop is done on the FILE, so it keeps the photo's full resolution.
    // Switching tools flushes whatever is pending (see selectTool), so a crop
    // is never outstanding at the same time as a drawing — which matters,
    // because the capture below can only ever photograph what is on screen,
    // and on screen the crop has not happened yet.
    if (cropped) {
      const box = toNaturalCrop(crop, displayed, natural);
      const out = await ImageManipulator.manipulateAsync(
        working, [{ crop: { originX: box.x, originY: box.y, width: box.width, height: box.height } }],
        { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG },
      );
      return out.uri;
    }

    if (!captureRef || !shotRef.current) {
      Alert.alert('Not available', 'Drawing needs a newer version of the app.');
      return null;
    }
    // Captures the on-screen picture, so drawing and captions are burnt in.
    return await captureRef(shotRef.current, { format: 'jpg', quality: 0.95 });
  }

  /** Make the current edits permanent and start a fresh step on top. */
  async function apply(): Promise<boolean> {
    if (busy || !pending) return true;
    setBusy(true);
    try {
      const out = await rasterise();
      if (!out) return false;
      setHistory(h => [...h, out]);
      setCrop(null);
      setStrokes([]);
      setTexts([]);
      return true;
    } catch {
      Alert.alert('Could not edit', 'That change could not be applied.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Switching tool applies whatever the current one left outstanding.
   *
   * Not a convenience — it is what keeps a crop and a drawing from ever being
   * pending together. The exporter can crop a file or photograph the screen,
   * and the screen always shows the picture BEFORE the pending crop; so if
   * both were outstanding at once one of them would necessarily be lost. That
   * is precisely how the crop used to disappear the moment anything was drawn.
   */
  async function selectTool(next: Tool) {
    if (next === tool || busy) return;
    if (pending && !(await apply())) return;
    setTool(next);
  }

  async function finish(action: 'send' | 'save' | 'replace') {
    if (busy) return;
    setBusy(true);
    try {
      // Forgetting to press Apply must not silently throw the last edit away.
      // At most one kind of edit can be pending here, so one pass is enough.
      const out = pending ? await rasterise() : working;
      onDone({ uri: out || working, action });
    } catch {
      Alert.alert('Could not edit', 'The photo could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  // Only the picture itself is captured. The previous version wrapped the
  // whole canvas, which is letterboxed with black to fill the screen — so an
  // exported annotation came back padded with bars and at the wrong aspect
  // ratio. `collapsable={false}` is what guarantees the view survives as a
  // real native view for captureRef to photograph.
  const picture = displayed && (
    <View style={{
      position: 'absolute',
      left: displayed.x, top: displayed.y, width: displayed.width, height: displayed.height,
    }}>
      <View
        ref={shotRef}
        collapsable={false}
        style={StyleSheet.absoluteFill}
      >
          <Image source={{ uri: working }} style={StyleSheet.absoluteFill} resizeMode="contain" />

          {/* Finished strokes, then the one under the finger. */}
          {strokes.map((st, i) => (
            <React.Fragment key={`st${i}`}>
              {strokeSegments(st.points, st.width).map((sg, j) => (
                <View key={j} style={{
                  position: 'absolute', left: sg.x - displayed.x, top: sg.y - displayed.y,
                  width: sg.length, height: st.width, borderRadius: st.width / 2,
                  backgroundColor: st.color, transform: [{ rotate: `${sg.angle}deg` }],
                }} />
              ))}
            </React.Fragment>
          ))}
          {strokeSegments(live, penWidth).map((sg, j) => (
            <View key={`live${j}`} style={{
              position: 'absolute', left: sg.x - displayed.x, top: sg.y - displayed.y,
              width: sg.length, height: penWidth, borderRadius: penWidth / 2,
              backgroundColor: color, transform: [{ rotate: `${sg.angle}deg` }],
            }} />
          ))}

          {texts.map(t => (
            <Text key={t.id} style={[s.overlayText, {
              left: t.x - displayed.x, top: t.y - displayed.y, color: t.color,
            }]}>{t.text}</Text>
          ))}
      </View>
    </View>
  );

  const canvas = (
    <View style={s.canvas} onLayout={e => setArea({
      width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height,
    })}>
      {picture}
    </View>
  );

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <View style={s.screen}>
        <View style={s.header}>
          <TouchableOpacity onPress={onCancel} style={s.iconBtn} hitSlop={hit}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={s.title}>Edit photo</Text>
          <TouchableOpacity onPress={undo} style={s.iconBtn} hitSlop={hit} disabled={!step}>
            <Ionicons name="arrow-undo" size={21} color={step ? '#fff' : 'rgba(255,255,255,0.3)'} />
          </TouchableOpacity>
        </View>

        <View style={{ flex: 1 }}>
          {canvas}

          {/* Gesture layers sit above the picture, one per tool. */}
          {tool === 'crop' && displayed && (
            <View style={StyleSheet.absoluteFill} {...cropPan.panHandlers}>
              {crop && (
                <View pointerEvents="none" style={[s.cropBox, {
                  left: crop.x, top: crop.y, width: crop.width, height: crop.height,
                }]}>
                  {['tl', 'tr', 'bl', 'br'].map(cn => (
                    <View key={cn} style={[s.handle, handleStyle(cn)]} />
                  ))}
                </View>
              )}
            </View>
          )}
          {tool === 'pen' && (
            <View style={StyleSheet.absoluteFill} {...penPan.panHandlers} />
          )}
          {tool === 'text' && (
            <TouchableOpacity
              style={StyleSheet.absoluteFill}
              activeOpacity={1}
              onPress={() => setAskText(true)}
            />
          )}
        </View>

        {/* Colour and thickness, only for the tools they apply to. */}
        {(tool === 'pen' || tool === 'text') && (
          <View style={s.optionRow}>
            {COLORS.map(c => (
              <TouchableOpacity key={c} onPress={() => setColor(c)}
                style={[s.swatch, { backgroundColor: c }, color === c && s.swatchOn]} />
            ))}
            {tool === 'pen' && PEN_WIDTHS.map(w => (
              <TouchableOpacity key={w} onPress={() => setPenWidth(w)} style={s.widthBtn}>
                <View style={{ width: w + 8, height: w, borderRadius: w, backgroundColor: penWidth === w ? C.accent : '#9ca3af' }} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Each edit gets its own Done, so a crop becomes part of the picture
            the moment it is confirmed rather than being carried invisibly
            until the very end — where it used to get lost. It appears only
            when there is something to confirm. */}
        {pending && (
          <View style={s.applyRow}>
            <Text style={s.applyHint} numberOfLines={1}>
              {cropped ? 'Crop ready' : 'Drawing ready'}
            </Text>
            <TouchableOpacity style={s.applyBtn} onPress={apply} disabled={busy}>
              {busy
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="checkmark" size={17} color="#fff" />}
              <Text style={s.applyText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={s.tools}>
          <Tool2 icon="crop" label="Crop" on={tool === 'crop'} onPress={() => selectTool('crop')} />
          {!!ViewShot && <Tool2 icon="brush" label="Draw" on={tool === 'pen'} onPress={() => selectTool('pen')} />}
          {!!ViewShot && <Tool2 icon="text" label="Text" on={tool === 'text'} onPress={() => selectTool('text')} />}
        </View>

        <View style={s.actions}>
          <TouchableOpacity style={[s.action, s.actionGhost]} onPress={() => finish('save')} disabled={busy}>
            <Ionicons name="download-outline" size={18} color="#fff" />
            <Text style={s.actionText}>Save</Text>
          </TouchableOpacity>
          {/* The reason to annotate a photo is nearly always to give it to
              someone, so sending is one tap from the editor. */}
          {!!sendLabel && (
            <TouchableOpacity style={[s.action, s.actionPrimary]} onPress={() => finish('send')} disabled={busy}>
              {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send" size={17} color="#fff" />}
              <Text style={s.actionText}>{sendLabel}</Text>
            </TouchableOpacity>
          )}
          {!sendLabel && (
            <TouchableOpacity style={[s.action, s.actionPrimary]} onPress={() => finish('replace')} disabled={busy}>
              {busy ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark" size={19} color="#fff" />}
              <Text style={s.actionText}>Done</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Typing the caption before it is placed, rather than editing it in
            place on top of the picture. */}
        <Modal visible={askText} transparent animationType="fade" onRequestClose={() => setAskText(false)}>
          <View style={s.textOverlay}>
            <View style={s.textCard}>
              <Text style={s.textCardTitle}>Add text</Text>
              <TextInput
                style={s.textInput}
                value={typing}
                onChangeText={setTyping}
                autoFocus
                placeholder="Type something…"
                placeholderTextColor={C.muted}
              />
              <View style={s.textCardRow}>
                <TouchableOpacity style={s.textCancel} onPress={() => { setAskText(false); setTyping(''); }}>
                  <Text style={s.textCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.textAdd}
                  onPress={() => {
                    const v = typing.trim();
                    setAskText(false);
                    setTyping('');
                    if (!v || !displayed) return;
                    // Dropped in the middle; the picture is small enough that
                    // placing it precisely matters less than placing it at all.
                    seq.current += 1;
                    setTexts(prev => [...prev, {
                      id: Date.now(),
                      seq: seq.current,
                      text: v,
                      x: displayed.x + displayed.width / 2 - 60,
                      y: displayed.y + displayed.height / 2,
                      color: colorRef.current,
                    }]);
                  }}
                >
                  <Text style={s.textAddText}>Add</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

function Tool2({ icon, label, on, onPress }: any) {
  return (
    <TouchableOpacity style={[s.tool, on && s.toolOn]} onPress={onPress}>
      <Ionicons name={icon} size={19} color={on ? '#fff' : '#9ca3af'} />
      <Text style={[s.toolText, on && s.toolTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

function handleStyle(corner: string) {
  const o = -8;
  switch (corner) {
    case 'tl': return { left: o, top: o };
    case 'tr': return { right: o, top: o };
    case 'bl': return { left: o, bottom: o };
    default: return { right: o, bottom: o };
  }
}

const hit = { top: 10, bottom: 10, left: 10, right: 10 };

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingTop: 44, paddingBottom: 10, paddingHorizontal: 10,
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
  title: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '700' },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },

  canvas: { flex: 1, backgroundColor: '#000' },
  overlayText: { position: 'absolute', fontSize: 26, fontWeight: '800' },

  cropBox: { position: 'absolute', borderWidth: 2, borderColor: '#fff' },
  handle: {
    position: 'absolute', width: 18, height: 18, borderRadius: 3,
    backgroundColor: '#fff', borderWidth: 2, borderColor: C.accent,
  },

  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#0b0b0b',
  },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: C.accent, transform: [{ scale: 1.15 }] },
  widthBtn: { paddingHorizontal: 6, paddingVertical: 8 },

  applyRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#0b0b0b',
  },
  applyHint: { flex: 1, color: '#9ca3af', fontSize: 12.5, fontWeight: '600' },
  applyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: C.accent, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 8,
  },
  applyText: { color: '#fff', fontSize: 13.5, fontWeight: '800' },

  tools: {
    flexDirection: 'row', justifyContent: 'center', gap: 10,
    paddingVertical: 10, backgroundColor: '#0b0b0b',
  },
  tool: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
  },
  toolOn: { backgroundColor: 'rgba(255,255,255,0.14)' },
  toolText: { color: '#9ca3af', fontSize: 13, fontWeight: '700' },
  toolTextOn: { color: '#fff' },

  actions: {
    flexDirection: 'row', gap: 10, paddingHorizontal: 14,
    paddingTop: 8, paddingBottom: 26, backgroundColor: '#0b0b0b',
  },
  action: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, paddingVertical: 13,
  },
  actionGhost: { backgroundColor: 'rgba(255,255,255,0.12)' },
  actionPrimary: { backgroundColor: C.accent },
  actionText: { color: '#fff', fontSize: 14.5, fontWeight: '700' },

  textOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  textCard: { backgroundColor: C.sidebar, borderRadius: 16, padding: 18 },
  textCardTitle: { color: C.text, fontSize: 16, fontWeight: '800', marginBottom: 12 },
  textInput: {
    backgroundColor: C.inputBg, borderRadius: 10, padding: 12, color: C.text,
    fontSize: 15, borderWidth: 1, borderColor: C.border, marginBottom: 14,
  },
  textCardRow: { flexDirection: 'row', gap: 10 },
  textCancel: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  textCancelText: { color: C.text, fontSize: 14, fontWeight: '700' },
  textAdd: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', backgroundColor: C.accent },
  textAddText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
