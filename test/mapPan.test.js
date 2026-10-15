// Pushing the map around with one finger, and hitting what you aimed at.
//
// Reported as: "location picker doesn't work fine on moving around with one
// finger and selecting location is not precise". Two separate faults, and
// neither of them is in the maths that was already tested.
//
// 1. THE MAP WENT GREY UNDER THE FINGER. tilesForViewport tiled the viewport
//    exactly — the first tile was floor(origin/256) and the last was
//    floor((origin+width)/256), with nothing either side. So there was no tile
//    beyond the edge of the screen, because none had ever been asked for, and
//    a drag pulled in empty space from the moment it started. The real tiles
//    were fetched when the finger lifted, which on these connections is a
//    wait you watch.
//
// 2. EVERY TILE RE-RENDERED, PER TOUCH EVENT. The drag was React state, and
//    each tile and marker computed its own absolute left/top from it — so one
//    finger moving meant sixteen <Image>es reconciled and laid out again for
//    every event the gesture handler sent. It is now one Animated transform on
//    the layer they all sit in: the same numbers, written to the view, with no
//    render at all.
//
// 3. THE CROSSHAIR POINTED SOMEWHERE ELSE. `onSend(center)` sends the middle
//    of the viewport. The teardrop was centred on the middle, so its TIP — the
//    part of a pin that means "here" — hung half a pin below it, and the dot
//    had been nudged DOWN to meet the tip instead of the icon nudged UP to
//    meet the map. Both agreed with each other and both were twenty pixels
//    south of the answer. That is the "not precise": at the zoom this picker
//    opens at, twenty pixels is most of a building.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NATIVE = path.join(__dirname, '..', 'native-app');
const SRC = path.join(NATIVE, 'src');
const TSC = path.join(NATIVE, 'node_modules', '.bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.log('  ! skipping map-pan tests (native-app deps not installed)');
  process.exit(0);
}
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mappan-'));
execFileSync(TSC, [
  path.join(SRC, 'geo.ts'), path.join(SRC, 'locationPick.ts'),
  '--outDir', OUT, '--module', 'commonjs', '--target', 'es2019', '--skipLibCheck',
], { stdio: 'pipe' });
const G = require(path.join(OUT, 'geo.js'));
const P = require(path.join(OUT, 'locationPick.js'));

