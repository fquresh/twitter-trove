#!/usr/bin/env python3
"""Build the SQL that loads the MCP index into Cloudflare D1.

The remote MCP server (webapp/functions/api/mcp.ts) answers from
D1, not from the R2 JSONs, because a Worker cannot parse a 40 MB JSON on
every request. This script turns categorized_tweets.json, enriched_tweets.json
and the wiki/ folder into one .sql file that `wrangler d1 execute --file`
ingests. `./trove deploy` runs it after the R2 push.

Incremental by default: pass --existing <json> (the output of
`SELECT id, h FROM mcp_tweets` as wrangler --json prints it) and only tweets
whose content hash changed, plus new and removed ids, are written. D1's free
tier caps rows written per day, so a daily deploy must not rewrite 37k rows.
--full drops and recreates every table.

Usage:
  build_mcp_d1.py --categorized categorized_tweets.json \
                  --enriched enriched_tweets.json --wiki wiki \
                  --output mcp_d1.sql [--existing existing.json | --full]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS mcp_tweets (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  author TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0,
  retweet_count INTEGER NOT NULL DEFAULT 0,
  is_article INTEGER,
  article_title TEXT,
  categories TEXT NOT NULL DEFAULT '[]',
  tickers TEXT NOT NULL DEFAULT '[]',
  urls TEXT NOT NULL DEFAULT '[]',
  media_type TEXT,
  media_urls TEXT NOT NULL DEFAULT '[]',
  enrichment TEXT,
  source_file TEXT,
  h TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_tweets_created ON mcp_tweets(created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tweets_handle ON mcp_tweets(handle);
CREATE INDEX IF NOT EXISTS idx_mcp_tweets_likes ON mcp_tweets(like_count);
CREATE VIRTUAL TABLE IF NOT EXISTS mcp_tweets_fts USING fts5(
  id UNINDEXED, handle, text, article_title, enrichment,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS mcp_tweet_categories (
  tweet_id TEXT NOT NULL,
  category TEXT NOT NULL,
  PRIMARY KEY (tweet_id, category)
);
CREATE INDEX IF NOT EXISTS idx_mcp_tc_category ON mcp_tweet_categories(category);
CREATE TABLE IF NOT EXISTS mcp_tweet_tickers (
  tweet_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  PRIMARY KEY (tweet_id, ticker)
);
CREATE INDEX IF NOT EXISTS idx_mcp_tt_ticker ON mcp_tweet_tickers(ticker);
CREATE TABLE IF NOT EXISTS mcp_wiki (
  path TEXT PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS mcp_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""

DROP = """
DROP TABLE IF EXISTS mcp_tweets;
DROP TABLE IF EXISTS mcp_tweets_fts;
DROP TABLE IF EXISTS mcp_tweet_categories;
DROP TABLE IF EXISTS mcp_tweet_tickers;
DROP TABLE IF EXISTS mcp_wiki;
DROP TABLE IF EXISTS mcp_meta;
"""

BATCH = 100
ENRICH_MAX = 1200  # chars per enrichment snippet kept in the index


def q(v: object) -> str:
    """SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return repr(v)
    s = str(v).replace("\x00", "")
    return "'" + s.replace("'", "''") + "'"


