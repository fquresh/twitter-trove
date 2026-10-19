#!/usr/bin/env python3
"""
Parse X/Twitter posts from exported HTML files, classify them using
the Anthropic API, and produce structured JSON + markdown analysis.
"""

import json
import os
import re
import hashlib
import time
import sys
import asyncio
import threading
from datetime import datetime
from collections import Counter, defaultdict
from pathlib import Path

from bs4 import BeautifulSoup
import anthropic
import httpx

from trove_common import (
    load_json_cache,
    save_json_cache,
    parse_classification_response,
    run_classification,
)

# ── Config ──────────────────────────────────────────────────────────────────
EXPORTS_DIR = Path(__file__).parent / "exports"
OUTPUT_JSON = Path(__file__).parent / "categorized_tweets.json"
OUTPUT_MD = Path(__file__).parent / "tweet_analysis.md"
CACHE_FILE = Path(__file__).parent / ".classification_cache.json"
BATCH_SIZE = 25
MODEL = "claude-sonnet-4-20250514"
API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

client = anthropic.Anthropic(api_key=API_KEY)


# ── Step 1: Parse HTML files ───────────────────────────────────────────────
def parse_html_file(filepath: str) -> list[dict]:
    """Parse a single HTML export file and return list of tweet dicts."""
    with open(filepath, "r", encoding="utf-8") as f:
        raw = f.read()
    soup = BeautifulSoup(raw, "lxml")

    # The export also embeds a `const tweetsData = [...]` JSON block that carries
    # engagement (likeCount/retweetCount) which the rendered cards don't display,
    # plus the extension v1.1+ article flags (isArticle/articleTitle). Build an
    # id -> extras map (same regex the webapp parser uses) and merge it onto the
    # card-parsed tweets below. is_article stays None (unknown) on legacy exports
    # so downstream importers don't clobber a known flag with a false default.
    extras_by_id: dict[str, dict] = {}
    m = re.search(r"const tweetsData = (\[[\s\S]*?\]);", raw)
    if m:
        try:
            for item in json.loads(m.group(1)):
                tid = str(item.get("id", ""))
                if tid:
                    is_article = item.get("isArticle")
                    extras_by_id[tid] = {
                        "like_count": int(item.get("likeCount", 0) or 0),
                        "retweet_count": int(item.get("retweetCount", 0) or 0),
                        "is_article": None if is_article is None else bool(is_article),
                        "article_title": item.get("articleTitle") or None,
                    }
        except (json.JSONDecodeError, ValueError, TypeError):
            pass  # cards still parse without engagement

    tweets = []
    for card in soup.find_all(class_="tweet-card"):
        tweet = {}

        # URL / ID
        href = card.get("href", "")
        tweet["url"] = href
        # Extract tweet ID from URL like https://x.com/user/status/123456
        match = re.search(r"/status/(\d+)", href)
        tweet["id"] = match.group(1) if match else hashlib.md5(href.encode()).hexdigest()

        # Author
        author_div = card.find(class_="tweet-author")
        if author_div:
            name_el = author_div.find(class_="name")
            handle_el = author_div.find(class_="handle")
            tweet["author"] = name_el.get_text(strip=True) if name_el else ""
            tweet["handle"] = handle_el.get_text(strip=True) if handle_el else ""
        else:
            tweet["author"] = ""
            tweet["handle"] = ""

        # Date
        date_el = card.find(class_="tweet-date")
        tweet["timestamp"] = date_el.get_text(strip=True) if date_el else ""

        # Text
        text_el = card.find(class_="tweet-text")
        tweet["text"] = text_el.get_text(strip=True) if text_el else ""

        # Media
        images_div = card.find(class_="tweet-images")
        video_div = card.find(class_="video-indicator")
        if video_div:
            tweet["media"] = {"type": "video", "urls": []}
        elif images_div:
            img_urls = [img.get("src", "") for img in images_div.find_all("img")]
            tweet["media"] = {"type": "image", "urls": img_urls}
        else:
            tweet["media"] = {"type": "none", "urls": []}

        # Extract URLs from text
        urls = re.findall(r'https?://\S+', tweet["text"])
        tweet["urls"] = urls

        # Extract tickers
        tickers = re.findall(r'\$([A-Z]{1,6})\b', tweet["text"])
        tweet["tickers"] = list(set(tickers))

        tweet["source_file"] = os.path.basename(filepath)

        extras = extras_by_id.get(tweet["id"], {})
        tweet["like_count"] = extras.get("like_count", 0)
        tweet["retweet_count"] = extras.get("retweet_count", 0)
        tweet["is_article"] = extras.get("is_article")
        tweet["article_title"] = extras.get("article_title")

        tweets.append(tweet)

    return tweets


