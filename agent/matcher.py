"""Match a product (by name) to the right Instagram video using Claude.

Primarily matches against post captions; tolerant of fuzzy names,
misspellings, and mixed Persian/English text.
"""

import json

from anthropic import Anthropic

from .instagram import IgVideo

MATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "media_id": {
            "type": ["string", "null"],
            "description": "id of the best-matching post, or null if none match",
        },
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "reason": {"type": "string"},
    },
    "required": ["media_id", "confidence", "reason"],
    "additionalProperties": False,
}


def match_product_to_video(
    client: Anthropic, model: str, product_name: str, videos: list[IgVideo]
) -> tuple[IgVideo | None, str]:
    """Return (video, reason). video is None when no confident match exists."""
    if not videos:
        return None, "no videos found on the Instagram account"

    catalog = "\n".join(
        f"- id: {v.media_id}\n  caption: {v.caption[:400] or '(no caption)'}"
        for v in videos
    )
    response = client.messages.create(
        model=model,
        max_tokens=1000,
        output_config={"format": {"type": "json_schema", "schema": MATCH_SCHEMA}},
        messages=[
            {
                "role": "user",
                "content": (
                    "You match products of an online shop to the shop's own "
                    "Instagram posts. Captions may be in Persian or English, and "
                    "product names may be spelled slightly differently in the "
                    "captions.\n\n"
                    f"Product to find: {product_name}\n\n"
                    f"Instagram video posts:\n{catalog}\n\n"
                    "Pick the single post whose caption most clearly refers to "
                    "this exact product. If no caption plausibly refers to it, "
                    "return media_id null with confidence low. Do not guess "
                    "between visually similar products."
                ),
            }
        ],
    )
    text = "".join(b.text for b in response.content if b.type == "text")
    result = json.loads(text)

    if not result["media_id"] or result["confidence"] == "low":
        return None, result["reason"]
    for v in videos:
        if v.media_id == result["media_id"]:
            return v, result["reason"]
    return None, f"model returned unknown media id: {result['media_id']}"
