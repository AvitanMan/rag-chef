import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/api/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/kitchen-store", "**/recipe-store"],
          message: "HTTP routes use the Kitchen or Catalog service; persistence belongs behind its repository port.",
        }],
      }],
    },
  },
  {
    files: ["app/api/chef/route.ts", "app/api/health/route.ts", "app/lib/chef-client.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/chef-service", "**/chef-provider", "**/chef-health", "**/chef-verification", "**/provider-readiness", "**/kitchen-store", "**/recipe-store"],
          message: "Chef orchestration and model I/O belong to the private Chef Worker; gateway routes use chef-client.",
        }],
      }],
    },
  },
  {
    files: ["app/lib/kitchen-commands.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["react", "react/**", "node:*", "cloudflare:*", "**/*-store", "**/household", "**/auth"],
          message: "Kitchen commands are shared pure domain logic. Pass identity, dates and permissions through the command/context.",
        }],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "dist/**",
    ".wrangler/**",
    ".venv-recipes/**",
    "work/**",
    "output/**",
    "outputs/**",
    "recipe-runs/**",
    "cloudflare-env.d.ts",
  ]),
]);

export default eslintConfig;
