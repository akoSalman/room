// ── Video send quality ───────────────────────────────────────────────────────
//
// A phone records 1080p (often 4K) at a bitrate far higher than anything needs
// for a chat, so a 30-second clip can be 60-100 MB. Re-encoding to a sensible
// resolution and bitrate makes it a few MB with no visible difference on a
// phone screen.
//
// The maths — target dimensions, and the size estimate shown next to each
// option — lives here, away from the native transcoder, so it can be tested.

export type VideoQuality = 'low' | 'medium' | 'high' | 'original';

export type VideoPreset = {
  id: VideoQuality;
  label: string;
  /** Longest edge of the output, in pixels. 0 = leave the video alone. */
  maxEdge: number;
  /** Video bitrate in bits per second. */
  bitrate: number;
};

// Three re-encoding choices plus the untouched original. The bitrates are
// chosen to look clean at each size rather than to hit a particular file size.
export const VIDEO_PRESETS: VideoPreset[] = [
  { id: 'low', label: '480p', maxEdge: 854, bitrate: 800_000 },
  { id: 'medium', label: '720p', maxEdge: 1280, bitrate: 1_800_000 },
  { id: 'high', label: '1080p', maxEdge: 1920, bitrate: 3_500_000 },
  { id: 'original', label: 'Original', maxEdge: 0, bitrate: 0 },
];

export function presetFor(id: VideoQuality): VideoPreset {
  return VIDEO_PRESETS.find(p => p.id === id) || VIDEO_PRESETS[1];
}

/**
 * Output dimensions for a source of this size, or null to leave it alone.
 *
 * Never upscales: a 480p clip sent as "1080p" would be a bigger file with no
 * more detail. The result is rounded to EVEN numbers because H.264 encoders
 * reject odd dimensions — a detail that only shows up as a failed export on a
 * device, which is exactly why it is pinned down by a test here.
 */
export function videoTarget(
  width: number, height: number, quality: VideoQuality,
): { width: number; height: number } | null {
  const preset = presetFor(quality);
  if (!preset.maxEdge) return null;
  if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return null;

  const longest = Math.max(width, height);
  if (longest <= preset.maxEdge) return null;

  const scale = preset.maxEdge / longest;
  const even = (n: number) => Math.max(2, Math.round(n * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** Seconds of video that will actually be sent, given a trim range. */
export function trimmedDuration(
  durationSec: number, startSec: number, endSec: number,
): number {
  if (!isFinite(durationSec) || durationSec <= 0) return 0;
  const start = Math.max(0, Math.min(startSec, durationSec));
  const end = Math.max(start, Math.min(endSec, durationSec));
  return end - start;
}

/**
 * Rough output size in bytes: bitrate × duration, plus a nominal audio track.
 *
 * An estimate, shown so nobody has to guess what an option costs. For
 * "original" the real file size is known, so it is scaled by how much of the
 * clip survives the trim instead.
 */
export function estimateBytes(
  quality: VideoQuality, seconds: number, originalBytes = 0, originalSeconds = 0,
): number {
  if (seconds <= 0) return 0;
  const preset = presetFor(quality);
  if (!preset.bitrate) {
    if (originalBytes <= 0) return 0;
    if (originalSeconds <= 0) return originalBytes;
    // Trimming an untouched file keeps roughly its own bitrate.
    return Math.round(originalBytes * Math.min(1, seconds / originalSeconds));
  }
  const AUDIO_BITRATE = 128_000;
  return Math.round(((preset.bitrate + AUDIO_BITRATE) / 8) * seconds);
}

/** mm:ss for the trim handles. */
export function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
