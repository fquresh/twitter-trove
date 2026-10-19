"""Local read-only HTTP server over the wiki/ directory.

Endpoints (CORS-enabled so the v2 webapp running on :5174 can hit it):

- GET /health
    -> {"status": "ok", "page_count": N, "last_log_entry": "<line or null>"}

- GET /wiki/list?category=people&query=sam
    -> [{"path": "people/jhalvorsen", "display": "Juno Halvorsen", "slug": "jhalvorsen", "type": "person"}, ...]
    Both query-string args are optional. Filter by category (folder name) and
    by case-insensitive substring match against display + slug.

- GET /wiki/read?path=people/jhalvorsen
    -> {"path": "people/jhalvorsen", "frontmatter": {...}, "body_markdown": "..."}
    `path` is folder/slug (no extension). 404 if missing or outside wiki/.

- GET /wiki/search?q=agentic&max=10
    -> [{"path": ..., "display": ..., "snippet": "...", "score": 3}, ...]
    Cheap ranked search: title hits 5 pts, header hits 2, body hits 1. We
    intentionally avoid full-text indexing - the wiki is small (<1k pages).

Run via:
    pip install flask
    python wiki_server.py        # default port 8765
    python wiki_server.py --port 9000

Plan §risk register #12: graceful degrade. The webapp tolerates this server
being down - every endpoint returns plain JSON, and the chat agent's wiki
tools surface {error: "wiki_unreachable"} when fetch fails.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Any

try:
    from flask import Flask, abort, jsonify, request, send_file
    from flask_cors import CORS
except ImportError:  # pragma: no cover
    print(
        "wiki_server requires flask and flask-cors. Install with:\n"
        "  pip install flask flask-cors",
        file=sys.stderr,
    )
    raise

ROOT = Path(__file__).resolve().parent
WIKI_ROOT = ROOT / "wiki"
EXPORTS_DIR = ROOT / "exports"
CATEGORIES = {"people", "concepts", "tickers"}

# Files the /api/data endpoints are allowed to serve. The webapp uses these to
# pull the latest pipeline outputs without the user having to drag-drop files.
DATA_FILES_AT_ROOT = {"categorized_tweets.json", "enriched_tweets.json", "embeddings.ndjson"}


def _load_yaml_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Tiny YAML-ish frontmatter parser. We only support flat key/value plus
    nested lists/dicts to one level - enough for the schema in wiki/CLAUDE.md.
    Leaning on PyYAML would add a dep we don't otherwise need.
    """
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end == -1:
        return {}, text
    raw = text[4:end]
    body = text[end + 4 :].lstrip("\n")

    frontmatter: dict[str, Any] = {}
    current_key: str | None = None
    current_dict: dict[str, Any] | None = None
    for line in raw.splitlines():
        if not line.strip():
            continue
        if line.startswith("  ") and current_key:
            sub = line.strip()
            if ":" in sub:
                k, _, v = sub.partition(":")
                v = v.strip()
                if current_dict is None:
                    current_dict = {}
                    frontmatter[current_key] = current_dict
                current_dict[k.strip()] = _parse_scalar(v)
            continue
        # Top-level
        current_dict = None
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        current_key = key
        if not val:
            frontmatter[key] = {}
            current_dict = frontmatter[key]
        else:
            frontmatter[key] = _parse_scalar(val)
    return frontmatter, body


_LIST_RE = re.compile(r"^\[(.*)\]$")


def _parse_scalar(v: str) -> Any:
    """Best-effort scalar/inline-list parser. We accept:
        bare strings, "quoted strings", [a, b, "c"], integers, ISO dates as
        strings (we don't parse them - they round-trip).
    """
    if not v:
        return ""
    if v.startswith('"') and v.endswith('"'):
        return v[1:-1]
    m = _LIST_RE.match(v)
    if m:
        inner = m.group(1).strip()
        if not inner:
            return []
        # Track which list items were quoted so we don't coerce tweet-id-like
        # strings to JSON numbers (would lose precision past 2^53).
        items: list[tuple[str, bool]] = []
        cur: list[str] = []
        in_str = False
        was_quoted = False
        for ch in inner:
            if ch == '"':
                in_str = not in_str
                if in_str:
                    was_quoted = True
                continue
            if ch == "," and not in_str:
                items.append(("".join(cur).strip(), was_quoted))
                cur = []
                was_quoted = False
                continue
            cur.append(ch)
        if cur or was_quoted:
            items.append(("".join(cur).strip(), was_quoted))
        return [it if quoted else _parse_scalar(it) for it, quoted in items]
    # Try int.
    try:
        return int(v)
    except ValueError:
        return v