def parse_all_files() -> list[dict]:
    """Parse all HTML files, deduplicate by tweet URL."""
    all_tweets = []
    files_processed = []

    for fname in sorted(os.listdir(EXPORTS_DIR)):
        if not fname.endswith(".html"):
            continue
        fpath = EXPORTS_DIR / fname
        print(f"  Parsing {fname}...", end=" ", flush=True)
        tweets = parse_html_file(str(fpath))
        print(f"{len(tweets)} tweets")
        all_tweets.extend(tweets)
        files_processed.append(fname)

    # Deduplicate by URL, keeping the FIRST occurrence's content (so image URLs
    # stay stable and the Vision cache keeps hitting) but folding in the MAX
    # engagement seen across re-scrapes - an early scrape often captured the
    # tweet before it accrued likes/retweets, and keeping-first alone would
    # discard the real counts. Engagement is the only field that grows.
    by_url: dict[str, dict] = {}
    for t in all_tweets:
        prev = by_url.get(t["url"])
        if prev is None:
            by_url[t["url"]] = t
        else:
            prev["like_count"] = max(prev.get("like_count", 0), t.get("like_count", 0))
            prev["retweet_count"] = max(prev.get("retweet_count", 0), t.get("retweet_count", 0))
    unique = list(by_url.values())

    print(f"\n  Total: {len(all_tweets)} → {len(unique)} unique tweets")
    return unique, files_processed


# ── Step 2: Classify tweets using Anthropic API ───────────────────────────
CLASSIFICATION_PROMPT = """You are a tweet categorization system. Given a batch of tweets, assign each one to 1-3 hierarchical categories.

Use a hierarchical taxonomy with ">" separators. Be SPECIFIC with subcategories. Examples:
- Trading > Crypto > Market Analysis
- Trading > Crypto > DeFi
- Trading > Equities > Semiconductors
- Trading > Equities > Market Structure
- Trading > Options > Strategy
- Trading > Macro > Federal Reserve
- Trading > Psychology > Discipline
- Technology > AI/ML > LLMs
- Technology > AI/ML > Infrastructure
- Technology > AI/ML > Agents
- Technology > Programming > Python
- Technology > Programming > Web Development
- Technology > Startups > Founder Advice
- Technology > Open Source
- Finance > Personal Finance > Investing
- Finance > Venture Capital
- Crypto > Bitcoin > Analysis
- Crypto > Ethereum > DeFi
- Crypto > NFTs
- Crypto > Regulation
- Personal Development > Productivity
- Personal Development > Career
- Personal Development > Mindset
- Culture > Humor
- Culture > Politics
- Culture > Media
- Science > Space
- Science > Health
- Education > Books
- Education > Courses

These are EXAMPLES - create whatever categories fit the actual content. Be granular. A tweet about NVIDIA's AI chip revenue should be "Trading > Equities > Semiconductors" AND "Technology > AI/ML > Infrastructure", not just "Technology".

For each tweet, respond with a JSON array. Each element must have:
- "id": the tweet id
- "categories": array of 1-3 category strings

Respond ONLY with the JSON array, no other text.

TWEETS:
"""


def load_cache() -> dict:
    return load_json_cache(CACHE_FILE)


def save_cache(cache: dict):
    save_json_cache(CACHE_FILE, cache)


def build_batch_prompt(tweets: list[dict]) -> str:
    """Build classification prompt for a batch of tweets."""
    tweet_texts = []
    for t in tweets:
        ticker_str = f" [Tickers: {', '.join('$'+tk for tk in t['tickers'])}]" if t["tickers"] else ""
        tweet_texts.append(f'ID: {t["id"]}\nAuthor: {t["author"]} ({t["handle"]})\nText: {t["text"][:500]}{ticker_str}\n')
    return CLASSIFICATION_PROMPT + "\n---\n".join(tweet_texts)


