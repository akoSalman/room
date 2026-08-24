// ── Editing a photo: crop and draw ───────────────────────────────────────────
//
// Two ways out on purpose. A photo you are about to send should be editable and
// then SENT, without going back to find it again; a photo already in a chat
// should be editable and then sent onward or saved, because the reason to
// annotate one is almost always to give it to someone.
//
// Each edit is APPLIED for real, producing a file, and they stack. That is not
// bookkeeping for its own sake — it is the only arrangement in which "crop,
// then draw" means what it looks like. A crop is done on the file by
// expo-image-manipulator, so the photo keeps its full resolution; a drawing
// exists only as views on screen and has to be photographed with
// react-native-view-shot at screen resolution. The two cannot happen in one
// pass, because the capture can only ever photograph what is on screen and on
// screen the pending crop has not happened yet. So switching tool applies
// whatever the last one left outstanding, and a crop and a drawing are never
// pending together.
//
// The crop box is stored as a FRACTION of the picture, never in screen pixels.
// See src/imageEditor.ts — pixels made the editor invent crops nobody asked
// for whenever the layout moved.
//
// If view-shot is missing from the build, drawing is hidden rather than offered
// and then failing at the last step.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Image, TouchableOpacity, StyleSheet,
  PanResponder, ActivityIndicator, Alert, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Makeup, clampEv, EV_MIN, EV_MAX, needsProcessing } from '../cameraTune';
import { tunePhoto } from '../photoTune';
import * as ImageManipulator from 'expo-image-manipulator';
import { C } from '../theme';
import {
  fitRect, strokeSegments, nextUndo,
  fracToScreen, screenToFrac, clampFrac, isWholeFrac, fracToNatural, WHOLE_IMAGE,
  savePlan, canSend,
  Rect, Size, Stroke, Point, FracRect,
} from '../imageEditor';

// Loaded defensively: a build without the native module must lose the drawing
// tools, not crash the moment someone opens the editor.
let captureRef: any = null;
try {
  // The JS half of this package imports fine even when the native half is
  // missing — it only warns — so the native module is what actually gets
  // checked. Otherwise the tools would appear and fail at the last step.
  const { NativeModules } = require('react-native');
  if (NativeModules?.RNViewShot) {
    captureRef = require('react-native-view-shot').captureRef;
  }
} catch {}

type Tool = 'crop' | 'pen';

/**
 * One applied version of the photo, with the size it really is.
 *
 * The size travels WITH the file rather than being looked up afterwards. Every
 * version here is produced by the manipulator or by a screen capture, both of
 * which report their own dimensions and neither of which carries an EXIF
 * orientation — so this number is the one the picture is actually drawn at.
 */
