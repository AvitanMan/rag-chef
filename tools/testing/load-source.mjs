import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repository = fileURLToPath(new URL("../../", import.meta.url));

/** Compile the real transitive TS graph into a disposable ESM tree.
 * Overrides replace explicit boundaries; imports never need hand-maintained lists.
 */
export async function createSourceLoader({ name = "source", overrides = {}, externals = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `jff-${name}-`));
  await symlink(join(repository, "node_modules"), join(directory, "node_modules"));
  const outputs = new Map(), work = new Map(), externalUrls = new Map();
  for (const [specifier, source] of Object.entries(externals)) {
    const path = join(directory, "externals", `${externalUrls.size}.mjs`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    externalUrls.set(specifier, pathToFileURL(path).href);
  }

  async function sourcePath(path) {
    for (const candidate of extname(path) ? [path] : [path + ".ts", path + ".tsx", path + ".mjs", path + ".js"]) {
      if (Object.hasOwn(overrides, candidate)) return candidate;
      try { await access(join(repository, candidate)); return candidate; } catch { /* Try next source extension. */ }
    }
    throw new Error(`Source test loader cannot resolve ${path}`);
  }

  async function compile(path) {
    path = await sourcePath(path);
    if (outputs.has(path)) return outputs.get(path);
    const output = join(directory, path.replace(/\.(?:tsx?|m?js)$/, ".mjs"));
    outputs.set(path, output); // Break import cycles before traversing dependencies.
    const writing = (async () => {
      const source = overrides[path] ?? await readFile(join(repository, path), "utf8");
      let code = ts.transpileModule(source, { fileName: path, compilerOptions: {
        module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
      } }).outputText;
      const references = [...code.matchAll(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])([^"']+)\2/g)];
      for (const match of references.reverse()) {
        const specifier = match[3];
        let destination = externalUrls.get(specifier);
        if (!destination && (specifier.startsWith(".") || specifier.startsWith("@/"))) {
          const dependency = specifier.startsWith("@/") ? specifier.slice(2)
            : relative(repository, resolve(repository, dirname(path), specifier));
          destination = pathToFileURL(await compile(dependency)).href;
        }
        if (destination) code = code.slice(0, match.index) + match[1] + JSON.stringify(destination) + code.slice(match.index + match[0].length);
      }
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, code);
    })();
    work.set(path, writing);
    await writing;
    return output;
  }

  return {
    directory,
    async import(path) {
      if (externalUrls.has(path)) return import(externalUrls.get(path));
      const output = await compile(path);
      await Promise.all(work.values());
      return import(pathToFileURL(output).href);
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
