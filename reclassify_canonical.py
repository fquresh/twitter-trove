#!/usr/bin/env python3
"""
Reclassify the entire Trove archive against a fixed canonical taxonomy.

Vision-aware: image-bearing tweets are categorized from their image content,
not just their text. Three modes (default `vision`):

  - `vision`: attach the actual image URLs as image_url content blocks (true
    multimodal) AND inject cached image descriptions as [Image: ...] text.
    Known-dead URLs (image-description cache status `bad_request`) never get
    an image block; the description remains as fallback evidence.
  - `desc`:   text-only request, but each tweet's cached image descriptions
    are injected as [Image: ...] lines. No image bytes sent.
  - `text`:   legacy text-only behavior (no image context at all).

Model: google/gemini-2.5-flash-lite via OpenRouter ($0.10 in / $0.40 out per
MTok). One model for all modes - no mixed-model taxonomy.

Cache: signature-keyed. Each entry is keyed by md5(tweet_id, mode, model,
prompt_version, text, live image URLs, injected descriptions), so changing
any prompt input naturally invalidates old entries. On startup, legacy
bare-tweet-id entries are backed up to .canonical_classification_cache
.textonly-backup.json and dropped from the in-memory cache.

Outputs (overwrite, with backups):
  categorized_tweets.json
  tweet_analysis.md
  .canonical_classification_cache.json   (sig-keyed; legacy backup alongside)

Required env: OPENROUTER_API_KEY
"""

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

import httpx

# Reuse parse + output helpers from the main classifier
from parse_and_classify import (
    parse_all_files,
    build_taxonomy,
    build_json_output,
    build_markdown_report,
)
from trove_common import (
    load_json_cache,
    save_json_cache,
    md5_key,
    normalize_image_url,
    parse_classification_response,
    run_classification,
)

ROOT = Path(__file__).resolve().parent
OUTPUT_JSON = ROOT / "categorized_tweets.json"
OUTPUT_MD = ROOT / "tweet_analysis.md"
CACHE_FILE = ROOT / ".canonical_classification_cache.json"
LEGACY_BACKUP_FILE = CACHE_FILE.with_name(CACHE_FILE.stem + ".textonly-backup.json")
IMAGE_DESCRIPTION_CACHE_FILE = ROOT / ".image_description_cache.json"

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# Gemini 2.5 Flash-Lite via OpenRouter: vision-capable, $0.10 input / $0.40
# output per 1M tokens. One model for all modes (text, desc, vision) so the
# taxonomy boundary sense stays consistent across image-bearing and text-only
# tweets. DeepSeek cannot take images, so flash-lite supersedes the earlier
# deepseek-v4-flash classification plan.
MODEL = "google/gemini-2.5-flash-lite"
PROMPT_VERSION = "vision-v1"
BATCH_SIZE = 25
CONCURRENCY = 10
MAX_IMAGES_PER_TWEET = 4  # X photo limit; extras are quote-card media

