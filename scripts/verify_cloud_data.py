#!/usr/bin/env python3
"""Post-deploy verification: prove the cloud actually SERVES the data we pushed.

Run by ``./trove deploy`` after the R2 upload. Upload success is not serve
success - a proxy encoding bug once passed every upload-side check.
This script verifies two layers:

1. S3 readback (requires R2_S3_* env): download ``categorized_tweets.json``
   from the bucket, gunzip, parse, and compare ``metadata.total_tweets`` and
   ``metadata.date_range.latest`` against the local file. HEAD
   ``enriched_tweets.json`` and confirm size + ``Content-Encoding: gzip``.

2. Origin round-trip (requires a CF Access service token in
   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET): fetch
   ``/api/data/categorized_tweets.json`` from the deployed site exactly like a
   browser (gzip accepted, transparently decoded) and run the same comparison.
   This is the ONLY layer that exercises the Pages Function proxy - the layer
   where the proxy encoding bug lived. Skipped with a hint when the token is absent.

Exit codes: 0 = all performed checks passed, 1 = a check failed, 2 = bad usage.
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time


def load_local_meta(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    meta = data.get("metadata") or {}
    return {
        "total_tweets": meta.get("total_tweets"),
        "latest": (meta.get("date_range") or {}).get("latest"),
    }


def compare_meta(where: str, local: dict, remote_doc: dict) -> list[str]:
    errors: list[str] = []
    meta = remote_doc.get("metadata") or {}
    total = meta.get("total_tweets")
    latest = (meta.get("date_range") or {}).get("latest")
    if total != local["total_tweets"]:
        errors.append(
            f"{where}: total_tweets mismatch (cloud={total}, local={local['total_tweets']})"
        )
    if latest != local["latest"]:
        errors.append(
            f"{where}: latest tweet date mismatch (cloud={latest}, local={local['latest']})"
        )
    if not errors:
        print(f"    ✓ {where}: {total} tweets, newest {latest} - matches local")
    return errors


def check_s3_readback(bucket: str, local: dict) -> list[str]:
    access = os.environ.get("R2_S3_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("R2_S3_SECRET_ACCESS_KEY", "").strip()
    endpoint = os.environ.get("R2_S3_ENDPOINT", "").strip()
    if not (access and secret and endpoint):
        print("    · S3 readback skipped (R2_S3_* not set)")
        return []

    import boto3
    from botocore.config import Config as BotoConfig

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access,
        aws_secret_access_key=secret,
        region_name="auto",
        config=BotoConfig(signature_version="s3v4", connect_timeout=30, read_timeout=120),
    )

    errors: list[str] = []

    obj = client.get_object(Bucket=bucket, Key="categorized_tweets.json")
    raw = obj["Body"].read()
    if obj.get("ContentEncoding") != "gzip":
        errors.append(
            f"S3 categorized_tweets.json: ContentEncoding={obj.get('ContentEncoding')!r}, expected 'gzip'"
        )
    try:
        doc = json.loads(gzip.decompress(raw))
    except Exception as e:  # noqa: BLE001 - any parse failure is the finding
        return errors + [f"S3 categorized_tweets.json: stored bytes do not gunzip to JSON: {e}"]
    errors += compare_meta("S3 categorized_tweets.json", local, doc)

    head = client.head_object(Bucket=bucket, Key="enriched_tweets.json")
    if head.get("ContentEncoding") != "gzip":
        errors.append(
            f"S3 enriched_tweets.json: ContentEncoding={head.get('ContentEncoding')!r}, expected 'gzip'"
        )
    elif head.get("ContentLength", 0) <= 0:
        errors.append("S3 enriched_tweets.json: zero-length object")
    else:
        mb = head["ContentLength"] / 1024 / 1024
        print(f"    ✓ S3 enriched_tweets.json: present, {mb:.1f} MB gz, Content-Encoding: gzip")
    return errors


def check_origin(origin: str, local: dict) -> list[str]:
    cid = os.environ.get("CF_ACCESS_CLIENT_ID", "").strip()
    csec = os.environ.get("CF_ACCESS_CLIENT_SECRET", "").strip()
    if not (cid and csec):
        print("    · origin round-trip skipped - no CF Access service token in .env")
        print("      (Mint one: Zero Trust → Access → Service Auth → Service Tokens; add a")
        print("       Service Auth policy to your Pages project's Access app; then put")
        print("       CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET in .env.)")
        return []

    import httpx

    headers = {
        "CF-Access-Client-Id": cid,
        "CF-Access-Client-Secret": csec,
        "Accept-Encoding": "gzip",
    }
    url = f"{origin}/api/data/categorized_tweets.json?cb={int(time.time())}"
    with httpx.Client(timeout=180, follow_redirects=False) as client:
        resp = client.get(url, headers=headers)
        if resp.status_code in (301, 302, 303, 307, 308):
            return [
                f"origin: got a redirect ({resp.status_code}) - the service token was not "
                "accepted by CF Access. Check the Service Auth policy on your Access app."
            ]
        if resp.status_code != 200:
            return [f"origin: HTTP {resp.status_code}: {resp.text[:160]}"]
        try:
            # httpx transparently decodes Content-Encoding, same as a browser.
            doc = resp.json()
        except Exception as e:  # noqa: BLE001
            enc = resp.headers.get("content-encoding", "none")
            ct = resp.headers.get("content-type", "?")
            return [
                f"origin categorized_tweets.json: served bytes are not JSON "
                f"(content-type={ct}, content-encoding={enc}): {e}"
            ]
        etag = resp.headers.get("etag")
    errors = compare_meta("origin categorized_tweets.json", local, doc)

    # Browser HTTP-cache revalidation path: a matching If-None-Match must get a
    # real 304 - never a 0-byte 200 (which poisons the browser cache and
    # breaks every sync after the first).
    if etag:
        with httpx.Client(timeout=180, follow_redirects=False) as client:
            resp = client.get(url, headers={**headers, "If-None-Match": etag})
        if resp.status_code == 304:
            print("    ✓ origin conditional GET: 304 on matching If-None-Match")
        elif resp.status_code == 200 and len(resp.content) == 0:
            errors.append(
                "origin conditional GET: 0-byte 200 on matching If-None-Match "
                "(must be 304 - this poisons the browser cache)"
            )
        elif resp.status_code != 200:
            errors.append(f"origin conditional GET: unexpected HTTP {resp.status_code}")
        else:
            print("    · origin conditional GET: served a full 200 (etag ignored) - acceptable")
    else:
        errors.append("origin categorized_tweets.json: no ETag header on the 200 response")

    # The enriched payload goes through the identical proxy code path; confirm
    # it starts serving without downloading all of it: stream the first decoded
    # bytes and check they open a JSON document.
    url = f"{origin}/api/data/enriched_tweets.json?cb={int(time.time())}"
    with httpx.Client(timeout=180, follow_redirects=False) as client:
        with client.stream("GET", url, headers=headers) as resp:
            if resp.status_code != 200:
                return errors + [f"origin enriched_tweets.json: HTTP {resp.status_code}"]
            first = b""
            for chunk in resp.iter_bytes():
                first += chunk
                if len(first) >= 4096:
                    break
    head = first.lstrip()[:1]
    if head not in (b"{", b"["):
        return errors + [
            f"origin enriched_tweets.json: decoded stream does not start a JSON document "
            f"(first bytes: {first[:24]!r})"
        ]
    print("    ✓ origin enriched_tweets.json: streams and decodes to JSON")
    return errors


def _default_origin() -> str | None:
    url = os.environ.get("TROVE_PAGES_URL", "").strip()
    if url:
        return url
    project = os.environ.get("TROVE_PAGES_PROJECT", "").strip()
    return f"https://{project}.pages.dev" if project else None


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--local", required=True, help="path to the local categorized_tweets.json")
    p.add_argument("--bucket", default=os.environ.get("TROVE_R2_BUCKET") or None,
                   help="R2 bucket name (default: $TROVE_R2_BUCKET)")
    p.add_argument("--origin", default=_default_origin(),
                   help="deployed site origin (default: $TROVE_PAGES_URL, else "
                        "https://$TROVE_PAGES_PROJECT.pages.dev)")
    args = p.parse_args()
    if not args.bucket:
        p.error("no bucket: pass --bucket or set TROVE_R2_BUCKET")
    if not args.origin:
        p.error("no origin: pass --origin or set TROVE_PAGES_URL / TROVE_PAGES_PROJECT")

    if not os.path.isfile(args.local):
        print(f"verify_cloud_data: local file not found: {args.local}", file=sys.stderr)
        return 2

    local = load_local_meta(args.local)
    if not local["total_tweets"] or not local["latest"]:
        print("verify_cloud_data: local file has no metadata.total_tweets/date_range", file=sys.stderr)
        return 2
    print(f"    local reference: {local['total_tweets']} tweets, newest {local['latest']}")

    errors: list[str] = []
    errors += check_s3_readback(args.bucket, local)
    errors += check_origin(args.origin.rstrip("/"), local)

    if errors:
        for e in errors:
            print(f"    ✗ {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
