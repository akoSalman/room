// ── The switch that screen sharing was missing ─────────────────────────────
//
// Reported four times. The first three rounds were theories about the
// encoder; this one is the device's own report, collected by the server:
//
//     scale=1.83  encoded=0  sent=0  size=0x0  after=5s
//
// `scale=1.83` says the capture reported its size and the downscale applied,
// so the previous round's theory was tested and is dead. `size=0x0` says the
// encoder never learned a frame size — it was never handed a frame at all.
// Nothing downstream of the capturer can produce that.
//
// The cause is three lines in react-native-webrtc: MediaProjectionService
// .launch() returns immediately unless WebRTCModuleOptions
// .enableMediaProjectionService is true, and that is a plain Java boolean
// with no initialiser. Nothing set it — not the library, not the Expo config
// plugin, not this app — so the foreground service was never started, and
// since Android 10 a MediaProjection without one produces no frames.
//
// Everything above it still reports success, which is why this took four
// rounds: the permission sheet appears, a track is created, getDisplayMedia
// resolves, replaceTrack succeeds. captured=1 senders=1 switched=1, every one
// of them true and none of them meaning anything.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAT = path.join(ROOT, 'native-app');
const plugin = require(path.join(NAT, 'plugins', 'withScreenShareService.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

const KOTLIN = `package com.akosalman.chatroom

import android.app.Application
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, false)
  }
}
`;

const JAVA = `package com.akosalman.chatroom;

import android.app.Application;

public class MainApplication extends Application implements ReactApplication {
  @Override
  public void onCreate() {
    super.onCreate();
    SoLoader.init(this, false);
  }
}
`;

test('THE FLAG IS SET AT ALL — the whole bug in one line', () => {
  const out = plugin.applyToMainApplication(KOTLIN, 'kt');
  assert.ok(out.includes('enableMediaProjectionService = true'),
    'the foreground service is still never started, so capture produces nothing');
  assert.ok(out.includes('import com.oney.WebRTCModule.WebRTCModuleOptions'),
    'the class is used without being imported, which does not compile');
});

test('…BEFORE ANYTHING ELSE IN onCreate', () => {
  const out = plugin.applyToMainApplication(KOTLIN, 'kt');
  const at = out.indexOf('enableMediaProjectionService');
  const sup = out.indexOf('super.onCreate()');
  assert.ok(at > 0 && sup > 0 && at < sup,
    'the flag is set after super.onCreate(), where a future early return could skip it');
});

test('IT STILL COMPILES: Kotlin gets no semicolons, Java gets them', () => {
  // The one way this fails is at build time in a generated file nobody reads.
  const kt = plugin.applyToMainApplication(KOTLIN, 'kt');
  assert.ok(/import com\.oney\.WebRTCModule\.WebRTCModuleOptions$/m.test(kt),
    'the Kotlin import ends in a semicolon');
  assert.ok(/enableMediaProjectionService = true$/m.test(kt),
    'the Kotlin statement ends in a semicolon');

  const java = plugin.applyToMainApplication(JAVA, 'java');
  assert.ok(/import com\.oney\.WebRTCModule\.WebRTCModuleOptions;$/m.test(java),
    'the Java import has no semicolon');
  assert.ok(/enableMediaProjectionService = true;$/m.test(java),
    'the Java statement has no semicolon');
});

test('THE IMPORT GOES AFTER THE PACKAGE LINE, which is the only one always there', () => {
  const out = plugin.applyToMainApplication(KOTLIN, 'kt');
  const pkg = out.indexOf('package com.akosalman.chatroom');
  const imp = out.indexOf('import com.oney.WebRTCModule.WebRTCModuleOptions');
  assert.ok(pkg >= 0 && imp > pkg, 'an import before the package declaration does not compile');
});

test('APPLYING IT TWICE DOES NOT DUPLICATE IT', () => {
  // Expo regenerates MainApplication on every build, but prebuild is not
  // always clean — and a second copy of the import is a compile error, not a
  // harmless repeat.
  const once = plugin.applyToMainApplication(KOTLIN, 'kt');
  const twice = plugin.applyToMainApplication(once, 'kt');
  assert.strictEqual(twice, once, 'a second pass added the lines again');
  assert.strictEqual((twice.match(/WebRTCModuleOptions/g) || []).length, 2,
    'the import and the one use — any more is a duplicate');
});

test('AN UNRECOGNISED FILE IS LEFT ALONE rather than half-edited', () => {
  // Expo changes this template between versions. Returning the original is a
  // screen share that does not work; returning a mangled file is an app that
  // does not build at all.
  assert.strictEqual(plugin.applyToMainApplication('package x.y', 'kt'), 'package x.y',
    'a file with no onCreate was edited anyway');
  assert.strictEqual(plugin.applyToMainApplication('class Foo {}', 'kt'), 'class Foo {}',
    'a file with no package line was edited anyway');
  assert.strictEqual(plugin.applyToMainApplication('', 'kt'), '');
  assert.strictEqual(plugin.applyToMainApplication(null, 'kt'), null);
});

test('THE LANGUAGE IS DETECTED WHEN EXPO DOES NOT SAY', () => {
  // cfg.modResults.language is what Expo reports; this does not depend on it.
  const kt = plugin.applyToMainApplication(KOTLIN, undefined);
  assert.ok(/enableMediaProjectionService = true$/m.test(kt), 'Kotlin was treated as Java');
  const java = plugin.applyToMainApplication(JAVA, undefined);
  assert.ok(/enableMediaProjectionService = true;$/m.test(java), 'Java was treated as Kotlin');
});

test('THE APP ACTUALLY REGISTERS THE PLUGIN', () => {
  // A plugin that is not in the list runs never, and everything above it
  // passes while the build is unchanged.
  const app = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));
  const names = (app.expo || app).plugins.map(p => (typeof p === 'string' ? p : p[0]));
  assert.ok(names.includes('./plugins/withScreenShareService'),
    'the plugin exists but is never run');
});