async def _api_call(prompt: str, aclient, semaphore, max_tokens: int = 8192) -> list[dict]:
    """One classification API call with rate-limit backoff. May return empty
    list if the response was unparseable."""
    max_retries = 5
    for attempt in range(max_retries):
        try:
            async with semaphore:
                resp = await aclient.messages.create(
                    model=MODEL,
                    max_tokens=max_tokens,
                    messages=[{"role": "user", "content": prompt}],
                )
            return parse_classification_response(resp.content[0].text)
        except anthropic.RateLimitError:
            await asyncio.sleep(20 * (attempt + 1))
        except Exception as e:
            msg = str(e)
            if "429" in msg or "rate_limit" in msg or "overloaded" in msg.lower():
                await asyncio.sleep(20 * (attempt + 1))
                continue
            raise
    raise RuntimeError(f"Anthropic classification request failed after {max_retries} retries")


def _accept_result(item: dict, asked_ids: set) -> tuple | None:
    """Accept a returned classification: keep any non-empty category list."""
    tid = str(item["id"])
    if tid not in asked_ids:
        return None
    cats = item["categories"]
    if isinstance(cats, list) and cats:
        return tid, cats
    return None


async def classify_all_async(tweets: list[dict]) -> list[dict]:
    """Classify all tweets with concurrent Anthropic API calls."""
    cache = load_cache()
    aclient = anthropic.AsyncAnthropic(api_key=API_KEY)
    semaphore = asyncio.Semaphore(3)  # 3 concurrent requests to stay under rate limits

    async def call_api(prompt: str) -> list[dict]:
        return await _api_call(prompt, aclient, semaphore)

    return await run_classification(
        tweets,
        cache=cache,
        save=lambda: save_cache(cache),
        build_prompt=build_batch_prompt,
        call_api=call_api,
        accept=_accept_result,
        fallback_category="Uncategorized",
        batch_size=BATCH_SIZE,
        wave_size=30,
        wave_pause=2.0,  # brief pause between waves to stay under rate limits
    )


def classify_all(tweets: list[dict]) -> list[dict]:
    """Wrapper to run async classification."""
    return asyncio.run(classify_all_async(tweets))


# ── Step 3: Parse dates and compute temporal data ─────────────────────────
def parse_date(date_str: str):
    """Parse date strings like 'Jan 4, 2023' or 'Mar 15'."""
    for fmt in ["%b %d, %Y", "%B %d, %Y", "%b %d", "%B %d", "%m/%d/%Y"]:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None


def get_month_key(date_str: str) -> str:
    """Get YYYY-MM from a date string."""
    dt = parse_date(date_str)
    if dt:
        # If no year was parsed (year defaults to 1900), skip
        if dt.year < 2000:
            return "unknown"
        return dt.strftime("%Y-%m")
    return "unknown"


# ── Step 4: Generate outputs ──────────────────────────────────────────────
def build_taxonomy(tweets: list[dict]) -> dict:
    """Build taxonomy with counts."""
    cat_counter = Counter()
    for t in tweets:
        for cat in t["categories"]:
            cat_counter[cat] += 1

    total = len(tweets)
    taxonomy = {}
    for cat, count in sorted(cat_counter.items(), key=lambda x: -x[1]):
        taxonomy[cat] = {
            "count": count,
            "percentage": round(count / total * 100, 2),
        }
    return taxonomy


def build_json_output(tweets, files_processed, taxonomy):
    """Build the full JSON output."""
    # Date range
    dates = [parse_date(t["timestamp"]) for t in tweets]
    valid_dates = [d for d in dates if d and d.year >= 2000]
    earliest = min(valid_dates).strftime("%Y-%m-%d") if valid_dates else ""
    latest = max(valid_dates).strftime("%Y-%m-%d") if valid_dates else ""

    all_cats = sorted(set(cat for t in tweets for cat in t["categories"]))

    output = {
        "metadata": {
            "total_tweets": len(tweets),
            "files_processed": files_processed,
            "date_range": {"earliest": earliest, "latest": latest},
            "categories_discovered": all_cats,
        },
        "taxonomy": taxonomy,
        "tweets": [
            {
                "id": t["id"],
                "author": t["author"],
                "handle": t["handle"],
                "text": t["text"],
                "timestamp": t["timestamp"],
                "source_file": t["source_file"],
                "urls": t["urls"],
                "tickers": t["tickers"],
                "media": t["media"],
                "is_article": t.get("is_article"),
                "article_title": t.get("article_title"),
                "categories": t["categories"],
                "engagement": {
                    "like_count": t.get("like_count", 0),
                    "retweet_count": t.get("retweet_count", 0),
                },
            }
            for t in tweets
        ],
    }
    return output


