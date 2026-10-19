#!/usr/bin/env python3
"""Shared utilities for the Trove offline pipeline.

Home for logic that was previously copy-pasted across the pipeline scripts:

- JSON cache load/save (`parse_and_classify.py`, `reclassify_canonical.py`,
  and `enrich.py` each shipped their own near-identical version).
- `md5_key` cache-key hashing (was defined in `enrich.py`).
- `parse_classification_response` (was defined in `parse_and_classify.py` and
  imported by `reclassify_canonical.py`).
- The async batched-classification engine with bisection-on-failure and
  wave-based cache checkpointing, which the two classifier scripts had two
  divergent copies of. It is parameterized here over prompt construction,
  the (provider-specific) API call, and per-result acceptance so both the
  canonical (OpenRouter) and legacy emergent (Anthropic) classifiers can share
  a single implementation.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Awaitable, Callable, Optional, Union
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

__all__ = [
    "md5_key",
    "normalize_image_url",
    "load_json_cache",
    "save_json_cache",
    "parse_classification_response",
    "run_classification",
]


# ── Hashing ────────────────────────────────────────────────────────────────
def md5_key(value: str) -> str:
    return hashlib.md5(value.encode("utf-8")).hexdigest()


# ── Image URL normalization ───────────────────────────────────────────────
# Twitter's CDN serves the same media file under several variants
# (?format=jpg&name=large, ?name=orig, etc.). Strip those before hashing so
# the same image deduplicates across tweets / sizes. Moved here from enrich.py
# so both the enrichment pipeline and the classifier share one definition.
_IMAGE_VARIANT_PARAM_DROPS = {"format", "name", "mode", "size", "quality"}


def normalize_image_url(url: str) -> str:
    """Canonicalize an image URL for the image-description cache key.

    Lowercase scheme + host, drop fragment, sort query params for stability,
    strip a single trailing slash, and drop Twitter-CDN variant params
    (`format`, `name`, ...) so `pic.png?format=jpg&name=large` and
    `pic.png?name=orig` collapse to the same key.
    """
    if not url:
        return ""
    raw = url.strip().split("#", 1)[0]
    try:
        p = urlparse(raw)
    except Exception:
        return raw.lower()
    if not p.scheme or not p.netloc:
        return raw.lower()
    qs = [
        (k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
        if k.lower() not in _IMAGE_VARIANT_PARAM_DROPS
    ]
    qs.sort()
    path = p.path.rstrip("/") or "/"
    return urlunparse((
        p.scheme.lower(),
        p.netloc.lower(),
        path,
        "",
        urlencode(qs),
        "",
    ))


# ── JSON cache helpers ─────────────────────────────────────────────────────
def load_json_cache(path: Path) -> dict:
    """Load a JSON dict cache, tolerating a missing or corrupt file."""
    if path.exists():
        try:
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, OSError) as e:
            print(f"  WARN: cache {path.name} unreadable ({e}); starting fresh",
                  file=sys.stderr)
    return {}


def save_json_cache(path: Path, cache: dict) -> None:
    """Persist a dict cache atomically (temp file + rename)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp.replace(path)


# ── Classifier response parsing ────────────────────────────────────────────
def parse_classification_response(text: str) -> list[dict]:
    """Parse a classifier response, salvaging partial JSON when possible.

    Returns a list of {id, categories} dicts. May be empty if nothing parsed,
    or partial if the response was truncated mid-array.
    """
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r'^```\w*\n?', '', text)
        text = re.sub(r'\n?```\s*$', '', text)

    # Strategy 1: clean parse of the outer array
    json_match = re.search(r'\[.*\]', text, re.DOTALL)
    if json_match:
        try:
            results = json.loads(json_match.group())
            if isinstance(results, list):
                return [r for r in results
                        if isinstance(r, dict) and 'id' in r and 'categories' in r]
        except json.JSONDecodeError:
            pass

    # Strategy 2: salvage individual {…} objects (handles truncated arrays /
    # trailing junk). Schema is flat, so a no-nesting regex is enough.
    items = []
    for m in re.finditer(r'\{[^{}]+\}', text, re.DOTALL):
        try:
            obj = json.loads(m.group())
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and 'id' in obj and 'categories' in obj:
            items.append(obj)
    return items


# ── Batched classification engine ──────────────────────────────────────────
# A prompt payload is either a plain string (text-only models) or an
# OpenAI-style content-blocks list (multimodal: text + image_url blocks).
PromptPayload = Union[str, list[dict]]

# Callable contracts:
#   build_prompt(tweets)        -> PromptPayload : batch prompt for the model
#   call_api(payload)           -> list[dict]     : awaited; already parsed +
#                                                   rate-limit-backed-off
#   accept(item, asked_ids)     -> (id, cats) | None : validate/normalize one
#                                                   returned result into the
#                                                   (tweet_id, categories) to
#                                                   cache, or None to reject
#   cache_key(tweet)            -> str            : stable key under which a
#                                                   tweet's classification is
#                                                   cached. Defaults to the
#                                                   bare tweet id (legacy
#                                                   behavior); the canonical
#                                                   classifier overrides it
#                                                   with a signature hash so
#                                                   changing the prompt input
#                                                   (mode, model, image ctx)
#                                                   invalidates old entries.
BuildPrompt = Callable[[list], PromptPayload]
CallApi = Callable[[PromptPayload], Awaitable[list]]
Accept = Callable[[dict, set], Optional[tuple]]
CacheKey = Callable[[dict], str]


