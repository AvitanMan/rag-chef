import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkServiceConfiguration } from "../tools/deployment/check-services.mjs";

const roots = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(built = false) {
  const root = await mkdtemp(join(tmpdir(), "jff-service-contract-")); roots.push(root);
  const files = ["service-contracts.json", "wrangler.jsonc", "wrangler.catalog.jsonc", "wrangler.chef.jsonc", "drizzle/meta/_journal.json", "drizzle/0009_catalog_job_recipe_receipts.sql"];
  for (const file of files) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), await readFile(new URL(`../${file}`, import.meta.url))); }
  const manifest = JSON.parse(await readFile(join(root, "service-contracts.json"), "utf8"));
  const configs = {}, paths = {};
  for (const [role, contract] of Object.entries(manifest.roles)) {
    configs[role] = JSON.parse(await readFile(join(root, contract.config), "utf8"));
    paths[role] = built ? `dist/${contract.build}/wrangler.json` : contract.config;
    if (built) configs[role].main = "index.js";
    const main = join(root, dirname(paths[role]), configs[role].main);
    await mkdir(dirname(main), { recursive: true }); await writeFile(main, "throw new Error('Offline checks must never execute service code');\n");
  }
  const save = async () => {
    await writeFile(join(root, "service-contracts.json"), JSON.stringify(manifest));
    for (const [role, path] of Object.entries(paths)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), `// Disposable JSONC fixture\n${JSON.stringify(configs[role])}\n`); }
  };
  await save(); return { root, manifest, configs, paths, save };
}

test("offline source and built checks accept complete matching service artifacts without executing workers", async () => {
  for (const built of [false, true]) { const setup = await fixture(built); assert.deepEqual(await checkServiceConfiguration({ root: setup.root, built }), { ok: true, errors: [] }); }
});

test("release contracts reject lost admission controls, missing service roles and rollback to an incompatible schema", async () => {
  for (const mutate of [manifest => { manifest.controls = 0; }, manifest => { manifest.protocol = 2; }, manifest => { manifest.schema = 8; }, manifest => { delete manifest.roles.chef; }, manifest => { manifest.roles.chef.services = []; }]) {
    const setup = await fixture(); mutate(setup.manifest); await setup.save();
    const result = await checkServiceConfiguration({ root: setup.root }); assert.equal(result.ok, false); assert.ok(result.errors.length > 0);
  }
});

test("deployment checks reject public private-workers, mismatched databases, missing bindings and broken queue recovery", async () => {
  const cases = [
    [configs => { configs.chef.workers_dev = true; }, /private workers/],
    [configs => { configs.catalog.preview_urls = true; }, /private workers/],
    [configs => { configs.chef.routes = ["example.test/*"]; }, /private workers/],
    [configs => { configs.chef.services = []; }, /CATALOG must bind/],
    [configs => { configs.gateway.services[0].service = "wrong-catalog"; }, /CATALOG must bind/],
    [configs => { configs.chef.d1_databases[0].database_id = "different-database"; }, /same database/],
    [configs => { configs.catalog.queues.producers = []; }, /CATALOG_TASKS/],
    [configs => { configs.catalog.queues.consumers = []; }, /scheduled recovery/],
    [configs => { configs.catalog.triggers.crons = []; }, /scheduled recovery/],
    [configs => { configs.chef.compatibility_flags = ["nodejs_compat"]; }, /enable_request_signal/],
  ];
  for (const [mutate, expected] of cases) {
    const setup = await fixture(); mutate(setup.configs); await setup.save();
    const result = await checkServiceConfiguration({ root: setup.root }); assert.equal(result.ok, false); assert.match(result.errors.join("\n"), expected);
  }
});

test("missing migration and source or built entry points cannot pass deployment preflight", async () => {
  for (const built of [false, true]) {
    const setup = await fixture(built);
    await rm(join(setup.root, dirname(setup.paths.chef), setup.configs.chef.main));
    const result = await checkServiceConfiguration({ root: setup.root, built }); assert.equal(result.ok, false); assert.ok(result.errors.some(error => /entry point/.test(error)));
  }
  const setup = await fixture(); await rm(join(setup.root, "drizzle/0009_catalog_job_recipe_receipts.sql"));
  assert.equal((await checkServiceConfiguration({ root: setup.root })).ok, false);
  const missingJournal = await fixture();
  await writeFile(join(missingJournal.root, "drizzle/meta/_journal.json"), JSON.stringify({ entries: [] }));
  assert.match((await checkServiceConfiguration({ root: missingJournal.root })).errors.join("\n"), /migration journal/);
});

test("malformed configuration diagnostics contain no configuration values or credentials", async () => {
  const setup = await fixture(); const secret = "synthetic-private-value-that-must-not-be-printed";
  await writeFile(join(setup.root, setup.paths.chef), `{\"OPENAI_API_KEY\":\"${secret}\",broken`);
  const result = await checkServiceConfiguration({ root: setup.root });
  assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes(secret));
});
