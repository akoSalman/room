"""Cut the most interesting segment out of a product video.

Pipeline: ffmpeg scene detection -> one preview frame per scene ->
Claude vision ranks the frames -> ffmpeg cuts the chosen segment.
Falls back to the opening seconds when anything is unavailable.
"""

import base64
import json
import re
import subprocess
from pathlib import Path

from anthropic import Anthropic

MAX_FRAMES = 8

PICK_SCHEMA = {
    "type": "object",
    "properties": {
        "segment_index": {"type": "integer", "description": "0-based index of the best segment"},
        "reason": {"type": "string"},
    },
    "required": ["segment_index", "reason"],
    "additionalProperties": False,
}


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def video_duration(path: Path) -> float:
    proc = _run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ])
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def detect_scene_starts(path: Path, threshold: float = 0.3) -> list[float]:
    """Timestamps (seconds) where a new scene begins, including 0.0."""
    proc = _run([
        "ffmpeg", "-i", str(path),
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-f", "null", "-",
    ])
    starts = [0.0]
    for match in re.finditer(r"pts_time:([0-9.]+)", proc.stderr):
        t = float(match.group(1))
        if t - starts[-1] >= 1.0:  # ignore near-duplicate cuts
            starts.append(t)
    return starts


def extract_frame(path: Path, at_seconds: float, dest: Path) -> Path | None:
    proc = _run([
        "ffmpeg", "-y", "-ss", f"{at_seconds:.2f}", "-i", str(path),
        "-frames:v", "1", "-q:v", "3", "-vf", "scale=640:-2", str(dest),
    ])
    return dest if dest.exists() and proc.returncode == 0 else None


def pick_best_segment(
    client: Anthropic,
    model: str,
    product_name: str,
    video_path: Path,
    workdir: Path,
    clip_seconds: int,
) -> tuple[float, str]:
    """Return (start_seconds, reason) for the best clip window."""
    duration = video_duration(video_path)
    if duration <= clip_seconds + 1:
        return 0.0, "video is short; using it from the start"

    starts = detect_scene_starts(video_path)
    # Keep only starts that leave room for a full clip.
    starts = [s for s in starts if s <= duration - clip_seconds] or [0.0]
    if len(starts) > MAX_FRAMES:
        step = len(starts) / MAX_FRAMES
        starts = [starts[int(i * step)] for i in range(MAX_FRAMES)]

    if len(starts) == 1:
        return starts[0], "only one scene detected"

    frames = []
    for i, s in enumerate(starts):
        frame = extract_frame(video_path, min(s + 1.0, duration - 0.5), workdir / f"frame_{i}.jpg")
        if frame:
            frames.append((i, s, frame))
    if not frames:
        return 0.0, "frame extraction failed; using the start"

    content: list[dict] = [
        {
            "type": "text",
            "text": (
                f"These frames are the beginnings of {len(frames)} segments of a "
                f"product video for an online shop. The product is: {product_name}.\n"
                f"Pick the segment that would make the most engaging "
                f"{clip_seconds}-second promo clip: prefer clear close-ups of the "
                f"product, the product in use, good lighting, and visual interest. "
                f"Frames are numbered in order."
            ),
        }
    ]
    for i, _, frame in frames:
        content.append({"type": "text", "text": f"Segment {i}:"})
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": base64.standard_b64encode(frame.read_bytes()).decode(),
                },
            }
        )

    response = client.messages.create(
        model=model,
        max_tokens=1000,
        output_config={"format": {"type": "json_schema", "schema": PICK_SCHEMA}},
        messages=[{"role": "user", "content": content}],
    )
    text = "".join(b.text for b in response.content if b.type == "text")
    result = json.loads(text)

    chosen = {i: s for i, s, _ in frames}.get(result["segment_index"])
    if chosen is None:
        return frames[0][1], "model picked an unknown segment; using the first"
    return chosen, result["reason"]


def cut_clip(video_path: Path, start: float, clip_seconds: int, dest: Path) -> Path:
    proc = _run([
        "ffmpeg", "-y", "-ss", f"{start:.2f}", "-i", str(video_path),
        "-t", str(clip_seconds),
        "-vf", "scale='min(720,iw)':-2",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        str(dest),
    ])
    if proc.returncode != 0 or not dest.exists():
        raise RuntimeError(f"ffmpeg failed to cut clip: {proc.stderr[-500:]}")
    return dest
