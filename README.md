# Telegram Product Agent

Once a day this agent:

1. Reads your product list (name + price) from a **Google Sheet**.
2. Picks the next product in rotation.
3. Finds the matching video on your **Instagram** page (by comparing your post captions to the product name with Claude).
4. Cuts the **most interesting ~12-second clip** from that video (scene detection + Claude vision picking the best segment).
5. Writes a natural, human-sounding caption (in the same language as your Instagram caption), including the price.
6. Posts the clip + caption to your **Telegram channel** — or, in draft mode, to your private chat for review first.

It runs for free on GitHub Actions on a daily schedule. The only running cost is the Claude API usage: roughly **a few cents per month** for one post per day.

---

## One-time setup

### 1. Telegram bot (5 minutes)

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts. Copy the **bot token**.
2. Add the bot as an **administrator** of your channel (with "Post messages" permission).
3. Your channel id is `@yourchannelname` (public) or the numeric `-100...` id (private — forward a channel message to **@userinfobot** to see it).
4. For **draft mode**: message **@userinfobot** yourself to get your personal chat id, and start a chat with your bot (press Start) so it can message you.

### 2. Instagram Graph API (15–30 minutes, once)

Your Instagram account must be a **Business or Creator** account (free to switch, in Instagram settings).

1. Go to <https://developers.facebook.com> → create an app (type: Business).
2. Add the **Instagram** product to the app and connect your Instagram account.
3. Generate an access token with `instagram_business_basic` permission, then exchange it for a **long-lived token** (valid ~60 days; the docs page has the exchange call).
4. Your `IG_USER_ID` is shown when you connect the account (or call `GET https://graph.instagram.com/me?fields=user_id&access_token=...`).

> The token expires after ~60 days. Refreshing it is one API call (`GET /refresh_access_token`) — mark a calendar reminder, or ask Claude to add auto-refresh later.

### 3. Google Sheet

1. Put products in a sheet with two columns: `name`, `price` (a header row is optional; Persian headers `نام`/`قیمت` also work).
2. **File → Share → Publish to web** → choose the sheet and **CSV** → copy the link.

### 4. Claude API key

Create a key at <https://platform.claude.com> (this is separate billing from a Claude Pro subscription — but one short post per day costs cents per month).

### 5. GitHub secrets

In this repo: **Settings → Secrets and variables → Actions → New repository secret**, add:

| Secret | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from step 4 |
| `SHEET_CSV_URL` | from step 3 |
| `IG_USER_ID` | from step 2 |
| `IG_ACCESS_TOKEN` | from step 2 |
| `TELEGRAM_BOT_TOKEN` | from step 1 |
| `TELEGRAM_CHANNEL_ID` | from step 1 |
| `TELEGRAM_DRAFT_CHAT_ID` | your personal chat id (recommended at first; delete the secret later to go fully automatic) |

Optional (Settings → Secrets and variables → Actions → **Variables**): `CAPTION_LANGUAGE` (e.g. `Persian`), `CLIP_SECONDS` (default 12).

---

## Running

- **Scheduled:** the workflow in `.github/workflows/daily-post.yml` runs every day at 06:30 UTC (10:00 Tehran). Edit the cron line to change the time.
- **Manual test:** repo → **Actions** tab → *Daily product post* → **Run workflow**.
- **Locally:** copy `.env.example` to `.env`, fill it in, then:

  ```bash
  pip install -r requirements.txt
  sudo apt install ffmpeg   # or brew install ffmpeg
  set -a; source .env; set +a
  python -m agent.main --dry-run   # everything except the actual Telegram upload
  python -m agent.main             # real run
  ```

## Draft mode → fully automatic

While `TELEGRAM_DRAFT_CHAT_ID` is set, every finished post is sent to **you** instead of the channel. Review it; if it's good, forward it to the channel. After a week or two of good picks, delete that secret and the agent posts straight to the channel.

## How rotation works

`state/posted.json` records which products were already posted (the workflow commits it back after each run). The agent always picks the first never-posted product; when all have been posted it starts over with the oldest. Products with no confident video match are skipped with a warning message sent to you, so the rotation never gets stuck.

## Project layout

```
agent/
  main.py        orchestration + draft mode
  config.py      environment variables
  sheet.py       Google Sheet (published CSV) reader
  state.py       posted-product rotation state
  instagram.py   Instagram Graph API: list + download videos
  matcher.py     Claude: product name -> matching post
  clipper.py     ffmpeg scene detection + Claude vision -> best clip
  captioner.py   Claude (+ web search): human-sounding caption
  telegram.py    Telegram Bot API upload
```
