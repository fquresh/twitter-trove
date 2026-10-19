#!/usr/bin/env python3
"""
Offline enrichment pipeline for the Trove archive.

Sibling to parse_and_classify.py. Reads `categorized_tweets.json` (the
classifier's output) and produces `enriched_tweets.json` consumed by the v2
webapp's `/import` route. Three enrichment phases, each independently
toggleable via --only-{embeddings,urls,images}:

  1. Embeddings        Voyage's voyage-3-large, L2-normalized, int8-quantized.
  2. URL extraction    trafilatura main-content extraction over linked pages.
  3. Image descriptions Vision over each unique image.  Default model is
                       google/gemini-2.5-flash via OpenRouter; pass any
                       --vision-model claude-* to use Anthropic instead.

Each phase has its own JSON cache (.embedding_cache.json, .url_content_cache.json,
.image_description_cache.json) keyed by stable IDs, so partial reruns never
re-spend on completed work. The HTML files in `exports/` remain the source
of truth - these caches are memoization, not replacement.

Required env: VOYAGE_API_KEY (embeddings); OPENROUTER_API_KEY for default
vision (OpenRouter) or ANTHROPIC_API_KEY when --vision-model is claude-*.
Required deps: voyageai, numpy (Phase 2); httpx, trafilatura (Phase 3);
anthropic (only when using a claude-* vision model).
"""

import argparse
import asyncio
import base64
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Sequence
from urllib.parse import urlparse, urlunparse, parse_qsl, urlencode

from trove_common import md5_key, load_json_cache, save_json_cache, normalize_image_url


# ── Paths ──────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT = ROOT / "categorized_tweets.json"
DEFAULT_EXPORTS_DIR = ROOT / "exports"
DEFAULT_OUTPUT = ROOT / "enriched_tweets.json"
EMBEDDING_CACHE_FILE = ROOT / ".embedding_cache.json"
URL_CONTENT_CACHE_FILE = ROOT / ".url_content_cache.json"
IMAGE_DESCRIPTION_CACHE_FILE = ROOT / ".image_description_cache.json"

# ── Defaults ───────────────────────────────────────────────────────────────
DEFAULT_EMBED_MODEL = "voyage-3-large"
DEFAULT_EMBED_DIM = 1024
DEFAULT_VISION_MODEL = "google/gemini-2.5-flash"

# Truncation budget for the embed-text per-tweet (plan §risk-8). Voyage's
# context window covers the rest; FTS still indexes the full content.
EMBED_TEXT_MAX_CHARS = 2000
# Per-batch sizing. Voyage allows up to 1000 inputs and 120K tokens; we keep
# batches smaller to keep retries cheap.
DEFAULT_EMBED_BATCH_SIZE = 128
# Cost / token approximation (rough char-to-token proxy used only for dry-run
# estimates; actual billing comes back as result.total_tokens after each call).
EMBED_COST_PER_M_TOKENS = 0.18  # voyage-3-large input pricing as of plan auth.

# URL extraction (Phase 3) - bandwidth only, no API spend.
URL_FETCH_TIMEOUT_SEC = 20.0
URL_CONNECT_TIMEOUT_SEC = 10.0
URL_CONTENT_MAX_CHARS = 4000
URL_MAX_REDIRECTS = 5
URL_MAX_BODY_BYTES = 2 * 1024 * 1024  # stop reading a response past 2 MB
URL_USER_AGENT = "Mozilla/5.0 (compatible; trove-enrich/1.0; +local archive)"
# A tweet's `text` field is X's display copy - long URLs get truncated with a
# Unicode ellipsis (U+2026). Those URLs cannot be fetched; we cache as
# 'truncated' rather than retry blindly. We deliberately don't match literal
# `...` because it's far too common inside legitimate URLs and tweet text.
TRUNCATION_MARKER = "…"

# Image descriptions (Phase 4). The prompt is locked in the plan; do not edit
# without renaming the model entry in the cache (since cache key includes the
# model and a prompt change ought to invalidate prior outputs).
IMAGE_DESCRIPTION_PROMPT = (
    "Describe this image in 30-80 words. Read all visible text first, then "
    "state objects/context. If a chart or diagram, name the axes and the "
    "main takeaway. Plain prose, no preamble."
)
IMAGE_DESCRIPTION_MAX_TOKENS = 200
# Haiku 4.5 input / output rates as of plan authoring.
HAIKU_COST_INPUT_PER_M = 1.0
HAIKU_COST_OUTPUT_PER_M = 5.0
# Anthropic Vision: ~700 input + ~120 output tokens per image (the image alone
# tokenizes to ~600; the prompt + response add the rest).
IMAGE_INPUT_TOKEN_ESTIMATE = 700
IMAGE_OUTPUT_TOKEN_ESTIMATE = 120

# OpenRouter (OpenAI-compatible Vision endpoint).  Used for non-Claude vision
# models like google/gemini-2.5-flash.  Prices per 1M tokens as of swap.
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
GEMINI_FLASH_COST_INPUT_PER_M = 0.30
GEMINI_FLASH_COST_OUTPUT_PER_M = 2.50
# Gemini 2.5 Flash tokenizes images more densely than Anthropic - observed
# ~1850 input + ~80 output tokens per Twitter-CDN image in field testing.
GEMINI_IMAGE_INPUT_TOKEN_ESTIMATE = 1850
GEMINI_IMAGE_OUTPUT_TOKEN_ESTIMATE = 100


