import { householdDb, householdSetting, initializeHouseholdRuntime } from "./household";
import { RuntimeAdmissionError, type ChefUsageContext, type ChefUsageLimits, type ModelPermit, type ModelPermitContext, type ModelPermitLimits, type ModelProvider, type RuntimeAdmissionStore } from "./runtime-admission-types";

export { RuntimeAdmissionError } from "./runtime-admission-types";
export type { ChefUsageContext, ChefUsageLimits, ModelPermit, ModelPermitContext, ModelPermitLimits, ModelProvider, RuntimeAdmissionStore } from "./runtime-admission-types";

/** Provider adapters must end their complete operation within 300 seconds. */
export const MODEL_PERMIT_LEASE_MS = 360_000;
export const MODEL_OPERATION_MAX_MS = 300_000;
const MINUTE_MS = 60_000, DAY_MS = 86_400_000;
const SQL_NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
type Settings = (name: string) => string | undefined;
type Dependencies = { db: () => Promise<D1Database>; now?: () => number; uuid?: () => string; setting?: Settings };
type PermitRow = { id: string; provider: ModelProvider; expires_at: number };
type UsageRow = { window_kind: "minute" | "day"; used: number; expires_at: number };

function invalidPolicy(): never {
  throw new RuntimeAdmissionError("runtime_policy_invalid", "Runtime admission limits are not configured correctly.", 503);
}
function positive(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) invalidPolicy();
  return value;
}
function settingLimit(setting: Settings, key: string, fallback: number | null, max: number): number | null {
  const raw = setting(key);
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw)) invalidPolicy();
  return positive(Number(raw), max);
}
function concurrencyPolicy(provider: ModelProvider, setting: Settings): ModelPermitLimits {
  if (provider !== "ollama" && provider !== "openai") invalidPolicy();
  return { concurrency: settingLimit(setting, provider === "ollama" ? "MODEL_OLLAMA_CONCURRENCY" : "MODEL_OPENAI_CONCURRENCY", provider === "ollama" ? 2 : 4, 100)! };
}
function usagePolicy(context: ChefUsageContext, setting: Settings): ChefUsageLimits {
  const hosted = context.mode === "hosted", prefix = hosted ? "CHEF_HOSTED_REQUESTS_PER_" : "CHEF_LOCAL_REQUESTS_PER_";
  return { minute: settingLimit(setting, `${prefix}MINUTE`, hosted ? 60 : null, 1_000_000), day: settingLimit(setting, `${prefix}DAY`, hosted ? 1_000 : null, 100_000_000) };
}
function usageContext(context: ChefUsageContext): void {
  if ((context.mode !== "local" && context.mode !== "hosted") || typeof context.householdId !== "string" || !context.householdId || context.householdId.length > 200 || /[\u0000-\u001f\u007f]/.test(context.householdId)) invalidPolicy();
}
function validateUsageLimits(limits: ChefUsageLimits): void {
  if (limits.minute !== null) positive(limits.minute, 1_000_000);
  if (limits.day !== null) positive(limits.day, 100_000_000);
}
async function runtimeSettings(): Promise<Settings> { await initializeHouseholdRuntime(); return householdSetting; }

export async function modelPermitLimits(provider: ModelProvider): Promise<ModelPermitLimits> {
  return concurrencyPolicy(provider, await runtimeSettings());
}
export async function chefUsageLimits(context: ChefUsageContext): Promise<ChefUsageLimits> {
  usageContext(context);
  return usagePolicy(context, await runtimeSettings());
}

