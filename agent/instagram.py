"""Fetch the shop's own posts via the Instagram Graph API.

Requires a Business/Creator Instagram account. IG_USER_ID is the numeric
Instagram user id; IG_ACCESS_TOKEN is a long-lived access token.
See README.md for the one-time setup.
"""

from dataclasses import dataclass
from pathlib import Path

import requests

GRAPH_BASE = "https://graph.instagram.com"


@dataclass
class IgVideo:
    media_id: str
    caption: str
    media_url: str
    permalink: str
    timestamp: str


def fetch_videos(ig_user_id: str, access_token: str, max_items: int = 200) -> list[IgVideo]:
    """Return all VIDEO/REELS posts of the account, newest first."""
    videos: list[IgVideo] = []
    url = f"{GRAPH_BASE}/{ig_user_id}/media"
    params = {
        "fields": "id,caption,media_type,media_url,permalink,timestamp",
        "access_token": access_token,
        "limit": 50,
    }
    while url and len(videos) < max_items:
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        for item in payload.get("data", []):
            if item.get("media_type") in ("VIDEO", "REELS") and item.get("media_url"):
                videos.append(
                    IgVideo(
                        media_id=item["id"],
                        caption=item.get("caption") or "",
                        media_url=item["media_url"],
                        permalink=item.get("permalink", ""),
                        timestamp=item.get("timestamp", ""),
                    )
                )
        url = payload.get("paging", {}).get("next")
        params = {}  # the "next" URL already contains all query params
    return videos


def download_video(video: IgVideo, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(video.media_url, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                f.write(chunk)
    return dest
