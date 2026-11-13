import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Use the exact bundler and Workerd runtime pinned by the application's Wrangler.
const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = runtimeRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = runtimeRequire("miniflare");

test("real Workerd invokes the default embedding fetch with the native receiver for queries and indexes", { timeout: 20_000 }, async () => {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); calls.push({ path: request.url, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ embeddings: body.input.map(() => [1, 2, 3]) }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let worker;
  try {
    const bundled = await build({ bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
      stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)), contents: `
        import { embedTextsWithOllama, precomputeRecipeEmbeddings, precomputeRecipeStepEmbeddings } from "./app/lib/recipe-embeddings.ts";
        const recipe = { id:"fixture",title:"Synthetic rice",category:"Dinner",cuisine:"Test",tags:[],ingredients:[{name:"rice",measure:"200 g"}],instructions:["Rinse rice.","Cook rice."] };
        export default { async fetch(request, env) {
          const mode = new URL(request.url).pathname;
          try {
            if (mode === "/bad-receiver") {
              const broken = { fetchImpl: globalThis.fetch };
              await broken.fetchImpl(env.MODEL_URL + "/api/embed", { method:"POST",body:'{"input":["wrong receiver"]}' });
              return Response.json({ unexpected: true });
            }
            const options = { baseUrl:env.MODEL_URL,model:"synthetic-embed",batchSize:1,timeoutMs:1000 };
            const result = mode === "/query" ? await embedTextsWithOllama(["rice", "beans"], options)
              : mode === "/recipe" ? await precomputeRecipeEmbeddings([recipe], [], options)
              : await precomputeRecipeStepEmbeddings([recipe], [], options);
            return Response.json(result);
          } catch (error) { return Response.json({ name:error.name,message:error.message,code:error.code }, {status:500}); }
        } };
      ` } });
    worker = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-10-01", compatibilityFlags: ["enable_request_signal"], host: "127.0.0.1", port: 0,
      cf: false, log: new Log(LogLevel.ERROR), bindings: { MODEL_URL: `http://127.0.0.1:${server.address().port}` },
    }), telemetry: { enabled: false }, enableDevRegistry: false });
    const broken = await worker.dispatchFetch("http://worker.test/bad-receiver");
    assert.equal(broken.status, 500); assert.match((await broken.json()).message, /Illegal invocation/);
    assert.equal(calls.length, 0, "The negative control fails before provider I/O");
    for (const mode of ["query", "recipe", "steps"]) {
      const response = await worker.dispatchFetch(`http://worker.test/${mode}`);
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      if (mode === "query") assert.deepEqual(result.vectors, [[1, 2, 3], [1, 2, 3]]);
      else { assert.deepEqual(result.failures, []); assert.equal(result.completedCount, mode === "recipe" ? 1 : 2); }
    }
    assert.equal(calls.length, 5);
    assert.ok(calls.every(call => call.path === "/api/embed" && call.body.model === "synthetic-embed" && call.body.input.length === 1));
  } finally {
    await worker?.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
