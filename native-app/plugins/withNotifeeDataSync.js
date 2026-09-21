// ── Let notifee's foreground service run as dataSync ────────────────────────
//
// Notifications work while the app's process is alive and not when it is not.
// Keeping the socket alive needs a foreground service, and the first attempt
// at one crashed the app on launch. This is why, found by unpacking notifee's
// own AAR:
//
//     <service android:name="app.notifee.core.ForegroundService"
//              android:foregroundServiceType="shortService" />
//
// notifee declares shortService. The code asked for DATA_SYNC. On Android 14
// startForeground() with a type the manifest does not declare throws
// MissingForegroundServiceTypeException — natively, after the JavaScript call
// has already returned — and the process dies. Declaring the PERMISSION
// FOREGROUND_SERVICE_DATA_SYNC does not help: the permission says the app may
// ask, the manifest attribute says what the service IS.
//
// AND shortService IS NO USE HERE, which is the part that makes this a
// manifest change rather than a one-word fix in the calling code. Android 14
// gives a shortService a hard ceiling of about three minutes, after which the
// app must stop it or be killed. A socket that dies after three minutes is
// not a socket that is being kept alive.
//
// So the app's own manifest overrides the library's attribute. The merger
// needs tools:replace to be told that the override is deliberate — without it
// the build fails with a merge conflict rather than silently picking one.
const { withAndroidManifest, AndroidConfig } = require('@expo/config-plugins');

const SERVICE = 'app.notifee.core.ForegroundService';
/** dataSync has no time limit. shortService, which notifee declares, does. */
const TYPE = 'dataSync';

/**
 * The whole change, as a function of the manifest.
 *
 * Separated from the plugin wrapper so it can be driven directly by a test. A
 * plugin that is registered and silently does nothing passes every check that
 * only reads the source, and then crashes the app exactly as before — which
 * is the failure this file exists to prevent, so it is not left to inspection.
 */
function applyToManifest(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

  // tools: is what marks the override as intentional. Without the namespace
  // on <manifest>, tools:replace below is an unknown attribute and the merge
  // fails.
  manifest.manifest.$ = manifest.manifest.$ || {};
  manifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

  app.service = app.service || [];
  let svc = app.service.find(s => s && s.$ && s.$['android:name'] === SERVICE);
  if (!svc) {
    svc = { $: { 'android:name': SERVICE } };
    app.service.push(svc);
  }
  svc.$['android:foregroundServiceType'] = TYPE;
  svc.$['android:exported'] = 'false';
  // Replace the library's value rather than merging with it: two different
  // values for one attribute is a manifest-merger error, and the build stops
  // rather than choosing.
  svc.$['tools:replace'] = 'android:foregroundServiceType';
  return manifest;
}

module.exports = function withNotifeeDataSync(config) {
  return withAndroidManifest(config, (cfg) => {
    applyToManifest(cfg.modResults);
    return cfg;
  });
};

module.exports.applyToManifest = applyToManifest;

// Exported for the test, so the values it checks come from here rather than
// being written out a second time.
module.exports.SERVICE = SERVICE;
module.exports.TYPE = TYPE;
