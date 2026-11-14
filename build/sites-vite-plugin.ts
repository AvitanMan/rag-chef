import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(): Plugin {
  let root = process.cwd();

  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== "client") return;
      // Resource Timing is not consistently exposed by WebKit. Publish the
      // complete built shell so offline startup does not depend on that API.
      const urls = Object.keys(bundle).filter(name => /^assets\/.*\.(?:js|css|woff2?)$/.test(name)).sort().map(name => `/${name}`);
      this.emitFile({ type: "asset", fileName: "kitchen-shell.json", source: JSON.stringify({ urls }) });
    },
    async closeBundle() {
      // Auxiliary Workers build concurrently and share this output directory.
      // Package application metadata once, rather than racing rm/cp operations.
      if (this.environment.name !== "rsc") return;
      const outputDirectory = resolve(root, "dist", ".openai");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }
    },
  };
}
