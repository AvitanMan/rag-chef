import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render(pathname = "/", bindings = {}, headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(pathname, "http://localhost/"), {
      headers: { accept: "text/html", ...headers },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
      ...bindings,
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
  assert.equal(response.headers.get("cache-control"), "private, no-cache");

  const html = await response.text();
  assert.match(html, /<title>RAG Chef — Cook with what you have<\/title>/i);
  assert.match(html, /RAG Chef/);
  assert.match(html, /Kitchen assistant/);
  assert.match(html, /Weekly plan/);
  assert.match(html, /Loading your weekly plan/);
  assert.doesNotMatch(html, /class="day-card/);
  assert.match(html, /Your everyday kitchen/);
  assert.doesNotMatch(html, /Find my dinner|Dinner day and portions/);
  assert.doesNotMatch(html, /Codex is working|loading skeleton|codex-preview/i);
});

test("hosted and RSC responses retain no-store instead of becoming offline shells", async () => {
  const hosted = await render("/", { RAG_CHEF_HOSTED: "1" });
  assert.equal(hosted.status, 200);
  assert.match(hosted.headers.get("cache-control"), /no-store/);
  await hosted.text();
  const rsc = await render("/.rsc?_rsc", { RAG_CHEF_HOSTED: "0" }, { RSC: "1", accept: "text/x-component" });
  assert.equal(rsc.status, 200);
  assert.match(rsc.headers.get("content-type"), /text\/x-component/);
  assert.match(rsc.headers.get("cache-control"), /no-store/);
  await rsc.text();
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