# ── URL normalization ─────────────────────────────────────────────────────
# `normalize_image_url` (image-URL variant collapse) now lives in
# `trove_common` so the classifier and this pipeline share one definition.
def normalize_url(url: str) -> str:
    """Canonicalize a URL for the URL-content cache key.

    Lowercase scheme + host, drop fragment, sort query params for stability,
    strip a single trailing slash. Any URL that fails to parse is returned
    lowercased and stripped - md5 over it still gives a stable key.
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
    qs = sorted(parse_qsl(p.query, keep_blank_values=True))
    path = p.path.rstrip("/") or "/"
    canonical = urlunparse((
        p.scheme.lower(),
        p.netloc.lower(),
        path,
        "",
        urlencode(qs),
        "",
    ))
    return canonical


# ── Embed-text construction ───────────────────────────────────────────────
def build_embed_text(
    tweet: dict,
    image_cache: dict,
    url_cache: dict,
) -> str:
    """Compose the text fed to the embedding model for `tweet`.

    Format (plan §Offline enrichment, Embedding text construction):

        {handle}: {text}

        [Categories: {csv categories}]
        [Image: {first cached image description, ≤400 chars}]
        [Linked: {first cached URL content, ≤300 chars}]

    Bracketed lines are emitted only when the corresponding enrichment exists
    in the cache. Including handle + categories materially improves recall;
    enrichment lines fold in image/article context that bare tweet text lacks.
    """
    handle = (tweet.get("handle") or "").strip()
    text = (tweet.get("text") or "")[:EMBED_TEXT_MAX_CHARS]
    cats = [c for c in (tweet.get("categories") or []) if c and c != "Uncategorized"]

    parts: list[str] = [f"{handle}: {text}".strip(), ""]  # blank line after main
    if cats:
        parts.append(f"[Categories: {', '.join(cats)}]")

    # First cached image description (if any).
    media_urls = ((tweet.get("media") or {}).get("urls")) or []
    for img_url in media_urls:
        entry = image_cache.get(md5_key(normalize_image_url(img_url)))
        if entry and entry.get("description"):
            desc = entry["description"][:400].strip()
            if desc:
                parts.append(f"[Image: {desc}]")
                break

    # First cached URL extraction (if any).
    for url in (tweet.get("urls") or []):
        entry = url_cache.get(md5_key(normalize_url(url)))
        if entry and entry.get("content"):
            summary = entry["content"][:300].strip()
            if summary:
                parts.append(f"[Linked: {summary}]")
                break

    return "\n".join(parts)


# ── Embeddings (Phase 2) ──────────────────────────────────────────────────
def quantize_int8(vec_f32) -> tuple[bytes, float, float, int]:
    """L2-normalize then int8-quantize a vector (per-vector scale, offset=0).

    Returns (bytes, scale, offset, dim). Reconstruction in the worker is
    `f = b * scale + offset` (offset is always 0 here but the schema keeps it
    in case future quantization wants a non-zero zero-point).
    """
    import numpy as np

    v = np.asarray(vec_f32, dtype=np.float32).ravel()
    n = float(np.linalg.norm(v))
    if n > 0:
        v = v / n
    abs_max = float(np.max(np.abs(v))) if v.size else 0.0
    if abs_max == 0.0:
        # Degenerate (zero vector). Store all-zero int8 with scale=0; the worker
        # will dequant to zero, which is correct.
        return bytes(v.size), 0.0, 0.0, int(v.size)
    scale = abs_max / 127.0
    q = np.clip(np.round(v / scale), -127, 127).astype(np.int8)
    return q.tobytes(), float(scale), 0.0, int(q.size)


async def embed_batch(
    aclient,
    semaphore,
    texts: Sequence[str],
    model: str,
    dim: int,
    *,
    max_retries: int = 6,
) -> tuple[list[list[float]], int]:
    """Embed a single batch of texts. Returns (embeddings, total_tokens)."""
    import voyageai

    async with semaphore:
        for attempt in range(max_retries):
            try:
                result = await aclient.embed(
                    list(texts),
                    model=model,
                    output_dimension=dim,
                    output_dtype="float",       # we quantize ourselves per plan
                    input_type=None,            # symmetric - query/document share embedding space
                    truncation=True,
                )
                return result.embeddings, int(result.total_tokens)
            except voyageai.error.RateLimitError as e:
                err = str(e)
                low = err.lower()
                # Tier-1 (free) accounts cap at 3 RPM / 10K TPM, which a normal
                # tweet batch blows through.  No amount of retry fixes this -
                # surface a clear error and stop.
                if "reduced rate limits" in low or "payment method" in low or \
                   "10k tpm" in low or "3 rpm" in low:
                    raise SystemExit(
                        "\n✗ Voyage rejected the request: account is on the free tier "
                        "(3 RPM / 10K TPM) which is too low for batched embeddings.\n"
                        f"  Voyage said: {err[:300]}\n"
                        "  Fix: add a payment method at https://dash.voyageai.com/ "
                        "to unlock standard limits.  The first $50 of usage is free, "
                        "and a full corpus embed is ~$1.  Then re-run "
                        "`./trove update --no-images` (URLs+embeddings only)."
                    )
                wait = min(60.0, 5.0 * (2 ** attempt))
                print(f"\n  rate-limited ({err[:120]}); sleeping {wait:.0f}s "
                      f"(attempt {attempt + 1}/{max_retries})",
                      file=sys.stderr)
                await asyncio.sleep(wait)
                continue
            except Exception as e:
                msg = str(e).lower()
                if "429" in msg or "rate" in msg or "timeout" in msg or "connection" in msg:
                    wait = min(60.0, 5.0 * (2 ** attempt))
                    print(f"\n  transient error '{e}'; sleeping {wait:.0f}s",
                          file=sys.stderr)
                    await asyncio.sleep(wait)
                    continue
                raise
        raise RuntimeError(f"embed_batch failed after {max_retries} retries")


def _guard_model_gate(
    *,
    phase: str,
    configured_model: str,
    pending_count: int,
    universe_count: int,
    cache: dict,
    yes_reprocess: bool,
    dry_run: bool,
    model_field: str = "model",
) -> None:
    """Catch an accidental full, PAID re-run caused by a changed model string.

    Both the image-describe and embedding caches are keyed on the model name,
    so pointing at a differently-named model turns every prior entry into a
    cache miss and re-bills the entire archive. That's the ONLY way a large
    re-run happens on an already-enriched corpus (the audit confirmed the pass
    is otherwise incremental). Detect it structurally: a large pending fraction
    against an already-large cache. When tripped, print the configured vs cached
    model strings loudly and - unless --yes-reprocess-images (or a dry run) -
    abort before spending anything.
    """
    if universe_count <= 0:
        return
    cache_size = len(cache)
    frac = pending_count / universe_count
    if not (frac > 0.5 and cache_size > 1000):
        return

    cached_models = sorted(
        {
            str(v.get(model_field))
            for v in cache.values()
            if isinstance(v, dict) and v.get(model_field)
        }
    )
    bar = "!" * 70
    print(f"\n  {bar}")
    print(
        f"  ⚠ MODEL GATE LIKELY TRIPPED - {pending_count}/{universe_count} "
        f"({frac:.0%}) pending against {cache_size} cached {phase} entries."
    )
    print(f"    Configured {phase} model : {configured_model}")
    print(
        f"    Model(s) in cache         : "
        f"{', '.join(cached_models) or '(none recorded)'}"
    )
    print("    The cache is keyed on the model string, so a renamed/changed model")
    print("    makes every prior entry a miss and forces a full PAID re-run.")
    if dry_run:
        print("    (dry-run: not blocking - this is what a real run would re-bill.)")
        print(f"  {bar}")
        return
    if yes_reprocess:
        print("    --yes-reprocess-images given: proceeding with the full re-run.")
        print(f"  {bar}")
        return
    print("    If you really did change models, re-run with:")
    print("      --yes-reprocess-images")
    print("    Otherwise set the model back to match the cache above.")
    print(f"  {bar}")
    raise SystemExit(2)


async def run_embeddings(
    tweets: list[dict],
    *,
    model: str,
    dim: int,
    batch_size: int,
    concurrency: int,
    save_every: int,
    image_cache: dict,
    url_cache: dict,
    dry_run: bool,
    yes_reprocess: bool = False,
) -> dict:
    """Embed every tweet not already in the cache.

    Returns the embedding cache (mutated in place + returned for clarity).
    """
    cache = load_json_cache(EMBEDDING_CACHE_FILE)

    # Build the work list (skip already-cached tweets that match the model).
    pending: list[tuple[str, str]] = []
    for t in tweets:
        tid = str(t.get("id") or "")
        if not tid:
            continue
        cached = cache.get(tid)
        if cached and cached.get("model") == model and cached.get("dim") == dim:
            continue
        pending.append((tid, build_embed_text(t, image_cache, url_cache)))

    cached_count = len(tweets) - len(pending)
    print(f"  Embedding cache: {cached_count}/{len(tweets)} already present "
          f"(model={model}, dim={dim})")

    _guard_model_gate(
        phase="embedding",
        configured_model=model,
        pending_count=len(pending),
        universe_count=len(tweets),
        cache=cache,
        yes_reprocess=yes_reprocess,
        dry_run=dry_run,
    )

    if dry_run:
        # Char-to-token proxy (~4 chars/token). Voyage's actual tokenization
        # tends to come in lower for short tweets - treat this as an upper bound.
        total_chars = sum(len(t) for _, t in pending)
        approx_tokens = max(1, total_chars // 4)
        cost = (approx_tokens / 1_000_000) * EMBED_COST_PER_M_TOKENS
        print(f"  DRY RUN - to embed {len(pending)} tweets: "
              f"~{approx_tokens:,} tokens, est. ${cost:.4f}")
        return cache

    if not pending:
        print("  All embeddings already cached.")
        return cache

    api_key = os.environ.get("VOYAGE_API_KEY")
    if not api_key:
        raise SystemExit(
            "ERROR: VOYAGE_API_KEY is not set. Run `export VOYAGE_API_KEY=…` "
            "or pass it inline before invoking enrich.py.")

    import voyageai
    aclient = voyageai.AsyncClient(api_key=api_key)
    semaphore = asyncio.Semaphore(concurrency)

    batches = [pending[i:i + batch_size] for i in range(0, len(pending), batch_size)]
    print(f"  {len(batches)} batches × ≤{batch_size} tweets, "
          f"concurrency={concurrency}, save every {save_every} batches")

    completed_batches = 0
    total_tokens = 0
    started = time.time()

    async def run_one(idx: int, batch: list[tuple[str, str]]):
        nonlocal completed_batches, total_tokens
        ids = [tid for tid, _ in batch]
        texts = [text for _, text in batch]
        embeddings, tokens = await embed_batch(aclient, semaphore, texts, model, dim)
        for tid, vec in zip(ids, embeddings):
            blob, scale, offset, vdim = quantize_int8(vec)
            cache[tid] = {
                "model": model,
                "dim": vdim,
                "dtype": "int8",
                "scale": scale,
                "offset": offset,
                "vector_b64": base64.b64encode(blob).decode("ascii"),
            }
        completed_batches += 1
        total_tokens += tokens
        if completed_batches % save_every == 0:
            save_json_cache(EMBEDDING_CACHE_FILE, cache)
        elapsed = time.time() - started
        rate = completed_batches / elapsed if elapsed > 0 else 0.0
        print(f"\r  batch {completed_batches}/{len(batches)} "
              f"({rate:.2f} batches/s, {total_tokens:,} tokens)",
              end="", flush=True)

    await asyncio.gather(*(run_one(i, b) for i, b in enumerate(batches)))
    save_json_cache(EMBEDDING_CACHE_FILE, cache)

    cost = (total_tokens / 1_000_000) * EMBED_COST_PER_M_TOKENS
    print(f"\n  Embedded {len(pending)} tweets - {total_tokens:,} tokens "
          f"(~${cost:.4f})")
    return cache


# ── URLs (Phase 3) ────────────────────────────────────────────────────────
def _is_truncated_url(url: str) -> bool:
    return TRUNCATION_MARKER in url


def _collect_unique_urls(tweets: list[dict]) -> dict[str, str]:
    """Return {md5(normalize_url): first-seen original URL} across all tweets.

    Two tweets that link to the same article through different t.co
    impressions WON'T dedupe here (their original URLs differ); _safe_get
    follows redirects per-fetch, so they collapse on
    the destination instead of the source. For our corpus that's good enough.
    """
    out: dict[str, str] = {}
    for t in tweets:
        for u in (t.get("urls") or []):
            if not isinstance(u, str) or not u.strip():
                continue
            key = md5_key(normalize_url(u))
            if key not in out:
                out[key] = u
    return out


class UnsafeURLError(Exception):
    """Raised when a URL (or a redirect hop) fails the SSRF destination check."""


def _ip_is_blocked(addr: str) -> bool:
    """True for any address that is not a public, globally routable one:
    loopback, private (RFC1918, fc00::/7), link-local (169.254/16, fe80::/10),
    multicast, reserved, unspecified, plus CGNAT and other non-global ranges."""
    import ipaddress

    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return True
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return (
        ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified or not ip.is_global
    )


async def _resolve_host(host: str, port: int) -> list[str]:
    """Resolve host to a list of IP strings. Separate so tests can patch it."""
    import socket

    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


async def _validate_fetch_url(url: str) -> None:
    """Allow only http/https URLs whose every resolved address is public.
    Raises UnsafeURLError otherwise."""
    import ipaddress

    parts = urlparse(url)
    if parts.scheme not in ("http", "https"):
        raise UnsafeURLError(f"scheme not allowed: {parts.scheme!r}")
    host = parts.hostname
    if not host:
        raise UnsafeURLError("missing host")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise UnsafeURLError("invalid port")
    try:
        ipaddress.ip_address(host)
        addrs = [host]
    except ValueError:
        try:
            addrs = await _resolve_host(host, port)
        except OSError as e:
            raise UnsafeURLError(f"cannot resolve host: {e}")
    if not addrs:
        raise UnsafeURLError("no addresses")
    for a in addrs:
        if _ip_is_blocked(a):
            raise UnsafeURLError(f"blocked destination address: {a}")


class _FetchResult:
    """Minimal response stand-in: status, headers, final url, decoded text."""

    def __init__(self, status_code, headers, url, body: bytes, encoding):
        self.status_code = status_code
        self.headers = headers
        self.url = url
        self._body = body
        self._encoding = encoding or "utf-8"

    @property
    def text(self) -> str:
        return self._body.decode(self._encoding, errors="replace")


async def _safe_get(client, url: str) -> "_FetchResult":
    """GET with manual redirect following. Every hop is re-validated, and the
    body is streamed and cut off at URL_MAX_BODY_BYTES. The client must be built
    with follow_redirects=False."""
    from urllib.parse import urljoin

    current = url
    for _ in range(URL_MAX_REDIRECTS + 1):
        await _validate_fetch_url(current)
        async with client.stream("GET", current) as resp:
            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("location")
                if loc:
                    current = urljoin(str(resp.url), loc)
                    continue
            chunks: list[bytes] = []
            size = 0
            async for chunk in resp.aiter_bytes():
                chunks.append(chunk)
                size += len(chunk)
                if size >= URL_MAX_BODY_BYTES:
                    break
            body = b"".join(chunks)[:URL_MAX_BODY_BYTES]
            return _FetchResult(resp.status_code, resp.headers, resp.url, body, resp.encoding)
    raise UnsafeURLError("too many redirects")


async def _fetch_one_url(client, url: str) -> dict:
    """Single URL fetch + main-content extract. Always returns a cache entry -
    failures get a status code so we don't re-fetch them."""
    import trafilatura

    fetched_at = int(time.time())
    try:
        t0 = time.time()
        resp = await _safe_get(client, url)
        elapsed_ms = int((time.time() - t0) * 1000)
        ct = resp.headers.get("content-type", "").lower()
        base = {
            "url": url,
            "final_url": str(resp.url),
            "status_code": resp.status_code,
            "content_type": ct,
            "fetched_at": fetched_at,
            "elapsed_ms": elapsed_ms,
        }
        if resp.status_code >= 400:
            return {**base, "status": f"http_{resp.status_code}", "content": ""}
        if "html" not in ct and "xml" not in ct and ct != "":
            return {**base, "status": "non_html", "content": ""}
        text = trafilatura.extract(
            resp.text,
            include_comments=False,
            include_tables=True,
            favor_precision=True,
        ) or ""
        text = text.strip()
        if not text:
            return {**base, "status": "empty", "content": ""}
        return {**base, "status": "ok", "content": text[:URL_CONTENT_MAX_CHARS]}
    except Exception as e:
        # httpx wraps a wide variety of network errors; we differentiate the
        # common ones for stat purposes but cache them all so the URL doesn't
        # get retried each run.
        import httpx
        if isinstance(e, UnsafeURLError):
            status = "blocked_url"
        elif isinstance(e, httpx.TimeoutException):
            status = "timeout"
        elif isinstance(e, (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadError)):
            status = "connection_error"
        elif isinstance(e, httpx.RequestError):
            status = "request_error"
        else:
            status = "error"
        return {
            "url": url,
            "status": status,
            "content": "",
            "fetched_at": fetched_at,
            "error": str(e)[:200],
        }


