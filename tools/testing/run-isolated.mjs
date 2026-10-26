import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSql } from "./fixtures.mjs";
import { startModelStub } from "./model-stub.mjs";
import { parseJourneyOptions } from "../recipes/journey-grading.mjs";

const mode = process.argv[2];
if (!["integration", "e2e", "chef", "journeys"].includes(mode)) throw new Error("Choose integration, e2e, chef, or journeys.");
const journeyOptions = mode === "journeys" ? parseJourneyOptions(process.argv.slice(3)) : undefined;
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "rag-chef-test-"));
const project = join(directory, "project");
const state = join(directory, "d1-state");
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
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
  MINIFLARE_REGISTRY_PATH: join(directory, "registry"),
  RAG_CHEF_TEST_ARTIFACTS: artifacts,
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
  await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`${label} failed (exit ${code}); see ${join(artifacts, `${label}.log`)}`)));
  });
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
    try { const response = await fetch(`${baseURL}/api/recipes/catalog`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* Starting up. */ }
    await new Promise((accept) => setTimeout(accept, 200));
  }
  throw new Error("Disposable preview did not become ready; see preview.log.");
}

try {
  const directories = ["app", "build", "db", "drizzle", "worker", "public", "tests", "tools", ".openai"];
  const names = new Set((await readdir(root)));
  for (const name of directories) if (names.has(name)) await cp(join(root, name), join(project, name), { recursive: true, filter: (source) => !source.includes("__pycache__") });
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vite.config.ts", "next.config.ts", "postcss.config.mjs", "tsconfig.json", "cloudflare-env.d.ts", "wrangler.jsonc", "playwright.config.ts"]) {
    if (names.has(name)) await cp(join(root, name), join(project, name));
  }
  await symlink(join(root, "node_modules"), join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  if (journeyOptions?.catalog === "local") originalSnapshot = localSnapshot("snapshot");
  if (mode === "journeys") env.RAG_CHEF_JOURNEY_ISOLATED = "1";
  stub = ["chef", "journeys"].includes(mode) ? undefined : await startModelStub();
  const ollamaURL = stub?.url ?? "http://127.0.0.1:11434";
  env.OLLAMA_BASE_URL = ollamaURL;
  if (stub) env.RAG_CHEF_TEST_MODEL_URL = stub.url;
  // Wrangler explicitly injects these test values into the isolated Worker.
  await writeFile(join(project, ".dev.vars"), `OLLAMA_BASE_URL=${JSON.stringify(ollamaURL)}\n`);
  console.log(`Building disposable project; artifacts: ${artifacts}`);
  await launch("build", ["node_modules/vinext/dist/cli.js", "build"]);
  if (mode === "integration") {
    await launch("rendered-html", ["--test", "tests/rendered-html.test.mjs"]);
    console.log("Isolated built-worker checks passed.");
  } else {
    const wrangler = "node_modules/wrangler/bin/wrangler.js";
    await launch("migrations", [wrangler, "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", state]);
    if (journeyOptions?.catalog !== "local") {
      const seedFile = join(directory, "fixtures.sql");
      await writeFile(seedFile, fixtureSql({ grounding: mode === "chef", journeys: mode === "journeys" }));
      await launch("seed", [wrangler, "d1", "execute", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", state, "--file", seedFile]);
    }
    const port = await freePort();
    const inspectorPort = await freePort([port]);
    env.RAG_CHEF_TEST_BASE_URL = `http://127.0.0.1:${port}`;
    const preview = await launch("preview", [wrangler, "dev", "--local", "--config", "dist/server/wrangler.json", "--persist-to", state, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort), "--var", `OLLAMA_BASE_URL:${ollamaURL}`], { wait: false });
    await waitForServer(env.RAG_CHEF_TEST_BASE_URL, preview);
    if (["chef", "journeys"].includes(mode)) {
      const indexed = await fetch(`${env.RAG_CHEF_TEST_BASE_URL}/api/admin/catalog`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ embeddingsOnly: true }), signal: AbortSignal.timeout(300_000) });
      if (!indexed.ok || !(await indexed.json()).ok) throw new Error("Disposable fixture embedding refresh failed.");
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
      await launch("browser", ["node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(3)]);
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