# ── Canonical Taxonomy ─────────────────────────────────────────────────────
# Hand-curated based on the actual content distribution observed in the
# archive. ~70 categories chosen so each meaningfully clusters tweets without
# fragmenting (the emergent taxonomy hit 4,640 singletons).
CANONICAL_TAXONOMY = [
    # ── Trading: Crypto (the heaviest area) ──
    ("Trading > Crypto > Market Analysis",
     "Macro crypto market commentary, narratives, cycle analysis, market structure"),
    ("Trading > Crypto > Bitcoin",
     "BTC-specific price/thesis/positioning, Bitcoin halving, hash rate, ETF flows"),
    ("Trading > Crypto > Ethereum & L1s",
     "ETH, Solana, and other Layer-1 blockchain analysis and positioning"),
    ("Trading > Crypto > Altcoins",
     "Mid/small-cap altcoin analysis, rotations, sector trades excluding memes"),
    ("Trading > Crypto > Memecoins",
     "Memecoin trading, $WIF, $BONK, pump.fun, memecoin meta and rotations"),
    ("Trading > Crypto > DeFi",
     "DeFi protocol analysis, yield, lending, perps DEXs, liquid staking, AMMs"),
    ("Trading > Crypto > Trading Strategy",
     "Crypto trading setups, entries/exits, position sizing, risk frameworks"),
    ("Trading > Crypto > On-chain & Whales",
     "Smart money tracking, whale wallets, on-chain flow analysis, wallet alpha"),
    ("Trading > Crypto > Airdrops & Yield Farming",
     "Airdrop hunting, points programs, farming strategies, retroactive rewards"),
    ("Trading > Crypto > Project Analysis",
     "Deep dives on specific tokens/projects, fundamental analysis, tokenomics"),
    ("Trading > Crypto > Technical Analysis",
     "Crypto chart analysis, TA setups, indicators, support/resistance levels"),

    # ── Trading: Equities & Macro ──
    ("Trading > Equities > Tech & Semis",
     "NVDA, semis, AI compute supply chain, big tech equity analysis"),
    ("Trading > Equities > Macro & Index",
     "S&P/Nasdaq, broad market commentary, sector rotation, equity macro"),
    ("Trading > Equities > Earnings & Fundamentals",
     "Earnings reports, fundamental analysis, individual stock theses (non-tech)"),
    ("Trading > Options & Derivatives",
     "Options strategy, vol, spreads, flows, futures, structured products"),
    ("Trading > Macro > Federal Reserve",
     "Fed policy, FOMC, rate decisions, quantitative tightening/easing"),
    ("Trading > Macro > Geopolitics & War",
     "Geopolitical risk, war, sanctions, energy markets, sovereign affairs"),
    ("Trading > Macro > Inflation & Currency",
     "Inflation prints, dollar/DXY, FX, currency debasement, monetary policy"),
    ("Trading > Macro > Economic Data",
     "Jobs, GDP, PMI, economic indicators, recession indicators"),

    # ── Trading: General craft ──
    ("Trading > Strategy & Setup",
     "Generic trading strategy, asset selection, setup quality (non-asset-specific)"),
    ("Trading > Technical Analysis",
     "General TA, chart patterns, indicators across asset classes"),
    ("Trading > Risk Management",
     "Position sizing, stop losses, drawdown management, capital preservation"),
    ("Trading > Psychology & Discipline",
     "Trader psychology, emotional control, discipline, ego management"),
    ("Trading > Market Sentiment",
     "Fear/greed, retail vs smart money sentiment, narrative flows, vibes"),

    # ── Technology: AI ──
    ("Technology > AI > LLMs & Models",
     "LLM releases (GPT, Claude, Gemini, Llama), model capabilities, benchmarks"),
    ("Technology > AI > Agents",
     "AI agents, agentic workflows, autonomous systems, agent frameworks"),
    ("Technology > AI > Coding Agents",
     "Cursor, Claude Code, Copilot, Devin, AI-pair-programming tools"),
    ("Technology > AI > Infrastructure & Compute",
     "GPU clusters, data centers, inference infra, scaling laws, training compute"),
    ("Technology > AI > Research & Methods",
     "AI research papers, training methods, RLHF, novel architectures"),
    ("Technology > AI > Products & Apps",
     "Consumer AI products, AI SaaS, vertical AI apps, image/video gen"),
    ("Technology > AI > Industry & Companies",
     "OpenAI, Anthropic, xAI news, AI company moves, deals, drama"),
    ("Technology > AI > Safety & Policy",
     "AI safety, alignment, regulation, ethics debates"),

    # ── Technology: Programming ──
    ("Technology > Programming > Web & Frontend",
     "Web dev, JS/TS, React, design systems, frontend tooling"),
    ("Technology > Programming > Backend & Infra",
     "Backend, databases, APIs, distributed systems, devops, cloud"),
    ("Technology > Programming > Languages & Tools",
     "Programming languages, dev tools, terminal workflows, IDEs"),
    ("Technology > Startups & Founders",
     "Founder advice, startup operating, fundraising, building in public"),
    ("Technology > Open Source",
     "Open-source projects, OSS sustainability, popular repos"),
    ("Technology > Hardware & Robotics",
     "Hardware, chips, robotics, physical-world AI, manufacturing"),
    ("Technology > Crypto Infrastructure",
     "Blockchain infra, on-chain dev, ZK, rollups, protocol-level engineering"),

    # ── Crypto industry (non-trading) ──
    ("Crypto > Regulation & Policy",
     "Crypto regulation, SEC actions, government stance, legal developments"),
    ("Crypto > Industry News",
     "Exchange news, industry events, conference takeaways, deals"),
    ("Crypto > NFTs & Collectibles",
     "NFT projects, collectible analysis, NFT market dynamics"),
    ("Crypto > Project Drama",
     "Rug pulls, exits, founder drama, project beef, on-chain controversies"),

    # ── Personal Development & Self ──
    ("Personal Development > Mindset",
     "Philosophy of approach, mental models, framing, attitude toward life/work"),
    ("Personal Development > Discipline & Habits",
     "Habit formation, daily routines, willpower, consistency"),
    ("Personal Development > Career & Work",
     "Career advice, professional growth, work strategy, getting hired"),
    ("Personal Development > Productivity",
     "Productivity systems, focus, deep work, output optimization"),
    ("Personal Development > Wealth Building",
     "How to build wealth, money mindset, financial freedom narratives"),
    ("Personal Development > Relationships",
     "Dating, friendship, family, social dynamics"),
    ("Personal Development > Masculinity",
     "Masculinity-focused content, red-pill, traditionalist self-improvement"),

    # ── Health ──
    ("Health > Fitness & Training",
     "Lifting, cardio, training programs, body composition"),
    ("Health > Nutrition & Diet",
     "Diet, nutrition, supplements, protein, eating strategies"),
    ("Health > Mental Health",
     "Anxiety, depression, mental wellness, therapy, psychological care"),
    ("Health > Longevity & Biohacking",
     "Longevity research, biohacking protocols, sleep, hormones"),

    # ── Finance (non-trading) ──
    ("Finance > Personal Finance",
     "Saving, budgeting, basic personal finance, investing 101"),
    ("Finance > Venture Capital",
     "VC industry, fundraising mechanics, fund dynamics, LP/GP commentary"),
    ("Finance > Real Estate",
     "Real estate investing, property markets, housing analysis"),

    # ── Culture ──
    ("Culture > Humor & Memes",
     "Jokes, memes, shitposts (without strong topic of their own)"),
    ("Culture > Politics",
     "Political commentary, elections, policy debates"),
    ("Culture > Social Media & Internet",
     "Platform commentary, virality mechanics, X/Twitter culture, internet trends"),
    ("Culture > Society & Trends",
     "Cultural trends, generational dynamics, lifestyle commentary"),
    ("Culture > Media & News",
     "Media criticism, news commentary, journalism takes"),
    ("Culture > Drama & Beef",
     "Public callouts, online beef, interpersonal drama between figures"),

    # ── Science ──
    ("Science > Health & Medicine",
     "Medical research, drugs, disease, healthcare science"),
    ("Science > Space & Physics",
     "Space exploration, astronomy, physics research"),
    ("Science > Biology & Genetics",
     "Biology, genetics, neuroscience, evolutionary findings"),

    # ── Education / Reference ──
    ("Education > Books & Reading",
     "Book recommendations, summaries, reading lists"),
    ("Education > Courses & Resources",
     "Online courses, tutorials, learning resources"),
    ("Education > History",
     "Historical analysis, historical anecdotes, history threads"),

    # ── Catch-alls ──
    ("Other > Inspiration",
     "Quotes, motivational content, aspirational posts (no concrete topic)"),
    ("Other > Philosophy",
     "Philosophical musings, abstract thinking on meaning/life"),
    ("Other > Misc",
     "Tweets that don't fit any other category"),
]


