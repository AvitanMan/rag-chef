import { readFile, writeFile } from "node:fs/promises";

// Export is a review worksheet. Import requires explicit approvals and a matching
// source hash; it never changes source recipe text, servings, or kitchen state.
const args = process.argv.slice(2).filter((x) => x !== "--");
const [command, path] = args;
const appFlag = args.indexOf("--app");
const base = appFlag >= 0 ? args[appFlag + 1] : process.env.RECIPES_APP_URL || "http://localhost:3000";
const origin = new URL(base);
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Curation connects only to the local app on a loopback address.");
if (!["report", "export", "preview", "import", "validate"].includes(command) || !path) throw new Error("Usage: node tools/recipes/curate.mjs report|export|preview|import|validate FILE.json [--app http://localhost:3000]");

const headers = { "content-type": "application/json", ...(process.env.CATALOG_ADMIN_TOKEN ? { authorization: `Bearer ${process.env.CATALOG_ADMIN_TOKEN}` } : {}) };
const MAX_WORKSHEET_ENTRIES = 1000;
const MAX_BATCH_ENTRIES = 100;
const MAX_BATCH_BYTES = 1_000_000;
async function request(body) {
  const response = await fetch(new URL("/api/admin/recipes/metadata", origin), { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers, signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
  return result;
}

function reviewBatches(entries) {
  const batches = [];
  let batch = [];
  // Include the larger boolean spelling when measuring either request type.
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ entries: [], preview: false }));
  let batchBytes = envelopeBytes;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry));
    if (envelopeBytes + entryBytes > MAX_BATCH_BYTES) throw new Error(`Metadata for ${entry.recipeId} exceeds the review request limit.`);
    if (batch.length && (batch.length === MAX_BATCH_ENTRIES || batchBytes + 1 + entryBytes > MAX_BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      batchBytes = envelopeBytes;
    }
    batchBytes += entryBytes + (batch.length ? 1 : 0);
    batch.push(entry);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

if (command === "report") {
  const catalog = await request();
  const report = { generatedAt: new Date().toISOString(), summary: catalog.summary, entries: catalog.entries.map(({ recipeId, title, sourceUrl, contentHash, quality, metadata }) => ({ recipeId, title, sourceUrl, contentHash, quality, coreDinner: Boolean(metadata?.coreDinner) })) };
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output: path, ...report.summary }, null, 2));
} else if (command === "export") {
  const catalog = await request();
  const manifest = { schemaVersion: 1, description: "Review the captured source; fill metadata and set reviewed:true only after review. Unknown is a valid reviewed value.", entries: catalog.entries.map((item) => ({ ...item, reviewed: false })) };
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  console.log(`Exported ${manifest.entries.length} source records to ${path}.`);
} else {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > MAX_WORKSHEET_ENTRIES) throw new Error(`Expected a version 1 manifest with 1–${MAX_WORKSHEET_ENTRIES} reviewed entries.`);
  const ids = new Set();
  const entries = manifest.entries.map((item) => {
    if (typeof item.recipeId !== "string" || ids.has(item.recipeId) || item.reviewed !== true || !item.metadata || !/^[a-f0-9]{64}$/.test(item.metadata.sourceContentHash)) throw new Error("Each unique entry requires reviewed:true and hash-bound metadata.");
    ids.add(item.recipeId);
    return { recipeId: item.recipeId, reviewed: true, metadata: item.metadata };
  });
  if (manifest.coreDinnerCount !== undefined && entries.filter((x) => x.metadata.coreDinner).length !== manifest.coreDinnerCount) throw new Error("Core dinner count differs from the reviewed manifest.");
  if (command === "validate") console.log(JSON.stringify({ ok: true, entries: entries.length, coreDinnerCount: entries.filter((x) => x.metadata.coreDinner).length, note: "File structure checked. Use preview to validate all field evidence against the current catalog." }, null, 2));
  else {
    const batches = reviewBatches(entries);
    const preview = command === "preview";
    // Check every source hash and review before the first write of a large import.
    if (!preview && batches.length > 1) {
      for (const batch of batches) await request({ entries: batch, preview: true });
    }
    const results = [];
    try {
      for (const batch of batches) {
        const result = await request({ entries: batch, preview });
        results.push(...result.results);
      }
    } catch (error) {
      if (!preview && results.length) throw new Error(`${results.length} entries were imported before a later batch failed. Fix the reported problem and rerun the worksheet; unchanged reviews are idempotent. ${error.message}`, { cause: error });
      throw error;
    }
    console.log(JSON.stringify({ ok: true, preview, entries: results.length, changed: results.filter((x) => x.changed).length, results: results.map(({ recipeId, revision, changed }) => ({ recipeId, revision, changed })) }, null, 2));
  }
}
