// ── Doze is why it works for a minute and then stops ───────────────────────
//
// Reported, on the first build where the socket listener was actually
// attached: "notification worked fine even on closed app for first seconds or
// first minute and then not worked".
//
// That shape — fine for about a minute, then silence — is Doze. It is not the
// foreground service failing, and it is not the socket being replaced, both of
// which were real and are fixed:
//
//   app standby    a foreground service DOES exempt the process from this,
//                  which is why the first minute works at all.
//   Doze           it does NOT. Once the device decides it is idle, network
//                  access for the app is suspended in windows, whatever
//                  services it is running. The socket stops answering pings,
//                  the server times it out — which is the ping-timeout in the
//                  presence log, at 45s to a couple of minutes — and nothing
//                  reaches the phone until the next maintenance window.
//
// There is exactly one documented way out, and the app cannot grant it to
// itself: the user puts the app on the battery-optimisation whitelist.
// Android deliberately makes this a decision only a person can make, so this
// module is about ASKING WELL rather than about a clever workaround. There is
// no clever workaround; anything claiming to be one is a build that still
// stops after a minute.
import * as IntentLauncher from 'expo-intent-launcher';
import { Linking, Platform } from 'react-native';

/**
 * The direct request dialog: one tap, no hunting through Settings.
 *
 * Requires REQUEST_IGNORE_BATTERY_OPTIMIZATIONS in the manifest. Without it
 * the intent is refused and nothing happens — which is why openSettings falls
 * back to a screen that always exists.
 */
export const REQUEST_ACTION = 'android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS';

/** The list of apps and their battery settings. Always available. */
export const LIST_ACTION = 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS';

// This app's own settings page is reached through Linking.openSettings()
// rather than an intent, because the intent form needs the package name and
// the package name differs per brand — the build rewrites it. Getting it
// wrong opens somebody else's settings page, or nothing.

/**
 * Which intent to try, in order, for a given package.
 *
 * A list rather than a single answer because these fail SILENTLY: an intent
 * no activity handles does not throw on every device, it simply does nothing,
 * and a button that does nothing is worse than no button. Each entry is tried
 * until one opens.
 *
 * Pure, so the order and the data URI are testable without a phone — the
 * `package:` prefix in particular is easy to get wrong and impossible to
 * notice, since the wrong form opens the general list instead of this app.
 */
export function intentPlan(pkg?: string | null): Array<{
  action: string; data?: string;
}> {
  const name = String(pkg || '').trim();
  const plan: Array<{ action: string; data?: string }> = [];
  // Only this form asks about THIS app, so it is first when the package is
  // known. It is optional because the package name differs per brand and the
  // build rewrites it; a guessed one opens the wrong app's page or nothing.
  if (name) plan.push({ action: REQUEST_ACTION, data: `package:${name}` });
  // Always available, needs no package: the list of apps and their battery
  // settings, where the user finds this one.
  plan.push({ action: LIST_ACTION });
  return plan;
}

/**
 * Is this worth offering at all?
 *
 * Android only, and only where Doze exists. On Android 5 and below there is
 * nothing to exempt from, and offering a button that opens nothing is the
 * sort of thing that makes a diagnostics screen untrustworthy.
 */
export function offerable(o?: { os?: string; version?: number | string }): boolean {
  const os = o && o.os ? o.os : Platform.OS;
  if (os !== 'android') return false;
  const v = Number(o && o.version != null ? o.version : Platform.Version);
  if (!Number.isFinite(v)) return true; // unknown: offer it rather than hide it
  return v >= 23; // Doze arrived in Marshmallow
}

/**
 * Open the best available screen for it.
 *
 * Never throws: this is offered from a diagnostics panel, and a screen that
 * crashes while explaining why notifications do not work would be a poor
 * joke. Returns whether anything opened, so the caller can say so.
 */
export async function open(pkg?: string | null): Promise<boolean> {
  if (!offerable()) return false;
  for (const step of intentPlan(pkg)) {
    try {
      await IntentLauncher.startActivityAsync(step.action, step.data ? { data: step.data } : {});
      return true;
    } catch {
      // Try the next one. A device without this activity is not an error.
    }
  }
  // This app's own settings page, from React Native, which needs no package
  // name and is the one route that exists on every Android there is. Battery
  // is one tap from there.
  try {
    await Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}


// ── Autostart: the OEM permission Android knows nothing about ──────────────
//
// Reported, and it is the last case left:
//
//   app open ......................... notifications work
//   app closed, service still running  notifications work
//   ALL apps cleared, service gone ... nothing
//
// The third is not a bug in this app and there is no code that fixes it. Once
// the process is dead the socket cannot exist, and the only thing that can
// reach a phone whose app is not running is a push service — which on these
// handsets is Firebase, and Firebase delivers nothing here. That is measured,
// not assumed: dozens sent, every one accepted by Google, none arriving, VPN
// included.
//
// What is left is the OEM's own permission. Stock Android does not kill a
// foreground service when its task is swiped away — notifee's service does
// not even set stopWithTask, so it defaults to staying — but Xiaomi, Huawei,
// Oppo and Vivo all ship a "clear all" that force-stops the process anyway,
// and a force-stopped app is not restarted by anything until a person opens
// it again. Their escape hatch is a per-app "Autostart" toggle that lives in
// the OEM's own settings app, under a different name on each.
//
// None of these intents exists on stock Android, and an intent no activity
// handles fails SILENTLY on many devices, so this is a list to try in order
// and the last step is the app's own settings page, which always opens.
const AUTOSTART_INTENTS: Array<{ action: string; pkg: string; cls: string }> = [
  // Xiaomi / Redmi / POCO — MIUI. The one this was reported from.
  { action: 'android.intent.action.MAIN', pkg: 'com.miui.securitycenter',
    cls: 'com.miui.permcenter.autostart.AutoStartManagementActivity' },
  // Huawei
  { action: 'android.intent.action.MAIN', pkg: 'com.huawei.systemmanager',
    cls: 'com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity' },
  // Oppo / Realme — ColorOS
  { action: 'android.intent.action.MAIN', pkg: 'com.coloros.safecenter',
    cls: 'com.coloros.safecenter.permission.startup.StartupAppListActivity' },
  // Vivo — FuntouchOS
  { action: 'android.intent.action.MAIN', pkg: 'com.vivo.permissionmanager',
    cls: 'com.vivo.permissionmanager.activity.BgStartUpManagerActivity' },
];

/** Exposed so the list can be checked without a phone. */
export function autostartPlan(): typeof AUTOSTART_INTENTS {
  return AUTOSTART_INTENTS.slice();
}

/**
 * Open the OEM's autostart screen, or the app's own settings if there is none.
 *
 * Tries every OEM in turn rather than detecting the manufacturer: the check
 * would be one more thing to get wrong, the wrong ones simply fail, and a
 * rebadged phone reporting an unexpected manufacturer still gets its screen.
 */
export async function openAutostart(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  for (const i of AUTOSTART_INTENTS) {
    try {
      await IntentLauncher.startActivityAsync(i.action, {
        packageName: i.pkg, className: i.cls,
      } as any);
      return true;
    } catch {
      // Not this manufacturer, or the activity moved. Try the next.
    }
  }
  try {
    await Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}