def build_taxonomy_block() -> str:
    """Format the canonical taxonomy as a numbered list for the prompt."""
    lines = []
    for i, (name, desc) in enumerate(CANONICAL_TAXONOMY, 1):
        lines.append(f"{i}. {name} - {desc}")
    return "\n".join(lines)

CLASSIFICATION_PROMPT_TEMPLATE = """You are a tweet categorization system. You must assign each tweet to 1-3 categories from the FIXED CANONICAL TAXONOMY below. DO NOT invent new categories.

CANONICAL TAXONOMY:
{taxonomy_block}

Rules:
- Pick 1-3 categories per tweet, with the BEST fit first.
- Use the exact category strings from the list above (with the " > " separators).
- Tweets may include images, provided either as attached image content or as [Image: ...] text descriptions. Each attached image belongs to the tweet whose text block immediately precedes it.
- Treat image content as primary evidence: read visible text, identify charts, screenshots, memes, and photos, and categorize by what the image shows.
- For image-only tweets with no text, categorize from the image. Use the author handle and tickers only as tiebreakers. Use "Other > Misc" only when neither text nor image gives a clear topic.
- Be specific: a tweet about NVDA earnings is "Trading > Equities > Tech & Semis" + "Trading > Equities > Earnings & Fundamentals", not just "Other > Misc".

Return ONLY a JSON array. Each element must have:
- "id": the tweet id (string)
- "categories": array of 1-3 category strings from the taxonomy

Respond with ONLY the JSON array, no other text.

TWEETS:
"""