def _safe_path(category_slug: str) -> Path:
    """Resolve `category/slug` (no extension) to an absolute file under WIKI_ROOT.
    Raises 404 if it escapes the root or doesn't exist.
    """
    if "/" not in category_slug:
        abort(400, "path must be `<category>/<slug>` (e.g. people/jhalvorsen)")
    category, _, slug = category_slug.partition("/")
    if category not in CATEGORIES:
        abort(404, f"unknown category {category!r}")
    if not re.fullmatch(r"[a-z0-9._-]+", slug):
        abort(400, "slug must be [a-z0-9._-]+")
    p = (WIKI_ROOT / category / f"{slug}.md").resolve()
    try:
        p.relative_to(WIKI_ROOT.resolve())
    except ValueError:
        abort(404, "path escapes wiki root")
    if not p.is_file():
        abort(404, "page not found")
    return p


def _list_pages(category: str | None, query: str | None) -> list[dict[str, Any]]:
    folders = [category] if category else CATEGORIES
    out: list[dict[str, Any]] = []
    for folder in folders:
        if folder not in CATEGORIES:
            continue
        d = WIKI_ROOT / folder
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.md")):
            text = f.read_text(encoding="utf-8")
            front, _ = _load_yaml_frontmatter(text)
            slug = f.stem
            display = (front.get("display") or slug) if isinstance(front, dict) else slug
            entry = {
                "path": f"{folder}/{slug}",
                "slug": slug,
                "display": display,
                "type": (front.get("type") if isinstance(front, dict) else None) or folder.rstrip("s"),
            }
            if query:
                hay = f"{slug} {display}".lower()
                if query.lower() not in hay:
                    continue
            out.append(entry)
    return out


def _last_log_line() -> str | None:
    log = WIKI_ROOT / "CHANGELOG.md"
    if not log.is_file():
        return None
    lines = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln.strip()]
    # Skip the header lines.
    while lines and lines[0].startswith("#"):
        lines.pop(0)
    return lines[-1] if lines else None


def _search(query: str, max_results: int) -> list[dict[str, Any]]:
    q = query.lower().strip()
    if not q:
        return []
    out: list[dict[str, Any]] = []
    for folder in CATEGORIES:
        d = WIKI_ROOT / folder
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.md")):
            text = f.read_text(encoding="utf-8")
            front, body = _load_yaml_frontmatter(text)
            slug = f.stem
            display = (front.get("display") or slug) if isinstance(front, dict) else slug
            score = 0
            if q in str(display).lower() or q in slug.lower():
                score += 5
            for line in body.splitlines():
                if line.startswith("#") and q in line.lower():
                    score += 2
                elif q in line.lower():
                    score += 1
            if score == 0:
                continue
            # Build a snippet - first body line containing the query.
            snippet = ""
            for line in body.splitlines():
                if q in line.lower():
                    snippet = line.strip()
                    break
            out.append(
                {
                    "path": f"{folder}/{slug}",
                    "display": display,
                    "score": score,
                    "snippet": snippet[:200],
                }
            )
    out.sort(key=lambda r: r["score"], reverse=True)
    return out[:max_results]


LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _host_only(host_header: str) -> str:
    """Strip the optional port from a Host header value. Handles bracketed
    IPv6 ("[::1]:8765") and bare hosts ("localhost:8765")."""
    h = (host_header or "").strip().lower()
    if h.startswith("["):
        end = h.find("]")
        return h[1:end] if end != -1 else h
    if h.count(":") == 1:
        return h.split(":", 1)[0]
    return h


def _is_loopback_host_header(host_header: str) -> bool:
    return _host_only(host_header) in LOOPBACK_HOSTS