async def run_urls(
    tweets: list[dict],
    *,
    concurrency: int,
    save_every: int,
    dry_run: bool,
) -> dict:
    cache = load_json_cache(URL_CONTENT_CACHE_FILE)

    unique = _collect_unique_urls(tweets)
    print(f"  Found {len(unique)} unique URL(s) across {len(tweets)} tweets")

    truncated_keys = {k for k, u in unique.items() if _is_truncated_url(u)}
    cached_keys = {k for k in unique if k in cache}
    pending_keys = [k for k in unique if k not in cache and k not in truncated_keys]

    print(f"  Cache: {len(cached_keys)} cached, {len(truncated_keys)} truncated (skip), "
          f"{len(pending_keys)} pending fetch")

    if dry_run:
        print(f"  DRY RUN - would fetch {len(pending_keys)} URLs "
              f"(no API cost, bandwidth only)")
        return cache

    # Mark truncated URLs in the cache so the next run doesn't recompute them.
    now = int(time.time())
    for k in truncated_keys:
        if k not in cache:
            cache[k] = {
                "url": unique[k],
                "content": "",
                "status": "truncated",
                "fetched_at": now,
            }

    if not pending_keys:
        save_json_cache(URL_CONTENT_CACHE_FILE, cache)
        return cache

    import httpx

    semaphore = asyncio.Semaphore(concurrency)
    stats: dict[str, int] = {}
    completed = 0
    started = time.time()
    save_lock = asyncio.Lock()

    timeout = httpx.Timeout(URL_FETCH_TIMEOUT_SEC, connect=URL_CONNECT_TIMEOUT_SEC)
    limits = httpx.Limits(
        max_connections=max(20, concurrency * 2),
        max_keepalive_connections=concurrency,
    )

    # follow_redirects stays off: _safe_get follows hops itself and re-validates
    # each destination (SSRF guard).
    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=timeout,
        headers={"User-Agent": URL_USER_AGENT},
        limits=limits,
    ) as client:
        async def fetch_one(key: str, url: str):
            nonlocal completed
            async with semaphore:
                entry = await _fetch_one_url(client, url)
            cache[key] = entry
            stats[entry["status"]] = stats.get(entry["status"], 0) + 1
            async with save_lock:
                completed += 1
                if completed % save_every == 0:
                    save_json_cache(URL_CONTENT_CACHE_FILE, cache)
                elapsed = time.time() - started
                rate = completed / elapsed if elapsed > 0 else 0.0
                print(f"\r  fetched {completed}/{len(pending_keys)} "
                      f"({rate:.1f}/s, ok={stats.get('ok', 0)})",
                      end="", flush=True)

        await asyncio.gather(*(fetch_one(k, unique[k]) for k in pending_keys))

    save_json_cache(URL_CONTENT_CACHE_FILE, cache)
    print(f"\n  URL fetch results: {stats}")
    return cache


