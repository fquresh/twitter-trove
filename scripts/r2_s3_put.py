#!/usr/bin/env python3
"""Upload a file to Cloudflare R2 via the S3-compatible API (multipart).

Used by ``./trove deploy`` for large objects (e.g. gzipped
``enriched_tweets.json``, tens of MB). Single-shot PUTs can time out on slow
links after ~17-20 s; multipart (~10 MB parts) finishes each part well inside that window
and retries parts independently.

Env (required):
  R2_S3_ACCESS_KEY_ID
  R2_S3_SECRET_ACCESS_KEY
  R2_S3_ENDPOINT   e.g. https://<account_id>.r2.cloudflarestorage.com

Usage:
  r2_s3_put.py --bucket NAME --key KEY --file PATH \\
               --content-type TYPE [--content-encoding ENC]
"""

from __future__ import annotations

import argparse
import os
import sys


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bucket", required=True)
    p.add_argument("--key", required=True)
    p.add_argument("--file", required=True)
    p.add_argument("--content-type", required=True)
    p.add_argument("--content-encoding", default="")
    args = p.parse_args()

    access = os.environ.get("R2_S3_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("R2_S3_SECRET_ACCESS_KEY", "").strip()
    endpoint = os.environ.get("R2_S3_ENDPOINT", "").strip()
    if not access or not secret or not endpoint:
        print(
            "r2_s3_put: need R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, "
            "R2_S3_ENDPOINT in the environment",
            file=sys.stderr,
        )
        return 2

    if not os.path.isfile(args.file):
        print(f"r2_s3_put: file not found: {args.file}", file=sys.stderr)
        return 2

    try:
        import boto3
        from boto3.s3.transfer import TransferConfig
        from botocore.config import Config as BotoConfig
    except ImportError:
        print(
            "r2_s3_put: boto3 not installed. "
            "Run: .venv/bin/pip install boto3  (or ./trove update)",
            file=sys.stderr,
        )
        return 2

    # 8 MB threshold → multipart for anything over small files.
    # 10 MB parts finish well under the ~17-20 s connection-reset window.
    transfer_cfg = TransferConfig(
        multipart_threshold=8 * 1024 * 1024,
        multipart_chunksize=10 * 1024 * 1024,
        max_concurrency=3,
        use_threads=True,
        num_download_attempts=5,
    )
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name="auto",
        config=BotoConfig(
            signature_version="s3v4",
            retries={"max_attempts": 10, "mode": "adaptive"},
            connect_timeout=30,
            read_timeout=120,
        ),
    )

    extra: dict = {"ContentType": args.content_type}
    if args.content_encoding:
        extra["ContentEncoding"] = args.content_encoding

    size = os.path.getsize(args.file)
    print(
        f"    → S3 multipart put s3://{args.bucket}/{args.key} "
        f"({size} bytes, chunk=10MiB)…",
        flush=True,
    )
    client.upload_file(
        args.file,
        args.bucket,
        args.key,
        ExtraArgs=extra,
        Config=transfer_cfg,
    )
    print("    Upload complete. (S3 multipart)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
