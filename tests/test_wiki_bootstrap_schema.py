"""Offline tests for the wiki schema bootstrap in wiki_bootstrap.py.

Run: .venv/bin/python3 -m unittest tests.test_wiki_bootstrap_schema
"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import wiki_bootstrap  # noqa: E402


class SchemaBootstrapTests(unittest.TestCase):
    def test_copies_template_when_schema_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp) / "wiki"
            with mock.patch.object(wiki_bootstrap, "WIKI", wiki), \
                 mock.patch.object(wiki_bootstrap, "SCHEMA_DOC", wiki / "CLAUDE.md"):
                text = wiki_bootstrap._read_schema_doc()
            self.assertTrue((wiki / "CLAUDE.md").is_file())
            self.assertIn("source_tweet_ids", text)

    def test_keeps_an_existing_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp) / "wiki"
            wiki.mkdir()
            (wiki / "CLAUDE.md").write_text("custom schema", encoding="utf-8")
            with mock.patch.object(wiki_bootstrap, "WIKI", wiki), \
                 mock.patch.object(wiki_bootstrap, "SCHEMA_DOC", wiki / "CLAUDE.md"):
                text = wiki_bootstrap._read_schema_doc()
            self.assertEqual(text, "custom schema")

    def test_template_exists_in_the_repo(self):
        self.assertTrue(wiki_bootstrap.SCHEMA_TEMPLATE.is_file())


if __name__ == "__main__":
    unittest.main()