# ── Images (Phase 4) ──────────────────────────────────────────────────────
def _collect_unique_images(tweets: list[dict]) -> dict[str, str]:
    """Return {md5(normalize_image_url): first-seen original URL} across all
    tweets. Twitter's CDN serves the same media file under several variants -
    `normalize_image_url` strips `?format=jpg&name=large`-style params so
    those variants collapse to one cache entry."""
    out: dict[str, str] = {}
    for t in tweets:
        media = t.get("media") or {}
        if media.get("type") != "image":
            continue
        for u in (media.get("urls") or []):
            if not isinstance(u, str) or not u.strip():
                continue
            key = md5_key(normalize_image_url(u))
            if key not in out:
                out[key] = u
    return out


def _vision_provider(model: str) -> str:
    """Return 'anthropic' for claude-* models, 'openrouter' for everything else.

    OpenRouter accepts model IDs of the form '<provider>/<model>'
    (e.g. 'google/gemini-2.5-flash')."""
    if model.startswith("claude-") or model.startswith("anthropic/claude-"):
        return "anthropic"
    return "openrouter"


def _vision_pricing(model: str) -> tuple[float, float]:
    """Return (input_per_M_tokens, output_per_M_tokens) USD for the model.

    Used for dry-run estimates and post-run cost summary; actual billing
    comes from the provider's usage object on each response."""
    if _vision_provider(model) == "anthropic":
        return HAIKU_COST_INPUT_PER_M, HAIKU_COST_OUTPUT_PER_M
    # OpenRouter: currently only Gemini Flash is wired up.  Add other models'
    # pricing here when we adopt them.
    return GEMINI_FLASH_COST_INPUT_PER_M, GEMINI_FLASH_COST_OUTPUT_PER_M


