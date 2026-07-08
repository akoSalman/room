"""Track which products have already been posted.

State lives in state/posted.json and is committed back to the repo by the
GitHub Actions workflow, so the rotation survives between runs.
"""

import json
from datetime import date
from pathlib import Path

from .sheet import Product

STATE_FILE = Path(__file__).resolve().parent.parent / "state" / "posted.json"


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def pick_next_product(products: list[Product], state: dict) -> Product | None:
    """Pick the first never-posted product; if all were posted, the one
    posted longest ago (round-robin)."""
    if not products:
        return None
    unposted = [p for p in products if p.key not in state]
    if unposted:
        return unposted[0]
    return min(products, key=lambda p: state[p.key].get("date", ""))


def mark_posted(state: dict, product: Product, media_id: str) -> None:
    state[product.key] = {
        "name": product.name,
        "date": date.today().isoformat(),
        "media_id": media_id,
    }
