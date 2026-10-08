// ── Turning on the service that screen sharing cannot work without ─────────
//
// Screen share has been reported four times. Three rounds were spent on
// theories about the encoder; this one comes from the device's own numbers,
// which the server now collects:
//
//     scale=1.83  encoded=0  sent=0  size=0x0  after=5s
//
// Read that carefully, because it rules out almost everything. `scale=1.83`
// says the capture reported its dimensions and the downscale was applied, so
// the last round's theory was tested and is dead. `size=0x0` says the encoder
// never learned a frame size — it was never handed a single frame. Not a
// frame it refused: a frame it never received. Nothing downstream of the
// capturer can produce that.
//
// The capturer is where it goes wrong, and the reason is three lines in
// react-native-webrtc:
//
//     public static void launch(Context context) {
//         if (!WebRTCModuleOptions.getInstance().enableMediaProjectionService) {
//             return;
//         }
//
// `enableMediaProjectionService` is a plain Java boolean with no initialiser,
// so it is FALSE unless the app sets it. Nothing sets it: not the library,
// not @config-plugins/react-native-webrtc, not this app. So the foreground
// service is never started, and since Android 10 a MediaProjection without a
// running foreground service of type mediaProjection cannot produce frames.
//
// Every layer above reports success, which is why this looked like a call
// problem for so long. The permission sheet appears and is granted; a track
// object is created; getDisplayMedia resolves; replaceTrack puts the track in
// the sender. captured=1, senders=1, switched=1 — all true, all meaningless,
// because the thing at the far end of the track was never switched on.
//
// The service itself is already declared, by the library's own manifest, with
// the right foregroundServiceType; the permission is already in app.json. The
// only missing piece is the flag, and it has to be set in MainApplication
// because that is the only code in an Expo app that runs before any of this.
const { withMainApplication } = require('@expo/config-plugins');

const IMPORT = 'com.oney.WebRTCModule.WebRTCModuleOptions';
/** Read by MediaProjectionService.launch every time a share starts. */
const FLAG = 'enableMediaProjectionService';

/**
 * Put the two lines into MainApplication, in whichever language it is.
 *
 * Expo regenerates this file on every build, so this runs against a fresh
 * copy each time and must be idempotent anyway — a build that applied it
 * twice would not compile.
 */
function applyToMainApplication(src, language) {
  if (typeof src !== 'string' || !src) return src;
  // Already done. Prebuild is not always clean, and a second copy of the
  // import is a compile error rather than a no-op.
  if (src.includes(FLAG)) return src;

  const kotlin = language === 'kt' || /fun onCreate\(\)/.test(src);
  const importLine = kotlin ? `import ${IMPORT}` : `import ${IMPORT};`;
  const setLine = kotlin
    ? `    WebRTCModuleOptions.getInstance().${FLAG} = true`
    : `    WebRTCModuleOptions.getInstance().${FLAG} = true;`;

  let out = src;

  // After the package declaration, which every one of these files starts
  // with, rather than after some other import that may not be there.
  const pkg = /^package .*$/m.exec(out);
  if (!pkg) return src;
  out = out.slice(0, pkg.index + pkg[0].length)
    + '\n\n' + importLine
    + out.slice(pkg.index + pkg[0].length);

  // Inside onCreate, before super.onCreate(). The flag is read when a share
  // starts rather than at startup, so anywhere in onCreate would do — but
  // first means it cannot end up after some future early return.
  const onCreate = kotlin
    ? /override fun onCreate\(\) \{/.exec(out)
    : /public void onCreate\(\) \{/.exec(out);
  if (!onCreate) return src;
  const at = onCreate.index + onCreate[0].length;
  out = out.slice(0, at)
    + '\n    // Screen sharing captures nothing at all without this: since\n'
    + '    // Android 10 a MediaProjection needs a running foreground service\n'
    + '    // of type mediaProjection, and the library will not start one\n'
    + '    // unless it is told to. Off by default; nothing else sets it.\n'
    + setLine
    + out.slice(at);

  return out;
}

module.exports = function withScreenShareService(config) {
  return withMainApplication(config, (cfg) => {
    cfg.modResults.contents = applyToMainApplication(
      cfg.modResults.contents, cfg.modResults.language);
    return cfg;
  });
};

module.exports.applyToMainApplication = applyToMainApplication;
module.exports.FLAG = FLAG;
module.exports.IMPORT = IMPORT;