def _vision_token_estimate(model: str) -> tuple[int, int]:
    """Return per-image (input_tokens, output_tokens) estimates for dry-run.

    Token-per-image varies sharply by provider - Anthropic image-tokenizes to
    ~600, Gemini to ~1800 - so the dry-run estimate would be wildly off if we
    used a single global constant."""
    if _vision_provider(model) == "anthropic":
        return IMAGE_INPUT_TOKEN_ESTIMATE, IMAGE_OUTPUT_TOKEN_ESTIMATE
    return GEMINI_IMAGE_INPUT_TOKEN_ESTIMATE, GEMINI_IMAGE_OUTPUT_TOKEN_ESTIMATE


async def _describe_one_image(aclient, url: str, model: str) -> dict:
    """Single Haiku Vision call. Always returns a cache entry - failures get a
    status code so we don't re-spend on them.

    Anthropic's Vision API supports a URL source type which makes the model
    fetch the image itself; that saves us a round-trip and keeps the binary
    out of our process memory. If a particular CDN refuses the API's IP,
    we fall back to fetching bytes ourselves on the next call (not yet
    implemented - see status='bad_request' entries to gauge if it's needed).
    """
    import anthropic

    fetched_at = int(time.time())
    max_retries = 6
    last_err: Optional[str] = None

    for attempt in range(max_retries):
        try:
            t0 = time.time()
            resp = await aclient.messages.create(
                model=model,
                max_tokens=IMAGE_DESCRIPTION_MAX_TOKENS,
                messages=[{
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "url", "url": url},
                        },
                        {
                            "type": "text",
                            "text": IMAGE_DESCRIPTION_PROMPT,
                        },
                    ],
                }],
            )
            elapsed_ms = int((time.time() - t0) * 1000)
            text = "".join(
                b.text for b in resp.content if getattr(b, "type", None) == "text"
            ).strip()
            return {
                "url": url,
                "description": text,
                "model": model,
                "input_tokens": int(resp.usage.input_tokens),
                "output_tokens": int(resp.usage.output_tokens),
                "tokens": int(resp.usage.input_tokens + resp.usage.output_tokens),
                "fetched_at": fetched_at,
                "elapsed_ms": elapsed_ms,
                "status": "ok",
            }
        except anthropic.RateLimitError:
            wait = min(60.0, 5.0 * (2 ** attempt))
            print(f"\n  rate-limited; sleeping {wait:.0f}s "
                  f"(attempt {attempt + 1}/{max_retries})", file=sys.stderr)
            await asyncio.sleep(wait)
            continue
        except anthropic.BadRequestError as e:
            err = str(e)
            # Account-level fatal: don't persist 13k poisoned cache entries
            # and don't keep dialing.  Surface a clear error and stop.
            low = err.lower()
            if "credit balance is too low" in low or "insufficient_quota" in low or "billing" in low:
                raise SystemExit(
                    "\n✗ Anthropic API rejected the request: credits exhausted.\n"
                    "  Top up at https://console.anthropic.com/settings/billing\n"
                    "  then re-run `./trove update`.  Cached descriptions are kept;\n"
                    "  this run did not poison the cache."
                )
            # Per-image bad_request (image too large, unsupported format,
            # host blocked Anthropic, etc).  Terminal - no retry.
            return {
                "url": url, "description": "", "model": model,
                "fetched_at": fetched_at, "status": "bad_request",
                "error": err[:300],
            }
        except anthropic.APITimeoutError:
            wait = min(60.0, 5.0 * (2 ** attempt))
            await asyncio.sleep(wait)
            continue
        except Exception as e:
            msg = str(e).lower()
            last_err = str(e)[:300]
            if any(s in msg for s in ("overloaded", "timeout", "connection", "429")):
                wait = min(60.0, 5.0 * (2 ** attempt))
                await asyncio.sleep(wait)
                continue
            return {
                "url": url, "description": "", "model": model,
                "fetched_at": fetched_at, "status": "error",
                "error": last_err,
            }

    return {
        "url": url, "description": "", "model": model,
        "fetched_at": fetched_at, "status": "retries_exhausted",
        "error": last_err,
    }