test('THE PERMISSION IT NEEDS IS DECLARED', () => {
  // Starting a mediaProjection foreground service on Android 14 without it
  // throws, natively, after the JavaScript call has returned.
  const app = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));
  const perms = (app.expo || app).android.permissions || [];
  assert.ok(perms.includes('android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION'),
    'the service the flag enables cannot start');
  assert.ok(perms.includes('android.permission.FOREGROUND_SERVICE'),
    'no foreground service may start at all');
});

test('THE LIBRARY STILL READS THE FLAG THIS WAY', () => {
  // Pinned against the installed source. If an upgrade starts the service
  // unconditionally, or renames the flag, this plugin becomes a no-op that
  // nothing else would notice — and the tests above would all still pass.
  const svc = path.join(NAT, 'node_modules', 'react-native-webrtc', 'android', 'src',
    'main', 'java', 'com', 'oney', 'WebRTCModule', 'MediaProjectionService.java');
  if (!fs.existsSync(svc)) {
    console.log('  ! react-native-webrtc not installed; skipping the pin');
    return;
  }
  const src = fs.readFileSync(svc, 'utf8');
  assert.ok(src.includes(`if (!WebRTCModuleOptions.getInstance().${plugin.FLAG})`),
    'the library no longer gates the service on this flag — the plugin may be pointless now');
  const opts = fs.readFileSync(path.join(path.dirname(svc), 'WebRTCModuleOptions.java'), 'utf8');
  // No initialiser: a Java boolean field defaults to false. This is the fact
  // the whole diagnosis rests on, so it is checked rather than remembered.
  assert.ok(new RegExp(`public boolean ${plugin.FLAG};`).test(opts),
    'the flag now has a default — check whether it is true before keeping this plugin');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