# ── Image context ──────────────────────────────────────────────────────────
def load_image_context(tweets: list[dict]) -> dict:
    """Build per-tweet image context for the prompt and the cache key.

    Returns {tweet_id: {"urls_live": [...], "descs": [...]}}. Tweets without
    image media map to empty lists so the cache-key function has a uniform
    input. `urls_live` excludes URLs known-dead in the image-description cache
    (status == "bad_request"); those never get an image block. `descs` are the
    OK cached descriptions, in display order, truncated to 400 chars, max 4.
    """
    img_cache = load_json_cache(IMAGE_DESCRIPTION_CACHE_FILE)
    ctx_by_id: dict[str, dict] = {}
    for t in tweets:
        tid = str(t["id"])
        media = t.get("media") or {}
        if media.get("type") != "image":
            ctx_by_id[tid] = {"urls_live": [], "descs": []}
            continue
        # Normalize + dedupe preserving display order. The HTML export embeds
        # size variants of the same image; normalization collapses them.
        seen = set()
        unique_urls: list[str] = []
        for u in (media.get("urls") or []):
            if not isinstance(u, str) or not u.strip():
                continue
            nu = normalize_image_url(u)
            if nu in seen:
                continue
            seen.add(nu)
            unique_urls.append(u)
        urls_live: list[str] = []
        descs: list[str] = []
        for u in unique_urls:
            key = md5_key(normalize_image_url(u))
            entry = img_cache.get(key)
            if entry and entry.get("status") == "bad_request":
                continue  # known-dead URL, skip the image block
            urls_live.append(u)
            if entry and entry.get("status") == "ok" and entry.get("description"):
                desc = entry["description"].strip()[:400]
                if desc:
                    descs.append(desc)
        ctx_by_id[tid] = {
            "urls_live": urls_live[:MAX_IMAGES_PER_TWEET],
            "descs": descs[:MAX_IMAGES_PER_TWEET],
        }
    return ctx_by_id


def _tweet_block(t: dict, ctx_by_id: dict, mode: str) -> str:
    """One tweet's text block. Includes [Image: ...] lines in desc/vision modes."""
    ticker_str = (f" [Tickers: {', '.join('$' + tk for tk in t['tickers'])}]"
                  if t["tickers"] else "")
    media_str = (f" [Media: {t['media']['type']}]"
                 if t["media"]["type"] != "none" else "")
    text = t["text"][:500] if t["text"] else "(no text)"
    lines = [
        f'ID: {t["id"]}',
        f'Author: {t["author"]} ({t["handle"]}){media_str}',
        f'Text: {text}{ticker_str}',
    ]
    if mode != "text":
        ctx = ctx_by_id.get(str(t["id"])) or {"urls_live": [], "descs": []}
        for desc in ctx["descs"]:
            lines.append(f'  [Image: {desc}]')
    return "\n".join(lines) + "\n"


def build_batch_prompt(tweets: list[dict], ctx_by_id: dict, mode: str):
    """Build the batch payload.

    Returns a plain string in `text`/`desc` modes, or an OpenAI content-blocks
    list in `vision` mode (text header + per-tweet text block + image_url
    blocks for each live URL). `ctx_by_id` is ignored entirely in `text` mode.
    """
    header = CLASSIFICATION_PROMPT_TEMPLATE.format(taxonomy_block=build_taxonomy_block())
    if mode == "vision":
        blocks: list[dict] = [{"type": "text", "text": header}]
        for i, t in enumerate(tweets):
            sep = "---\n" if i > 0 else ""
            blocks.append({"type": "text", "text": sep + _tweet_block(t, ctx_by_id, mode)})
            ctx = ctx_by_id.get(str(t["id"])) or {"urls_live": [], "descs": []}
            for u in ctx["urls_live"]:
                blocks.append({"type": "image_url", "image_url": {"url": u}})
        return blocks
    # text / desc: plain joined string (desc includes [Image:] lines, text never)
    tweet_blocks = [_tweet_block(t, ctx_by_id, mode) for t in tweets]
    return header + "\n---\n".join(tweet_blocks)


