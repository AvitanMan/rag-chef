import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSql } from "./fixtures.mjs";
import { startModelStub } from "./model-stub.mjs";
import { parseJourneyOptions } from "../recipes/journey-grading.mjs";
import { hostedFixtureSql, HOSTED_TEST_SECRET, HOSTED_OWNER_EMAILS, HOSTED_ADMIN_EMAILS } from "./hosted-fixtures.mjs";
import { catalogOperationResult, submitCatalogOperation } from "../recipes/catalog-jobs.mjs";

const mode = process.argv[2];
if (!["integration", "e2e", "setup", "smoke", "dev", "chef", "journeys", "hosted", "hosted-dev"].includes(mode)) throw new Error("Choose integration, e2e, setup, smoke, dev, chef, journeys, hosted, or hosted-dev.");
const hostedRun = ["hosted", "hosted-dev"].includes(mode);
const devRuntime = ["dev", "hosted-dev"].includes(mode);
const journeyOptions = mode === "journeys" ? parseJourneyOptions(process.argv.slice(3)) : undefined;
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "rag-chef-test-"));
const project = join(directory, "project");
const state = devRuntime ? join(project, ".wrangler", "state") : join(directory, "d1-state");
const artifacts = resolve(root, "output", "playwright", `${mode}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
await mkdir(artifacts, { recursive: true });
await mkdir(project);
const children = new Set();
let stub;
let cleaning;
let originalSnapshot;
function localSnapshot(operation) {
  const result = spawnSync("python3", [join(root, "tools/testing/snapshot-local-catalog.py"), operation, root, state], { encoding: "utf8", env });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "Local catalog snapshot requires Python 3.");
  return JSON.parse(result.stdout);
}

// Only non-secret tool settings reach the disposable project. No user .env file,
// cloud credentials, browser profile, or inherited model key is copied. The
// optional local-catalog track explicitly snapshots SQLite read-only.
const env = {
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  SYSTEMROOT: process.env.SYSTEMROOT,
  CI: "1",
  // Exercise Vite's agent-default console forwarding as well as ordinary dev.
  ...(devRuntime ? { AI_AGENT: "codex", RAG_CHEF_TEST_VITE_CACHE_DIR: join(project, ".wrangler", "node_modules", ".vite") } : {}),
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
  MINIFLARE_REGISTRY_PATH: join(directory, "registry"),
  RAG_CHEF_TEST_ARTIFACTS: artifacts,
  RAG_CHEF_TEST_STATE_DIR: state,
  ...(mode === "setup" ? { RAG_CHEF_SETUP_TEST: "1" } : {}),
};

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    for (const child of children) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    }
    await Promise.all([...children].map((child) => new Promise((done) => {
      if (child.exitCode !== null) { done(); return; }
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } done(); }, 4000);
      child.once("exit", () => { clearTimeout(timer); done(); });
    })));
    await stub?.close();
    await rm(directory, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void cleanup().then(() => process.exit(1)));

async function launch(label, args, { wait = true } = {}) {
  const log = await open(join(artifacts, `${label}.log`), "w");
  const child = spawn(process.execPath, args, { cwd: project, env, stdio: ["ignore", log.fd, log.fd], detached: true });
  children.add(child);
  child.once("exit", () => { children.delete(child); void log.close(); });
  child.once("error", () => { children.delete(child); void log.close(); });
  if (!wait) return child;
  try {
    await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`${label} failed (exit ${code}); see ${join(artifacts, `${label}.log`)}`)));
    });
  } catch (error) {
    // CI must show the actual failure, not just a path inside a downloadable artifact.
    try { console.error(await readFile(join(artifacts, `${label}.log`), "utf8")); }
    catch { /* Preserve the process error if its log cannot be read. */ }
    throw error;
  }
}

async function freePort(excluded = []) {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", accept); });
  const port = socket.address().port;
  await new Promise((accept) => socket.close(accept));
  if (port === 3000 || excluded.includes(port)) return freePort(excluded);
  return port;
}

async function waitForServer(baseURL, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Disposable preview stopped; see preview.log.");
    try { const response = await fetch(`${baseURL}${hostedRun ? "/api/session" : "/api/recipes/catalog"}`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* Starting up. */ }
    await new Promise((accept) => setTimeout(accept, 200));
  }
  throw new Error("Disposable preview did not become ready; see preview.log.");
}

try {
  const directories = ["app", "build", "db", "drizzle", "worker", "public", "tests", "tools", ".openai"];
  const names = new Set((await readdir(root)));
  for (const name of directories) if (names.has(name)) await cp(join(root, name), join(project, name), { recursive: true, filter: (source) => !source.includes("__pycache__") });
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "service-contracts.json", "vite.config.ts", "next.config.ts", "tsconfig.json", "cloudflare-env.d.ts", "wrangler.jsonc", "wrangler.catalog.jsonc", "wrangler.chef.jsonc", "playwright.config.ts", "playwright.smoke.config.ts", "playwright.dev.config.ts"]) {
    if (names.has(name)) await cp(join(root, name), join(project, name));
  }
  await symlink(join(root, "node_modules"), join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  if (journeyOptions?.catalog === "local") originalSnapshot = localSnapshot("snapshot");
  if (mode === "journeys") env.RAG_CHEF_JOURNEY_ISOLATED = "1";
  stub = ["chef", "journeys"].includes(mode) ? undefined : await startModelStub();
  const ollamaURL = stub?.url ?? "http://127.0.0.1:11434";
  const modelVars = { OLLAMA_BASE_URL: ollamaURL, ...(stub ? { OLLAMA_CHAT_MODEL: "test-model" } : {}) };
  Object.assign(env, modelVars);
  if (stub) env.RAG_CHEF_TEST_MODEL_URL = stub.url;
  const hostedPort = hostedRun ? await freePort() : undefined;
  const hostedVars = hostedRun ? {
    RAG_CHEF_HOSTED: "1", BETTER_AUTH_URL: `http://127.0.0.1:${hostedPort}`, BETTER_AUTH_SECRET: HOSTED_TEST_SECRET,
    GOOGLE_CLIENT_ID: "isolated-google-client", GOOGLE_CLIENT_SECRET: "isolated-google-secret",
    HOUSEHOLD_OWNER_EMAILS: HOSTED_OWNER_EMAILS, PLATFORM_ADMIN_EMAILS: HOSTED_ADMIN_EMAILS,
    HOSTED_RECIPE_SOURCE_IDS: "test-fixtures",
  } : {};
  if (hostedRun) Object.assign(env, hostedVars, { RAG_CHEF_HOSTED_TEST: "1", RAG_CHEF_TEST_AUTH_SECRET: HOSTED_TEST_SECRET });
  // Wrangler explicitly injects these test values into the isolated Worker.
  await writeFile(join(project, ".dev.vars"), Object.entries({ ...modelVars, ...hostedVars }).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n");
  console.log(`${devRuntime ? "Starting development checks" : "Building disposable project"}; artifacts: ${artifacts}`);
  await launch("service-contracts", ["tools/deployment/check-services.mjs"]);
  if (!devRuntime) await launch("build", ["node_modules/vinext/dist/cli.js", "build"]);
  if (!devRuntime) await launch("service-build-contracts", ["tools/deployment/check-services.mjs", "--built"]);
  if (!devRuntime) for (const name of ["server", "catalog", "chef"]) {
    // All three isolates must use the same authorization/source policy. These are
    // disposable fixture credentials only, never the user's environment.
    const path = join(project, "dist", name, "wrangler.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.vars = { ...config.vars, ...modelVars, ...hostedVars };
    await writeFile(path, JSON.stringify(config));
  }
  if (mode === "integration") {
    await launch("rendered-html", ["--test", "tests/rendered-html.test.mjs"]);
    console.log("Isolated built-worker checks passed.");
  } else {
    const wrangler = "node_modules/wrangler/bin/wrangler.js";
    await launch("migrations", [wrangler, "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", state]);
    if (mode !== "setup" && journeyOptions?.catalog !== "local") {
      const seedFile = join(directory, "fixtures.sql");
      await writeFile(seedFile, fixtureSql({ grounding: mode === "chef", journeys: mode === "journeys" }) + (hostedRun ? "\n" + hostedFixtureSql() : ""));
      await launch("seed", [wrangler, "d1", "execute", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", state, "--file", seedFile]);
    }
    const port = hostedPort ?? await freePort();
    const inspectorPort = await freePort([port]);
    env.RAG_CHEF_TEST_BASE_URL = `http://127.0.0.1:${port}`;
    const previewArgs = devRuntime
      ? ["node_modules/vinext/dist/cli.js", "dev", "--hostname", "127.0.0.1", "--port", String(port)]
      : [wrangler, "dev", "--local", "--config", "dist/server/wrangler.json", "--config", "dist/catalog/wrangler.json", "--config", "dist/chef/wrangler.json", "--persist-to", state, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort)];
    const preview = await launch("preview", previewArgs, { wait: false });
    await waitForServer(env.RAG_CHEF_TEST_BASE_URL, preview);
    if (["chef", "journeys"].includes(mode)) {
      const signal = AbortSignal.timeout(15 * 60_000);
      const indexed = await submitCatalogOperation(`${env.RAG_CHEF_TEST_BASE_URL}/api/admin/catalog`, { embeddingsOnly: true }, { signal });
      if (!(await catalogOperationResult(indexed, { base: env.RAG_CHEF_TEST_BASE_URL, signal })).ok) throw new Error("Disposable fixture embedding refresh failed.");
      if (mode === "journeys") {
        await launch("journeys", ["tools/recipes/evaluate-journeys.mjs", ...process.argv.slice(3)]);
        console.log("Isolated real-model journey checks passed.");
      } else {
        await launch("grounding", ["tools/recipes/evaluate-grounding.mjs", ...process.argv.slice(3)]);
        console.log("Isolated real-model grounding checks passed.");
      }
    } else {
      console.log(`Disposable D1 preview ready at ${env.RAG_CHEF_TEST_BASE_URL}; running browser checks.`);
      if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      const browserConfig = mode === "smoke" ? "playwright.smoke.config.ts" : mode === "dev" ? "playwright.dev.config.ts" : undefined;
      await launch("browser", ["node_modules/@playwright/test/cli.js", "test", ...(browserConfig ? ["--config", browserConfig] : []), ...process.argv.slice(3)]);
      console.log("Isolated browser checks passed.");
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (originalSnapshot) {
    try {
      const after = localSnapshot("fingerprint");
      const unchanged = JSON.stringify(originalSnapshot) === JSON.stringify(after);
      await writeFile(join(artifacts, "local-snapshot-check.json"), JSON.stringify({ unchanged, before: originalSnapshot, after }, null, 2) + "\n");
      try {
        const path = join(artifacts, "journey-results.json"), report = JSON.parse(await readFile(path, "utf8"));
        report.originalDataUnchanged = unchanged; report.gatesPassed = Boolean(report.gatesPassed && unchanged);
        await writeFile(path, JSON.stringify(report, null, 2) + "\n");
        const md = join(artifacts, "journey-report.md");
        await writeFile(md, await readFile(md, "utf8") + `\nOriginal local database comparison: **${unchanged ? "UNCHANGED" : "CHANGED DURING RUN — results require review"}**.\n`);
      } catch { /* A preflight failure may not have produced a full report. */ }
      if (!unchanged) { console.error("Original local database changed during evaluation; results require review."); process.exitCode = 1; }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
  await cleanup();
}
