// ── Where the app looks for its own updates ──────────────────────────────────
//
// Asked for as: upload the newest version to each brand's server and get the
// update file from there instead of from GitHub.
//
// The reason it matters is not tidiness. The check asked api.github.com and
// the download came from a GitHub release, and for the people this app is for
// GitHub is unreliable at best and unreachable at worst. The chat server, by
// contrast, is the one host every user of a brand can definitely reach — they
// are talking to it right now.
//
// So the brand's own server is asked first and GitHub is kept as a fallback,
// because a server that has not been given a build yet must not mean no
// updates at all.
//
// A failed check is its own answer. Not knowing whether a newer build exists
// is different from knowing there is none, and conflating the two is what put
// an active "Update now" button in the profile while the header showed
// nothing — the button believed an unknown version was worth downloading and
// the badge believed the opposite.

export type Manifest = {
  version: number;
  /** Absolute, or relative to the server it came from. */
  url: string;
  size?: number;
  sha256?: string | null;
  notes?: string;
};

export type Source = 'server' | 'github' | null;

export type UpdateInfo = {
  latestVersion: number | null;
  /** Where the APK will be fetched from, ready to hand to the downloader. */
  apkUrl: string | null;
  source: Source;
  /** True when neither place could be asked at all. */
  failed: boolean;
  /**
   * How big the build is, when the source said.
   *
   * Carried through because the DOWNLOAD needs it: a response with no
   * Content-Length cannot report a percentage, and this is the only other
   * place the size is known. GitHub's fallback url has none, so it is
   * undefined there and the download falls back to showing bytes.
   */
  sizeBytes?: number;
};

export const UNKNOWN: UpdateInfo = {
  latestVersion: null, apkUrl: null, source: null, failed: true,
};

/** Read the server's manifest, defensively: anything odd counts as no answer. */
export function parseServerManifest(body: any): Manifest | null {
  if (!body || typeof body !== 'object') return null;
  const version = parseInt(body.version, 10);
  if (!Number.isInteger(version) || version <= 0) return null;
  const url = typeof body.url === 'string' && body.url ? body.url : '/app/download';
  return {
    version,
    url,
    size: typeof body.size === 'number' ? body.size : undefined,
    sha256: typeof body.sha256 === 'string' ? body.sha256 : null,
    notes: typeof body.notes === 'string' ? body.notes : '',
  };
}

/**
 * The version buried in a GitHub release.
 *
 * The build number is written into the release notes as "version:NNN" and into
 * the title as "vNNN". Both are checked because the two have disagreed before.
 */
export function parseGithubRelease(body: any): number | null {
  if (!body || typeof body !== 'object') return null;
  const m = /version:(\d+)/.exec(String(body.body || ''))
    || /v(\d+)\b/.exec(String(body.name || ''));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Turn a manifest URL into something fetchable. */
export function absoluteUrl(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

/**
 * Which answer to believe.
 *
 * The server wins when it has one — it is this brand's own build, and it is
 * reachable. GitHub is consulted only when the server has nothing to say,
 * which covers a server that has not been given a build yet.
 */
export function chooseSource(o: {
  server: Manifest | null; github: number | null; baseUrl: string; githubUrl: string;
}): UpdateInfo {
  if (o.server) {
    return {
      latestVersion: o.server.version,
      apkUrl: absoluteUrl(o.server.url, o.baseUrl),
      source: 'server',
      failed: false,
      sizeBytes: o.server.size,
    };
  }
  if (o.github !== null) {
    return { latestVersion: o.github, apkUrl: o.githubUrl, source: 'github', failed: false };
  }
  return UNKNOWN;
}

/**
 * Should the header show its update badge?
 *
 * Only for a build that is genuinely NEWER. The old test was "different from
 * the one running", which would advertise an update to somebody testing a
 * build ahead of the server's — and it required a version, so a failed check
 * hid the badge while the profile still offered a confident Update button.
 * They now answer from the same rule.
 */
export function updateAvailable(o: {
  latestVersion: number | null; currentVersion: number;
}): boolean {
  if (o.latestVersion === null) return false;
  // 0 is a local build, which is by definition not something to update from a
  // release channel — but it is also the value CI never stamps, so treating it
  // as "older than everything" would nag every developer forever.
  if (!o.currentVersion) return false;
  return o.latestVersion > o.currentVersion;
}
