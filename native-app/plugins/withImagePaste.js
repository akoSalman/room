// ── Making the keyboard's image key work ────────────────────────────────────
//
// Reported twice with a photograph of Gboard refusing: "BistbargChat does not
// support image pasting here". Asked for again as: do not give me a Paste
// button, make the keyboard's own paste work, and put the image in the
// composer as something to send.
//
// THE FIRST FIX NEVER RAN. It patched ReactEditText.java in node_modules, and
// since React Native 0.71 the Android code is a prebuilt artifact from Maven —
// node_modules/react-native/ReactAndroid/src is not compiled unless the
// project builds React Native from source, and this one does not. React
// Native's own node_modules/react-native/android/README.md says so outright.
// The patch applied cleanly, had four passing tests, and changed nothing. The
// tests checked the SHAPE OF A PATCH FILE, which is not the same as checking
// that any of it runs.
//
// So the code moves to where the build actually compiles it: the app's own
// module. That is what this plugin is for — it copies the two Java files in
// ./imagePaste into the generated project and registers the package.
//
// Expo regenerates android/ on every build, so this runs against a fresh tree
// each time and is written to be idempotent anyway.
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');

/** The two files, which live beside this plugin so they can be read and linted. */
const SOURCES = ['ImagePasteModule.java', 'ImagePastePackage.java'];
const CLASS = 'ImagePastePackage';

/**
 * Add the package to MainApplication's list, in whichever language it is.
 *
 * Exported and pure so it can be tested without a generated project — the
 * same shape as withScreenShareService next door, for the same reason: this
 * edit is the difference between a module that is registered and one that is
 * compiled and never reachable.
 */
function applyToMainApplication(src, language, pkgName) {
  if (typeof src !== 'string' || !src) return src;
  // Prebuild is not always clean, and a second add() would register the
  // module twice.
  if (src.includes(CLASS)) return src;

  const kotlin = language === 'kt' || /fun getPackages\(\)/.test(src);

  // The list comes from PackageList(this).packages, which Expo generates with
  // a comment showing exactly where a hand-written package goes.
  if (kotlin) {
    const m = /PackageList\(this\)\.packages\.apply \{/.exec(src);
    if (!m) return src;
    const at = m.index + m[0].length;
    return src.slice(0, at)
      + `\n            // The keyboard's image key is grey until something declares that`
      + `\n            // this app accepts images. See plugins/imagePaste.`
      + `\n            add(${CLASS}())`
      + src.slice(at);
  }

  const m = /List<ReactPackage> packages = new PackageList\(this\)\.getPackages\(\);/.exec(src);
  if (!m) return src;
  const at = m.index + m[0].length;
  return src.slice(0, at)
    + `\n      // The keyboard's image key is grey until something declares that`
    + `\n      // this app accepts images. See plugins/imagePaste.`
    + `\n      packages.add(new ${CLASS}());`
    + src.slice(at);
}

/** Where the app's own Java lives in the generated project. */
function javaDirFor(projectRoot, androidPackage) {
  return path.join(
    projectRoot, 'android', 'app', 'src', 'main', 'java',
    ...androidPackage.split('.'),
  );
}

/**
 * The file as it will be compiled: the placeholder package replaced by the
 * app's real one, which differs between brands.
 */
function sourceFor(contents, androidPackage) {
  return contents.replace(/__PACKAGE__/g, androidPackage);
}

module.exports = function withImagePaste(config) {
  let cfg = withDangerousMod(config, ['android', (c) => {
    const androidPackage = c.android && c.android.package;
    if (!androidPackage) return c;
    const dir = javaDirFor(c.modRequest.projectRoot, androidPackage);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of SOURCES) {
      const from = path.join(__dirname, 'imagePaste', name);
      fs.writeFileSync(
        path.join(dir, name),
        sourceFor(fs.readFileSync(from, 'utf8'), androidPackage),
      );
    }
    return c;
  }]);

  return withMainApplication(cfg, (c) => {
    c.modResults.contents = applyToMainApplication(
      c.modResults.contents, c.modResults.language, c.android && c.android.package);
    return c;
  });
};

module.exports.applyToMainApplication = applyToMainApplication;
module.exports.sourceFor = sourceFor;
module.exports.javaDirFor = javaDirFor;
module.exports.SOURCES = SOURCES;
module.exports.CLASS = CLASS;