async def _describe_one_image_openrouter(
    client, url: str, model: str, api_key: str,
) -> dict:
    """Single OpenRouter Vision call.  OpenAI-compatible chat-completions
    endpoint.  Mirrors _describe_one_image's return shape exactly so the
    on-disk cache is provider-agnostic.

    Image part uses the OpenAI shape ({"type": "image_url", "image_url":
    {"url": ...}}), not Anthropic's nested "source" object.  OpenRouter
    forwards the URL to the model provider, which fetches the image itself."""
    fetched_at = int(time.time())
    max_retries = 6
    last_err: Optional[str] = None

    body = {
        "model": model,
        "max_tokens": IMAGE_DESCRIPTION_MAX_TOKENS,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": url}},
                {"type": "text", "text": IMAGE_DESCRIPTION_PROMPT},
            ],
        }],
    }
    endpoint = f"{OPENROUTER_BASE_URL}/chat/completions"

    for attempt in range(max_retries):
        try:
            t0 = time.time()
            resp = await client.post(endpoint, json=body)
            elapsed_ms = int((time.time() - t0) * 1000)

            # Account-level fatals - fail fast rather than poison the cache.
            if resp.status_code == 401:
                raise SystemExit(
                    "\n✗ OpenRouter rejected the request: API key invalid or revoked.\n"
                    "  Re-add it via `./trove set-key` and retry.\n"
                    "  Cached descriptions are kept; this run did not poison the cache."
                )
            if resp.status_code == 402:
                raise SystemExit(
                    "\n✗ OpenRouter rejected the request: credits exhausted.\n"
                    "  Top up at https://openrouter.ai/credits then re-run.\n"
                    "  Cached descriptions are kept; this run did not poison the cache."
                )
            if resp.status_code == 429:
                wait = min(60.0, 5.0 * (2 ** attempt))
                print(f"\n  rate-limited; sleeping {wait:.0f}s "
                      f"(attempt {attempt + 1}/{max_retries})", file=sys.stderr)
                await asyncio.sleep(wait)
                continue
            if 500 <= resp.status_code < 600:
                wait = min(60.0, 5.0 * (2 ** attempt))
                last_err = f"HTTP {resp.status_code}: {resp.text[:200]}"
                await asyncio.sleep(wait)
                continue
            if resp.status_code >= 400:
                # Per-image bad_request - terminal (image too large, unsupported
                # format, host blocked the model provider, etc).
                return {
                    "url": url, "description": "", "model": model,
                    "fetched_at": fetched_at, "status": "bad_request",
                    "error": f"HTTP {resp.status_code}: {resp.text[:300]}",
                }

            # 2xx - parse the OpenAI-format response.
            try:
                data = resp.json()
            except Exception as e:
                last_err = f"non-JSON response: {str(e)[:200]}"
                wait = min(60.0, 5.0 * (2 ** attempt))
                await asyncio.sleep(wait)
                continue

            # OpenRouter occasionally returns 200 with an error object embedded
            # in the body (e.g. upstream provider rejected the request).
            if isinstance(data, dict) and data.get("error"):
                err_obj = data["error"]
                err_msg = (err_obj.get("message") if isinstance(err_obj, dict)
                           else str(err_obj))
                err_code = err_obj.get("code") if isinstance(err_obj, dict) else None
                low = (err_msg or "").lower()
                if err_code == 402 or "insufficient" in low or "credits" in low:
                    raise SystemExit(
                        "\n✗ OpenRouter rejected the request: credits exhausted.\n"
                        f"  ({err_msg})\n"
                        "  Top up at https://openrouter.ai/credits then re-run."
                    )
                return {
                    "url": url, "description": "", "model": model,
                    "fetched_at": fetched_at, "status": "bad_request",
                    "error": (err_msg or str(err_obj))[:300],
                }

            choices = data.get("choices") or []
            if not choices:
                return {
                    "url": url, "description": "", "model": model,
                    "fetched_at": fetched_at, "status": "error",
                    "error": f"empty choices: {str(data)[:200]}",
                }

            msg = choices[0].get("message") or {}
            text = (msg.get("content") or "").strip()

            usage = data.get("usage") or {}
            input_tokens = int(usage.get("prompt_tokens", 0))
            output_tokens = int(usage.get("completion_tokens", 0))

            return {
                "url": url,
                "description": text,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "tokens": input_tokens + output_tokens,
                "fetched_at": fetched_at,
                "elapsed_ms": elapsed_ms,
                "status": "ok",
            }
        except SystemExit:
            raise
        except Exception as e:
            import httpx
            last_err = str(e)[:300]
            if isinstance(e, httpx.RequestError):
                wait = min(60.0, 5.0 * (2 ** attempt))
                await asyncio.sleep(wait)
                continue
            return {
                "url": url, "description": "", "model": model,
                "fetched_at": fetched_at, "status": "error",
                "error": last_err,
            }

    return {
        "url": url, "description": "", "model": model,
        "fetched_at": fetched_at, "status": "retries_exhausted",
        "error": last_err,
    }


