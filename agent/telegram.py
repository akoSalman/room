"""Post the clip to Telegram via the Bot API."""

from pathlib import Path

import requests


def send_video(bot_token: str, chat_id: str, video_path: Path, caption: str) -> dict:
    url = f"https://api.telegram.org/bot{bot_token}/sendVideo"
    with open(video_path, "rb") as f:
        resp = requests.post(
            url,
            data={
                "chat_id": chat_id,
                "caption": caption,
                "supports_streaming": True,
            },
            files={"video": (video_path.name, f, "video/mp4")},
            timeout=300,
        )
    payload = resp.json()
    if not payload.get("ok"):
        raise RuntimeError(f"Telegram sendVideo failed: {payload}")
    return payload["result"]


def send_message(bot_token: str, chat_id: str, text: str) -> None:
    requests.post(
        f"https://api.telegram.org/bot{bot_token}/sendMessage",
        data={"chat_id": chat_id, "text": text},
        timeout=30,
    )