def _default_cache_key(t: dict) -> str:
    return str(t["id"])


async def _classify_recursive(
    tweets: list,
    *,
    cache: dict,
    lock: asyncio.Lock,
    build_prompt: BuildPrompt,
    call_api: CallApi,
    accept: Accept,
    fallback_category: str,
    cache_key: CacheKey = _default_cache_key,
) -> None:
    """Classify a batch; on partial/total failure, bisect down to size 1.

    A tweet is only assigned `fallback_category` after a single-tweet attempt
    also fails - so one stray malformed response no longer kills a whole batch.
    """
    key_by_id = {str(t["id"]): cache_key(t) for t in tweets}
    pending = [t for t in tweets if cache_key(t) not in cache]
    if not pending:
        return

    asked_ids = {t["id"] for t in pending}
    try:
        results = await call_api(build_prompt(pending))
    except Exception as e:
        # Report the failure, then fall through to bisection. Letting this
        # propagate would abort the whole wave in classify_all's gather() and
        # skip its save(), losing the cache checkpoint for work that already
        # succeeded. A tweet still only reaches `fallback_category` after a
        # single-tweet attempt of its own has failed.
        print(f"\n  ! batch of {len(pending)} failed ({type(e).__name__}: {e}); "
              f"bisecting", file=sys.stderr, flush=True)
        results = []

    if results:
        async with lock:
            for item in results:
                accepted = accept(item, asked_ids)
                if accepted is not None:
                    tid, cats = accepted
                    cache[key_by_id.get(str(tid), str(tid))] = cats

    still_pending = [t for t in pending if cache_key(t) not in cache]
    if not still_pending:
        return
    if len(still_pending) == 1:
        async with lock:
            cache[cache_key(still_pending[0])] = [fallback_category]
        return

    mid = len(still_pending) // 2
    kw = dict(cache=cache, lock=lock, build_prompt=build_prompt,
              call_api=call_api, accept=accept,
              fallback_category=fallback_category, cache_key=cache_key)
    await asyncio.gather(
        _classify_recursive(still_pending[:mid], **kw),
        _classify_recursive(still_pending[mid:], **kw),
    )


async def _classify_batch(
    batch: list,
    *,
    cache: dict,
    lock: asyncio.Lock,
    progress: dict,
    **kw,
) -> None:
    """Classify one batch (with bisection), then advance the progress line."""
    cache_key = kw.get("cache_key", _default_cache_key)
    if any(cache_key(t) not in cache for t in batch):
        await _classify_recursive(batch, cache=cache, lock=lock, **kw)
    async with lock:
        progress["done"] += len(batch)
        done = progress["done"]
        total = progress["total"]
        print(f"\r  Progress: {done}/{total} tweets ({done * 100 // total}%)...",
              end="", flush=True)


async def run_classification(
    tweets: list,
    *,
    cache: dict,
    save: Callable[[], None],
    build_prompt: BuildPrompt,
    call_api: CallApi,
    accept: Accept,
    fallback_category: str,
    batch_size: int,
    wave_size: int,
    wave_pause: float = 0.0,
    cache_key: CacheKey = _default_cache_key,
) -> list:
    """Classify all `tweets` concurrently, checkpointing the cache per wave.

    `save` persists `cache` to disk; it is called after each wave so a crash
    never loses more than one wave of work. `wave_pause` inserts a delay
    between waves (used by the Anthropic path to stay under rate limits).
    `cache_key` maps a tweet to its cache key; the default keeps the legacy
    bare-tweet-id behavior so `parse_and_classify.py` is unchanged.
    Categories are attached to each tweet in place and `tweets` is returned.
    """
    cached_count = sum(1 for t in tweets if cache_key(t) in cache)
    print(f"  Cache: {cached_count}/{len(tweets)} already classified")

    batches = []
    for i in range(0, len(tweets), batch_size):
        batch = tweets[i:i + batch_size]
        if not all(cache_key(t) in cache for t in batch):
            batches.append(batch)

    if not batches:
        print("  All tweets already cached!")
    else:
        print(f"  {len(batches)} batches to process...")
        lock = asyncio.Lock()
        progress = {"done": cached_count, "total": len(tweets)}
        kw = dict(build_prompt=build_prompt, call_api=call_api,
                  accept=accept, fallback_category=fallback_category,
                  cache_key=cache_key)
        for wave_start in range(0, len(batches), wave_size):
            wave = batches[wave_start:wave_start + wave_size]
            await asyncio.gather(*[
                _classify_batch(b, cache=cache, lock=lock, progress=progress, **kw)
                for b in wave
            ])
            save()
            print(f"\n  [wave saved: {len(cache)} entries cached]", flush=True)
            if wave_pause:
                await asyncio.sleep(wave_pause)

    print("\n  Classification complete!")
    for t in tweets:
        t["categories"] = cache.get(cache_key(t), [fallback_category])
    return tweets
