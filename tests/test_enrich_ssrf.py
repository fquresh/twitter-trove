"""Offline tests for the SSRF guard in enrich.py (no real network).

Run: .venv/bin/python3 -m unittest tests.test_enrich_ssrf
"""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
import enrich  # noqa: E402


def run(coro):
    return asyncio.run(coro)


class ValidatorTests(unittest.TestCase):
    def test_blocked_literals(self):
        for a in ["127.0.0.1", "10.0.0.5", "172.16.1.1", "192.168.1.1", "169.254.169.254",
                  "0.0.0.0", "224.0.0.1", "240.0.0.1", "100.64.0.1", "::1", "fc00::1",
                  "fd12::1", "fe80::1", "ff02::1", "::", "::ffff:127.0.0.1"]:
            self.assertTrue(enrich._ip_is_blocked(a), a)

    def test_public_allowed(self):
        for a in ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]:
            self.assertFalse(enrich._ip_is_blocked(a), a)

    def test_scheme_and_literal_hosts(self):
        for u in ["file:///etc/passwd", "ftp://example.com/", "http://127.0.0.1/", "http://[::1]/",
                  "http://169.254.169.254/latest/meta-data", "http://"]:
            with self.assertRaises(enrich.UnsafeURLError, msg=u):
                run(enrich._validate_fetch_url(u))

    def test_resolved_private_blocked(self):
        async def fake(host, port):
            return ["93.184.216.34", "10.0.0.1"]
        with mock.patch.object(enrich, "_resolve_host", fake):
            with self.assertRaises(enrich.UnsafeURLError):
                run(enrich._validate_fetch_url("https://rebind.example/"))

    def test_resolved_public_ok(self):
        async def fake(host, port):
            return ["93.184.216.34"]
        with mock.patch.object(enrich, "_resolve_host", fake):
            run(enrich._validate_fetch_url("https://ok.example/"))


class FetchTests(unittest.TestCase):
    def _client(self, handler):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)

    def setUp(self):
        async def fake(host, port):
            return {"internal.example": ["10.0.0.9"]}.get(host, ["93.184.216.34"])
        p = mock.patch.object(enrich, "_resolve_host", fake)
        p.start()
        self.addCleanup(p.stop)

    def test_redirect_to_internal_blocked(self):
        seen = []

        def handler(req):
            seen.append(str(req.url))
            if req.url.host == "ok.example":
                return httpx.Response(302, headers={"location": "http://169.254.169.254/x"})
            return httpx.Response(200, html="<p>secret</p>")

        async def go():
            async with self._client(handler) as c:
                return await enrich._fetch_one_url(c, "http://ok.example/r")
        entry = run(go())
        self.assertEqual(entry["status"], "blocked_url")
        self.assertEqual(seen, ["http://ok.example/r"])

    def test_relative_redirect_followed_and_ok(self):
        def handler(req):
            if req.url.path == "/a":
                return httpx.Response(301, headers={"location": "/b"})
            return httpx.Response(200, headers={"content-type": "text/html"},
                                  text="<html><body><article><p>" + "hello world " * 30 + "</p></article></body></html>")

        async def go():
            async with self._client(handler) as c:
                return await enrich._fetch_one_url(c, "http://ok.example/a")
        entry = run(go())
        self.assertIn(entry["status"], ("ok", "empty"))
        self.assertTrue(entry["final_url"].endswith("/b"))

    def test_redirect_loop_capped(self):
        def handler(req):
            return httpx.Response(302, headers={"location": "http://ok.example/again"})

        async def go():
            async with self._client(handler) as c:
                return await enrich._fetch_one_url(c, "http://ok.example/")
        self.assertEqual(run(go())["status"], "blocked_url")

    def test_body_capped(self):
        def handler(req):
            return httpx.Response(200, content=b"a" * (enrich.URL_MAX_BODY_BYTES * 2))

        async def go():
            async with self._client(handler) as c:
                return await enrich._safe_get(c, "http://ok.example/big")
        r = run(go())
        self.assertLessEqual(len(r._body), enrich.URL_MAX_BODY_BYTES)


if __name__ == "__main__":
    unittest.main()