def create_app() -> Flask:
    app = Flask(__name__)
    # Allowlist localhost origins (where the Vite dev server runs). The
    # /api/keys endpoint exposes secrets; we MUST NOT allow arbitrary
    # cross-origin scripts to read them.
    _ALLOWED_ORIGINS = [
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        # Legacy port, harmless to leave allowlisted for now
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    CORS(app, origins=_ALLOWED_ORIGINS, supports_credentials=False)

    @app.before_request
    def _require_loopback_host():
        # App-wide DNS-rebinding defence. A rebound page is same-origin, so
        # CORS does not stop it, but its Host header is the attacker's name.
        if not _is_loopback_host_header(request.host):
            return jsonify({"error": "forbidden"}), 403
        return None

    @app.get("/health")
    def health():
        page_count = sum(
            1
            for cat in CATEGORIES
            for _ in (WIKI_ROOT / cat).glob("*.md")
            if (WIKI_ROOT / cat).is_dir()
        )
        return jsonify(
            status="ok",
            page_count=page_count,
            last_log_entry=_last_log_line(),
        )

    @app.get("/wiki/list")
    def wiki_list():
        category = request.args.get("category") or None
        query = request.args.get("query") or None
        return jsonify(_list_pages(category, query))

    @app.get("/wiki/read")
    def wiki_read():
        path = request.args.get("path", "")
        f = _safe_path(path)
        text = f.read_text(encoding="utf-8")
        frontmatter, body = _load_yaml_frontmatter(text)
        return jsonify(path=path, frontmatter=frontmatter, body_markdown=body)

    @app.get("/wiki/search")
    def wiki_search():
        q = request.args.get("q", "")
        max_results_raw = request.args.get("max") or "10"
        try:
            max_results = max(1, min(50, int(max_results_raw)))
        except ValueError:
            max_results = 10
        return jsonify(_search(q, max_results))

    # ── Data endpoints ────────────────────────────────────────────────────
    # The webapp /import route can pull these instead of asking the user to
    # drag-drop files. Manifest lists what's available + mtimes; /file serves
    # the bytes.

    @app.get("/api/data/manifest")
    def data_manifest():
        out: dict[str, Any] = {"root_files": {}, "html_files": []}
        for name in DATA_FILES_AT_ROOT:
            p = ROOT / name
            if p.exists():
                st = p.stat()
                out["root_files"][name] = {"mtime": int(st.st_mtime), "size": st.st_size}
        if EXPORTS_DIR.is_dir():
            for p in sorted(EXPORTS_DIR.glob("*.html")):
                st = p.stat()
                out["html_files"].append(
                    {"name": p.name, "mtime": int(st.st_mtime), "size": st.st_size}
                )
        return jsonify(out)

    # ── Key sharing ──────────────────────────────────────────────────────
    # The webapp's chat needs DEEPSEEK + VOYAGE keys (the Python pipeline still
    # uses OPENROUTER + ANTHROPIC, which are also returned here for completeness).
    # They already live in .env (sourced into the env at trove startup). This
    # endpoint hands them to the webapp so the user doesn't have to paste them
    # again.
    # CORS is locked to localhost above, so other origins can't read this.

    def _is_local_host() -> bool:
        """True only if the request's Host header is a loopback address. CORS is
        browser-enforced and does nothing against curl or a DNS-rebinding attack
        (which arrives with the attacker's Host); this header check closes that.
        """
        return _is_loopback_host_header(request.host)

    def _env_key(name: str) -> str:
        """Return env var, falling back to a literal scan of .env. The trove
        launcher sources .env, but if wiki_server is started another way we
        still want the keys to come through."""
        v = os.environ.get(name, "").strip()
        if v:
            return v
        env_path = ROOT / ".env"
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith(f"{name}="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        return ""

    @app.get("/api/keys/status")
    def keys_status():
        if not _is_local_host():
            return jsonify({"error": "forbidden"}), 403
        # Just yes/no per key.
        return jsonify({
            "anthropic": bool(_env_key("ANTHROPIC_API_KEY")),
            "openrouter": bool(_env_key("OPENROUTER_API_KEY")),
            "deepseek": bool(_env_key("DEEPSEEK_API_KEY")),
            "voyage": bool(_env_key("VOYAGE_API_KEY")),
        })

    @app.get("/api/keys/load")
    def keys_load():
        # Actual key values. Gated by BOTH the localhost CORS allowlist (stops a
        # cross-origin web page) AND a loopback Host check (stops curl / DNS
        # rebinding, which CORS does not).
        if not _is_local_host():
            return jsonify({"error": "forbidden"}), 403
        return jsonify({
            "anthropic": _env_key("ANTHROPIC_API_KEY"),
            "voyage": _env_key("VOYAGE_API_KEY"),
            "openrouter": _env_key("OPENROUTER_API_KEY"),
            "deepseek": _env_key("DEEPSEEK_API_KEY"),
        })

    @app.get("/api/data/file")
    def data_file():
        # Either ?name=categorized_tweets.json (root file) or
        # ?html=x-<slug>-YYYY-MM-DD.html (a file inside `exports/`).
        name = request.args.get("name", "").strip()
        html = request.args.get("html", "").strip()
        if name:
            if name not in DATA_FILES_AT_ROOT:
                abort(404)
            target = (ROOT / name).resolve()
        elif html:
            # Constrain to EXPORTS_DIR. No traversal.
            if "/" in html or "\\" in html or html.startswith("."):
                abort(400)
            target = (EXPORTS_DIR / html).resolve()
            try:
                target.relative_to(EXPORTS_DIR.resolve())
            except ValueError:
                abort(403)
            if not target.is_file() or target.suffix.lower() != ".html":
                abort(404)
        else:
            abort(400, "supply ?name= or ?html=")
        if not target.exists():
            abort(404)
        return send_file(target, as_attachment=False)

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Trove wiki server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("WIKI_PORT") or "8765"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument(
        "--allow-non-loopback",
        action="store_true",
        help="Permit a non-loopback --host. The Host check still allows only "
        "loopback names, so this is rarely useful and exposes the corpus.",
    )
    args = parser.parse_args()

    if _host_only(args.host) not in LOOPBACK_HOSTS:
        if not args.allow_non_loopback:
            parser.error(
                f"--host {args.host!r} is not loopback; pass "
                "--allow-non-loopback to bind it anyway"
            )
        if args.debug:
            parser.error("--debug is not available with a non-loopback --host")

    if not WIKI_ROOT.is_dir():
        print(
            f"wiki/ directory not found at {WIKI_ROOT}. Create it and run again.",
            file=sys.stderr,
        )
        sys.exit(1)

    app = create_app()
    print(
        f"wiki_server listening on http://{args.host}:{args.port} "
        f"(serving {WIKI_ROOT})",
        flush=True,
    )
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":
    main()