# ── Cache ──────────────────────────────────────────────────────────────────
def load_cache() -> dict:
    return load_json_cache(CACHE_FILE)


def save_cache(cache: dict):
    save_json_cache(CACHE_FILE, cache)

async def _api_call(client: httpx.AsyncClient, content, semaphore: asyncio.Semaphore,
                    max_tokens: int = 8192) -> list[dict]:
    """Single OpenRouter call with rate-limit backoff and dead-image fallback.

    `content` is a PromptPayload: a plain string (text/desc modes) or an
    OpenAI content-blocks list (vision mode). It is placed in the user message
    verbatim. On an image-fetch failure (HTTP 400 mentioning image fetching,
    or a 200 with an embedded image-related error object), image_url blocks
    are stripped and the request is retried once with a note telling the model
    to fall back on the [Image:] descriptions.
    """
    api_key = os.environ["OPENROUTER_API_KEY"]
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/fquresh/twitter-trove",
        "X-Title": "trove-reclassify",
    }
    base_payload = {
        "model": MODEL,
        "max_tokens": max_tokens,
        "temperature": 0,
    }

    current_content = content
    stripped_used = False
    max_retries = 5
    for attempt in range(max_retries):
        payload = {**base_payload,
                   "messages": [{"role": "user", "content": current_content}]}
        try:
            async with semaphore:
                resp = await client.post(OPENROUTER_URL, headers=headers,
                                         json=payload, timeout=120)
        except (httpx.TimeoutException, httpx.HTTPStatusError) as e:
            if attempt == max_retries - 1:
                raise
            await asyncio.sleep(15 * (attempt + 1))
            continue
        except Exception as e:
            msg = str(e).lower()
            if "rate" in msg or "429" in msg or "timeout" in msg:
                await asyncio.sleep(15 * (attempt + 1))
                continue
            raise

        if resp.status_code == 429 or resp.status_code >= 500:
            await asyncio.sleep(15 * (attempt + 1))
            continue

        # Dead-image fallback: HTTP 400 whose body mentions image fetching.
        if resp.status_code == 400:
            body = resp.text
            if (not stripped_used and _is_image_fetch_error_body(body)
                    and _strip_image_blocks(content) is not None):
                current_content = _strip_image_blocks(content)
                stripped_used = True
                continue
            resp.raise_for_status()

        if resp.status_code >= 400:
            resp.raise_for_status()

        try:
            data = resp.json()
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            await asyncio.sleep(15 * (attempt + 1))
            continue

        # OpenRouter quirk: 200 with an embedded top-level error object.
        if isinstance(data, dict) and data.get("error"):
            err_obj = data["error"]
            err_msg = ((err_obj.get("message") if isinstance(err_obj, dict)
                        else str(err_obj)) or "")
            if (not stripped_used and _is_image_error_message(err_msg)
                    and _strip_image_blocks(content) is not None):
                current_content = _strip_image_blocks(content)
                stripped_used = True
                continue
            raise RuntimeError(f"OpenRouter returned an error: {err_msg[:300]}")

        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise RuntimeError(
                f"OpenRouter response missing choices/message: {str(data)[:300]}")
        return parse_classification_response(text)
    raise RuntimeError(
        f"OpenRouter classification request failed after {max_retries} retries")


def _strip_image_blocks(content):
    """Return content with image_url blocks removed + a fallback note appended.

    Returns None if `content` had no image_url blocks (nothing to strip), so
    callers can detect "no fallback available" and raise instead of looping.
    """
    if not isinstance(content, list):
        return None
    stripped = [b for b in content
                if not (isinstance(b, dict) and b.get("type") == "image_url")]
    if len(stripped) == len(content):
        return None
    stripped.append({
        "type": "text",
        "text": ("Note: one or more images were unavailable. Classify using "
                 "the text and [Image:] descriptions."),
    })
    return stripped


