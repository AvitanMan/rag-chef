import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const hash = value => createHash("sha256").update(value).digest("hex");

/** Paths participate in the digest, so renames and additions are visible as well as edits. */
export async function fingerprintFiles(root, paths) {
  const files = await Promise.all([...new Set(paths)].sort().map(async path => ({ path, sha256: hash(await readFile(join(root, path))) })));
  return { sha256: hash(JSON.stringify(files)), files };
}

export async function fingerprintApplication(root) {
  const paths = [];
  async function walk(folder) {
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  for (const folder of ["app", "db", "worker", "build", "drizzle"]) await walk(folder);
  paths.push("package.json", "pnpm-lock.yaml", "wrangler.jsonc", "vite.config.ts", "next.config.ts");
  return fingerprintFiles(root, paths);
}
