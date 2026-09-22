// ── The grey square where the app's icon should be ──────────────────────────
//
// Reported with a photograph of the shade: the keep-alive notification says
// "Connected", and beside it is a blank grey box.
//
// notifee draws that notification, and notifee's own AAR settles what happens
// when no icon is named. NotificationAndroidModel.getSmallIcon returns null
// the moment the `smallIcon` key is absent from the bundle, and the builder
// then skips setSmallIcon entirely:
//
//     751: getSmallIcon:()Ljava/lang/Integer;
//     756: ifnull  796          ← straight past setSmallIcon
//
// With no small icon set, Android falls back to the launcher icon and renders
// it the way it renders every small icon: as a silhouette, keeping only the
// alpha channel. A full-colour launcher icon is opaque everywhere, so its
// silhouette is a solid square — which is exactly what the photograph shows.
//
// None of the three notifee call sites named an icon. This was never a
// keep-alive problem: the message notifications and the update progress bar
// drew the same grey square.
//
// What was already there, unused: the expo-notifications plugin is configured
// with `icon: './assets/notification-icon.png'`, and its build step writes
// that into the Android resources as drawable/notification_icon — a proper
// silhouette asset, 5% opaque and a single near-white colour, so Android's
// alpha-only rendering gives the app's shape rather than a block. It was
// wired to expo-notifications and to Firebase through manifest meta-data,
// which notifee does not read.
//
// So the fix is to name it. One module rather than three string literals,
// because the day that resource is renamed all three must move together, and
// notifee's failure mode for a name that does not resolve is to log a line
// nobody will read and draw the grey square again.

/**
 * The drawable the expo-notifications plugin generates from
 * `expo.plugins['expo-notifications'].icon` in app.json.
 *
 * Kept identical to NOTIFICATION_ICON in that plugin's source. A test
 * asserts the two still agree, because a silent mismatch here looks exactly
 * like the bug it fixes.
 */
export const SMALL_ICON = 'notification_icon';

/** The tint Android applies to the silhouette. Same source as the icon. */
export const ICON_COLOR = '#3b7dd8';

/**
 * The icon fields every notifee notification needs.
 *
 * Spread into an `android` block. Deliberately not a whole notification
 * helper: the three call sites differ in every other respect, and a wrapper
 * that tried to unify them would be a worse thing than three spreads.
 */
export function iconFields(): { smallIcon: string; color: string } {
  return { smallIcon: SMALL_ICON, color: ICON_COLOR };
}