const mapSrc = fs.readFileSync(path.join(SRC, 'components', 'TileMap.tsx'), 'utf8');
const pickSrc = fs.readFileSync(path.join(SRC, 'components', 'LocationPicker.tsx'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

const TEHRAN = { lat: 35.6892, lng: 51.3890 };
// A portrait phone, less the header and footer the picker puts around the map.
const W = 400, H = 700;

/**
 * The body of `const name = (…) => { … }`, by matching braces.
 *
 * Not a fixed slice of characters: those have silently drifted off the end of
 * the thing they were meant to be reading twice in this suite already, and a
 * test reading the wrong lines passes for the wrong reason.
 */
function bodyOf(src, name) {
  const at = src.indexOf(`const ${name} = `);
  assert.ok(at >= 0, `${name} is not in the file at all`);
  const open = src.indexOf('{', src.indexOf('=>', at));
  assert.ok(open > at, `${name} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name}'s body never closes`);
}

// ── 1. There is map beyond the edge of the screen ───────────────────────────

/** Is every one of these viewport pixels under some tile, after a drag? */
function coveredAfterDrag(tiles, dx, dy) {
  const edges = [0, 1, W / 2, W - 1, W];
  const downs = [0, 1, H / 2, H - 1, H];
  for (const px of edges) {
    for (const py of downs) {
      const hit = tiles.some((t) => {
        const l = t.left + dx, tp = t.top + dy;
        return px >= l && px < l + G.TILE_SIZE && py >= tp && py < tp + G.TILE_SIZE;
      });
      if (!hit) return { px, py };
    }
  }
  return null;
}

test('THE BUG: a drag has real map under it, not the grey it had before', () => {
  const tiles = G.tilesForViewport(TEHRAN, 16, W, H);
  // A deliberate drag on a phone is a couple of hundred pixels. Every one of
  // these used to expose a band of nothing on the leading edge.
  for (const [dx, dy] of [[200, 0], [-200, 0], [0, 200], [0, -200], [180, 180], [-180, -180]]) {
    const gap = coveredAfterDrag(tiles, dx, dy);
    assert.strictEqual(gap, null,
      `dragging by ${dx},${dy} leaves viewport pixel ${gap && gap.px},${gap && gap.py} with no tile`);
  }
});

test('…which is a whole tile of slack, in every direction', () => {
  assert.ok(G.TILE_MARGIN >= 1, 'no margin: the drag is back to pulling in grey');
  // A drag shorter than the margin can never run out of map, whichever way
  // it goes. This is the property the number has to buy.
  const tiles = G.tilesForViewport(TEHRAN, 16, W, H);
  const d = G.TILE_SIZE;
  for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
    assert.strictEqual(coveredAfterDrag(tiles, dx, dy), null,
      `a drag of one tile (${dx},${dy}) outruns the tiles that were fetched`);
  }
});

test('…and NOT two tiles of slack, because the user pays for them', () => {
  // These phones are on metered data in Iran. One ring already takes a
  // 400x700 viewport from twelve tiles to thirty; two would be fifty-six, for
  // map nobody is going to look at. If someone raises TILE_MARGIN this fails
  // on purpose.
  const n = G.tilesForViewport(TEHRAN, 16, W, H).length;
  assert.ok(n <= 32, `${n} tiles for one screen is more data than this is worth`);
  assert.strictEqual(G.TILE_MARGIN, 1, 'the margin is no longer the one that was costed');
});

test('the margin does not invent tiles outside the world', () => {
  // The ring reaches past the poles at low zoom, where no tile exists. It did
  // not have to handle that before, because it never looked outside the
  // screen.
  for (const z of [G.MIN_ZOOM, 4, 8, 14, G.MAX_ZOOM]) {
    const n = Math.pow(2, z);
    for (const t of G.tilesForViewport({ lat: 84, lng: 179.9 }, z, W, H)) {
      assert.ok(t.x >= 0 && t.x < n, `tile x ${t.x} is outside the world at z${z}`);
      assert.ok(t.y >= 0 && t.y < n, `tile y ${t.y} is outside the world at z${z}`);
      assert.ok(Number.isFinite(t.left) && Number.isFinite(t.top),
        `tile ${t.x},${t.y} has no position at z${z}`);
    }
  }
});

test('the viewport itself is still covered, margin or no margin', () => {
  // The margin must be added AROUND the old range, not instead of it.
  assert.strictEqual(coveredAfterDrag(G.tilesForViewport(TEHRAN, 16, W, H), 0, 0), null,
    'the resting viewport has a hole in it');
});

// ── 2. The drag does not go through React ───────────────────────────────────

test('THE BUG: the pan handler sets no state', () => {
  const body = bodyOf(mapSrc, 'onPanEvent');
  assert.ok(/pan\.setValue\(/.test(body), 'the pan handler no longer moves the map');
  // A bare setSomething(…), not a method call: `pan.setValue(` is the fix and
  // matches a naive /set[A-Z]/ perfectly well, which is how this assertion
  // first failed against correct code.
  assert.ok(!/(?<![.\w])set[A-Z]\w*\(/.test(body),
    'the pan handler is back to setState, which re-renders every tile per touch event');
});

test('…and nothing positions itself from a drag value any more', () => {
  assert.ok(!/dragOffset/.test(mapSrc),
    'dragOffset is back: tiles and markers are computing their own absolute positions again');
});

test('…because they all move together, as one transformed layer', () => {
  assert.ok(/<Animated\.View/.test(mapSrc), 'there is no animated layer to move');
  assert.ok(/translateX:\s*pan\.x/.test(mapSrc) && /translateY:\s*pan\.y/.test(mapSrc),
    'the layer is not driven by the pan value');
  assert.ok(/Animated/.test(mapSrc.slice(0, mapSrc.indexOf("} from 'react-native'"))),
    'Animated is used but never imported, so the screen crashes on open');
});

test('the pinch still owns the gesture when two fingers are down', () => {
  // This is the guard that stopped a pinch from also being committed as a
  // drag, which used to fling the map sideways. Driving the value natively
  // would read the gesture before this ran and the map would follow a pinch.
  const body = bodyOf(mapSrc, 'onPanEvent');
  assert.ok(/mode\.current === 'pinch'\) return/.test(body),
    'the pan handler no longer stands aside for a pinch');
  assert.ok(!/useNativeDriver:\s*true/.test(mapSrc),
    'a natively-driven pan bypasses the handler, and with it the pinch guard');
});

test('letting go still commits the move, through the maths that was tested', () => {
  const body = bodyOf(mapSrc, 'onPanState');
  assert.ok(/onCenterChange\?\.\(panCenter\(/.test(body),
    'the drag is shown but never committed, so the map springs back');
  assert.ok(/pan\.setValue\(\{ x: 0, y: 0 \}\)/.test(body),
    'the layer is never put back, so the next drag starts offset by the last one');
  // The commit has to stay behind the pinch guard. A pinch that began
  // mid-drag has already moved the map through applyZoom, and committing the
  // drag's translation on top of it moves it twice — which is the sideways
  // fling this guard was added for.
  const commit = body.indexOf('onCenterChange?.(panCenter(');
  const guard = body.indexOf("mode.current !== 'pinch'");
  assert.ok(guard >= 0 && guard < commit,
    'the drag is committed even when a pinch already moved the map, so it moves twice');
});

test('a marker being dragged into view is already mounted when it arrives', () => {
  // Culling has to be measured from where a marker sits BEFORE the drag now,
  // because the drag does not re-render it — so the margin has to be wide
  // enough that it was never culled in the first place.
  const bounds = /if \(x < (-?[\w *]+) \|\| y < (-?[\w *]+) \|\| x > ([\w *]+) \|\| y > ([\w *]+)\) return null/
    .exec(mapSrc);
  assert.ok(bounds, 'the marker cull is not in a shape this can check any more');
  assert.ok(/width/.test(bounds[1]) && /height/.test(bounds[2]),
    `cull margin ${bounds[1]}/${bounds[2]} is a fixed few pixels: markers pop in mid-drag`);
  assert.ok(/width/.test(bounds[3]) && /height/.test(bounds[4]),
    `cull margin ${bounds[3]}/${bounds[4]} is a fixed few pixels: markers pop in mid-drag`);
});

// ── 3. The crosshair points at the point that gets sent ─────────────────────

/**
 * Where the two halves of the crosshair end up, in pixels from the centre
 * line, given how the picker lays them out: one in-flow icon and one absolute
 * dot, both centred in a box that fills the map.
 *
 * Centring works on the MARGIN box, which is what makes a bottom margin lift
 * the icon: the box grows downwards, the whole thing is re-centred, and the
 * glyph rides up by half the margin... twice, once for the growth and once
 * for the shift. A margin of a whole size therefore puts the glyph's bottom
 * edge — the teardrop's tip — exactly on the line.
 */
function crosshair(size) {
  const o = P.crosshairOffsets(size);
  const s = size === undefined ? P.PIN_SIZE : size;
  const marginBox = s + o.iconMarginBottom;
  const contentTop = -marginBox / 2;
  return { tip: contentTop + s, dot: o.dotMarginTop };
}

test('THE BUG: the teardrop\'s tip is on the point that gets sent', () => {
  const { tip } = crosshair(undefined);
  assert.strictEqual(tip, 0,
    `the tip is ${tip}px from the centre, so the pin lands ${Math.abs(tip)}px away from where it points`);
});

test('…and so is the dot, which is the mark you actually aim with', () => {
  const { dot } = crosshair(undefined);
  assert.strictEqual(dot, 0, `the dot is ${dot}px below the point that gets sent`);
});

test('…so the two of them agree with each other', () => {
  // They did before, too — both twenty pixels south. Agreeing is necessary
  // and not sufficient, which is why it is not the only check here.
  const { tip, dot } = crosshair(undefined);
  assert.strictEqual(tip, dot, 'the icon points at one place and the dot marks another');
});

test('and it holds at any pin size, not just the one it was tuned at', () => {
  for (const size of [16, 24, 40, 64, 100]) {
    const { tip, dot } = crosshair(size);
    assert.strictEqual(tip, 0, `a ${size}px pin points ${tip}px off centre`);
    assert.strictEqual(dot, 0, `a ${size}px pin's dot is ${dot}px off centre`);
  }
});

test('a nonsense size falls back rather than putting the pin somewhere random', () => {
  for (const bad of [0, -40, NaN, Infinity, undefined, null, 'big']) {
    const o = P.crosshairOffsets(bad);
    assert.strictEqual(o.iconMarginBottom, P.PIN_SIZE,
      `size ${String(bad)} produced a margin of ${o.iconMarginBottom}`);
    assert.strictEqual(o.dotMarginTop, 0, `size ${String(bad)} moved the dot`);
  }
});

// ── The wiring, because the numbers are only right if they are used ─────────

test('the picker draws the crosshair at the offsets, not at its own numbers', () => {
  assert.ok(/marginBottom: crosshairOffsets\(\)\.iconMarginBottom/.test(pickSrc),
    'the icon is positioned by hand again, so the tip and the sent point can drift apart');
  assert.ok(/marginTop: crosshairOffsets\(\)\.dotMarginTop/.test(pickSrc),
    'the dot is positioned by hand again');
  assert.ok(/size={PIN_SIZE}/.test(pickSrc),
    'the icon is drawn at a size the offsets were not computed for');
});

test('…and the old hardcoded nudge is gone from the stylesheet', () => {
  // This is the actual bug, in one line: the dot was moved down to meet the
  // tip, rather than the icon up to meet the map.
  const dot = /crossDot: \{[^}]*\}/.exec(pickSrc);
  assert.ok(dot, 'crossDot is no longer a style this can read');
  assert.ok(!/marginTop/.test(dot[0]),
    `crossDot still carries its own margin: ${dot[0].replace(/\s+/g, ' ')}`);
});

test('the point that is sent is still the centre of the map', () => {
  // Everything above is about making the crosshair agree with this line. If
  // it ever sends something else, all of it is wrong again.
  assert.ok(/onPress={\(\) => onSend\(center\)}/.test(pickSrc),
    'the picker no longer sends the viewport centre, so the crosshair is aimed at nothing');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
