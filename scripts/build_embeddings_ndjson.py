#!/usr/bin/env python3
"""Derive an embeddings-only NDJSON artifact from enriched_tweets.json.

The full enriched_tweets.json (~51 MB) OOMs iOS Safari when JSON.parse'd
monolithically. This script extracts just the embeddings into a
newline-delimited JSON file that can be streamed line-by-line, keeping
peak JS heap flat regardless of corpus size.

Format:
  Line 1: {"_meta":true,"embed_model":"...","embed_dim":1024,"embed_dtype":"int8","count":28850}
  Line 2+: {"tweet_id":"...","model":"...","dim":1024,"dtype":"int8","scale":...,"offset":...,"vector_b64":"..."}

Usage:
    .venv/bin/python3 scripts/build_embeddings_ndjson.py [--input enriched_tweets.json] [--output embeddings.ndjson]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    parser = argparse.ArgumentParser(description="Build embeddings.ndjson from enriched_tweets.json")
    parser.add_argument("--input", default=str(ROOT / "enriched_tweets.json"), help="Path to enriched_tweets.json")
    parser.add_argument("--output", default=str(ROOT / "embeddings.ndjson"), help="Path to output embeddings.ndjson")
    args = parser.parse_args()

    inp = Path(args.input)
    out = Path(args.output)
    if not inp.exists():
        print(f"✗ {inp} not found", file=sys.stderr)
        return 1

    print(f"▸ reading {inp.name}…", file=sys.stderr)
    with inp.open("r", encoding="utf-8") as f:
        data = json.load(f)

    meta = data.get("metadata", {})
    embeddings = data.get("embeddings", [])
    embed_model = meta.get("embed_model", "")
    embed_dim = meta.get("embed_dim", 0)
    embed_dtype = meta.get("embed_dtype", "")

    print(f"  {len(embeddings)} embeddings, model={embed_model}, dim={embed_dim}, dtype={embed_dtype}", file=sys.stderr)

    written = 0
    with out.open("w", encoding="utf-8") as f:
        # Metadata header line.
        header = {
            "_meta": True,
            "embed_model": embed_model,
            "embed_dim": embed_dim,
            "embed_dtype": embed_dtype,
            "count": len(embeddings),
        }
        f.write(json.dumps(header, separators=(",", ":")) + "\n")

        for emb in embeddings:
            tweet_id = emb.get("tweet_id")
            model = emb.get("model")
            dim = emb.get("dim")
            dtype = emb.get("dtype")
            vector_b64 = emb.get("vector_b64")
            scale = emb.get("scale")
            offset = emb.get("offset")
            if not tweet_id or not model or not dim or not vector_b64:
                continue
            line = {
                "tweet_id": tweet_id,
                "model": model,
                "dim": dim,
                "dtype": dtype,
                "scale": scale,
                "offset": offset,
                "vector_b64": vector_b64,
            }
            f.write(json.dumps(line, separators=(",", ":")) + "\n")
            written += 1

    out_size = out.stat().st_size
    print(f"✓ wrote {written} embeddings to {out.name} ({out_size / 1024 / 1024:.1f} MB)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
