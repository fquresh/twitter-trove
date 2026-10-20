"""Offline tests for the per-user bearer token in wiki_server.py.

Any local account can reach a loopback port. The token keeps the keys, the
data files, and the wiki pages for the user who started the server.
All values are dummies. ROOT points at a temp dir, so no real .env is read.

Run: .venv/bin/python3 -m unittest tests.test_wiki_server_token
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wiki_server  # noqa: E402

TOKEN = "dummy-wiki-token-0123456789"
DUMMY_KEYS = {
    "DEEPSEEK_API_KEY": "dummy-deepseek",
    "VOYAGE_API_KEY": "dummy-voyage",
    "ANTHROPIC_API_KEY": "dummy-anthropic",
    "OPENROUTER_API_KEY": "dummy-openrouter",
}
PROTECTED = [
    "/api/keys/load",
    "/api/keys/status",
    "/api/data/manifest",
    "/api/data/file?name=categorized_tweets.json",
    "/wiki/list",
    "/wiki/search?q=agent",
    "/wiki/read?path=people/ada_fieldstone",
]
HOST = {"Host": "127.0.0.1:8765"}


class TokenTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "wiki" / "people").mkdir(parents=True)
        (root / "wiki" / "people" / "ada_fieldstone.md").write_text(
            "---\ntype: person\n---\n# Ada Fieldstone\nWrites about agent memory.\n",
            encoding="utf-8",
        )
        (root / "categorized_tweets.json").write_text("{}", encoding="utf-8")
        patches = [
            mock.patch.object(wiki_server, "ROOT", root),
            mock.patch.object(wiki_server, "WIKI_ROOT", root / "wiki"),
            mock.patch.object(wiki_server, "EXPORTS_DIR", root / "exports"),
            mock.patch.dict(os.environ, DUMMY_KEYS, clear=False),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        os.environ.pop("TROVE_WIKI_TOKEN", None)
        self.root = root
        self.client = wiki_server.create_app(wiki_token=TOKEN).test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def get(self, path, auth=None, client=None):
        headers = dict(HOST)
        if auth is not None:
            headers["Authorization"] = auth
        return (client or self.client).get(path, headers=headers)

    def test_401_without_token(self):
        for path in PROTECTED:
            r = self.get(path)
            self.assertEqual(r.status_code, 401, path)
            self.assertNotIn(b"dummy-", r.data, path)

    def test_401_with_wrong_or_malformed_token(self):
        for auth in ("Bearer wrong", f"Basic {TOKEN}", TOKEN, "Bearer ", f"Bearer {TOKEN}x"):
            for path in PROTECTED:
                self.assertEqual(self.get(path, auth).status_code, 401, (path, auth))

    def test_200_with_token(self):
        for path in PROTECTED:
            r = self.get(path, f"Bearer {TOKEN}")
            self.assertEqual(r.status_code, 200, path)
            r.close()

    def test_health_needs_no_token(self):
        self.assertEqual(self.get("/health").status_code, 200)

    def test_keys_load_returns_only_chat_keys(self):
        r = self.get("/api/keys/load", f"Bearer {TOKEN}")
        body = json.loads(r.data)
        self.assertEqual(body, {"deepseek": "dummy-deepseek", "voyage": "dummy-voyage"})
        self.assertNotIn(b"dummy-anthropic", r.data)
        self.assertNotIn(b"dummy-openrouter", r.data)

    def test_no_configured_token_fails_closed(self):
        client = wiki_server.create_app(wiki_token="").test_client()
        for path in PROTECTED:
            for auth in (None, "Bearer ", f"Bearer {TOKEN}"):
                self.assertEqual(self.get(path, auth, client).status_code, 401, (path, auth))
        self.assertEqual(self.get("/health", client=client).status_code, 200)

    def test_token_from_env_then_file(self):
        with mock.patch.dict(os.environ, {"TROVE_WIKI_TOKEN": "env-dummy-token"}):
            client = wiki_server.create_app().test_client()
            self.assertEqual(self.get("/api/keys/status", "Bearer env-dummy-token", client).status_code, 200)
        (self.root / ".wiki_token").write_text("file-dummy-token\n", encoding="utf-8")
        client = wiki_server.create_app().test_client()
        self.assertEqual(self.get("/api/keys/status", "Bearer file-dummy-token", client).status_code, 200)

    def test_cors_preflight_allows_authorization(self):
        r = self.client.options(
            "/api/keys/load",
            headers={
                **HOST,
                "Origin": "http://127.0.0.1:5174",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:5174")
        self.assertIn("authorization", r.headers.get("Access-Control-Allow-Headers", "").lower())

    def test_env_file_fallback_reads_shell_quoting(self):
        # ./trove set-key writes single-quoted values; `source` and the server
        # must read back the same bytes.
        for name in DUMMY_KEYS:
            os.environ.pop(name, None)
        (self.root / ".env").write_text(
            "DEEPSEEK_API_KEY='a&b|c\\d\"e'\\''f'\nVOYAGE_API_KEY=plain-dummy\n", encoding="utf-8"
        )
        body = json.loads(self.get("/api/keys/load", f"Bearer {TOKEN}").data)
        self.assertEqual(body, {"deepseek": "a&b|c\\d\"e'f", "voyage": "plain-dummy"})


if __name__ == "__main__":
    unittest.main()