def _is_image_fetch_error_body(body: str) -> bool:
    """Match OpenRouter's image-fetch 400 shape, e.g.
    {"error":{"message":"Received 404 status code when fetching image from URL: ..."}}"""
    low = body.lower()
    return ("fetching image" in low
            or ("image" in low and "404" in low)
            or "image from url" in low)


def _is_image_error_message(msg: str) -> bool:
    low = (msg or "").lower()
    return ("image" in low
            and ("fetch" in low or "404" in low
                 or "unavailable" in low or "url" in low))


VALID_CATEGORIES = {name for name, _ in CANONICAL_TAXONOMY}


def normalize_category(cat: str) -> str | None:
    """Snap a returned category to the canonical set, tolerating minor whitespace."""
    if not isinstance(cat, str):
        return None
    cat = cat.strip()
    if cat in VALID_CATEGORIES:
        return cat
    # Tolerate odd separators or casing issues
    normalized = re.sub(r'\s*>\s*', ' > ', cat).strip()
    if normalized in VALID_CATEGORIES:
        return normalized
    # Case-insensitive match
    for valid in VALID_CATEGORIES:
        if valid.lower() == normalized.lower():
            return valid
    return None


def _accept_result(item: dict, asked_ids: set) -> tuple | None:
    """Snap returned categories to the canonical set, dedupe, cap at 3."""
    tid = str(item.get("id", ""))
    if tid not in asked_ids:
        return None
    raw_cats = item.get("categories", []) or []
    if not isinstance(raw_cats, list):
        return None
    normalized = [c for c in (normalize_category(rc) for rc in raw_cats) if c]
    if not normalized:
        return None
    # Dedupe while preserving order
    seen = set()
    deduped = []
    for c in normalized:
        if c not in seen:
            seen.add(c)
            deduped.append(c)
    return tid, deduped[:3]

def _drop_legacy_bare_id_keys(cache: dict) -> None:
    """Preserve legacy bare-tweet-id cache entries, then drop them in-memory.

    The legacy cache keyed entries by the bare tweet id. The sig-keyed cache
    makes those orphans unreachable, so we back the whole file up verbatim
    (once, skip if the backup already exists) and drop the bare-id entries
    from the in-memory dict so future saves don't carry 35k orphans. The
    backup file is never deleted.
    """
    bare_keys = [k for k in cache if k.isdigit()]
    if not bare_keys:
        return
    if not LEGACY_BACKUP_FILE.exists():
        if CACHE_FILE.exists():
            shutil.copy2(CACHE_FILE, LEGACY_BACKUP_FILE)
        print(f"  Legacy bare-id cache detected: backed up {CACHE_FILE.name}"
              f" -> {LEGACY_BACKUP_FILE.name}")
    for k in bare_keys:
        del cache[k]
    print(f"  Dropped {len(bare_keys)} legacy bare-id entries "
          f"(signature-keyed cache now active)")


def _make_cache_key(mode: str, ctx_by_id: dict):
    """Build the per-tweet signature cache key closure."""
    def _cache_key(t: dict) -> str:
        ctx = ctx_by_id.get(str(t["id"])) or {"urls_live": [], "descs": []}
        parts = [
            str(t["id"]),
            mode,
            MODEL,
            PROMPT_VERSION,
            t.get("text") or "",
            "|".join(ctx["urls_live"]),
            "|".join(ctx["descs"]),
        ]
        return md5_key("\x00".join(parts))
    return _cache_key


async def classify_all_async(tweets: list[dict], mode: str,
                             ctx_by_id: dict) -> list[dict]:
    cache = load_cache()
    _drop_legacy_bare_id_keys(cache)
    async with httpx.AsyncClient() as client:
        semaphore = asyncio.Semaphore(CONCURRENCY)

        async def call_api(content) -> list[dict]:
            return await _api_call(client, content, semaphore)

        def build_prompt(batch: list[dict]):
            return build_batch_prompt(batch, ctx_by_id, mode)

        return await run_classification(
            tweets,
            cache=cache,
            save=lambda: save_cache(cache),
            build_prompt=build_prompt,
            call_api=call_api,
            accept=_accept_result,
            fallback_category="Other > Misc",
            batch_size=BATCH_SIZE,
            wave_size=60,
            cache_key=_make_cache_key(mode, ctx_by_id),
        )

