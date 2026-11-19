import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("server-renders the RAG Chef application shell", async () => {
  const response = await fetch(new URL("/", process.env.RAG_CHEF_TEST_BASE_URL), {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>RAG Chef — Cook with what you have<\/title>/i);
  assert.match(html, /RAG Chef/);
  assert.match(html, /Ask Chef/);
  assert.match(html, /Dinner context/);
  assert.match(html, /Find my dinner/);
  assert.doesNotMatch(html, /What sounds good tonight\?/);
  assert.doesNotMatch(html, /Make the week easier|Your kitchen, organized/);
  assert.match(html, /Dinner day and portions/);
  assert.match(html, /Browse recipes/);
  assert.doesNotMatch(html, /New dinner search/);
  assert.match(html, /Approved catalog/);
  assert.match(html, /Persistent recipes \+ local fallback/);
  assert.doesNotMatch(html, /Codex is working|loading skeleton|codex-preview/i);
});

test("removes the disposable starter preview", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<RagChefApp \/>/);
  assert.match(layout, /RAG Chef — Cook with what you have/);
  assert.match(layout, /\/og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("app/_sites-preview", projectRoot)));
});
