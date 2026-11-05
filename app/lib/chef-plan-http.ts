import { listCatalogRecipes } from "./recipe-store";
import type { ChefPlanCatalog } from "./chef-plan-types";

export class PlanHttpError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export const planJson = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
export function planFailure(error: unknown): Response {
  const detail = error as { status?: number; code?: string; message?: string };
  const status = detail?.status ?? 503;
  return planJson({ error: { code: detail?.code ?? "planner_unavailable", message: detail?.status ? detail.message : "The saved kitchen or approved catalog is unavailable. Your plan has not been saved." } }, status);
}
export async function readPlanRequest(request: Request): Promise<Record<string, unknown>> {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new PlanHttpError("Cross-origin planning requests are not allowed.", "cross_origin", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") throw new PlanHttpError("Send application/json.", "invalid_content_type", 415);
  const reader = request.body?.getReader(); if (!reader) throw new PlanHttpError("A request body is required.", "invalid_request", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1_500_000) { await reader.cancel(); throw new PlanHttpError("The planning request is too large.", "request_too_large", 413); } chunks.push(part.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(); return input; }
  catch { throw new PlanHttpError("Send a valid planning request.", "invalid_request", 400); }
}
export async function loadPlanCatalog(): Promise<ChefPlanCatalog> {
  const stored = await listCatalogRecipes(1000);
  return { recipes: stored.map(row => row.recipe), metadata: Object.fromEntries(stored.flatMap(row => row.metadata ? [[row.recipe.id, row.metadata]] : [])), contentHashes: Object.fromEntries(stored.map(row => [row.recipe.id, row.contentHash])) };
}
