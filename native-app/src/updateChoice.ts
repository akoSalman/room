// ── What the update button should offer ──────────────────────────────────────
//
// Kept apart from appUpdate.ts, which cannot be loaded outside a device: it
// pulls in the file system, the installer and the notification library. This is
// the decision on its own, so it can be tested.

/**
 * What the update button should offer.
 *
 * Downloading and installing are two separate things, and the second one can
 * fail to happen: Android shows its installer, the user backs out or misses the
 * "allow from this source" prompt, and the APK is left sitting in the cache.
 * The app then offered "Update" again — a second forty-megabyte download of a
 * file already on the phone, which for these users is the expensive part.
 *
 * So a finished download is offered as INSTALL instead, but only while it is
 * still the newest thing available. Once a newer build exists the file is out
 * of date and downloading really is the right thing to do.
 */
export type UpdateChoice = 'install' | 'update' | 'up-to-date' | 'unknown';

export function installChoice(o: {
  /** Version of an APK already downloaded and not yet installed. */
  downloadedVersion: number | null;
  /** Newest version the server offers, or null if the check failed. */
  latestVersion: number | null;
  /** The version running right now. */
  currentVersion: number;
}): UpdateChoice {
  // Without knowing what is available, nothing can be recommended.
  if (o.latestVersion === null) return 'unknown';
  if (o.currentVersion === o.latestVersion) return 'up-to-date';
  const d = o.downloadedVersion;
  // Offer the file on disk only while it is both newer than what is running and
  // not itself out of date.
  if (d !== null && d >= o.latestVersion && d > o.currentVersion) return 'install';
  return 'update';
}
