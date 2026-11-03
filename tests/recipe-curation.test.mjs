import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../tools/recipes/curate.mjs", import.meta.url));
const fields = ["coreDinner", "dinnerRole", "diets.vegan", "diets.vegetarian", "diets.gluten_free", "diets.low_carb", "totalMinutes", "equipment", "servings", "ingredients"];
function catalogEntries(count, evidence = "Not established in the source.") {
  return Array.from({ length: count }, (_, index) => ({ recipeId: `recipe-${index}`, metadata: {
    revision: 1, sourceContentHash: "a".repeat(64), coreDinner: false, dinnerRole: "unknown",
    diets: { vegan: "unknown", vegetarian: "unknown", gluten_free: "unknown", low_carb: "unknown" },
    totalMinutes: null, equipment: null,
    provenance: Object.fromEntries(fields.map(field => [field, { basis: "curator_assessment", evidence }])),
    reviewedBy: "Test reviewer", reviewedAt: "2026-11-02T00:00:00.000Z",
  } }));
}

async function setup(t, entries) {
  const directory = await mkdtemp(join(tmpdir(), "jff-curation-"));
  const file = join(directory, "worksheet.json");
  const requests = [], saved = new Set();
  const failures = { previewRecipeId: null, importRecipeId: null };
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") { response.end(JSON.stringify({ entries })); return; }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const body = JSON.parse(bytes);
      assert.equal(request.url, "/api/admin/recipes/metadata");
      assert.ok(body.entries.length <= 100);
      assert.ok(bytes.length <= 1_000_000);
      requests.push(body);
      const rejected = body.preview ? failures.previewRecipeId : failures.importRecipeId;
      if (body.entries.some(entry => entry.recipeId === rejected)) {
        response.writeHead(400); response.end(JSON.stringify({ error: `Source changed: ${rejected}` })); return;
      }
      const results = body.entries.map(entry => {
        const changed = !saved.has(entry.recipeId);
        if (!body.preview) saved.add(entry.recipeId);
        return { recipeId: entry.recipeId, revision: 1, changed };
      });
      response.end(JSON.stringify({ ok: true, preview: body.preview, results }));
    } catch (error) {
      response.writeHead(500); response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = command => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, command, file, "--app", base], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CATALOG_ADMIN_TOKEN: "" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("exit", code => resolve({ code, stdout, stderr }));
  });
  const approve = async () => {
    const worksheet = JSON.parse(await readFile(file, "utf8"));
    worksheet.entries.forEach(entry => { entry.reviewed = true; });
    await writeFile(file, JSON.stringify(worksheet));
  };
  return { file, requests, saved, failures, run, approve };
}

test("full catalog worksheets validate, preview and import in bounded batches with idempotent retries", async t => {
  const entries = catalogEntries(205);
  const h = await setup(t, entries);
  assert.equal((await h.run("export")).code, 0);
  assert.equal((await h.run("validate")).code, 1, "Exporting does not grant review approval");
  await h.approve();
  const validated = await h.run("validate");
  assert.equal(validated.code, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).entries, 205);
  const previewed = await h.run("preview");
  assert.equal(previewed.code, 0, previewed.stderr);
  assert.equal(JSON.parse(previewed.stdout).entries, 205);
  assert.deepEqual(h.requests.map(body => body.entries.length), [100, 100, 5]);
  assert.ok(h.requests.every(body => body.preview));
  assert.equal(h.saved.size, 0);
  h.requests.length = 0;
  const imported = await h.run("import");
  assert.equal(imported.code, 0, imported.stderr);
  const result = JSON.parse(imported.stdout);
  assert.equal(result.preview, false);
  assert.equal(result.entries, 205); assert.equal(result.changed, 205);
  assert.deepEqual(result.results.map(entry => entry.recipeId), entries.map(entry => entry.recipeId));
  assert.deepEqual(h.requests.map(body => body.preview), [true, true, true, false, false, false]);
  assert.equal(h.saved.size, 205);
  const repeated = await h.run("import");
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).changed, 0);
});

test("a failed later preview prevents every write of a multi-batch import", async t => {
  const h = await setup(t, catalogEntries(101));
  await h.run("export"); await h.approve();
  h.failures.previewRecipeId = "recipe-100";
  const result = await h.run("import");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Source changed: recipe-100/);
  assert.ok(h.requests.every(body => body.preview));
  assert.equal(h.saved.size, 0);
});

test("a later import failure reports saved progress and the same worksheet can safely resume", async t => {
  const h = await setup(t, catalogEntries(101));
  await h.run("export"); await h.approve();
  h.failures.importRecipeId = "recipe-100";
  const failed = await h.run("import");
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /100 entries were imported before a later batch failed/);
  assert.match(failed.stderr, /Source changed: recipe-100/);
  assert.equal(h.saved.size, 100);
  h.failures.importRecipeId = null;
  const resumed = await h.run("import");
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).changed, 1);
  assert.equal(h.saved.size, 101);
});

test("batches respect UTF-8 body limits even when fewer than 100 reviews fit", async t => {
  const h = await setup(t, catalogEntries(40, "界".repeat(2000)));
  await h.run("export"); await h.approve();
  const result = await h.run("import");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).entries, 40);
  assert.equal(h.saved.size, 40);
  const writes = h.requests.filter(body => !body.preview);
  assert.ok(writes.length > 1);
  assert.ok(writes.every(body => body.entries.length < 100));
});