async def run_images(
    tweets: list[dict],
    *,
    model: str,
    concurrency: int,
    save_every: int,
    dry_run: bool,
    limit: Optional[int],
    yes_reprocess: bool = False,
) -> dict:
    cache = load_json_cache(IMAGE_DESCRIPTION_CACHE_FILE)

    unique = _collect_unique_images(tweets)
    print(f"  Found {len(unique)} unique image(s) across {len(tweets)} tweets")

    # An image is 'cached' for our purposes only if the cached entry uses the
    # currently-configured model AND succeeded. Failed entries with a
    # different model? still cached (don't retry on the same model). The plan
    # locks model into the cache key so swapping vision models adds rows
    # rather than overwriting prior runs (plan §schema delta footnote).
    cached_keys = {
        k for k, v in cache.items()
        if k in unique and v.get("model") == model
    }
    pending = [(k, u) for k, u in unique.items() if k not in cached_keys]

    # Check for an accidental full re-describe (changed --vision-model string)
    # on the natural pending set, BEFORE any --vision-limit truncation masks it.
    _guard_model_gate(
        phase="image-describe",
        configured_model=model,
        pending_count=len(pending),
        universe_count=len(unique),
        cache=cache,
        yes_reprocess=yes_reprocess,
        dry_run=dry_run,
    )

    if limit is not None and limit >= 0:
        pending = pending[:limit]
        print(f"  --vision-limit {limit}: processing only the first "
              f"{len(pending)} new images (Phase 4 gate)")

    print(f"  Cache: {len(cached_keys)} cached, {len(pending)} pending describe")

    provider = _vision_provider(model)
    in_per_m, out_per_m = _vision_pricing(model)
    in_per_img, out_per_img = _vision_token_estimate(model)

    if dry_run:
        n = len(pending)
        in_tok = n * in_per_img
        out_tok = n * out_per_img
        cost = (in_tok / 1_000_000) * in_per_m + (out_tok / 1_000_000) * out_per_m
        print(f"  DRY RUN - to describe {n} images with {model} ({provider}): "
              f"~{in_tok:,} input + ~{out_tok:,} output tokens, est. ${cost:.2f}")
        return cache

    if not pending:
        return cache

    if provider == "openrouter":
        api_key = os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise SystemExit(
                "ERROR: OPENROUTER_API_KEY is not set. Run `./trove set-key` "
                "to add it, or `export OPENROUTER_API_KEY=…` before invoking enrich.py.")
    else:  # anthropic
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise SystemExit(
                "ERROR: ANTHROPIC_API_KEY is not set. Run `export ANTHROPIC_API_KEY=…` "
                "before invoking enrich.py with the images phase enabled.")

    semaphore = asyncio.Semaphore(concurrency)
    completed = 0
    started = time.time()
    save_lock = asyncio.Lock()
    stats: dict[str, int] = {}
    actual_input = 0
    actual_output = 0

    # Both clients are bound below in the provider-specific block; the closure
    # in describe_one reads whichever the active provider needs.  Names are
    # read from run_images' scope at call time, after assignment.
    or_client = None
    an_client = None

    async def describe_one(key: str, url: str):
        nonlocal completed, actual_input, actual_output
        async with semaphore:
            if provider == "openrouter":
                entry = await _describe_one_image_openrouter(or_client, url, model, api_key)
            else:
                entry = await _describe_one_image(an_client, url, model)
        cache[key] = entry
        if entry.get("status") == "ok":
            actual_input += entry.get("input_tokens", 0)
            actual_output += entry.get("output_tokens", 0)
        async with save_lock:
            completed += 1
            stats[entry["status"]] = stats.get(entry["status"], 0) + 1
            if completed % save_every == 0:
                save_json_cache(IMAGE_DESCRIPTION_CACHE_FILE, cache)
            elapsed = time.time() - started
            rate = completed / elapsed if elapsed > 0 else 0.0
            print(f"\r  described {completed}/{len(pending)} "
                  f"({rate:.1f}/s, ok={stats.get('ok', 0)})",
                  end="", flush=True)

    if provider == "openrouter":
        import httpx
        timeout = httpx.Timeout(60.0)
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/fquresh/twitter-trove",
            "X-Title": "trove-enrich",
        }
        async with httpx.AsyncClient(timeout=timeout, headers=headers) as client:
            or_client = client
            await asyncio.gather(*(describe_one(k, u) for k, u in pending))
    else:
        import anthropic
        an_client = anthropic.AsyncAnthropic(api_key=api_key)
        await asyncio.gather(*(describe_one(k, u) for k, u in pending))

    save_json_cache(IMAGE_DESCRIPTION_CACHE_FILE, cache)
    cost = (actual_input / 1_000_000) * in_per_m + (actual_output / 1_000_000) * out_per_m
    print(f"\n  Image describe results: {stats}")
    print(f"  Tokens: {actual_input:,} input + {actual_output:,} output "
          f"= ${cost:.4f}")
    return cache


