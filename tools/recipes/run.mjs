import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const python = `${root}.venv-recipes/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`;
if (!existsSync(python)) {
  console.error("Recipe importer setup is needed. See README.md → Collect recipes (Python 3.10+).");
  process.exit(1);
}
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const result = spawnSync(python, [`${root}tools/recipes/collect.py`, ...args], { cwd: root, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
