import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = (await readdir(new URL("../../tests/", import.meta.url)))
  .filter((name) => name.endsWith(".test.mjs") && name !== "rendered-html.test.mjs")
  .sort().map((name) => `tests/${name}`);
const child = spawn(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