/** D1 is the authority across Worker isolates; injected clocks are only for tests. */
export function createRuntimeAdmissionStore(dependencies: Dependencies): RuntimeAdmissionStore {
  const uuid = dependencies.uuid ?? (() => crypto.randomUUID());
  const settings = async () => dependencies.setting ?? await runtimeSettings();
  const clock = (): { sql: string; bindings: number[] } => {
    if (!dependencies.now) return { sql: SQL_NOW, bindings: [] };
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0) invalidPolicy();
    return { sql: "CAST(? AS INTEGER)", bindings: [now] };
  };
  return {
    async acquireModelPermit(provider: ModelProvider, context: ModelPermitContext = {}, limits?: ModelPermitLimits): Promise<ModelPermit> {
      if (provider !== "ollama" && provider !== "openai") invalidPolicy();
      const concurrency = positive((limits ?? concurrencyPolicy(provider, await settings())).concurrency, 100);
      if (context.requestId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(context.requestId)) invalidPolicy();
      const db = await dependencies.db(), id = uuid(), time = clock();
      const results = await db.batch<PermitRow>([
        db.prepare(`DELETE FROM runtime_model_permits WHERE expires_at<=${time.sql}`).bind(...time.bindings),
        db.prepare(`WITH clock AS (SELECT ${time.sql} AS now)
          INSERT INTO runtime_model_permits(id,provider,request_id,expires_at,created_at)
          SELECT ?,?,?,now+?,now FROM clock WHERE (SELECT count(*) FROM runtime_model_permits WHERE provider=? AND expires_at>clock.now)<?
          RETURNING id,provider,expires_at`).bind(...time.bindings, id, provider, context.requestId ?? null, MODEL_PERMIT_LEASE_MS, provider, concurrency),
      ]);
      const row = results[1].results[0];
      if (row) return { id: row.id, provider: row.provider, expiresAt: row.expires_at };
      const retryClock = clock();
      const wait = await db.prepare(`SELECT max(1,CAST((min(expires_at)-${retryClock.sql}+999)/1000 AS INTEGER)) AS seconds FROM runtime_model_permits WHERE provider=?`)
        .bind(...retryClock.bindings, provider).first<{ seconds: number | null }>();
      throw new RuntimeAdmissionError("service_busy", "The model service is busy. Try again shortly.", 429, Math.max(1, wait?.seconds ?? 1));
    },
    async releaseModelPermit(permit: ModelPermit): Promise<void> {
      const db = await dependencies.db();
      // A late release cannot remove a different permit admitted after expiry.
      await db.prepare("DELETE FROM runtime_model_permits WHERE id=? AND provider=? AND expires_at=?").bind(permit.id, permit.provider, permit.expiresAt).run();
    },
    async authorizeChefUsage(context: ChefUsageContext, limits?: ChefUsageLimits): Promise<void> {
      usageContext(context);
      const policy = limits ?? usagePolicy(context, await settings());
      validateUsageLimits(policy);
      if (policy.minute === null && policy.day === null) return;
      const db = await dependencies.db(), token = uuid(), time = clock();
      const scope = [context.mode, context.householdId];
      // The first statement guards both windows at one database timestamp. The
      // day counter only advances from that statement's unique attempt token.
      // This couples both counters without recording rejected requests.
      const results = await db.batch<UsageRow>([
        db.prepare(`DELETE FROM runtime_chef_usage WHERE expires_at<=${time.sql}`).bind(...time.bindings),
        db.prepare(`WITH clock AS (SELECT ${time.sql} AS now)
          INSERT INTO runtime_chef_usage(mode,household_id,window_kind,window_start,used,expires_at,attempt_token)
          SELECT ?,?,'minute',(now/${MINUTE_MS})*${MINUTE_MS},1,(now/${MINUTE_MS}+1)*${MINUTE_MS},? FROM clock
          WHERE (? IS NULL OR COALESCE((SELECT used FROM runtime_chef_usage WHERE mode=? AND household_id=? AND window_kind='minute' AND window_start=(clock.now/${MINUTE_MS})*${MINUTE_MS}),0)<?)
            AND (? IS NULL OR COALESCE((SELECT used FROM runtime_chef_usage WHERE mode=? AND household_id=? AND window_kind='day' AND window_start=(clock.now/${DAY_MS})*${DAY_MS}),0)<?)
          ON CONFLICT(mode,household_id,window_kind,window_start) DO UPDATE SET used=used+1,attempt_token=excluded.attempt_token`)
          .bind(...time.bindings, ...scope, token, policy.minute, ...scope, policy.minute, policy.day, ...scope, policy.day),
        db.prepare(`INSERT INTO runtime_chef_usage(mode,household_id,window_kind,window_start,used,expires_at,attempt_token)
          SELECT mode,household_id,'day',(window_start/${DAY_MS})*${DAY_MS},1,(window_start/${DAY_MS}+1)*${DAY_MS},attempt_token
          FROM runtime_chef_usage WHERE mode=? AND household_id=? AND window_kind='minute' AND attempt_token=?
          ON CONFLICT(mode,household_id,window_kind,window_start) DO UPDATE SET used=used+1,attempt_token=excluded.attempt_token`)
          .bind(...scope, token),
        db.prepare("SELECT window_kind,used,expires_at FROM runtime_chef_usage WHERE mode=? AND household_id=? AND attempt_token=? ORDER BY window_kind")
          .bind(...scope, token),
      ]);
      if (results[3].results.length === 2) return;
      const retryClock = clock();
      const rows = await db.prepare(`SELECT window_kind,used,max(1,CAST((expires_at-${retryClock.sql}+999)/1000 AS INTEGER)) AS seconds FROM runtime_chef_usage WHERE mode=? AND household_id=?`)
        .bind(...retryClock.bindings, ...scope).all<{ window_kind: "minute" | "day"; used: number; seconds: number }>();
      const retry = Math.max(1, ...rows.results.filter(row => policy[row.window_kind] !== null && row.used >= policy[row.window_kind]!).map(row => row.seconds));
      throw new RuntimeAdmissionError("usage_limit_exceeded", "This household has reached its Chef request limit. Try again later.", 429, retry);
    },
  };
}

const admission = createRuntimeAdmissionStore({ db: householdDb });
export const acquireModelPermit = admission.acquireModelPermit;
export const releaseModelPermit = admission.releaseModelPermit;
/** Call only after validating the live, server-derived household context. */
export const authorizeChefUsage = admission.authorizeChefUsage;
