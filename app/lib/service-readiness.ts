import { catalogReadScope } from "./catalog-read-service";
import { householdDb, householdSetting, initializeHouseholdRuntime } from "./household";
import { chefUsageLimits, modelPermitLimits } from "./runtime-admission";
import { serviceResponseHeaders, type ServiceName } from "./service-observability";

export const SERVICE_SCHEMA_VERSION = 9;
/** Private/operator readiness checks inspect schema and policy, never providers. */
export async function serviceReadiness(service: ServiceName, bindings?: object): Promise<Response> {
  await initializeHouseholdRuntime();
  const headers = { ...serviceResponseHeaders(), "Cache-Control": "no-store" };
  try {
    const env = (bindings ?? (await import("cloudflare:workers")).env) as Record<string, { fetch?: unknown; send?: unknown } | undefined>;
    const requiredServices = service === "gateway" ? ["CHEF", "CATALOG"] : service === "chef" ? ["CATALOG"] : [];
    if (requiredServices.some(name => typeof env[name]?.fetch !== "function")
      || service !== "chef" && typeof env.CATALOG_TASKS?.send !== "function") throw new Error("Missing service or queue binding");
    const db = await householdDb();
    const checks = service === "catalog"
      ? ["SELECT id,approval_status FROM recipe_sources LIMIT 0", "SELECT id,version FROM recipes LIMIT 0", "SELECT id,lease_token FROM catalog_jobs LIMIT 0"]
      : ["SELECT id,revision FROM kitchen_state LIMIT 0", "SELECT household_id,command_id FROM kitchen_command_receipt LIMIT 0", "SELECT id,expiresAt FROM session LIMIT 0"];
    await db.batch(checks.concat([
      "SELECT id,provider,expires_at FROM runtime_model_permits LIMIT 0",
      "SELECT household_id,window_kind,used FROM runtime_chef_usage LIMIT 0",
      "SELECT job_id,catalog_id,request_hash,content_hash,recipe_version,result_json FROM catalog_job_recipe_receipts LIMIT 0",
    ]).map(sql => db.prepare(sql)));
    const scope = catalogReadScope();
    const limits = { ollama: (await modelPermitLimits("ollama")).concurrency, openai: (await modelPermitLimits("openai")).concurrency,
      chef: await chefUsageLimits({ mode: scope.hosted ? "hosted" : "local", householdId: "readiness" }) };
    const release = householdSetting("SERVICE_RELEASE");
    if (scope.hosted && !release || release && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(release)) throw new Error("Invalid release label");
    return Response.json({ ok: true, service, protocol: 1, controls: 1, schema: SERVICE_SCHEMA_VERSION, release: release || "development", scope, limits }, { headers });
  } catch {
    return Response.json({ ok: false, service, protocol: 1, controls: 1, schema: SERVICE_SCHEMA_VERSION, error: { code: "service_not_ready", message: "Apply the required migrations and check this service's runtime settings." } }, { status: 503, headers });
  }
}