def parse_ts(s: str | None) -> int:
    """'Jul 26, 2021' or ISO -> unix seconds (UTC noon for date-only)."""
    if not s:
        return 0
    s = s.strip()
    for fmt in ("%b %d, %Y", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            dt = datetime.strptime(s, fmt)
            if fmt in ("%b %d, %Y", "%Y-%m-%d"):
                dt = dt.replace(hour=12)
            return int(dt.replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        dt = datetime(int(m[1]), int(m[2]), int(m[3]), 12, tzinfo=timezone.utc)
        return int(dt.timestamp())
    return 0


def clean_handle(h: str | None) -> str:
    return (h or "").lstrip("@").strip()


def row_hash(row: dict) -> str:
    payload = json.dumps(row, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def build_rows(categorized: dict, enriched: dict) -> dict[str, dict]:
    enrich: dict[str, list[str]] = {}
    for u in enriched.get("url_enrichments", []) or []:
        c = (u.get("content") or "").strip()
        if c:
            enrich.setdefault(u["tweet_id"], []).append(f"[url] {c[:ENRICH_MAX]}")
    for i in enriched.get("image_enrichments", []) or []:
        c = (i.get("content") or "").strip()
        if c:
            enrich.setdefault(i["tweet_id"], []).append(f"[image] {c[:ENRICH_MAX]}")

    rows: dict[str, dict] = {}
    for t in categorized.get("tweets", []):
        tid = str(t["id"])
        eng = t.get("engagement") or {}
        media = t.get("media") or {}
        cats = sorted({c for c in (t.get("categories") or []) if c})
        tickers = sorted({str(x).lstrip("$").upper() for x in (t.get("tickers") or []) if x})
        row = {
            "id": tid,
            "handle": clean_handle(t.get("handle")),
            "author": t.get("author") or None,
            "text": t.get("text") or "",
            "created_at": parse_ts(t.get("timestamp")),
            "like_count": int(eng.get("like_count") or 0),
            "retweet_count": int(eng.get("retweet_count") or 0),
            "is_article": (None if t.get("is_article") is None else (1 if t.get("is_article") else 0)),
            "article_title": t.get("article_title") or None,
            "categories": cats,
            "tickers": tickers,
            "urls": [u for u in (t.get("urls") or []) if u][:10],
            "media_type": media.get("type") or "none",
            "media_urls": [u for u in (media.get("urls") or []) if u][:4],
            "enrichment": ("\n".join(enrich.get(tid, [])) or None),
            "source_file": t.get("source_file") or None,
        }
        row["h"] = row_hash(row)
        rows[tid] = row
    return rows


def tweet_insert(rows: list[dict]) -> list[str]:
    out: list[str] = []
    vals = []
    for r in rows:
        vals.append(
            "("
            + ",".join(
                [
                    q(r["id"]), q(r["handle"]), q(r["author"]), q(r["text"]), q(r["created_at"]),
                    q(r["like_count"]), q(r["retweet_count"]), q(r["is_article"]), q(r["article_title"]),
                    q(json.dumps(r["categories"], ensure_ascii=False)),
                    q(json.dumps(r["tickers"], ensure_ascii=False)),
                    q(json.dumps(r["urls"], ensure_ascii=False)),
                    q(r["media_type"]), q(json.dumps(r["media_urls"], ensure_ascii=False)),
                    q(r["enrichment"]), q(r["source_file"]), q(r["h"]),
                ]
            )
            + ")"
        )
    out.append(
        "INSERT OR REPLACE INTO mcp_tweets (id, handle, author, text, created_at, like_count, "
        "retweet_count, is_article, article_title, categories, tickers, urls, media_type, "
        "media_urls, enrichment, source_file, h) VALUES\n" + ",\n".join(vals) + ";"
    )
    fts = [
        f"({q(r['id'])},{q(r['handle'])},{q(r['text'])},{q(r['article_title'] or '')},{q(r['enrichment'] or '')})"
        for r in rows
    ]
    out.append(
        "INSERT INTO mcp_tweets_fts (id, handle, text, article_title, enrichment) VALUES\n"
        + ",\n".join(fts) + ";"
    )
    cats = [f"({q(r['id'])},{q(c)})" for r in rows for c in r["categories"]]
    if cats:
        out.append("INSERT OR IGNORE INTO mcp_tweet_categories (tweet_id, category) VALUES\n" + ",\n".join(cats) + ";")
    tks = [f"({q(r['id'])},{q(t)})" for r in rows for t in r["tickers"]]
    if tks:
        out.append("INSERT OR IGNORE INTO mcp_tweet_tickers (tweet_id, ticker) VALUES\n" + ",\n".join(tks) + ";")
    return out


def tweet_delete(ids: list[str]) -> list[str]:
    lst = ",".join(q(i) for i in ids)
    return [
        f"DELETE FROM mcp_tweets_fts WHERE id IN ({lst});",
        f"DELETE FROM mcp_tweet_categories WHERE tweet_id IN ({lst});",
        f"DELETE FROM mcp_tweet_tickers WHERE tweet_id IN ({lst});",
        f"DELETE FROM mcp_tweets WHERE id IN ({lst});",
    ]


def wiki_rows(wiki_dir: Path | None) -> list[dict]:
    if not wiki_dir or not wiki_dir.is_dir():
        return []
    rows = []
    for p in sorted(wiki_dir.rglob("*.md")):
        rel = p.relative_to(wiki_dir).as_posix()
        if rel in ("CLAUDE.md", "wiki_ingest_prompt.md"):
            continue  # operator files, not knowledge
        text = p.read_text(encoding="utf-8", errors="replace")
        title = None
        m = re.search(r"^#\s+(.+)$", text, re.M)
        if m:
            title = m[1].strip()
        fm = re.search(r"^last_updated_iso:\s*(\S+)", text, re.M)
        updated = parse_ts(fm[1]) if fm else int(p.stat().st_mtime)
        rows.append({"path": rel[:-3], "title": title or rel[:-3], "content": text, "updated_at": updated})
    return rows


def load_existing(path: str | None) -> dict[str, str] | None:
    """wrangler --json prints [{"results": [...], ...}]; also accept a bare list or {id: h}."""
    if not path:
        return None
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "results" not in raw:
        return {str(k): str(v) for k, v in raw.items()}
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and "results" in raw[0]:
        raw = raw[0]["results"]
    if isinstance(raw, dict):
        raw = raw.get("results", [])
    return {str(r["id"]): str(r["h"]) for r in raw}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--categorized", required=True)
    ap.add_argument("--enriched", required=False)
    ap.add_argument("--wiki", required=False)
    ap.add_argument("--output", required=True)
    ap.add_argument("--existing", help="JSON of existing (id, h) rows for an incremental build")
    ap.add_argument("--full", action="store_true", help="drop and rebuild every table")
    ap.add_argument("--summary-json", help="write a small summary JSON here (counts)")
    args = ap.parse_args()

    categorized = json.loads(Path(args.categorized).read_text(encoding="utf-8"))
    enriched = json.loads(Path(args.enriched).read_text(encoding="utf-8")) if args.enriched else {}
    rows = build_rows(categorized, enriched)
    existing = None if args.full else load_existing(args.existing)

    stmts: list[str] = []
    if args.full or existing is None:
        stmts.append(DROP.strip())
        stmts.append(SCHEMA.strip())
        to_write = list(rows.values())
        to_delete: list[str] = []
        mode = "full"
    else:
        stmts.append(SCHEMA.strip())
        to_write = [r for tid, r in rows.items() if existing.get(tid) != r["h"]]
        to_delete = [tid for tid in existing if tid not in rows]
        mode = "incremental"

    # Changed rows are replaced: clear their derived rows first so FTS and the
    # join tables never hold two versions of one tweet.
    changed_existing = [r["id"] for r in to_write if existing and r["id"] in existing]
    for i in range(0, len(changed_existing), BATCH):
        stmts.extend(tweet_delete(changed_existing[i : i + BATCH]))
    for i in range(0, len(to_delete), BATCH):
        stmts.extend(tweet_delete(to_delete[i : i + BATCH]))
    for i in range(0, len(to_write), BATCH):
        stmts.extend(tweet_insert(to_write[i : i + BATCH]))

    wiki = wiki_rows(Path(args.wiki) if args.wiki else None)
    stmts.append("DELETE FROM mcp_wiki;")
    for i in range(0, len(wiki), BATCH):
        vals = ",\n".join(
            f"({q(w['path'])},{q(w['title'])},{q(w['content'])},{q(w['updated_at'])})" for w in wiki[i : i + BATCH]
        )
        stmts.append("INSERT INTO mcp_wiki (path, title, content, updated_at) VALUES\n" + vals + ";")

    newest = max((r["created_at"] for r in rows.values()), default=0)
    meta = {
        "pushed_at": int(datetime.now(timezone.utc).timestamp()),
        "tweet_count": len(rows),
        "newest_tweet_at": newest,
        "wiki_pages": len(wiki),
        "mode": mode,
        "taxonomy_size": len((categorized.get("taxonomy") or {}) if isinstance(categorized.get("taxonomy"), dict) else categorized.get("taxonomy") or []),
    }
    stmts.append(
        "INSERT OR REPLACE INTO mcp_meta (key, value) VALUES "
        + ",".join(f"({q(k)},{q(json.dumps(v))})" for k, v in meta.items())
        + ";"
    )

    Path(args.output).write_text("\n".join(stmts) + "\n", encoding="utf-8")
    summary = {**meta, "written": len(to_write), "deleted": len(to_delete), "sql_bytes": Path(args.output).stat().st_size}
    if args.summary_json:
        Path(args.summary_json).write_text(json.dumps(summary), encoding="utf-8")
    print(
        f"mcp_d1: mode={mode} tweets={len(rows)} written={len(to_write)} deleted={len(to_delete)} "
        f"wiki={len(wiki)} sql={summary['sql_bytes'] / 1e6:.1f} MB"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
