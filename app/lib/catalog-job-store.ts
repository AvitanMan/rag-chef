import { householdDb, householdSetting, hostedMode, initializeHouseholdRuntime } from "./household";
import type { CatalogJob, CatalogJobActorMode, CatalogJobEnqueue, CatalogJobError, CatalogJobFence, CatalogJobInput, CatalogJobLease, CatalogJobProgress, CatalogJobSqlGuard, CatalogJobStatus } from "./catalog-job-types";

export const CATALOG_JOB_LEASE_MS = 120_000;
export const CATALOG_JOB_MAX_ATTEMPTS = 3;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_RESULT_BYTES = 2_000_000;

type JobRow = {
  id: string; actor_id: string; actor_mode: CatalogJobActorMode; request_id: string;
  kind: CatalogJobInput["kind"]; request_hash: string; payload_json: string;
  status: CatalogJobStatus; attempts: number; max_attempts: number; available_at: number;
  lease_token: string | null; lease_version: number; lease_until: number | null;
  progress_json: string | null; result_json: string | null; error_code: string | null; error_message: string | null;
  created_at: number; updated_at: number; started_at: number | null; finished_at: number | null;
};
export interface CatalogJobAccess { mode: CatalogJobActorMode; adminEmails: string[] }
export interface CatalogJobStoreOptions {
  db: () => Promise<D1Database>;
  now?: () => number;
  uuid?: () => string;
  access?: () => Promise<CatalogJobAccess>;
}

export class CatalogJobRequestError extends Error {
  readonly status = 400;
  readonly code = "INVALID_CATALOG_JOB";
  constructor(message: string) { super(message); this.name = "CatalogJobRequestError"; }
}
export class CatalogJobReuseError extends Error {
  readonly status = 409;
  readonly code = "CATALOG_REQUEST_ID_REUSED";
  constructor() { super("This request ID was already used for a different catalog job."); this.name = "CatalogJobReuseError"; }
}
export class CatalogJobAccessError extends Error {
  readonly status = 403;
  readonly code = "ADMIN_ACCESS_CHANGED";
  constructor() { super("Catalog administrator access changed. Sign in again before continuing."); this.name = "CatalogJobAccessError"; }
}
export class CatalogJobLeaseLostError extends Error {
  readonly status = 409;
  readonly code = "CATALOG_JOB_LEASE_LOST";
  constructor() { super("This catalog job attempt no longer owns its lease."); this.name = "CatalogJobLeaseLostError"; }
}

async function runtimeAccess(): Promise<CatalogJobAccess> {
  await initializeHouseholdRuntime();
  return { mode: hostedMode() ? "hosted" : "local", adminEmails: householdSetting("PLATFORM_ADMIN_EMAILS").split(",").map(email => email.trim().toLowerCase()).filter(Boolean) };
}

function actorGuard(access: CatalogJobAccess, alias: "catalog_jobs" | "actor"): CatalogJobSqlGuard {
  if (access.mode === "local") return { sql: `${alias}.actor_mode='local'`, bindings: [] };
  return {
    sql: `${alias}.actor_mode='hosted' AND EXISTS(SELECT 1 FROM user admin WHERE admin.id=${alias}.actor_id AND admin.emailVerified=1 AND lower(admin.email) IN (SELECT value FROM json_each(?)))`,
    bindings: [JSON.stringify(access.adminEmails)],
  };
}

function publicJob(row: JobRow): CatalogJob {
  return {
    id: row.id, kind: row.kind, status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts,
    availableAt: row.available_at, leaseUntil: row.lease_until,
    progress: row.progress_json ? JSON.parse(row.progress_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? "Catalog job failed." } : null,
    createdAt: row.created_at, updatedAt: row.updated_at, startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

function json(value: unknown, maximum: number): string {
  let serialized: string;
  try { serialized = JSON.stringify(value ?? null); }
  catch { throw new CatalogJobRequestError("Catalog job data must be serializable JSON."); }
  if (new TextEncoder().encode(serialized).byteLength > maximum) throw new CatalogJobRequestError("Catalog job data is too large.");
  return serialized;
}
function identifier(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new CatalogJobRequestError("A valid catalog request identity is required.");
}
function progressJson(progress?: CatalogJobProgress): string | null {
  if (progress === undefined) return null;
  if (!progress || typeof progress.phase !== "string" || !progress.phase.trim() || progress.phase.length > 100
    || Object.keys(progress).some(key => !["phase", "completed", "total"].includes(key))
    || [progress.completed, progress.total].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
    throw new CatalogJobRequestError("Invalid catalog job progress.");
  }
  return json(progress, 1_000);
}
async function inputHash(input: CatalogJobInput): Promise<string> {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
    return value;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(input))));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Injectable clock/database keep lease and crash recovery tests deterministic. */
