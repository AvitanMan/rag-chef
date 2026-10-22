import copy
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
from io import StringIO

MODULE = Path(__file__).parents[1] / "collect.py"
spec = importlib.util.spec_from_file_location("collect", MODULE)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
URL = "https://en.wikibooks.org/wiki/Cookbook:Test_Rice"
HTML = '''<html><head><link rel="canonical" href="https://en.wikibooks.org/wiki/Cookbook:Test_Rice"></head>
<body><h1 id="firstHeading">Cookbook:Test Rice</h1><div class="mw-parser-output">
<table><tr><th>Servings</th><td>4</td></tr></table><nav>Ignore navigation</nav>
<div class="mw-heading"><h2>Ingredients<span class="mw-editsection">edit</span></h2></div>
<ul><li>1 ½ cups rice</li><li>2 cloves garlic</li><li>Salt to taste</li></ul>
<h2>Procedure</h2><ol><li>Rinse rice.<ol><li>Use cold water.</li><li>Drain.</li></ol></li><li>Cook until tender.</li></ol>
<h2>Notes</h2><ul><li>Not a direction.</li></ul></div></body></html>'''


class CollectorTests(unittest.TestCase):
    def test_extract_preserves_order_and_explicit_servings(self):
        result = c.extract_recipe(HTML, URL)
        draft = result["draft"]
        self.assertEqual(draft["title"], "Test Rice")
        self.assertEqual(draft["servings"], 4)
        self.assertEqual(draft["ingredients"][0], {"name": "rice", "measure": "1 ½ cups"})
        self.assertEqual(draft["instructions"], ["Rinse rice. Use cold water. Drain.", "Cook until tender."])
        self.assertTrue(any("Salt to taste" in s for s in result["warnings"]))
        self.assertNotIn("image", draft)

    def test_missing_or_ambiguous_servings_are_not_invented(self):
        for value in ("2–4", "", "a family"):
            result = c.extract_recipe(HTML.replace("<td>4</td>", f"<td>{value}</td>"), URL)
            self.assertNotIn("servings", result["draft"])
            self.assertTrue(result["warnings"])

    def test_fractions_and_unclear_amounts(self):
        self.assertEqual(c.ingredient("1/2 tsp salt")[0], {"name": "salt", "measure": "1/2 tsp"})
        self.assertEqual(c.ingredient("½ cup milk")[0]["measure"], "½ cup")
        self.assertTrue(c.ingredient("1 (400 g) can beans")[1])
        self.assertTrue(c.ingredient("2–3 cups rice")[1])

    def test_missing_directions_or_content_blocks_extraction(self):
        for body in ("<html>not a recipe</html>", HTML.replace("Procedure", "Notes"), HTML.replace("Ingredients", "Notes"), HTML.replace("<nav>", '<div class="ambox">Rights notice</div><nav>')):
            with self.assertRaises(ValueError):
                c.extract_recipe(body, URL)

    def test_inline_punctuation_and_alternative_methods(self):
        result = c.extract_recipe(HTML.replace("Cook until tender.", "Cook <a>rice</a>, then <a>rest</a>."), URL)
        self.assertEqual(result["draft"]["instructions"][-1], "Cook rice, then rest.")
        with self.assertRaises(ValueError):
            c.extract_recipe(HTML.replace("<h2>Procedure</h2>", "<h2>Procedure</h2><h3>Method 1</h3>"), URL)

    def test_image_caption_inside_a_direction_is_excluded(self):
        body = HTML.replace("Rinse rice.", '<figure><img src="example.jpg"><figcaption>Finished rice photo</figcaption></figure>Rinse rice.')
        result = c.extract_recipe(body, URL)
        self.assertEqual(result["draft"]["instructions"][0], "Rinse rice. Use cold water. Drain.")

    def test_url_allowlist_and_canonicalization(self):
        self.assertEqual(c.canonical_url(URL + "#Ingredients"), URL)
        self.assertEqual(c.canonical_url(URL.replace("_", "%20")), URL)
        for url in ("http://en.wikibooks.org/wiki/Cookbook:Foo", "https://evil.example/wiki/Cookbook:Foo", "https://en.wikibooks.org@evil.example/wiki/Cookbook:Foo", URL + "?x=1", "https://en.wikibooks.org/wiki/Special:Foo", URL + "/%2e%2e/Bad", URL + "%5cBad"):
            with self.assertRaises(ValueError, msg=url):
                c.canonical_url(url)

    def test_read_links_deduplicates_and_caps_input(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "links.txt"
            path.write_text(URL + "\n" + URL + "#anchor\n")
            self.assertEqual(c.read_links(path), [URL])
            path.write_text((URL + "\n") * 21)
            with self.assertRaises(ValueError):
                c.read_links(path)

    def responses(self, pairs):
        self.calls = []
        def fetch(url, **kwargs):
            self.calls.append((url, kwargs))
            status, headers, body = pairs.pop(0)
            return SimpleNamespace(status=status, headers=headers, body=body.encode())
        return fetch

    def test_sequential_fetch_honors_delay_retry_after_and_no_stealth(self):
        now = [0.0]
        def sleep(seconds):
            now[0] += seconds
        fetch = self.responses([(200, {}, "User-agent: *\nCrawl-delay: 3\n"),
            (503, {"Retry-After": "7"}, "wait"), (200, {"Content-Type": "text/html"}, HTML)])
        collector = c.Collector(fetch, sleep, lambda: now[0])
        with self.assertRaises(ValueError):
            collector.collect(URL)
        collector.collect(URL)
        self.assertGreaterEqual(now[0], 10)
        for _, kwargs in self.calls:
            self.assertFalse(kwargs["follow_redirects"])
            self.assertFalse(kwargs["stealthy_headers"])
            self.assertIsNone(kwargs["impersonate"])
            self.assertEqual(kwargs["retries"], 1)

    def test_unsafe_redirect_never_requested(self):
        fetch = self.responses([(200, {}, "User-agent: *\n"), (302, {"Location": "http://127.0.0.1/private"}, "")])
        with self.assertRaises(ValueError):
            c.Collector(fetch, lambda _: None).collect(URL)
        self.assertEqual(len(self.calls), 2)

    def test_robots_and_access_blocks_stop_collection(self):
        for pairs in ([(200, {}, "User-agent: *\nDisallow: /wiki/\n")],
                      [(403, {}, "forbidden")],
                      [(200, {}, "User-agent: *\n"), (429, {}, "rate limited")]):
            fetch = self.responses(pairs)
            with self.assertRaises(c.CollectionBlocked):
                c.Collector(fetch, lambda _: None).collect(URL)

    def test_review_quit_and_skip_never_write_to_app(self):
        for choice, status in (("q", "collected"), ("s", "skipped")):
            report = {"entries": [c.extract_recipe(HTML, URL)]}
            with tempfile.TemporaryDirectory() as folder:
                c.review_entries(report, Path(folder) / "run.json", "http://localhost:3000", ask=lambda _: choice,
                    send=lambda *_: self.fail("Must not import without approval"))
                if choice == "s":
                    c.review_entries(report, Path(folder) / "run.json", "http://localhost:3000", ask=lambda _: self.fail("Skip must persist"),
                        send=lambda *_: self.fail("Must not import a skipped recipe"))
            self.assertEqual(report["entries"][0]["status"], status)

    def test_approval_persists_before_failure_and_retry_does_not_reapprove(self):
        report = {"entries": [c.extract_recipe(HTML, URL)]}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "run.json"
            def fail(*_):
                self.assertIn("approvedHash", json.loads(path.read_text())["entries"][0])
                raise ValueError("offline")
            c.review_entries(report, path, "http://localhost:3000", ask=lambda _: "a", send=fail)
            c.review_entries(report, path, "http://localhost:3000", ask=lambda _: self.fail("Already approved"),
                send=lambda *_: {"status": "saved", "embedding": "pending"})
            self.assertEqual(report["entries"][0]["status"], "saved")
            c.review_entries(report, path, "http://localhost:3000", embeddings_only=True,
                send=lambda draft, app, only: {"status": "saved", "embedding": "ready" if only else "bad"})
            self.assertEqual(report["entries"][0]["result"]["embedding"], "ready")

    def test_edited_approved_draft_requires_new_review(self):
        entry = c.extract_recipe(HTML, URL)
        entry["approvedHash"] = c.review_hash(entry["draft"])
        entry["status"] = "saved"
        entry["draft"]["instructions"][0] = "Changed direction."
        with tempfile.TemporaryDirectory() as folder:
            c.review_entries({"entries": [entry]}, Path(folder) / "run.json", "http://localhost:3000", ask=lambda _: "q", send=lambda *_: self.fail("Changed draft needs review"))
        self.assertNotIn("approvedHash", entry)

    def test_importer_never_sends_to_remote_app(self):
        with self.assertRaises(ValueError):
            c.send_to_app(c.extract_recipe(HTML, URL)["draft"], "https://example.com")

    def test_resume_and_embedding_retry_never_start_a_collector(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "run.json"
            c.save_report(path, {"schemaVersion": 1, "entries": [c.extract_recipe(HTML, URL)]})
            for flag in ("--resume", "--retry-embeddings"):
                with patch.object(c, "Collector", side_effect=AssertionError("Must not fetch")), patch.object(c, "review_entries") as review, redirect_stdout(StringIO()):
                    self.assertEqual(c.main([flag, str(path)]), 0)
                    review.assert_called_once()

    def test_interrupted_review_preserves_unapproved_draft(self):
        report = {"entries": [c.extract_recipe(HTML, URL)]}
        def interrupted(_):
            raise KeyboardInterrupt()
        with tempfile.TemporaryDirectory() as folder, redirect_stdout(StringIO()):
            path = Path(folder) / "run.json"
            c.review_entries(report, path, "http://localhost:3000", ask=interrupted, send=lambda *_: self.fail("Must not import"))
            self.assertEqual(json.loads(path.read_text())["entries"][0]["status"], "collected")
            self.assertNotIn("approvedHash", report["entries"][0])

    def test_failed_embedding_retry_never_becomes_an_automatic_recipe_overwrite(self):
        entry = c.extract_recipe(HTML, URL)
        entry.update({"status": "saved", "approvedHash": c.review_hash(entry["draft"]), "result": {"status": "saved", "embedding": "pending"}})
        report = {"entries": [entry]}
        with tempfile.TemporaryDirectory() as folder, redirect_stdout(StringIO()):
            path = Path(folder) / "run.json"
            c.review_entries(report, path, "http://localhost:3000", embeddings_only=True,
                send=lambda *_: {"status": "failed", "error": "Saved content changed"})
            self.assertEqual(entry["status"], "saved")
            self.assertEqual(entry["result"]["status"], "saved")
            self.assertIn("embeddingRetryError", entry)
            c.review_entries(report, path, "http://localhost:3000", send=lambda *_: self.fail("Must not overwrite"))


if __name__ == "__main__":
    unittest.main()
