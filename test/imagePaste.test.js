// ── The plugin that puts the paste code where it compiles ───────────────────
//
// The first attempt at this feature patched ReactEditText.java in
// node_modules. Since React Native 0.71 the Android code is a prebuilt
// artifact from Maven, so that file is not compiled unless the project builds
// React Native from source — and this one does not. The patch applied
// cleanly, had four passing tests, and never ran once.
//
// So the two properties worth testing are not about Java. They are:
//
//   1. the code is written into the app's own module, which IS compiled;
//   2. the package is registered in MainApplication, because a module nobody
//      registers is as dead as a patch nobody compiles.
//
// Both are checked by running the plugin's own functions, not by reading them.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAT = path.join(__dirname, '..', 'native-app');
const plugin = require(path.join(NAT, 'plugins', 'withImagePaste.js'));

const tests = [];
const test = (n, f) => tests.push({ n, f });

// What Expo generates for this app: Kotlin since SDK 50.
const KOTLIN = `package com.bistbarg.chat

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactPackage

class MainApplication : Application(), ReactApplication {
  override fun getPackages(): List<ReactPackage> {
    return PackageList(this).packages.apply {
      // Packages that cannot be autolinked yet can be added manually here
    }
  }
}
`;

const JAVA = `package com.bistbarg.chat;

public class MainApplication extends Application implements ReactApplication {
  protected List<ReactPackage> getPackages() {
    List<ReactPackage> packages = new PackageList(this).getPackages();
    return packages;
  }
}
`;

test('THE PACKAGE IS REGISTERED, or the module is as dead as the patch was', () => {
  const out = plugin.applyToMainApplication(KOTLIN, 'kt', 'com.bistbarg.chat');
  assert.ok(out.includes('add(ImagePastePackage())'), 'nothing registers the package');
  // Inside the list it is building, not loose in the file.
  const apply = out.slice(out.indexOf('PackageList(this).packages.apply {'), out.indexOf('\n  }'));
  assert.ok(apply.includes('add(ImagePastePackage())'),
    'the registration is outside the package list, so it does not compile');
});

test('…in Java too, because the generated language is not ours to choose', () => {
  const out = plugin.applyToMainApplication(JAVA, 'java', 'com.bistbarg.chat');
  assert.ok(out.includes('packages.add(new ImagePastePackage());'),
    'a Java MainApplication is left without the package');
  assert.ok(out.indexOf('packages.add(new ImagePastePackage());') > out.indexOf('new PackageList(this).getPackages();'),
    'the package is added to a list that does not exist yet');
});

test('RUNNING IT TWICE DOES NOT REGISTER IT TWICE', () => {
  // Prebuild is not always clean, and a second add() would construct the
  // module twice — or fail to compile.
  const once = plugin.applyToMainApplication(KOTLIN, 'kt', 'com.bistbarg.chat');
  const twice = plugin.applyToMainApplication(once, 'kt', 'com.bistbarg.chat');
  assert.strictEqual(twice, once, 'applying the plugin twice changes the file twice');
  assert.strictEqual((twice.match(/ImagePastePackage/g) || []).length, 1,
    'the package is registered more than once');
});

test('A FILE IT DOES NOT RECOGNISE IS LEFT ALONE', () => {
  // Returning something half-edited would break the build for everything,
  // not just pasting.
  for (const bad of ['', null, undefined, 'package com.x\n\nclass Other {}\n']) {
    const out = plugin.applyToMainApplication(bad, 'kt', 'com.bistbarg.chat');
    assert.strictEqual(out, bad, `a file it could not place the package in was edited: ${bad}`);
  }
});

test('THE JAVA IS WRITTEN INTO THE APP\'S OWN MODULE', () => {
  // The whole lesson of the first attempt. android/app/src/main/java is
  // compiled; node_modules/react-native/ReactAndroid/src is not.
  const dir = plugin.javaDirFor('/tmp/project', 'com.bistbarg.chat');
  assert.strictEqual(dir,
    path.join('/tmp/project', 'android', 'app', 'src', 'main', 'java', 'com', 'bistbarg', 'chat'),
    'the Java goes somewhere other than the app module');
});

test('…with the brand\'s own package name', () => {
  // Two brands build from this tree with different application ids, and a
  // Java file whose package does not match its directory does not compile.
  const src = fs.readFileSync(path.join(NAT, 'plugins', 'imagePaste', 'ImagePasteModule.java'), 'utf8');
  const out = plugin.sourceFor(src, 'com.akosalman.chat');
  assert.ok(out.startsWith('package com.akosalman.chat;'), 'the package line was not replaced');
  assert.ok(!out.includes('__PACKAGE__'), 'a placeholder survived into the compiled source');
});

test('BOTH FILES ARE COPIED, and they are the ones that exist', () => {
  // A package registered in MainApplication whose class was never copied is
  // a build that does not compile at all.
  for (const name of plugin.SOURCES) {
    assert.ok(fs.existsSync(path.join(NAT, 'plugins', 'imagePaste', name)),
      `${name} is registered to be copied and is not there`);
  }
  assert.deepStrictEqual([...plugin.SOURCES].sort(),
    ['ImagePasteModule.java', 'ImagePastePackage.java'],
    'the module or its package is no longer copied');
});

test('THE PLUGIN IS ACTUALLY TURNED ON', () => {
  // Written, correct, and not listed in app.json is the same as absent.
  const app = JSON.parse(fs.readFileSync(path.join(NAT, 'app.json'), 'utf8'));
  assert.ok((app.expo.plugins || []).includes('./plugins/withImagePaste'),
    'the plugin is never run, so none of this reaches the project');
});

let passed = 0, failed = 0;
for (const { n, f } of tests) {
  try { f(); console.log(`  ✓ ${n}`); passed++; }
  catch (e) { console.error(`  ✗ ${n}\n      ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
