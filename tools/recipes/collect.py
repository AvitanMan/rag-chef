#!/usr/bin/env python3
"""Small, explicit-link collector. Nothing is imported without a terminal review."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import unicodedata
from urllib import error, parse, request, robotparser

from lxml import html as lhtml
from scrapling.parser import Selector

HOST = "https://en.wikibooks.org"
USER_AGENT = "RAGChefRecipeCollector/1.0 (local personal prototype; explicit recipe links only)"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"
MAX_PAGES = 20


class CollectionBlocked(Exception):
    pass


def canonical_url(value: str) -> str:
    url = parse.urlsplit(value)
    path = unicodedata.normalize("NFC", parse.unquote(url.path)).replace(" ", "_")
    if (url.scheme != "https" or url.netloc != "en.wikibooks.org" or url.query
            or not path.startswith("/wiki/Cookbook:") or len(path) <= 15
            or re.search(r"[\\\x00-\x1f\x7f]", path)
            or any(part in (".", "..") for part in path.split("/"))):
        raise ValueError("Only HTTPS English Wikibooks Cookbook recipe URLs are supported.")
    return HOST + parse.quote(path, safe="/:")


def read_links(path: Path) -> list[str]:
    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()
             if line.strip() and not line.lstrip().startswith("#")]
    if not 1 <= len(lines) <= MAX_PAGES:
        raise ValueError("Provide 1–20 recipe links, one per line.")
    return list(dict.fromkeys(canonical_url(line) for line in lines))


def clean(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def element_text(node) -> str:
    """Keep inline punctuation intact, separating only HTML block boundaries."""
    pieces = [node.text or ""]
    for child in node:
        block = child.tag in ("li", "ol", "ul", "p", "div", "br", "tr", "th", "td")
        pieces.extend([" " if block else "", element_text(child), " " if block else "", child.tail or ""])
    return "".join(pieces)


QUANTITY = r"(?:\d+\s+(?:\d+/\d+|[¼½¾⅓⅔⅛⅜⅝⅞])|\d+/\d+|\d+(?:\.\d+)?[¼½¾⅓⅔⅛⅜⅝⅞]?|[¼½¾⅓⅔⅛⅜⅝⅞])"
UNIT = r"(?:cups?|tablespoons?|tbsp|teaspoons?|tsp|grams?|g|kilograms?|kg|millilit(?:er|re)s?|ml|lit(?:er|re)s?|l|ounces?|oz|pounds?|lb|cloves?|cans?|sticks?|pinch(?:es)?|slices?)"


def ingredient(line: str) -> tuple[dict, bool]:
    """Split only a clear leading amount. Keep ambiguous source lines verbatim."""
    match = re.fullmatch(rf"({QUANTITY}(?:\s*[–-]\s*{QUANTITY})?)(?:\s+({UNIT}))?\s+(.+)", line, re.I)
    if not match or line.startswith("("):
        return {"name": line, "measure": ""}, True
    number, unit, name = match.groups()
    if name.startswith("(") or re.match(r"^(?:to|or|of)\b", name, re.I):
        return {"name": line, "measure": ""}, True
    return {"name": name, "measure": " ".join(part for part in (number, unit) if part)}, "–" in number or "-" in number


def extract_recipe(body: str | bytes, source_url: str) -> dict:
    page = Selector(body)
    selected = page.css(".mw-parser-output").get()
    if not selected:
        raise ValueError("No Wikibooks recipe content found.")
    content = lhtml.fromstring(str(selected))
    # Removing surrounding widgets never changes source recipe wording.
    for unwanted in content.cssselect("script, style, .mw-editsection, .reference, .reflist, .navbox, .noprint, .toc, .printfooter, figure, figcaption, .thumb, .thumbcaption"):
        unwanted.drop_tree()
    text = lambda node: clean(element_text(node))
    if content.cssselect(".ambox, .tmbox, .warningbox"):
        raise ValueError("This page carries a notice. Review its rights/quality manually before collecting.")
    canonical = page.css('link[rel="canonical"]::attr(href)').get()
    source_url = canonical_url(parse.urljoin(source_url, str(canonical))) if canonical else canonical_url(source_url)
    title = clean(str(page.css("#firstHeading").get() or ""))
    if title:
        title = text(lhtml.fromstring(title))
    else:
        title = parse.unquote(parse.urlsplit(source_url).path.split("Cookbook:", 1)[1]).replace("_", " ")
    title = re.sub(r"^Cookbook:\s*", "", title)
    ingredients, instructions, warnings = [], [], []
    mode = None
    for node in content.iter():
        if node.tag == "h2":
            heading = text(node).lower().rstrip(":")
            mode = "ingredients" if heading == "ingredients" else "directions" if heading in ("procedure", "procedures", "directions", "instructions", "method", "preparation") else None
        if node.tag in ("h3", "h4") and mode == "directions" and re.search(r"\b(?:method\s*\d|alternativ|variation)", text(node), re.I):
            raise ValueError("Alternative cooking methods need manual separation; approval is blocked for this version.")
        if node.tag != "li" or any(parent.tag == "li" for parent in node.iterancestors()):
            continue
        line = text(node)
        if not line:
            continue
        if mode == "ingredients":
            item, unclear = ingredient(line)
            ingredients.append(item)
            if unclear:
                warnings.append(f"Review ingredient amount: {line}")
        elif mode == "directions" and node.getparent().tag == "ol":
            # Nested substeps stay inside their parent, once, in source order.
            instructions.append(line)
    if not ingredients or not instructions:
        raise ValueError("Missing ingredients or ordered directions; approval is blocked.")
    servings = None
    for row in content.xpath(".//tr"):
        cells = row.xpath("./th|./td")
        if len(cells) < 2:
            continue
        label, amount = text(cells[0]).lower().rstrip(":"), text(cells[1])
        if label in ("servings", "serves", "yield"):
            match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(?:servings?|people|persons?)?", amount, re.I)
            if match and (label != "yield" or re.search("servings?|people|persons?", amount, re.I)):
                number = float(match[1])
                if 0 < number <= 10000:
                    servings = int(number) if number.is_integer() else number
            if servings is None:
                warnings.append(f"Unclear source yield, not assumed: {amount}")
            break
    if servings is None:
        warnings.append("No explicit servings found; planning will use recipe batches.")
    draft = {"sourceUrl": source_url, "title": title, "ingredients": ingredients, "instructions": instructions}
    if servings is not None:
        draft["servings"] = servings
    # Keep drafts within the same bounds as persisted kitchen snapshots.
    if len(title) > 300 or len(ingredients) > 200 or len(instructions) > 300 or any(len(i["name"]) > 200 for i in ingredients) or any(len(s) > 4000 for s in instructions):
        raise ValueError("Recipe exceeds supported size; approval is blocked.")
    return {"draft": draft, "warnings": warnings, "status": "collected"}


def review_hash(draft: dict) -> str:
    representation = {key: draft[key] for key in ("sourceUrl", "title", "ingredients", "instructions")}
    # Match JavaScript JSON.stringify's ordered object and integer formatting.
    representation["ingredients"] = [{"name": i["name"], "measure": i["measure"]} for i in draft["ingredients"]]
    servings = draft.get("servings")
    representation["servings"] = int(servings) if isinstance(servings, float) and servings.is_integer() else servings
    return hashlib.sha256(json.dumps(representation, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def retry_after(value: str | None) -> float:
    if not value:
        return 0
    try:
        return max(0, float(value))
    except ValueError:
        try:
            return max(0, parsedate_to_datetime(value).timestamp() - time.time())
        except (ValueError, TypeError, OverflowError):
            return 0


class Collector:
    def __init__(self, fetch=None, sleep=time.sleep, clock=time.monotonic):
        if fetch is None:
            from scrapling.fetchers import Fetcher
            fetch = Fetcher.get
        self.fetch, self.sleep, self.clock = fetch, sleep, clock
        self.next_request = 0
        self.delay = 2.0
        self.robots = None

    def get(self, url: str):
        wait = self.next_request - self.clock()
        if wait > 0:
            self.sleep(wait)
        try:
            response = self.fetch(url, headers={"User-Agent": USER_AGENT}, impersonate=None,
                                  stealthy_headers=False, follow_redirects=False, retries=1,
                                  timeout=30, proxies={"all": ""})
        finally:
            self.next_request = self.clock() + self.delay
        headers = {str(k).lower(): str(v) for k, v in response.headers.items()}
        self.next_request = max(self.next_request, self.clock() + retry_after(headers.get("retry-after")))
        if response.status in (401, 403, 429):
            raise CollectionBlocked(f"Access blocked ({response.status}); collection stopped. Retry-After: {headers.get('retry-after', 'not specified')}.")
        return response, headers

    def load_robots(self):
        try:
            response, _ = self.get(HOST + "/robots.txt")
        except CollectionBlocked:
            raise
        except Exception as exc:
            raise CollectionBlocked("Cannot verify robots.txt; collection stopped.") from exc
        if response.status != 200:
            raise CollectionBlocked("Cannot verify robots.txt; collection stopped.")
        self.robots = robotparser.RobotFileParser()
        self.robots.parse(response.body.decode("utf-8", errors="replace").splitlines())
        rate = self.robots.request_rate(USER_AGENT)
        self.delay = max(2, self.robots.crawl_delay(USER_AGENT) or 0, rate.seconds / rate.requests if rate else 0)
        self.next_request = max(self.next_request, self.clock() + self.delay)

    def collect(self, url: str) -> dict:
        if self.robots is None:
            self.load_robots()
        url = canonical_url(url)
        for _ in range(4):
            if not self.robots.can_fetch(USER_AGENT, url):
                raise CollectionBlocked("robots.txt disallows this recipe; collection stopped.")
            response, headers = self.get(url)
            if response.status in (301, 302, 303, 307, 308):
                # Validate before any redirect request is sent.
                location = headers.get("location")
                if not location:
                    raise ValueError("Redirect has no destination.")
                url = canonical_url(parse.urljoin(url, location))
                continue
            if response.status != 200:
                raise ValueError(f"Page request failed ({response.status}).")
            if "html" not in headers.get("content-type", "").lower():
                raise ValueError("Expected an HTML recipe page.")
            if len(response.body) > 3_000_000:
                raise ValueError("Page exceeds the collection size limit.")
            result = extract_recipe(response.body, url)
            result["fetchedAt"] = datetime.now(timezone.utc).isoformat()
            return result
        raise ValueError("Too many redirects.")


def save_report(path: Path, report: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def send_to_app(draft: dict, app: str, embeddings_only=False) -> dict:
    url = parse.urlsplit(app)
    if url.scheme not in ("http", "https") or url.hostname not in ("localhost", "127.0.0.1", "::1") or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise ValueError("The importer connects only to the local app on a loopback address.")
    payload = {**draft, "reviewed": True, "reviewHash": review_hash(draft)}
    data = json.dumps({"recipes": [payload], "retryEmbeddingsOnly": embeddings_only}, ensure_ascii=False).encode()
    req = request.Request(app.rstrip("/") + "/api/admin/recipes/import", data=data, headers={"Content-Type": "application/json"})
    opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=45) as response:
            result = json.load(response)
    except error.HTTPError as exc:
        raise ValueError(f"App rejected import ({exc.code}). Check that migrations are applied and the report is valid.") from exc
    except error.URLError as exc:
        raise ValueError("Local app is unavailable. Start it, then resume this report.") from exc
    if not isinstance(result, dict) or not isinstance(result.get("results"), list) or len(result["results"]) != 1:
        raise ValueError("The app returned an unexpected import result.")
    return result["results"][0]


def review_entries(report: dict, path: Path, app: str, embeddings_only=False, ask=input, send=send_to_app):
    for entry in report["entries"]:
        draft = entry.get("draft")
        if not draft:
            continue
        fingerprint = review_hash(draft)
        if entry.get("status") == "skipped" and entry.get("skippedHash") == fingerprint:
            continue
        if entry.get("approvedHash") != fingerprint:
            entry.pop("approvedHash", None)
            entry.pop("skippedHash", None)
            entry.pop("result", None)
            entry["status"] = "collected"
        if embeddings_only:
            if entry.get("approvedHash") != fingerprint or entry.get("result", {}).get("status") != "saved" or entry["result"].get("embedding") != "pending":
                continue
        else:
            if entry.get("status") in ("saved", "skipped"):
                continue
            if not entry.get("approvedHash"):
                print(f"\n{draft['title']}\n{draft['sourceUrl']}\nWikibooks contributors · CC BY-SA 4.0\n{LICENSE_URL}")
                print("Formatting normalized; source wording retained.\nServings:", draft.get("servings", "unknown — use batches"))
                print("Ingredients:")
                for item in draft["ingredients"]:
                    print("  -", clean(item["measure"] + " " + item["name"]))
                print("Directions:")
                for number, step in enumerate(draft["instructions"], 1):
                    print(f"  {number}. {step}")
                for warning in entry.get("warnings", []):
                    print("  REVIEW:", warning)
                if not draft["ingredients"] or not draft["instructions"]:
                    print("Approval blocked: ingredients and ordered directions are required.")
                    continue
                choice = ""
                while choice not in ("a", "approve", "s", "skip", "q", "quit"):
                    try:
                        choice = ask("[a]pprove, [s]kip, [q]uit: ").strip().lower()
                    except (EOFError, KeyboardInterrupt):
                        choice = "q"
                if choice in ("q", "quit"):
                    save_report(path, report)
                    return
                if choice in ("s", "skip"):
                    entry["status"] = "skipped"
                    entry["skippedHash"] = fingerprint
                    save_report(path, report)
                    continue
                entry["approvedHash"] = fingerprint
                # Persist the approval before network I/O, even on interruption.
                save_report(path, report)
        try:
            result = send(draft, app, embeddings_only)
            if embeddings_only and result["status"] != "saved":
                # Never turn a failed embedding-only retry into an automatic
                # recipe overwrite on a later ordinary --resume.
                entry["embeddingRetryError"] = result.get("error", "Embedding retry failed.")
            else:
                entry["result"] = result
                entry["status"] = result["status"]
                entry.pop("embeddingRetryError", None)
                if result["status"] == "saved":
                    entry.pop("error", None)
            print(f"  {result['status']}: {result.get('embedding', result.get('error', ''))}")
        except (ValueError, OSError) as exc:
            if embeddings_only:
                entry["embeddingRetryError"] = str(exc)
            else:
                entry["status"], entry["error"] = "failed", str(exc)
            print(" ", exc)
        save_report(path, report)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("links", nargs="?", type=Path)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--resume", type=Path, help="Review/retry existing drafts; never fetch pages")
    group.add_argument("--retry-embeddings", type=Path, help="Retry saved pending vectors; never fetch pages")
    parser.add_argument("--collect-only", action="store_true", help="Save drafts without approvals or app writes")
    parser.add_argument("--app", default="http://localhost:3000")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    if args.links and (args.resume or args.retry_embeddings):
        parser.error("Choose a links file OR an existing report.")
    if args.report and (args.resume or args.retry_embeddings):
        parser.error("Resume updates the original report; do not specify --report.")
    report_path = args.resume or args.retry_embeddings or args.report or Path("recipe-runs") / (datetime.now().strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}.json")
    report = None
    try:
        if args.resume or args.retry_embeddings:
            report = json.loads(report_path.read_text(encoding="utf-8"))
            if report.get("schemaVersion") != 1 or not isinstance(report.get("entries"), list) or not 1 <= len(report["entries"]) <= 20:
                raise ValueError("Unsupported run report.")
        else:
            if not args.links:
                parser.error("Provide a links file or --resume/--retry-embeddings report.")
            if report_path.exists():
                raise ValueError("Report already exists; use --resume instead of overwriting it.")
            links = read_links(args.links)
            report = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(), "entries": [{"url": url, "status": "pending"} for url in links]}
            save_report(report_path, report)
            collector, seen = Collector(), set()
            for entry in report["entries"]:
                try:
                    entry.update(collector.collect(entry["url"]))
                    canonical = entry["draft"]["sourceUrl"]
                    if canonical in seen:
                        entry.pop("draft")
                        entry["status"] = "duplicate"
                    seen.add(canonical)
                except CollectionBlocked as exc:
                    entry["status"], entry["error"] = "blocked", str(exc)
                    print(exc)
                    save_report(report_path, report)
                    break
                except Exception as exc:
                    entry["status"], entry["error"] = "failed", str(exc)
                    print(f"Could not collect {entry['url']}: {exc}")
                save_report(report_path, report)
        print("Run report:", report_path)
        if not args.collect_only:
            review_entries(report, report_path, args.app, bool(args.retry_embeddings))
        drafted = sum("draft" in row for row in report["entries"])
        saved = sum(row.get("status") == "saved" for row in report["entries"])
        print(f"{drafted} drafts · {saved} saved. Resume with: pnpm recipes:collect -- --resume {report_path}")
        return 0
    except KeyboardInterrupt:
        if report is not None:
            save_report(report_path, report)
        print(f"\nStopped safely. Report: {report_path}")
        return 130
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
