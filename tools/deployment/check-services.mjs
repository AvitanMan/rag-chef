import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const names = { CATALOG: "catalog", CHEF: "chef" };

/** Offline validation only: this never publishes workers or opens a database. */
export async function checkServiceConfiguration({ root = repository, built = false } = {}) {
  const errors = [];
  const error = (message) => errors.push(message);
  const read = async (path) => {
    const result = ts.parseConfigFileTextToJson(path, await readFile(resolve(root, path), "utf8"));
    if (result.error) throw new Error(`Invalid configuration: ${path}`);
    return result.config;
  };
  try {
    const manifest = await read("service-contracts.json");
    if (manifest.protocol !== 1 || manifest.controls !== 1 || manifest.schema !== 9 || manifest.migration !== "0009_catalog_job_recipe_receipts") error("Service contract must match protocol 1, controls 1 and schema 9.");
    if (JSON.stringify(Object.keys(manifest.roles ?? {}).sort()) !== JSON.stringify(["catalog", "chef", "gateway"])) throw new Error("Manifest must describe gateway, catalog and chef.");
    const required = { gateway: ["CATALOG", "CHEF"], catalog: [], chef: ["CATALOG"] };
    const configs = {}, paths = {};
    for (const [role, contract] of Object.entries(manifest.roles)) {
      if (JSON.stringify(contract.services) !== JSON.stringify(required[role]) || Boolean(contract.private) !== (role !== "gateway")
        || Boolean(contract.queueProducer) !== (role !== "chef") || Boolean(contract.queueConsumer) !== (role === "catalog")) error(`${role}: manifest must retain its required boundaries.`);
      paths[role] = built ? `dist/${contract.build}/wrangler.json` : contract.config;
      configs[role] = await read(paths[role]);
    }
    const database = configs.gateway.d1_databases?.find(binding => binding.binding === "DB");
    const queue = configs.gateway.queues?.producers?.find(binding => binding.binding === "CATALOG_TASKS")?.queue;
    if (!database?.database_id || !database.database_name) error("gateway: a DB binding is required.");
    if (!queue) error("gateway: a CATALOG_TASKS queue producer is required.");
    if (new Set(Object.values(configs).map(config => config.name)).size !== 3) error("Each service must have a distinct worker name.");
    for (const [role, config] of Object.entries(configs)) {
      if (typeof config.name !== "string" || !config.name) error(`${role}: worker name is required.`);
      for (const flag of ["nodejs_compat", "enable_request_signal"]) {
        if (config.compatibility_flags?.filter(value => value === flag).length !== 1) error(`${role}: ${flag} must occur exactly once.`);
      }
      if (config.compatibility_date !== configs.gateway.compatibility_date) error(`${role}: compatibility date must match the gateway.`);
      if (role !== "gateway" && (config.workers_dev !== false || config.preview_urls !== false || config.route || config.routes?.length)) error(`${role}: private workers must disable public routes, workers.dev and preview URLs.`);
      const databases = config.d1_databases?.filter(binding => binding.binding === "DB") ?? [];
      if (databases.length !== 1 || databases[0].database_id !== database?.database_id || databases[0].database_name !== database?.database_name) error(`${role}: DB must refer to the same database as the gateway.`);
      for (const binding of required[role]) {
        const matches = config.services?.filter(entry => entry.binding === binding) ?? [];
        if (matches.length !== 1 || matches[0].service !== configs[names[binding]].name || matches[0].environment) error(`${role}: ${binding} must bind to the matching release's worker.`);
      }
      if (role !== "chef") {
        const producers = config.queues?.producers?.filter(binding => binding.binding === "CATALOG_TASKS") ?? [];
        if (producers.length !== 1 || producers[0].queue !== queue) error(`${role}: CATALOG_TASKS must use the shared catalog queue.`);
      }
      if (role === "catalog" && (config.queues?.consumers?.filter(binding => binding.queue === queue).length !== 1 || !config.triggers?.crons?.length)) error("catalog: queue consumer and scheduled recovery are required.");
      if (role !== "catalog" && config.queues?.consumers?.length) error(`${role}: only Catalog consumes catalog jobs.`);
      if (typeof config.main !== "string") error(`${role}: worker entry point is required.`);
      else try { await access(resolve(root, dirname(paths[role]), config.main)); }
      catch { error(`${role}: worker entry point does not exist.`); }
    }
    const journal = await read("drizzle/meta/_journal.json");
    if (!journal.entries?.some(entry => entry.tag === manifest.migration)) error("Required runtime admission migration is missing from the migration journal.");
    await access(resolve(root, "drizzle", `${manifest.migration}.sql`));
  } catch (failure) {
    // Never print config contents, environment values or credentials.
    error(failure instanceof Error && failure.message.startsWith("Invalid configuration:") ? failure.message : "Required service configuration, entry point or migration is missing or malformed.");
  }
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkServiceConfiguration({ built: process.argv.includes("--built") });
  for (const error of result.errors) console.error(error);
  if (result.ok) console.log(`Service ${process.argv.includes("--built") ? "build" : "source"} contracts passed (protocol 1, controls 1, schema 9).`);
  process.exitCode = result.ok ? 0 : 1;
}
