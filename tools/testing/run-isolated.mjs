import { cp, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { ensureLocalTLS } from "../local-tls.mjs";
import { localCredentials } from "../secure-local-server.mjs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir, networkInterfaces } from "node:os";
import { privateAddresses, selectLocalAddress } from "../local-server.mjs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSql } from "./fixtures.mjs";
import { startModelStub } from "./model-stub.mjs";
import { parseJourneyOptions } from "../recipes/journey-grading.mjs";
import { localOllamaBaseUrl } from "./local-ollama.mjs";
import { hostedFixtureSql, HOSTED_TEST_SECRET, HOSTED_TEST_ENCRYPTION_KEY } from "./hosted-fixtures.mjs";

const mode = process.argv[2];
if (!["integration", "e2e", "setup", "smoke", "dev", "chef", "journeys", "planning", "hosted", "hosted-dev", "lan", "secure-lan"].includes(mode)) throw new Error("Choose integration, e2e, setup, smoke, dev, chef, journeys, planning, hosted, hosted-dev, lan, or secure-lan.");
const secureRun = mode === "secure-lan";
const lanRun = mode === "lan" || secureRun;
const serverHost = lanRun ? selectLocalAddress(privateAddresses(networkInterfaces())).address : "127.0.0.1";
const hostedRun = ["hosted", "hosted-dev"].includes(mode);
const devRuntime = ["dev", "hosted-dev"].includes(mode);
const journeyOptions = mode === "journeys" ? parseJourneyOptions(process.argv.slice(3)) : undefined;
// Other model tracks still read model metadata from the default daemon.
const realModelURL = ["chef", "journeys", "planning"].includes(mode) ? localOllamaBaseUrl(mode === "planning" ? process.env.OLLAMA_BASE_URL : "") : undefined;
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "rag-chef-test-"));
const project = join(directory, "project");
const state = devRuntime ? join(project, ".wrangler", "state") : join(directory, "d1-state");
const artifacts = resolve(root, "output", "playwright", `${mode}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
await mkdir(artifacts, { recursive: true });
await mkdir(project);
const children = new Set();
let stub;
let cleaning;
let originalSnapshot;
let secureTLS, secureLogin;
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
  ...(lanRun ? { RAG_CHEF_LAN_TEST: "1" } : {}),
  ...(secureRun ? { RAG_CHEF_SECURE_LAN_TEST: "1" } : {}),
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
  await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`${label} failed (exit ${code}); see ${join(artifacts, `${label}.log`)}`)));
  });
}

async function freePort(excluded = []) {
  const socket = createServer();
  await new Promise((accept, reject) => { socket.once("error", reject); socket.listen(0, serverHost, accept); });
  const port = socket.address().port;
  await new Promise((accept) => socket.close(accept));
  if (port === 3000 || excluded.includes(port)) return freePort(excluded);
  return port;
}

async function probeServer(baseURL, servername) {
  if (!secureRun) return (await fetch(`${baseURL}${hostedRun ? "/api/session" : "/api/recipes/catalog"}`, { signal: AbortSignal.timeout(1000) })).ok;
  return new Promise((accept, reject) => {
    const request = httpsRequest(`${baseURL}/api/session`, { ca: secureTLS.ca, timeout: 1000, ...(servername ? { servername, headers: { host: `${servername}:${new URL(baseURL).port}` } } : {}) }, response => {
      response.resume(); accept(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy(new Error("Server probe timed out")));
    request.on("error", reject); request.end();
  });
}

async function waitForServer(baseURL, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Disposable preview stopped; see preview.log.");
    try { if (await probeServer(baseURL)) return; } catch { /* Starting up. */ }
    await new Promise((accept) => setTimeout(accept, 200));
  }
  throw new Error("Disposable preview did not become ready; see preview.log.");
}

try {
  const directories = ["app", "build", "db", "drizzle", "worker", "public", "tests", "tools", ".openai"];
  const names = new Set((await readdir(root)));
  for (const name of directories) if (names.has(name)) await cp(join(root, name), join(project, name), { recursive: true, filter: (source) => !source.includes("__pycache__") });
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vite.config.ts", "next.config.ts", "tsconfig.json", "cloudflare-env.d.ts", "wrangler.jsonc", "playwright.config.ts", "playwright.smoke.config.ts", "playwright.dev.config.ts"]) {
    if (names.has(name)) await cp(join(root, name), join(project, name));
  }
  await symlink(join(root, "node_modules"), join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  if (journeyOptions?.catalog === "local") originalSnapshot = localSnapshot("snapshot");
  if (mode === "journeys") env.RAG_CHEF_JOURNEY_ISOLATED = "1";
  if (mode === "planning") env.RAG_CHEF_PLANNING_ISOLATED = "1";
  stub = ["chef", "journeys", "planning"].includes(mode) ? undefined : await startModelStub();
  const ollamaURL = stub?.url ?? realModelURL;
  env.OLLAMA_BASE_URL = ollamaURL;
  if (stub) env.RAG_CHEF_TEST_MODEL_URL = stub.url;
  const hostedPort = hostedRun ? await freePort() : undefined;
  const hostedVars = hostedRun ? {
    RAG_CHEF_HOSTED: "1", BETTER_AUTH_URL: `http://127.0.0.1:${hostedPort}`, BETTER_AUTH_SECRET: HOSTED_TEST_SECRET,
    GOOGLE_CLIENT_ID: "isolated-google-client", GOOGLE_CLIENT_SECRET: "isolated-google-secret",
    HOUSEHOLD_OWNER_EMAILS: "owner-desktop@example.test,other-desktop@example.test,owner-mobile@example.test,other-mobile@example.test",
    PLATFORM_ADMIN_EMAILS: "admin-desktop@example.test,admin-mobile@example.test",
    HOSTED_RECIPE_SOURCE_IDS: "test-fixtures", // Original synthetic content, explicitly admitted only in this disposable harness.
    AI_CREDENTIALS_ENCRYPTION_KEY_V1: HOSTED_TEST_ENCRYPTION_KEY, AI_CREDENTIALS_KEY_VERSION: "v1",
  } : {};
  if (hostedRun) Object.assign(env, hostedVars, { RAG_CHEF_HOSTED_TEST: "1", RAG_CHEF_TEST_AUTH_SECRET: HOSTED_TEST_SECRET });
  // Wrangler explicitly injects these test values into the isolated Worker.
  await writeFile(join(project, ".dev.vars"), Object.entries({ OLLAMA_BASE_URL: ollamaURL, ...hostedVars }).map(([key,value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n");
  console.log(`${devRuntime ? "Starting development checks" : "Building disposable project"}; artifacts: ${artifacts}`);
  if (!devRuntime) await launch("build", ["node_modules/vinext/dist/cli.js", "build"]);
  if (mode === "integration") {
    await launch("rendered-html", ["--test", "tests/rendered-html.test.mjs"]);
    console.log("Isolated built-worker checks passed.");
  } else {
    const wrangler = "node_modules/wrangler/bin/wrangler.js";
    await launch("migrations", [wrangler, "d1", "migrations", "apply", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", state]);
    if (mode !== "setup" && journeyOptions?.catalog !== "local") {
      const seedFile = join(directory, "fixtures.sql");
      await writeFile(seedFile, fixtureSql({ grounding: mode === "chef", journeys: ["journeys", "planning"].includes(mode) }) + (hostedRun ? "\n" + hostedFixtureSql() : ""));
      await launch("seed", [wrangler, "d1", "execute", "DB", "--local", "--config", "wrangler.jsonc", "--persist-to", state, "--file", seedFile]);
    }
    const port = hostedPort ?? await freePort();
    const protocol = secureRun ? "https" : "http";
    const friendlyURL = `https://ragchef.local:${port}`;
    let secureVars = {};
    if (secureRun) {
      const tls = await ensureLocalTLS({ directory: join(directory, "tls"), name: "ragchef.local", address: serverHost });
      secureTLS = { ...tls, ca: await readFile(tls.caCert) };
      const credentials = await localCredentials(join(directory, "tls"));
      secureLogin = JSON.parse(await readFile(credentials.path, "utf8"));
      secureVars = { RAG_CHEF_LAN_AUTH: "1", RAG_CHEF_LAN_PASSWORD_SHA256: credentials.hash };
      Object.assign(env, { RAG_CHEF_TEST_LAN_PASSWORD: secureLogin.password, RAG_CHEF_TEST_FRIENDLY_URL: friendlyURL, RAG_CHEF_TEST_LAN_ADDRESS: serverHost });
    }
    const lanVars = lanRun ? { RAG_CHEF_LAN_ORIGINS: `${secureRun ? `${friendlyURL},` : ""}${protocol}://${serverHost}:${port}`, OLLAMA_CHAT_MODEL: "test-model", ...secureVars } : {};
    const inspectorPort = await freePort([port]);
    env.RAG_CHEF_TEST_BASE_URL = `${protocol}://${serverHost}:${port}`;
    const previewArgs = devRuntime
      ? ["node_modules/vinext/dist/cli.js", "dev", "--hostname", "127.0.0.1", "--port", String(port)]
      : [wrangler, "dev", "--local", "--config", "dist/server/wrangler.json", "--persist-to", state, "--ip", serverHost, "--port", String(port), "--inspector-ip", "127.0.0.1", "--inspector-port", String(inspectorPort), ...(secureRun ? ["--local-protocol", "https", "--upstream-protocol", "https", "--https-key-path", secureTLS.key, "--https-cert-path", secureTLS.cert] : []), "--var", `OLLAMA_BASE_URL:${ollamaURL}`, ...Object.entries({ ...hostedVars, ...lanVars }).flatMap(([key,value]) => ["--var", `${key}:${value}`])];
    const preview = await launch("preview", previewArgs, { wait: false });
    await waitForServer(env.RAG_CHEF_TEST_BASE_URL, preview);
    if (secureRun && !await probeServer(env.RAG_CHEF_TEST_BASE_URL, "ragchef.local")) throw new Error("Friendly HTTPS identity or authenticated session probe failed.");
    if (["chef", "journeys", "planning"].includes(mode)) {
      const indexed = await fetch(`${env.RAG_CHEF_TEST_BASE_URL}/api/admin/catalog`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ embeddingsOnly: true }), signal: AbortSignal.timeout(300_000) });
      if (!indexed.ok || !(await indexed.json()).ok) throw new Error("Disposable fixture embedding refresh failed.");
      if (mode === "planning") {
        await launch("planning", ["tools/recipes/evaluate-planning.mjs", ...process.argv.slice(3)]);
        console.log("Isolated real-model planning checks passed.");
      } else if (mode === "journeys") {
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
      await launch("browser", ["node_modules/@playwright/test/cli.js", "test", ...(browserConfig ? ["--config", browserConfig] : []), ...(hostedRun ? ["tests/e2e/hosted.spec.ts"] : secureRun ? ["tests/e2e/secure-lan.spec.ts", "tests/e2e/local-session.spec.ts"] : lanRun ? ["tests/e2e/lan.spec.ts"] : []), ...process.argv.slice(3)]);
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
