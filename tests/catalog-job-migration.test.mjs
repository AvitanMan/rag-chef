import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("receipt migration stops only previously attempted unfinished text jobs and retains their review data", async () => {
  const db = new DatabaseSync(":memory:");
  const directory = new URL("../drizzle/", import.meta.url);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const name of (await readdir(directory)).filter(name => /^000[0-8]_.*\.sql$/.test(name)).sort()) db.exec(await readFile(new URL(name, directory), "utf8"));
    const insert = db.prepare(`INSERT INTO catalog_jobs(id,actor_id,actor_mode,request_id,kind,request_hash,payload_json,status,attempts,max_attempts,
      available_at,lease_token,lease_version,lease_until,progress_json,result_json,created_at,updated_at,started_at,finished_at)
      VALUES(?,'operator','local',?,?,'original-hash',?,?,?,3,123,'old-token',2,9999999999999,'{"phase":"saving","completed":1}',NULL,100,101,102,?)`);
    const cases = [
      ["queued-import", "import", "queued", 1, {}, true],
      ["running-demo", "demo", "running", 1, {}, true],
      ["running-sync", "sync", "running", 2, {}, true],
      ["new-import", "import", "queued", 0, {}, false],
      ["new-demo", "demo", "queued", 0, {}, false],
      ["new-sync", "sync", "queued", 0, {}, false],
      ["running-index", "embeddings", "running", 2, {}, false],
      ["queued-index", "embeddings", "queued", 1, {}, false],
      ["retry-vectors", "import", "running", 2, { retryEmbeddingsOnly: true }, false],
      ["done-import", "import", "succeeded", 1, {}, false],
      ["failed-import", "import", "failed", 2, {}, false],
    ];
    for (const [id, kind, status, attempts, options] of cases) insert.run(id, id, kind, JSON.stringify({ kind, recipes: [{ title: "Retained reviewed draft" }], ...options }), status, attempts, ["failed", "succeeded"].includes(status) ? 103 : null);
    const before = new Map(db.prepare("SELECT * FROM catalog_jobs").all().map(row => [row.id, row]));
    await db.exec(await readFile(new URL("0009_catalog_job_recipe_receipts.sql", directory), "utf8"));
    for (const [id, , , , , stopped] of cases) {
      const after = db.prepare("SELECT * FROM catalog_jobs WHERE id=?").get(id), prior = before.get(id);
      if (!stopped) { assert.deepEqual(after, prior, id); continue; }
      assert.equal(after.status, "failed", id); assert.equal(after.error_code, "CATALOG_REVIEW_REQUIRED", id);
      assert.match(after.error_message, /Review the saved recipes/);
      assert.equal(after.lease_token, null); assert.equal(after.lease_until, null); assert.ok(after.finished_at > prior.updated_at);
      for (const field of ["payload_json", "request_hash", "request_id", "actor_id", "progress_json", "attempts", "result_json", "lease_version", "started_at", "created_at"]) assert.equal(after[field], prior[field], `${id}: ${field}`);
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM catalog_job_recipe_receipts").get().n, 0);
  } finally { db.close(); }
});