type Version = { uri: string; width: number; height: number };

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
  // Every applied edit produces a real file. The last entry is what is on
  // screen and what anything new is applied to.
  //
  // Each entry carries its OWN pixel size, measured when the file was made,
  // rather than being looked up later — see the note on normalising below.
  const [history, setHistory] = useState<Version[]>([]);
  const current = history[history.length - 1] || null;
  const working = current?.uri || uri;
  const natural: Size | null = current ? { width: current.width, height: current.height } : null;
  const [area, setArea] = useState<Size>({ width: 0, height: 0 });
  const [tool, setTool] = useState<Tool>('crop');
  // Brightness and makeup, the same two corrections the camera offers — a
  // photo from the gallery deserves them as much as one just taken.
  const [ev, setEv] = useState(0);
  const [makeup, setMakeup] = useState<Makeup>('off');
  const [busy, setBusy] = useState(false);

  const [crop, setCrop] = useState<FracRect>({ ...WHOLE_IMAGE });
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState(COLORS[2]);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1]);
  const seq = useRef(0);

  const shotRef = useRef<any>(null);
  const drawing = useRef<Point[]>([]);
  const [live, setLive] = useState<Point[]>([]);

  // The photo is NORMALISED before anything is measured on it.
  //
  // This is why crops landed on the wrong part of the picture. Image.getSize
  // reports the size the file is STORED at, while <Image> draws it with its
  // EXIF orientation applied — and a phone photo taken in portrait is very
  // often stored landscape with a "rotate 90" flag. The editor was then fitting
  // a landscape rectangle to a portrait picture and converting the crop box
  // into coordinates of an image nobody could see. It looked plausible and cut
  // out the wrong thing.
  //
  // Passing the file through the manipulator with no operations decodes it,
  // applies the rotation, and writes it back with no orientation flag at all —
  // and hands back the real width and height. After that the picture on screen
  // and the pixels being cropped cannot disagree, because there is only one
  // interpretation of the file left.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const out = await ImageManipulator.manipulateAsync(uri, [], {
          compress: 1, format: ImageManipulator.SaveFormat.JPEG,
        });
        if (alive) setHistory([{ uri: out.uri, width: out.width, height: out.height }]);
      } catch {
        // Fall back to measuring the original. The crop may be wrong on a
        // rotated photo, but an editor that opens beats one that does not.
        Image.getSize(uri,
          (width, height) => { if (alive) setHistory([{ uri, width, height }]); },
          () => { if (alive) setHistory([{ uri, width: 1000, height: 1000 }]); });
      }
    })();
    return () => { alive = false; };
  }, [uri]);

  const displayed = natural ? fitRect(natural, area) : null;
  const cropBox = displayed ? fracToScreen(crop, displayed) : null;

  // ── Gestures ───────────────────────────────────────────────────────────────
  // The PanResponders are built once, so anything they read at gesture time
  // has to come from a ref rather than from a closed-over render value.
  const cropRef = useRef<FracRect>(crop); cropRef.current = crop;
  const displayedRef = useRef<Rect | null>(null); displayedRef.current = displayed;
  const colorRef = useRef(color); colorRef.current = color;
  const widthRef = useRef(penWidth); widthRef.current = penWidth;

  // Which corner is being dragged, decided once when the finger lands.
  const grab = useRef<{ corner: string; start: Rect } | null>(null);

  const cropPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const bounds = displayedRef.current;
      if (!bounds) return;
      const box = fracToScreen(cropRef.current, bounds);
      const { locationX: x, locationY: y } = e.nativeEvent;
      // Nearest corner within reach; otherwise the whole box moves.
      const near = (px: number, py: number) => Math.hypot(x - px, y - py) < 48;
      const corner =
        near(box.x, box.y) ? 'tl'
        : near(box.x + box.width, box.y) ? 'tr'
        : near(box.x, box.y + box.height) ? 'bl'
        : near(box.x + box.width, box.y + box.height) ? 'br'
        : 'move';
      grab.current = { corner, start: box };
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
      // Straight back to a fraction: nothing is ever stored in screen pixels.
      setCrop(clampFrac(screenToFrac(next, bounds)));
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

  const annotated = strokes.length > 0;
  const cropped = !isWholeFrac(crop);
  /** Changes made since the last Done. */
  const pending = annotated || cropped;

  const step = nextUndo({
    lastStrokeSeq: strokes.length ? strokes[strokes.length - 1].seq : null,
    cropped,
    committed: history.length - 1,
  });

  function undo() {
    switch (step) {
      case 'stroke': setStrokes(prev => prev.slice(0, -1)); break;
      case 'crop': setCrop({ ...WHOLE_IMAGE }); break;
      case 'revert':
        setHistory(h => h.slice(0, -1));
        setCrop({ ...WHOLE_IMAGE });
        setStrokes([]);
        break;
    }
  }

  /** Turn the pending edits into a real image file, and measure it. */
  async function rasterise(): Promise<Version | null> {
    if (!natural || !current) return null;
    if (!pending) return current;

    // Drawing first, because a drawing can only be got at by photographing the
    // screen — and the screen shows the picture UNCROPPED, with the strokes on
    // top. The crop is a fraction of that same rectangle, so it applies just
    // as well to the photograph afterwards.
    //
    // This used to return after the crop, which silently threw the strokes
    // away whenever both were outstanding. The comment above selectTool
    // promises that cannot happen; a promise the code does not enforce is
    // exactly the kind that stops being true after the next change.
    const plan = savePlan({ annotated, cropped });
    if (plan.unchanged) return current;

    let base: Version;
    if (plan.capture) {
      if (!captureRef || !shotRef.current) {
        Alert.alert('Not available', 'Drawing needs a newer version of the app.');
        return null;
      }
      // A capture has no orientation flag, and it is exactly the rectangle the
      // picture occupies, so its size follows from the layout.
      const shot = await captureRef(shotRef.current, { format: 'jpg', quality: 0.95 });
      const size = await new Promise<Size>(resolve => {
        Image.getSize(shot,
          (width, height) => resolve({ width, height }),
          () => resolve({ width: Math.round(displayed?.width || 1000), height: Math.round(displayed?.height || 1000) }));
      });
      base = { uri: shot, width: size.width, height: size.height };
    } else {
      base = current;
    }

    if (!plan.crop) return base;

    // A crop is done on the FILE, so an uncropped photo keeps its full
    // resolution. The manipulator reports the size of what it produced, which
    // is what the next crop will be measured against.
    const box = fracToNatural(crop, { width: base.width, height: base.height });
    const out = await ImageManipulator.manipulateAsync(
      base.uri, [{ crop: { originX: box.x, originY: box.y, width: box.width, height: box.height } }],
      { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG },
    );
    return { uri: out.uri, width: out.width, height: out.height };
  }

  /** Make the current edits permanent and start a fresh step on top. */
  async function apply(): Promise<boolean> {
    if (busy || !pending) return true;
    setBusy(true);
    try {
      const out = await rasterise();
      if (!out) return false;
      setHistory(h => [...h, out]);
      setCrop({ ...WHOLE_IMAGE });
      setStrokes([]);
      return true;
    } catch {
      Alert.alert('Could not edit', 'That change could not be applied.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Switching tool applies whatever the current one left outstanding, which is
   * what keeps a crop and a drawing from ever being pending together.
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
      // Forgetting to press Done must not throw the last edit away.
      const out = pending ? await rasterise() : current;
      // Reported as: after drawing on a photo and sending it, the drawing is
      // not there and the ORIGINAL goes.
      //
      // This is where that happened. When the edits could not be turned into a
      // file — the capture unavailable, or a measurement that came back with
      // nothing — the code fell back to `working`, the untouched photo, and
      // sent it as though nothing had been asked for. Quietly substituting the
      // original for the edit is the worst of the three options available:
      // better to say so and let the user decide, and far better than a
      // photograph arriving somewhere with the annotation missing.
      if (!canSend(out)) {
        Alert.alert('Edit not saved', 'The change could not be applied, so nothing was sent. Try again.');
        return;
      }
      let uri = out.uri;
      // Applied last, over the finished crop and drawing: correcting first and
      // then cropping would re-encode the photo twice for no reason.
      if (needsProcessing({ ev, makeup })) uri = await tunePhoto(uri, { ev, makeup });
      onDone({ uri, action });
    } catch {
      Alert.alert('Could not edit', 'The photo could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  // Only the picture goes inside the capture. Wrapping the whole canvas caught
  // its black letterbox too, so an exported drawing came back padded with bars
  // at the wrong aspect ratio. `collapsable={false}` keeps it a real native
  // view for captureRef to photograph.
  const picture = displayed && (
    <View style={{
      position: 'absolute',
      left: displayed.x, top: displayed.y, width: displayed.width, height: displayed.height,
    }}>
      <View ref={shotRef} collapsable={false} style={StyleSheet.absoluteFill}>
        <Image source={{ uri: working }} style={StyleSheet.absoluteFill} resizeMode="contain" />

        {/* Finished strokes, then the one under the finger. */}
        {strokes.map(st => (
          <React.Fragment key={`st${st.seq}`}>
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
      </View>
    </View>
  );

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <View style={s.screen}>
        <View style={s.header}>
          <TouchableOpacity onPress={onCancel} style={s.iconBtn} hitSlop={hit}>
            <Ionicons name="close" size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={s.title}>Edit photo</Text>
          <TouchableOpacity onPress={undo} style={s.iconBtn} hitSlop={hit} disabled={!step}>
            <Ionicons name="arrow-undo-outline" size={20}
              color={step ? '#fff' : 'rgba(255,255,255,0.28)'} />
          </TouchableOpacity>
        </View>

        <View style={{ flex: 1 }}>
          <View style={s.canvas} onLayout={e => setArea({
            width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height,
          })}>
            {picture}
            {/* Normalising the photo takes a moment on a large one, and until
                it finishes there is nothing that can honestly be drawn: the
                size the picture will turn out to be is exactly what is being
                established. */}
            {!current && (
              <View style={s.loading}>
                <ActivityIndicator size="large" color="#fff" />
              </View>
            )}
          </View>

          {/* Gesture layers sit above the picture, one per tool. */}
          {tool === 'crop' && cropBox && (
            <View style={StyleSheet.absoluteFill} {...cropPan.panHandlers}>
              <View pointerEvents="none" style={[s.cropBox, {
                left: cropBox.x, top: cropBox.y, width: cropBox.width, height: cropBox.height,
              }]}>
                {['tl', 'tr', 'bl', 'br'].map(cn => (
                  <View key={cn} style={[s.handle, handleStyle(cn)]} />
                ))}
              </View>
            </View>
          )}
          {tool === 'pen' && (
            <View style={StyleSheet.absoluteFill} {...penPan.panHandlers} />
          )}

          {/* Each edit has its own Done, and it FLOATS over the picture.
              Inserting it into the column made the canvas shorter the instant
              it appeared, which moved the picture — and back when the crop box
              was measured in screen pixels, that alone was read as a crop. */}
          {pending && (
            <View style={s.applyRow} pointerEvents="box-none">
              <TouchableOpacity style={s.applyBtn} onPress={apply} disabled={busy}>
                {busy
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="checkmark" size={16} color="#fff" />}
                <Text style={s.applyText}>{cropped ? 'Apply crop' : 'Apply drawing'}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Colour and thickness, only for the tool they apply to. */}
        {tool === 'pen' && (
          <View style={s.optionRow}>
            {COLORS.map(c => (
              <TouchableOpacity key={c} onPress={() => setColor(c)}
                style={[s.swatch, { backgroundColor: c }, color === c && s.swatchOn]} />
            ))}
            {PEN_WIDTHS.map(w => (
              <TouchableOpacity key={w} onPress={() => setPenWidth(w)} style={s.widthBtn}>
                <View style={{
                  width: w + 8, height: w, borderRadius: w,
                  backgroundColor: penWidth === w ? C.accent : '#9ca3af',
                }} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Brightness. A photo that is too dark to see is the commonest thing
            wrong with one, and until now the editor could crop it and draw on
            it but not fix that. */}
        <View style={s.tuneRow}>
          <Ionicons name="moon-outline" size={15} color="rgba(255,255,255,0.7)" />
          <View style={s.tuneTrack}>
            {[-1, -0.5, 0, 0.5, 1].map(v => (
              <TouchableOpacity
                key={v}
                style={[s.tuneStop, Math.abs(ev - v) < 0.01 && s.tuneStopOn]}
                onPress={() => setEv(clampEv(v))}
                accessibilityLabel={v === 0 ? 'Original brightness' : `Brightness ${v > 0 ? '+' : ''}${v}`}
              />
            ))}
          </View>
          <Ionicons name="sunny-outline" size={16} color="rgba(255,255,255,0.9)" />
        </View>

        <View style={s.tools}>
          <ToolBtn icon="crop-outline" label="Crop" on={tool === 'crop'} onPress={() => selectTool('crop')} />
          {!!captureRef && (
            <ToolBtn icon="brush-outline" label="Draw" on={tool === 'pen'} onPress={() => selectTool('pen')} />
          )}
          <ToolBtn
            icon="sparkles-outline"
            label={makeup === 'off' ? 'Makeup' : makeup === 'light' ? 'Makeup 1' : 'Makeup 2'}
            on={makeup !== 'off'}
            onPress={() => setMakeup(m => (m === 'off' ? 'light' : m === 'light' ? 'strong' : 'off'))}
          />
        </View>

        <View style={s.actions}>
          <TouchableOpacity style={[s.action, s.actionGhost]} onPress={() => finish('save')} disabled={busy}>
            <Ionicons name="download-outline" size={17} color="#fff" />
            <Text style={s.actionText}>Save</Text>
          </TouchableOpacity>
          {/* The reason to annotate a photo is nearly always to give it to
              someone, so sending is one tap from the editor. */}
          <TouchableOpacity
            style={[s.action, s.actionPrimary]}
            onPress={() => finish(sendLabel ? 'send' : 'replace')}
            disabled={busy}
          >
            {busy
              ? <ActivityIndicator size="small" color="#fff" />
              : <Ionicons name={sendLabel ? 'arrow-up' : 'checkmark'} size={17} color="#fff" />}
            <Text style={s.actionText}>{sendLabel || 'Done'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function ToolBtn({ icon, label, on, onPress }: any) {
  return (
    <TouchableOpacity style={[s.tool, on && s.toolOn]} onPress={onPress}>
      <Ionicons name={icon} size={18} color={on ? '#fff' : '#9ca3af'} />
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
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },

  cropBox: { position: 'absolute', borderWidth: 2, borderColor: '#fff' },
  handle: {
    position: 'absolute', width: 18, height: 18, borderRadius: 3,
    backgroundColor: '#fff', borderWidth: 2, borderColor: C.accent,
  },

  // Floats over the picture rather than taking a row of its own, so nothing
  // re-lays-out when it appears.
  applyRow: {
    position: 'absolute', left: 0, right: 0, bottom: 14, alignItems: 'center',
  },
  applyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: C.accent, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 9,
  },
  applyText: { color: '#fff', fontSize: 13.5, fontWeight: '700' },

  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#0b0b0b',
  },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: C.accent, transform: [{ scale: 1.15 }] },
  widthBtn: { paddingHorizontal: 6, paddingVertical: 8 },

  tools: {
    flexDirection: 'row', justifyContent: 'center', gap: 10,
    paddingVertical: 10, backgroundColor: '#0b0b0b',
  },
  // Five stops rather than a free slider: a photo needs "a bit brighter", not
  // a number, and discrete stops are far easier to hit with a thumb.
  tuneRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 22, paddingTop: 10, backgroundColor: '#0b0b0b',
  },
  tuneTrack: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tuneStop: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
  },
  tuneStopOn: { backgroundColor: '#ffd666', borderColor: '#ffd666' },
  tool: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20,
  },
  toolOn: { backgroundColor: 'rgba(255,255,255,0.14)' },
  toolText: { color: '#9ca3af', fontSize: 13, fontWeight: '600' },
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
});
