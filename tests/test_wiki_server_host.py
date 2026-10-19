"""Offline tests for the app-wide loopback Host check in wiki_server.py.

Run: .venv/bin/python3 -m unittest tests.test_wiki_server_host
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wiki_server  # noqa: E402

PATHS = ["/api/data/file?name=categorized_tweets.json", "/api/data/manifest",
         "/wiki/list", "/health", "/api/keys/status"]


class HostCheckTests(unittest.TestCase):
    def setUp(self):
        self.client = wiki_server.create_app().test_client()

    def test_attacker_host_rejected_everywhere(self):
        for path in PATHS:
            for host in ("attacker.example:8765", "attacker.example", "127.0.0.1.evil.test"):
                r = self.client.get(path, headers={"Host": host})
                self.assertEqual(r.status_code, 403, (path, host))

    def test_loopback_hosts_allowed(self):
        for host in ("localhost", "localhost:8765", "127.0.0.1:8765", "[::1]", "[::1]:8765"):
            r = self.client.get("/health", headers={"Host": host})
            self.assertEqual(r.status_code, 200, host)

    def test_host_parsing(self):
        f = wiki_server._is_loopback_host_header
        self.assertTrue(f("[::1]:8765"))
        self.assertFalse(f("[::2]:8765"))
        self.assertFalse(f(""))


if __name__ == "__main__":
    unittest.main()
