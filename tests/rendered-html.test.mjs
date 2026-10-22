import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(pathname, "http://localhost/"), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the RAG Chef application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>RAG Chef — Cook with what you have<\/title>/i);
  assert.match(html, /RAG Chef/);
  assert.match(html, /Weekly plan/);
  assert.match(html, /Choose dinner/);
  assert.doesNotMatch(html, /What sounds good tonight\?/);
  assert.doesNotMatch(html, /Make the week easier|Your kitchen, organized/);
  assert.match(html, /This week<\/button>/);
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
