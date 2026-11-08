import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const dir = await mkdtemp(join(tmpdir(), "local-server-config-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const name of ["household", "local-server-config", "chef-schema", "kitchen-types"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(dir, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const { configureHouseholdRuntime } = await import(pathToFileURL(join(dir, "household.mjs")));
const { publicLocalServerConfig } = await import(pathToFileURL(join(dir, "local-server-config.mjs")));
test("new phone browsers receive server model defaults and exact app URLs without credentials", () => {
  configureHouseholdRuntime({ RAG_CHEF_HOSTED: "0", RAG_CHEF_AI_PROVIDER: "lmstudio", RAG_CHEF_LAN_ORIGINS: "http://192.168.1.20:3000,https://public.example:3000", LMSTUDIO_MODEL: "local-model", LMSTUDIO_API_KEY: "private-token", LMSTUDIO_BASE_URL: "http://127.0.0.1:1234/v1", OPENAI_API_KEY: "private-cloud-key" });
  const config = publicLocalServerConfig();
  assert.deepEqual(config.origins, ["http://192.168.1.20:3000"]);
  assert.equal(config.aiDefaults.provider, "lmstudio"); assert.equal(config.aiDefaults.lmstudioModel, "local-model");
  assert.doesNotMatch(JSON.stringify(config), /private-token|private-cloud-key|127\.0\.0\.1|API_KEY|BASE_URL/);
});
test("hosted sessions never inherit the standalone server model configuration", () => {
  configureHouseholdRuntime({ RAG_CHEF_HOSTED: "1", RAG_CHEF_AI_PROVIDER: "lmstudio", LMSTUDIO_MODEL: "private-host-model" });
  assert.equal(publicLocalServerConfig(), undefined);
});
