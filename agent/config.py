"""Configuration loaded from environment variables.

See .env.example for documentation of every variable.
"""

import os
import sys
from dataclasses import dataclass, field


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"ERROR: required environment variable {name} is not set", file=sys.stderr)
        sys.exit(2)
    return value


@dataclass
class Config:
    anthropic_api_key: str = field(default_factory=lambda: _require("ANTHROPIC_API_KEY"))
    sheet_csv_url: str = field(default_factory=lambda: _require("SHEET_CSV_URL"))
    ig_user_id: str = field(default_factory=lambda: _require("IG_USER_ID"))
    ig_access_token: str = field(default_factory=lambda: _require("IG_ACCESS_TOKEN"))
    telegram_bot_token: str = field(default_factory=lambda: _require("TELEGRAM_BOT_TOKEN"))
    telegram_channel_id: str = field(default_factory=lambda: _require("TELEGRAM_CHANNEL_ID"))

    # Optional: when set, posts go here (your private chat) instead of the channel.
    telegram_draft_chat_id: str = field(
        default_factory=lambda: os.environ.get("TELEGRAM_DRAFT_CHAT_ID", "").strip()
    )
    # Optional: language for generated captions. Default: match the Instagram caption.
    caption_language: str = field(
        default_factory=lambda: os.environ.get("CAPTION_LANGUAGE", "").strip()
    )
    clip_seconds: int = field(
        default_factory=lambda: int(os.environ.get("CLIP_SECONDS", "12"))
    )
    model: str = field(
        default_factory=lambda: os.environ.get("CLAUDE_MODEL", "claude-opus-4-8")
    )

    @property
    def draft_mode(self) -> bool:
        return bool(self.telegram_draft_chat_id)

    @property
    def target_chat_id(self) -> str:
        return self.telegram_draft_chat_id or self.telegram_channel_id
