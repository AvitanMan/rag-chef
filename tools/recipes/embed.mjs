import { catalogOperationResult, submitCatalogOperation } from "./catalog-jobs.mjs";

const base = process.env.RECIPES_APP_URL || "http://localhost:3000";
try {
  const headers = process.env.CATALOG_ADMIN_TOKEN ? { authorization: `Bearer ${process.env.CATALOG_ADMIN_TOKEN}` } : {};
  const signal = AbortSignal.timeout(300_000);
  const response = await submitCatalogOperation(new URL("/api/admin/catalog", base), { embeddingsOnly: true }, {
    headers, signal, requestId: process.env.CATALOG_REQUEST_ID || crypto.randomUUID(),
  });
  const result = await catalogOperationResult(response, { base, headers, signal });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) { console.error(`Embedding refresh failed: ${error.message}. Approved recipes remain saved; retry this command.`); process.exitCode = 1; }
