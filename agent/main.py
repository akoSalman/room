"""Daily run: pick a product, find its Instagram video, clip it, caption it,
post it to Telegram.

Usage:
    python -m agent.main            # normal run
    python -m agent.main --dry-run  # everything except the Telegram upload
"""

import sys
import tempfile
from pathlib import Path

from anthropic import Anthropic

from . import clipper, instagram, matcher, sheet, state, telegram
from .captioner import write_caption
from .config import Config


def run(dry_run: bool = False) -> int:
    cfg = Config()
    client = Anthropic(api_key=cfg.anthropic_api_key)

    print("Reading product sheet...")
    products = sheet.fetch_products(cfg.sheet_csv_url)
    if not products:
        print("No products found in the sheet — nothing to do.")
        return 0
    print(f"  {len(products)} products in the sheet")

    posted = state.load_state()
    product = state.pick_next_product(products, posted)
    print(f"Today's product: {product.name} ({product.price})")

    print("Fetching Instagram videos...")
    videos = instagram.fetch_videos(cfg.ig_user_id, cfg.ig_access_token)
    print(f"  {len(videos)} video posts found")

    video, reason = matcher.match_product_to_video(client, cfg.model, product.name, videos)
    if video is None:
        msg = f"⚠️ Skipped '{product.name}': no confident video match ({reason})"
        print(msg)
        if not dry_run:
            telegram.send_message(cfg.telegram_bot_token, cfg.target_chat_id, msg)
        # Mark it so the rotation moves on instead of getting stuck.
        state.mark_posted(posted, product, media_id="no-match")
        state.save_state(posted)
        return 0
    print(f"Matched post {video.permalink} ({reason})")

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        raw = instagram.download_video(video, workdir / "source.mp4")
        print(f"Downloaded video ({raw.stat().st_size // 1024} KB)")

        start, pick_reason = clipper.pick_best_segment(
            client, cfg.model, product.name, raw, workdir, cfg.clip_seconds
        )
        print(f"Clip window: {start:.1f}s +{cfg.clip_seconds}s ({pick_reason})")
        clip = clipper.cut_clip(raw, start, cfg.clip_seconds, workdir / "clip.mp4")

        caption = write_caption(
            client, cfg.model, product.name, product.price, video.caption, cfg.caption_language
        )
        print(f"Caption:\n{caption}\n")

        if dry_run:
            print("Dry run — not posting to Telegram.")
        else:
            target = "DRAFT chat" if cfg.draft_mode else "channel"
            telegram.send_video(cfg.telegram_bot_token, cfg.target_chat_id, clip, caption)
            print(f"Posted to Telegram {target}.")

    if not dry_run:
        state.mark_posted(posted, product, video.media_id)
        state.save_state(posted)
    return 0


if __name__ == "__main__":
    sys.exit(run(dry_run="--dry-run" in sys.argv))