export function createCatalogJobStore(options: CatalogJobStoreOptions) {
  const clock = options.now ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const access = options.access ?? runtimeAccess;

  async function writeGuard(fence: CatalogJobFence): Promise<CatalogJobSqlGuard> {
    const actor = actorGuard(await access(), "catalog_jobs");
    // Production expiry is evaluated when SQL executes, even if the database
    // request waited in transit. A supplied test clock remains deterministic.
    const nowSql = options.now ? "?" : "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
    return {
      sql: `EXISTS(SELECT 1 FROM catalog_jobs WHERE id=? AND lease_token=? AND lease_version=? AND status='running' AND lease_until>${nowSql} AND ${actor.sql})`,
      bindings: [fence.jobId, fence.leaseToken, fence.leaseVersion, ...(options.now ? [clock()] : []), ...actor.bindings],
    };
  }

  function revokeStatement(db: D1Database, scope: CatalogJobAccess, now: number, jobId?: string): D1PreparedStatement {
    const actor = actorGuard(scope, "catalog_jobs");
    return db.prepare(`UPDATE catalog_jobs SET status='failed',error_code='ADMIN_ACCESS_CHANGED',error_message='Catalog administrator access changed.',lease_token=NULL,lease_until=NULL,updated_at=?,finished_at=?
      WHERE status IN ('queued','running') AND NOT (${actor.sql}) ${jobId ? "AND id=?" : ""}`)
      .bind(now, now, ...actor.bindings, ...(jobId ? [jobId] : []));
  }

  async function lostLease(db: D1Database, fence: CatalogJobFence): Promise<never> {
    await revokeStatement(db, await access(), clock(), fence.jobId).run();
    throw new CatalogJobLeaseLostError();
  }

  return {
    writeGuard,
    async enqueue(input: CatalogJobEnqueue): Promise<{ job: CatalogJob; replayed: boolean }> {
      identifier(input.actorId); identifier(input.requestId);
      if (!["local", "hosted"].includes(input.actorMode) || !input.input || !["demo", "sync", "embeddings", "import"].includes(input.input.kind)) throw new CatalogJobRequestError("Invalid catalog job kind or actor mode.");
      const payload = json(input.input, MAX_INPUT_BYTES);
      const normalized: CatalogJobInput = JSON.parse(payload);
      if (normalized.kind === "import"
        ? !Array.isArray(normalized.recipes) || normalized.recipes.length < 1 || normalized.recipes.length > 20
          || normalized.retryEmbeddingsOnly !== undefined && typeof normalized.retryEmbeddingsOnly !== "boolean"
          || Object.keys(normalized).some(key => !["kind", "recipes", "retryEmbeddingsOnly"].includes(key))
        : Object.keys(normalized).some(key => key !== "kind")) throw new CatalogJobRequestError("Invalid catalog job input.");
      const { actorId, actorMode, requestId } = input;
      const hash = await inputHash(normalized);
      const db = await options.db(), now = clock(), scope = await access();
      const actor = actorGuard(scope, "actor");
      const inserted = await db.prepare(`INSERT INTO catalog_jobs(id,actor_id,actor_mode,request_id,kind,request_hash,payload_json,status,attempts,max_attempts,available_at,lease_version,created_at,updated_at)
        SELECT ?,actor.actor_id,actor.actor_mode,?,?,?,?,'queued',0,?, ?,0,?,? FROM (SELECT ? AS actor_id,? AS actor_mode) actor WHERE ${actor.sql}
        ON CONFLICT(actor_mode,actor_id,request_id) DO NOTHING RETURNING *`)
        .bind(uuid(), requestId, normalized.kind, hash, payload, CATALOG_JOB_MAX_ATTEMPTS, now, now, now, actorId, actorMode, ...actor.bindings).first<JobRow>();
      if (inserted) return { job: publicJob(inserted), replayed: false };
      const permitted = actorGuard(scope, "catalog_jobs");
      const previous = await db.prepare(`SELECT * FROM catalog_jobs WHERE actor_id=? AND actor_mode=? AND request_id=? AND ${permitted.sql}`)
        .bind(actorId, actorMode, requestId, ...permitted.bindings).first<JobRow>();
      if (!previous) throw new CatalogJobAccessError();
      if (previous.request_hash !== hash) throw new CatalogJobReuseError();
      return { job: publicJob(previous), replayed: true };
    },
    async get(jobId: string, actorId: string, actorMode: CatalogJobActorMode): Promise<CatalogJob | null> {
      const actor = actorGuard(await access(), "catalog_jobs");
      const row = await (await options.db()).prepare(`SELECT * FROM catalog_jobs WHERE id=? AND actor_id=? AND actor_mode=? AND ${actor.sql}`)
        .bind(jobId, actorId, actorMode, ...actor.bindings).first<JobRow>();
      return row ? publicJob(row) : null;
    },
    async claim(jobId?: string): Promise<CatalogJobLease | null> {
      const db = await options.db(), now = clock(), scope = await access();
      const actor = actorGuard(scope, "catalog_jobs");
      const token = uuid();
      const results = await db.batch<JobRow>([
        revokeStatement(db, scope, now),
        db.prepare(`UPDATE catalog_jobs SET status='failed',error_code='ATTEMPTS_EXHAUSTED',error_message='The catalog job exhausted its retry attempts.',lease_token=NULL,lease_until=NULL,updated_at=?,finished_at=?
          WHERE attempts>=max_attempts AND ((status='running' AND lease_until<=?) OR (status='queued' AND available_at<=?))`).bind(now, now, now, now),
        db.prepare(`UPDATE catalog_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_version=lease_version+1,lease_until=?,updated_at=?,started_at=COALESCE(started_at,?)
          WHERE id=(SELECT id FROM catalog_jobs WHERE attempts<max_attempts AND ((status='queued' AND available_at<=?) OR (status='running' AND lease_until<=?))
          AND ${actor.sql} ${jobId ? "AND id=?" : ""} ORDER BY available_at,created_at,id LIMIT 1) RETURNING *`)
          .bind(token, now + CATALOG_JOB_LEASE_MS, now, now, now, now, ...actor.bindings, ...(jobId ? [jobId] : [])),
      ]);
      const row = results[2].results[0];
      return row ? { ...publicJob(row), input: JSON.parse(row.payload_json), fence: { jobId: row.id, leaseToken: token, leaseVersion: row.lease_version } } : null;
    },
    async heartbeat(fence: CatalogJobFence, progress?: CatalogJobProgress): Promise<void> {
      const serialized = progressJson(progress);
      const db = await options.db(), now = clock(), guard = await writeGuard(fence);
      const row = await db.prepare(`UPDATE catalog_jobs SET lease_until=?,progress_json=COALESCE(?,progress_json),updated_at=? WHERE id=? AND ${guard.sql} RETURNING id`)
        .bind(now + CATALOG_JOB_LEASE_MS, serialized, now, fence.jobId, ...guard.bindings).first<{ id: string }>();
      if (!row) await lostLease(db, fence);
    },
    async complete(fence: CatalogJobFence, result: unknown): Promise<CatalogJob> {
      const serialized = json(result, MAX_RESULT_BYTES);
      const db = await options.db(), now = clock(), guard = await writeGuard(fence);
      const row = await db.prepare(`UPDATE catalog_jobs SET status='succeeded',result_json=?,error_code=NULL,error_message=NULL,lease_token=NULL,lease_until=NULL,updated_at=?,finished_at=? WHERE id=? AND ${guard.sql} RETURNING *`)
        .bind(serialized, now, now, fence.jobId, ...guard.bindings).first<JobRow>();
      if (!row) return lostLease(db, fence);
      return publicJob(row);
    },
    async fail(fence: CatalogJobFence, error: CatalogJobError | Error | string, retryable = false, retryDelayMs = 0): Promise<CatalogJob> {
      if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 86_400_000) throw new CatalogJobRequestError("Invalid catalog retry delay.");
      const code = typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.slice(0, 100) : "CATALOG_JOB_FAILED";
      const message = (typeof error === "string" ? error : error.message || "Catalog job failed.").slice(0, 500);
      const db = await options.db(), now = clock(), guard = await writeGuard(fence);
      const row = await db.prepare(`UPDATE catalog_jobs SET status=CASE WHEN ?=1 AND attempts<max_attempts THEN 'queued' ELSE 'failed' END,
        available_at=CASE WHEN ?=1 AND attempts<max_attempts THEN ?+max(?,CASE attempts WHEN 1 THEN 5000 ELSE 10000 END) ELSE available_at END,
        error_code=?,error_message=?,lease_token=NULL,lease_until=NULL,updated_at=?,finished_at=CASE WHEN ?=1 AND attempts<max_attempts THEN NULL ELSE ? END
        WHERE id=? AND ${guard.sql} RETURNING *`)
        .bind(Number(retryable), Number(retryable), now, Math.ceil(retryDelayMs), code, message, now, Number(retryable), now, fence.jobId, ...guard.bindings).first<JobRow>();
      if (!row) return lostLease(db, fence);
      return publicJob(row);
    },
  };
}

const catalogJobs = createCatalogJobStore({ db: householdDb });
export const enqueueCatalogJob = catalogJobs.enqueue;
export const getCatalogJob = catalogJobs.get;
export const claimCatalogJob = catalogJobs.claim;
export const heartbeatCatalogJob = catalogJobs.heartbeat;
export const completeCatalogJob = catalogJobs.complete;
export const failCatalogJob = catalogJobs.fail;
export const catalogJobWriteGuard = catalogJobs.writeGuard;
