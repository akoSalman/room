// Two reports: a map that cannot be moved, and a call that kills the app.
//
//   1. "Pinch on map to zoom and unzoom does not work and also moving map
//      doesn't work."
//
//      On the web a received location was nine fixed tiles in a 150-pixel box
//      wrapped in a link to openstreetmap.org — a site most of the people
//      using this cannot reach. There was nothing to pinch, nothing to drag,
//      and nowhere useful to go. (The PICKER, for sending a location, has
//      been draggable all along, which is probably why this looked like a
//      regression rather than something that was never built.)
//
//   2. "On tapping call and by first ring the app crashes."
//
//      From Android 14 a foreground service must declare what it is for, and
//      the system checks that the app holds the permission behind each type
//      AT THE MOMENT THE SERVICE STARTS. It does not fail softly — it throws
//      SecurityException on the main thread, which is a process death, not
//      something the try/catch around displayNotification can catch, because
//      the service is started natively after that call returns.
//
//      Two of the three types were being asked for without their permission:
//      PHONE_CALL needs MANAGE_OWN_CALLS, which was not in app.json at all;
//      MICROPHONE needs RECORD_AUDIO to be GRANTED, and an outgoing call
//      reaches this before the microphone has ever been asked for.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const ongoing = fs.readFileSync(path.join(ROOT, 'native-app', 'src', 'ongoingCall.ts'), 'utf8');
const appJson = fs.readFileSync(path.join(ROOT, 'native-app', 'app.json'), 'utf8');

const tests = [];
const test = (n, f) => tests.push({ n, f });

// ── The map ─────────────────────────────────────────────────────────────────

test('THE BUG: a received location opens a map, not a link to a blocked site', () => {
  const fn = app.slice(app.indexOf('function buildLocationCard('), app.indexOf('function buildLocationCard(') + 2500);
  assert.ok(fn.includes('openMapViewer(p.lat, p.lng, live)'), 'the card still does not open anything');
  assert.ok(!/map\.href = url/.test(fn), 'the map is still a link to openstreetmap.org');
  assert.ok(app.includes('function openMapViewer('), 'there is no viewer to open');
});

test('and that map can be dragged and pinched', () => {
  const fn = app.slice(app.indexOf('function openMapViewer('), app.indexOf('function buildLocationCard('));
  assert.ok(fn.length > 0, 'the viewer is gone — this check would be vacuous');
  for (const ev of ['touchstart', 'touchmove', 'touchend', 'wheel', 'mousedown', 'mousemove']) {
    assert.ok(fn.includes(`addEventListener('${ev}'`), `${ev} is not handled`);
  }
  assert.ok(fn.includes('GeoZoom.pinchZoomDelta('), 'the pinch does not change the zoom');
  assert.ok(fn.includes('GeoZoom.zoomAbout('), 'zooming does not keep the fingers over the same place');
  assert.ok(fn.includes('GeoZoom.clampZoom('), 'the zoom is unbounded');
});

test('the touch listeners can actually cancel the browser gesture', () => {
  // A listener registered passively is FORBIDDEN from calling preventDefault,
  // and the browser goes on scrolling whatever the handler does.
  const fn = app.slice(app.indexOf('function openMapViewer('), app.indexOf('function buildLocationCard('));
  // Each touch listener is read up to the START of the next listener, so a
  // `{ passive: false }` belonging to a later one cannot vouch for it.
  const starts = [...fn.matchAll(/addEventListener\('(touch\w+)'/g)];
  assert.ok(starts.length >= 4, `only ${starts.length} touch listeners found`);
  starts.forEach((m, i) => {
    const next = i + 1 < starts.length ? starts[i + 1].index : fn.length;
    const block = fn.slice(m.index, next);
    assert.ok(/\{ passive: false \}/.test(block),
      `${m[1]} is registered passively, so preventDefault() in it is ignored`);
  });
  assert.ok(fn.includes('if (e.cancelable) e.preventDefault();'), 'the browser keeps its own gesture');
});

test('THE iOS HALF: the surface says touch-action: none', () => {
  // Safari decides whether a gesture is a page zoom from the CSS, BEFORE any
  // listener runs. Without this the pinch zooms the page and the map sits
  // still — exactly what was reported.
  const rule = /\.map-surface\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.map-surface has no rule — this check would be vacuous');
  assert.ok(/touch-action:\s*none/.test(rule[1]), 'a pinch will zoom the page instead of the map');
  assert.ok(/overscroll-behavior:\s*none/.test(rule[1]), 'a drag past the edge will bounce the page');
});

test('a finger lifting out of a pinch does not fling the map', () => {
  const fn = app.slice(app.indexOf('function openMapViewer('), app.indexOf('function buildLocationCard('));
  assert.ok(/e\.touches\.length === 1 && drag && drag\.kind === 'pinch'/.test(fn),
    'the remaining finger becomes a pan from wherever it happens to be');
});

test('the viewer clears the notch and the home indicator', () => {
  const bar = /\.map-bar\s*\{([^}]*)\}/.exec(css);
  const foot = /\.map-foot\s*\{([^}]*)\}/.exec(css);
  assert.ok(bar && /var\(--sat\)/.test(bar[1]), 'the close button sits under the status bar');
  assert.ok(foot && /var\(--sab\)/.test(foot[1]), 'the footer sits under the home indicator');
});

// ── The call ────────────────────────────────────────────────────────────────

test('THE CRASH: MANAGE_OWN_CALLS is declared', () => {
  // Without it, asking for the PHONE_CALL service type is a SecurityException
  // on every Android 14 device, on every call, at the first ring.
  assert.ok(appJson.includes('android.permission.MANAGE_OWN_CALLS'),
    'the phoneCall foreground-service type will be refused, and refusal is a crash');
  assert.ok(appJson.includes('android.permission.FOREGROUND_SERVICE_PHONE_CALL'),
    'the service type itself is no longer declared');
});

test('and no service type is asked for without its permission', () => {
  assert.ok(ongoing.includes('async function allowedTypes('), 'the types are still a fixed list');
  assert.ok(/foregroundServiceTypes: types,/.test(ongoing), 'the fixed list is still what is sent');
  assert.ok(/PermissionsAndroid\.check\(/.test(ongoing), 'nothing checks what is actually held');
  assert.ok(/PERMISSIONS\.RECORD_AUDIO/.test(ongoing),
    'MICROPHONE is claimed without checking that the microphone was granted');
  assert.ok(/hasManageOwnCalls\(\)/.test(ongoing), 'PHONE_CALL is claimed without checking');
});

test('a call with no usable type still runs, as an ordinary notification', () => {
  // A foreground service with NO valid type is refused just as firmly as one
  // with the wrong type. Losing the protection from being frozen is a far
  // smaller failure than the app disappearing mid-ring.
  assert.ok(/asForegroundService: types\.length > 0/.test(ongoing),
    'an empty type list still asks for a foreground service, which is refused');
});

test('the camera type is only for video calls, and only if granted', () => {
  const fn = ongoing.slice(ongoing.indexOf('async function allowedTypes('), ongoing.indexOf('async function hasManageOwnCalls'));
  assert.ok(/kind === 'video' && await has\(PermissionsAndroid\.PERMISSIONS\.CAMERA\)/.test(fn),
    'a voice call claims the camera, or the camera is claimed without permission');
});

test('none of this runs on iOS, where there is no such thing', () => {
  const fn = ongoing.slice(ongoing.indexOf('async function allowedTypes('), ongoing.indexOf('async function hasManageOwnCalls'));
  assert.ok(/Platform\.OS !== 'android'/.test(fn), 'iOS is put through Android permission checks');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