def _sample_misc_images(tweets: list[dict], n: int) -> list[dict]:
    """Filter to the first N image-bearing tweets currently in Other > Misc.

    Loads the existing categorized_tweets.json, takes the set of tweet ids
    whose categories == ["Other > Misc"], and keeps parsed tweets that are in
    that set AND have image media, preserving parse order, truncated to N.
    Used by the smoke-test protocol so both modes see the same tweets.
    """
    if not OUTPUT_JSON.exists():
        sys.exit(f"--sample-misc-images needs {OUTPUT_JSON.name}, which is missing")
    with OUTPUT_JSON.open() as f:
        data = json.load(f)
    misc_ids = {str(t["id"]) for t in data.get("tweets", [])
                if t.get("categories") == ["Other > Misc"]}
    filtered = [t for t in tweets
                if str(t["id"]) in misc_ids
                and (t.get("media") or {}).get("type") == "image"]
    truncated = filtered[:n]
    print(f"\n[--sample-misc-images] {len(filtered)} misc+image tweets; "
          f"using first {len(truncated)}")
    return truncated


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["vision", "desc", "text"],
                        default="vision",
                        help="Classification mode (default: vision)")
    parser.add_argument("--limit", type=int, default=None,
                        help="Classify only the first N tweets (for testing)")
    parser.add_argument("--smoke-test", action="store_true",
                        help="Classify just one batch (25 tweets) and stop")
    parser.add_argument("--sample-misc-images", type=int, default=None,
                        help="Sample N image-bearing tweets currently in "
                             "Other > Misc (smoke test)")
    args = parser.parse_args()

    if not os.environ.get("OPENROUTER_API_KEY"):
        sys.exit("ERROR: OPENROUTER_API_KEY env var not set")

    print("=" * 60)
    print(f"TROVE RECLASSIFIER  ({MODEL} via OpenRouter)")
    print(f"Mode: {args.mode}  |  Canonical taxonomy: "
          f"{len(CANONICAL_TAXONOMY)} categories")
    print("=" * 60)

    print("\n[1/4] Parsing HTML files...\n")
    tweets, files_processed = parse_all_files()

    if args.sample_misc_images is not None:
        tweets = _sample_misc_images(tweets, args.sample_misc_images)
    if args.smoke_test:
        tweets = tweets[:BATCH_SIZE]
        print(f"\n[smoke test] limited to {len(tweets)} tweets")
    elif args.limit:
        tweets = tweets[:args.limit]
        print(f"\n[--limit] limited to {len(tweets)} tweets")

    print(f"\n[2/4] Loading image context...\n")
    ctx_by_id = load_image_context(tweets)
    with_ctx = sum(1 for c in ctx_by_id.values()
                   if c["urls_live"] or c["descs"])
    print(f"  {with_ctx}/{len(tweets)} tweets have image context "
          f"(urls or descriptions)")

    print(f"\n[3/4] Classifying {len(tweets)} tweets ({args.mode} mode)...\n")
    t0 = time.time()
    tweets = asyncio.run(classify_all_async(tweets, args.mode, ctx_by_id))
    print(f"  Took {time.time()-t0:.1f}s")

    print("\n[4/4] Generating outputs...\n")
    taxonomy = build_taxonomy(tweets)

    # Smoke tests / --limit / --sample-misc-images runs write to *.smoke.* so
    # they don't clobber the full-archive outputs.
    is_smoke = (args.smoke_test or args.limit
                or args.sample_misc_images is not None)
    suffix = ".smoke" if is_smoke else ""
    out_json = OUTPUT_JSON.with_name(OUTPUT_JSON.stem + suffix + OUTPUT_JSON.suffix)
    out_md = OUTPUT_MD.with_name(OUTPUT_MD.stem + suffix + OUTPUT_MD.suffix)

    json_output = build_json_output(tweets, files_processed, taxonomy)
    with open(out_json, "w") as f:
        json.dump(json_output, f, indent=2, ensure_ascii=False)
    print(f"  Wrote {out_json}")

    md_output = build_markdown_report(tweets, taxonomy, files_processed)
    with open(out_md, "w") as f:
        f.write(md_output)
    print(f"  Wrote {out_md}")

    print(f"\nDone! {len(tweets)} tweets classified into {len(taxonomy)} categories "
          f"(canonical taxonomy size: {len(CANONICAL_TAXONOMY)}).")


if __name__ == "__main__":
    main()
