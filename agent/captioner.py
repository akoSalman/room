"""Generate a human-sounding Telegram caption with Claude.

Uses web search to pull a short factual description of the product when
useful, and writes in the same language as the Instagram caption unless
CAPTION_LANGUAGE overrides it.
"""

from anthropic import Anthropic

TELEGRAM_CAPTION_LIMIT = 1024


def write_caption(
    client: Anthropic,
    model: str,
    product_name: str,
    price: str,
    ig_caption: str,
    language: str,
) -> str:
    language_rule = (
        f"Write the caption in {language}."
        if language
        else "Write the caption in the same language as the original Instagram caption."
    )
    response = client.messages.create(
        model=model,
        max_tokens=2000,
        tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 3}],
        messages=[
            {
                "role": "user",
                "content": (
                    "You write daily product posts for an online shop's Telegram "
                    "channel. Write ONE caption for today's post.\n\n"
                    f"Product: {product_name}\n"
                    f"Price: {price}\n"
                    f"Original Instagram caption:\n{ig_caption or '(none)'}\n\n"
                    "Guidelines:\n"
                    f"- {language_rule}\n"
                    "- Sound like a real person running the shop, not a bot: "
                    "warm, direct, no marketing clichés.\n"
                    "- If the Instagram caption lacks a useful description, you "
                    "may search the web for one or two factual details about "
                    "this kind of product — but never invent specifications.\n"
                    "- Include the price clearly.\n"
                    "- 2-5 short lines, at most a couple of fitting emoji.\n"
                    "- End with a short call to action (e.g. DM/order info).\n"
                    "- Vary structure and opening from day to day; do not use a "
                    "template feel.\n"
                    f"- Hard limit {TELEGRAM_CAPTION_LIMIT} characters.\n\n"
                    "Reply with the caption text only — no preamble, no quotes."
                ),
            }
        ],
    )
    caption = "".join(b.text for b in response.content if b.type == "text").strip()
    if len(caption) > TELEGRAM_CAPTION_LIMIT:
        caption = caption[: TELEGRAM_CAPTION_LIMIT - 1] + "…"
    return caption