def build_markdown_report(tweets, taxonomy, files_processed):
    """Build the analysis markdown report."""
    total = len(tweets)
    lines = []
    lines.append("# Tweet Analysis Report")
    lines.append(f"\n**Total unique tweets analyzed:** {total}")
    lines.append(f"**Files processed:** {len(files_processed)}")
    lines.append(f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M')}")

    # ── Section 1: Category Breakdown ──
    lines.append("\n---\n## Section 1: Category Breakdown\n")
    lines.append("### Full Hierarchical Taxonomy\n")
    lines.append("| Category | Count | % |")
    lines.append("|----------|------:|--:|")
    for cat, data in sorted(taxonomy.items(), key=lambda x: -x[1]["count"]):
        lines.append(f"| {cat} | {data['count']} | {data['percentage']}% |")

    # Top 5
    top5 = sorted(taxonomy.items(), key=lambda x: -x[1]["count"])[:5]
    lines.append("\n### Top 5 Most Populated Categories\n")
    for i, (cat, data) in enumerate(top5, 1):
        lines.append(f"{i}. **{cat}** - {data['count']} tweets ({data['percentage']}%)")

    # Small categories
    small = [(cat, data) for cat, data in taxonomy.items() if data["count"] < 3]
    if small:
        lines.append(f"\n### Categories with Fewer Than 3 Tweets ({len(small)} categories)\n")
        lines.append("These may represent niche interests or noise:\n")
        for cat, data in sorted(small, key=lambda x: x[0]):
            lines.append(f"- {cat} ({data['count']})")

    # Top-level distribution
    lines.append("\n### Top-Level Category Distribution\n")
    top_level = Counter()
    for t in tweets:
        for cat in t["categories"]:
            top = cat.split(" > ")[0]
            top_level[top] += 1
    lines.append("| Top-Level Category | Count |")
    lines.append("|-------------------|------:|")
    for cat, count in sorted(top_level.items(), key=lambda x: -x[1]):
        lines.append(f"| {cat} | {count} |")

    # ── Section 2: Temporal Patterns ──
    lines.append("\n---\n## Section 2: Temporal Patterns\n")

    # Monthly breakdown
    month_cats = defaultdict(lambda: Counter())
    month_counts = Counter()
    for t in tweets:
        mk = get_month_key(t["timestamp"])
        if mk == "unknown":
            continue
        month_counts[mk] += 1
        for cat in t["categories"]:
            top = cat.split(" > ")[0]
            month_cats[mk][top] += 1

    lines.append("### Monthly Tweet Volume\n")
    lines.append("| Month | Tweets |")
    lines.append("|-------|-------:|")
    for month in sorted(month_counts.keys()):
        lines.append(f"| {month} | {month_counts[month]} |")

    lines.append("\n### Interest Shifts Over Time\n")
    # For each month, show top categories
    for month in sorted(month_cats.keys()):
        if month == "unknown":
            continue
        cats = month_cats[month]
        total_month = sum(cats.values())
        lines.append(f"\n**{month}** ({total_month} categorized entries):")
        for cat, cnt in cats.most_common(5):
            pct = round(cnt / total_month * 100, 1)
            lines.append(f"  - {cat}: {cnt} ({pct}%)")

    # Subcategory temporal analysis
    lines.append("\n### Subcategory Trends\n")
    month_subcats = defaultdict(lambda: Counter())
    for t in tweets:
        mk = get_month_key(t["timestamp"])
        if mk == "unknown":
            continue
        for cat in t["categories"]:
            month_subcats[mk][cat] += 1

    # Find categories that spiked
    all_months = sorted(m for m in month_subcats.keys() if m != "unknown")
    if len(all_months) >= 2:
        lines.append("Notable spikes and trends:\n")
        cat_by_month = defaultdict(dict)
        for m in all_months:
            for cat, cnt in month_subcats[m].items():
                cat_by_month[cat][m] = cnt

        for cat, monthly in cat_by_month.items():
            values = list(monthly.values())
            if len(values) >= 2 and max(values) >= 5:
                avg = sum(values) / len(values)
                peak_month = max(monthly, key=monthly.get)
                peak_val = monthly[peak_month]
                if peak_val > avg * 2:
                    lines.append(f"- **{cat}** spiked in {peak_month} "
                                 f"({peak_val} tweets, avg {avg:.0f})")

    # Sustained vs brief
    lines.append("\n### Sustained vs. Brief Interests\n")
    cat_month_presence = defaultdict(set)
    for t in tweets:
        mk = get_month_key(t["timestamp"])
        if mk == "unknown":
            continue
        for cat in t["categories"]:
            cat_month_presence[cat].add(mk)

    sustained = [(cat, len(months)) for cat, months in cat_month_presence.items()
                 if len(months) >= len(all_months) * 0.6 and taxonomy.get(cat, {}).get("count", 0) >= 10]
    brief = [(cat, len(months)) for cat, months in cat_month_presence.items()
             if len(months) <= 2 and taxonomy.get(cat, {}).get("count", 0) >= 5]

    if sustained:
        lines.append("\n**Sustained interests** (present in 60%+ of months):\n")
        for cat, n in sorted(sustained, key=lambda x: -taxonomy.get(x[0], {}).get("count", 0)):
            lines.append(f"- {cat} ({taxonomy[cat]['count']} tweets across {n} months)")

    if brief:
        lines.append("\n**Brief interests** (appeared in 1-2 months only):\n")
        for cat, n in sorted(brief, key=lambda x: -taxonomy.get(x[0], {}).get("count", 0)):
            lines.append(f"- {cat} ({taxonomy[cat]['count']} tweets, {n} month(s))")

    # ── Section 3: Behavioral Patterns ──
    lines.append("\n---\n## Section 3: Behavioral Patterns\n")

    # Top authors
    author_counter = Counter()
    author_cats = defaultdict(lambda: Counter())
    for t in tweets:
        key = f"{t['author']} ({t['handle']})"
        author_counter[key] += 1
        for cat in t["categories"]:
            top = cat.split(" > ")[0]
            author_cats[key][top] += 1

    lines.append("### Top 10 Most-Liked Authors\n")
    lines.append("| # | Author | Tweets | Primary Categories |")
    lines.append("|---|--------|-------:|-------------------|")
    for i, (author, count) in enumerate(author_counter.most_common(10), 1):
        top_cats = ", ".join(f"{c}" for c, _ in author_cats[author].most_common(3))
        lines.append(f"| {i} | {author} | {count} | {top_cats} |")

    # Author concentration
    lines.append("\n### Author Concentration\n")
    total_authors = len(author_counter)
    top10_tweets = sum(c for _, c in author_counter.most_common(10))
    top50_tweets = sum(c for _, c in author_counter.most_common(50))
    lines.append(f"- **Total unique authors:** {total_authors}")
    lines.append(f"- **Top 10 authors account for:** {top10_tweets} tweets "
                 f"({round(top10_tweets/total*100, 1)}%)")
    lines.append(f"- **Top 50 authors account for:** {top50_tweets} tweets "
                 f"({round(top50_tweets/total*100, 1)}%)")
    lines.append(f"- **Single-tweet authors:** "
                 f"{sum(1 for c in author_counter.values() if c == 1)} "
                 f"({round(sum(1 for c in author_counter.values() if c == 1)/total_authors*100, 1)}%)")

    # Content type distribution
    lines.append("\n### Content Type Distribution\n")
    media_types = Counter(t["media"]["type"] for t in tweets)
    lines.append("| Media Type | Count | % |")
    lines.append("|-----------|------:|--:|")
    for mtype, count in media_types.most_common():
        lines.append(f"| {mtype} | {count} | {round(count/total*100, 1)}% |")

    # Ticker mentions
    ticker_counter = Counter()
    for t in tweets:
        for tk in t["tickers"]:
            ticker_counter[tk] += 1

    if ticker_counter:
        lines.append("\n### Ticker/Asset Mentions (Top 20)\n")
        lines.append("| Ticker | Mentions |")
        lines.append("|--------|--------:|")
        for ticker, count in ticker_counter.most_common(20):
            lines.append(f"| ${ticker} | {count} |")

    # ── Section 4: Key Insights ──
    lines.append("\n---\n## Section 4: Key Insights\n")

    # Generate insights using the data we've computed
    lines.append("### Priorities Revealed by Like Patterns\n")

    top_level_sorted = sorted(top_level.items(), key=lambda x: -x[1])
    if top_level_sorted:
        lines.append(f"Your top interest area is **{top_level_sorted[0][0]}** "
                     f"({top_level_sorted[0][1]} tweets, "
                     f"{round(top_level_sorted[0][1]/total*100, 1)}% of all likes), "
                     f"followed by **{top_level_sorted[1][0]}** "
                     f"({top_level_sorted[1][1]} tweets) "
                     f"and **{top_level_sorted[2][0]}** ({top_level_sorted[2][1]} tweets)."
                     if len(top_level_sorted) >= 3 else "")

    # Actionable vs passive
    lines.append("\n### Actionable vs. Passive Content\n")
    actionable_keywords = ["how to", "guide", "tutorial", "step by step", "thread",
                           "here's how", "strategy", "playbook", "framework",
                           "code", "build", "implement", "setup", "install"]
    passive_keywords = ["opinion", "think", "believe", "imo", "hot take",
                        "unpopular opinion", "controversial"]

    actionable = sum(1 for t in tweets
                     if any(kw in t["text"].lower() for kw in actionable_keywords))
    passive = sum(1 for t in tweets
                  if any(kw in t["text"].lower() for kw in passive_keywords))
    lines.append(f"- **Actionable content** (how-tos, strategies, code): ~{actionable} tweets "
                 f"({round(actionable/total*100, 1)}%)")
    lines.append(f"- **Opinion/commentary content**: ~{passive} tweets "
                 f"({round(passive/total*100, 1)}%)")
    lines.append(f"- **Other/mixed**: ~{total - actionable - passive} tweets")

    # Redundancy check
    lines.append("\n### Redundancy Analysis\n")
    # Check for similar tweets (same author + similar topic)
    author_cat_combos = Counter()
    for t in tweets:
        for cat in t["categories"]:
            key = f"{t['handle']} → {cat}"
            author_cat_combos[key] += 1

    redundant = [(combo, cnt) for combo, cnt in author_cat_combos.items() if cnt >= 5]
    if redundant:
        lines.append("You frequently like similar content from the same authors:\n")
        for combo, cnt in sorted(redundant, key=lambda x: -x[1])[:15]:
            lines.append(f"- {combo}: {cnt} tweets")
    else:
        lines.append("No significant redundancy detected - your likes are fairly diverse.")

    # URL-heavy tweets
    url_tweets = sum(1 for t in tweets if t["urls"])
    lines.append(f"\n### Link Sharing\n")
    lines.append(f"- {url_tweets} tweets ({round(url_tweets/total*100,1)}%) contain URLs")
    lines.append(f"- {total - url_tweets} tweets ({round((total-url_tweets)/total*100,1)}%) are text/media only")

    return "\n".join(lines)


# ── Main ──────────────────────────────────────────────────────────────────
def purge_failed_from_cache() -> int:
    """Drop cached entries that represent failed classifications - exact
    ['Uncategorized'], empty lists, or non-list values - so the next run
    re-classifies them. Returns the number of entries purged."""
    cache = load_cache()
    before = len(cache)
    def is_failure(v):
        return v == ["Uncategorized"] or not isinstance(v, list) or not v
    cache = {k: v for k, v in cache.items() if not is_failure(v)}
    purged = before - len(cache)
    save_cache(cache)
    return purged


def main():
    print("=" * 60)
    print("TROVE PARSER & CLASSIFIER")
    print("=" * 60)

    if "--retry-failed" in sys.argv:
        purged = purge_failed_from_cache()
        print(f"\n[0/3] Purged {purged} 'Uncategorized' entries from cache "
              f"- they will be re-classified.")

    # Step 1: Parse
    print("\n[1/3] Parsing HTML files...\n")
    tweets, files_processed = parse_all_files()

    # Step 2: Classify
    print(f"\n[2/3] Classifying {len(tweets)} tweets with {MODEL}...\n")
    tweets = classify_all(tweets)

    # Step 3: Output
    print("\n[3/3] Generating outputs...\n")
    taxonomy = build_taxonomy(tweets)

    # JSON
    json_output = build_json_output(tweets, files_processed, taxonomy)
    with open(OUTPUT_JSON, "w") as f:
        json.dump(json_output, f, indent=2, ensure_ascii=False)
    print(f"  Wrote {OUTPUT_JSON}")

    # Markdown
    md_output = build_markdown_report(tweets, taxonomy, files_processed)
    with open(OUTPUT_MD, "w") as f:
        f.write(md_output)
    print(f"  Wrote {OUTPUT_MD}")

    print(f"\nDone! {len(tweets)} tweets classified into {len(taxonomy)} categories.")


if __name__ == "__main__":
    main()