# ── Output assembly ───────────────────────────────────────────────────────
def emit_enriched_json(
    *,
    output_path: Path,
    tweets: list[dict],
    embedding_cache: dict,
    url_cache: dict,
    image_cache: dict,
    embed_model: str,
    embed_dim: int,
    vision_model: str,
) -> tuple[int, int, int]:
    """Materialize the cross-cache state into the schema the v2 importer reads.

    Each row is keyed by tweet_id so the v2 import code can UPSERT idempotently.
    Tweets with no embedding / no enrichments simply don't appear in those
    arrays - partial coverage is supported.
    """
    embeddings_out: list[dict] = []
    url_out: list[dict] = []
    image_out: list[dict] = []

    tweet_id_set = {str(t.get("id")) for t in tweets if t.get("id")}

    for tid, entry in embedding_cache.items():
        if tid not in tweet_id_set:
            continue
        if entry.get("model") != embed_model:
            continue
        embeddings_out.append({
            "tweet_id": tid,
            "model": entry["model"],
            "dim": entry["dim"],
            "dtype": entry["dtype"],
            "scale": entry.get("scale"),
            "offset": entry.get("offset"),
            "vector_b64": entry["vector_b64"],
        })

    # URL/image enrichments: a single tweet may have multiple URLs/images, so
    # we walk each tweet and emit one row per cached enrichment.
    for t in tweets:
        tid = str(t.get("id") or "")
        if not tid:
            continue
        for url in (t.get("urls") or []):
            key = md5_key(normalize_url(url))
            entry = url_cache.get(key)
            if entry and entry.get("content"):
                url_out.append({
                    "tweet_id": tid,
                    "source_ref": entry.get("url") or url,
                    "content": entry["content"],
                    "metadata": {
                        "status": entry.get("status"),
                        "fetched_at": entry.get("fetched_at"),
                    },
                })
        for img in ((t.get("media") or {}).get("urls") or []):
            key = md5_key(normalize_image_url(img))
            entry = image_cache.get(key)
            if entry and entry.get("description"):
                image_out.append({
                    "tweet_id": tid,
                    "source_ref": entry.get("url") or img,
                    "content": entry["description"],
                    "model": entry.get("model"),
                    "metadata": {
                        "tokens": entry.get("tokens"),
                    },
                })

    payload = {
        "metadata": {
            "embed_model": embed_model,
            "embed_dim": embed_dim,
            "embed_dtype": "int8",
            "vision_model": vision_model,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "stats": {
                "embeddings": len(embeddings_out),
                "url_enrichments": len(url_out),
                "image_enrichments": len(image_out),
            },
        },
        "embeddings": embeddings_out,
        "url_enrichments": url_out,
        "image_enrichments": image_out,
    }

    tmp = output_path.with_suffix(output_path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    tmp.replace(output_path)
    return len(embeddings_out), len(url_out), len(image_out)


# ── CLI ────────────────────────────────────────────────────────────────────
def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="enrich.py",
        description=__doc__.splitlines()[1] if __doc__ else None,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Notes
─────
The HTML files in `exports/` are the input source of truth. Cache files
(.embedding_cache.json, .url_content_cache.json, .image_description_cache.json)
are memoization, not replacement; deleting them forces a re-run at the next
invocation, costing money. Re-runs are otherwise idempotent - only tweets/URLs/
images not already in cache hit the API.
""",
    )
    p.add_argument("--input", type=Path, default=DEFAULT_INPUT,
                   help=f"classifier output JSON (default: {DEFAULT_INPUT.name})")
    p.add_argument("--exports-dir", "--likes-dir", dest="exports_dir", type=Path, default=DEFAULT_EXPORTS_DIR,
                   help=f"directory of HTML exports (default: {DEFAULT_EXPORTS_DIR.name})")
    p.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                   help=f"output JSON for /import (default: {DEFAULT_OUTPUT.name})")

    p.add_argument("--embed-model", default=DEFAULT_EMBED_MODEL,
                   help=f"Voyage embedding model (default: {DEFAULT_EMBED_MODEL})")
    p.add_argument("--embed-dim", type=int, default=DEFAULT_EMBED_DIM,
                   help=f"output dimension (default: {DEFAULT_EMBED_DIM})")
    p.add_argument("--embed-batch-size", type=int, default=DEFAULT_EMBED_BATCH_SIZE,
                   help=f"texts per Voyage call (default: {DEFAULT_EMBED_BATCH_SIZE})")

    p.add_argument("--vision-model", default=DEFAULT_VISION_MODEL,
                   help=f"Vision model.  claude-* uses Anthropic; everything "
                        f"else uses OpenRouter (OpenAI-compatible).  "
                        f"Default: {DEFAULT_VISION_MODEL}")

    p.add_argument("--max-concurrency-embed", type=int, default=8)
    p.add_argument("--max-concurrency-vision", type=int, default=3)
    p.add_argument("--max-concurrency-fetch", type=int, default=10)
    p.add_argument("--save-every", type=int, default=10,
                   help="persist caches after every N completed batches (default: 10)")

    p.add_argument("--limit", type=int, default=None,
                   help="process only the first N tweets (for slice validation)")
    p.add_argument("--vision-limit", type=int, default=None,
                   help="cap the image-describe pass at the first N new images "
                        "(Phase 4 gate uses --vision-limit 50)")
    p.add_argument("--dry-run", action="store_true",
                   help="estimate token / API cost; do not call any API")
    p.add_argument("--yes-reprocess-images", action="store_true",
                   help="bypass the model-gate guard and allow a full, PAID "
                        "re-describe / re-embed (only needed after deliberately "
                        "changing --vision-model or --embed-model)")

    only_group = p.add_mutually_exclusive_group()
    only_group.add_argument("--only-embeddings", action="store_true")
    only_group.add_argument("--only-urls", action="store_true")
    only_group.add_argument("--only-images", action="store_true")

    return p.parse_args(argv)


def load_corpus(input_path: Path, limit: Optional[int]) -> list[dict]:
    if not input_path.exists():
        raise SystemExit(f"ERROR: input not found: {input_path}")
    with input_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    tweets = data.get("tweets") or []
    if limit is not None and limit >= 0:
        tweets = tweets[:limit]
    return tweets


def required_phases(args: argparse.Namespace) -> tuple[bool, bool, bool]:
    """Returns (do_embeddings, do_urls, do_images). With no --only-*, all run."""
    if args.only_embeddings:
        return True, False, False
    if args.only_urls:
        return False, True, False
    if args.only_images:
        return False, False, True
    return True, True, True


async def amain(args: argparse.Namespace) -> int:
    tweets = load_corpus(args.input, args.limit)
    print(f"Loaded {len(tweets)} tweets from {args.input.name}"
          + (f" (limited from corpus)" if args.limit else ""))

    do_embed, do_urls, do_images = required_phases(args)

    image_cache = load_json_cache(IMAGE_DESCRIPTION_CACHE_FILE)
    url_cache = load_json_cache(URL_CONTENT_CACHE_FILE)

    if do_urls:
        print("\n[urls] extracting URL content…")
        url_cache = await run_urls(
            tweets,
            concurrency=args.max_concurrency_fetch,
            save_every=args.save_every,
            dry_run=args.dry_run,
        )

    if do_images:
        print("\n[images] generating image descriptions…")
        image_cache = await run_images(
            tweets,
            model=args.vision_model,
            concurrency=args.max_concurrency_vision,
            save_every=args.save_every,
            dry_run=args.dry_run,
            limit=args.vision_limit,
            yes_reprocess=args.yes_reprocess_images,
        )

    if do_embed:
        print(f"\n[embed] computing embeddings ({args.embed_model}, "
              f"dim={args.embed_dim}, int8)…")
        await run_embeddings(
            tweets,
            model=args.embed_model,
            dim=args.embed_dim,
            batch_size=args.embed_batch_size,
            concurrency=args.max_concurrency_embed,
            save_every=args.save_every,
            image_cache=image_cache,
            url_cache=url_cache,
            dry_run=args.dry_run,
            yes_reprocess=args.yes_reprocess_images,
        )

    if args.dry_run:
        print("\nDry run complete - no output written.")
        return 0

    # Always emit the full output JSON, populated from whatever caches exist
    # at this point. This way a partial run still produces an importable file.
    embedding_cache = load_json_cache(EMBEDDING_CACHE_FILE)
    image_cache = load_json_cache(IMAGE_DESCRIPTION_CACHE_FILE)
    url_cache = load_json_cache(URL_CONTENT_CACHE_FILE)

    print("\n[output] writing enriched_tweets.json…")
    n_emb, n_url, n_img = emit_enriched_json(
        output_path=args.output,
        tweets=tweets,
        embedding_cache=embedding_cache,
        url_cache=url_cache,
        image_cache=image_cache,
        embed_model=args.embed_model,
        embed_dim=args.embed_dim,
        vision_model=args.vision_model,
    )
    print(f"  Wrote {args.output} - "
          f"{n_emb} embeddings / {n_url} URL extractions / {n_img} image descriptions")
    return 0


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(amain(args))
    except KeyboardInterrupt:
        print("\nInterrupted; partial caches saved.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
