export type CatalogJobInput =
  | { kind: "demo" }
  | { kind: "sync" }
  | { kind: "embeddings" }
  | { kind: "import"; recipes: unknown[]; retryEmbeddingsOnly?: boolean };

export type CatalogJobStatus = "queued" | "running" | "succeeded" | "failed";
export type CatalogJobActorMode = "local" | "hosted";
export interface CatalogJobProgress { phase: string; completed?: number; total?: number }
export interface CatalogJobError { code: string; message: string }

/** Public status deliberately omits the submitted recipes and internal lease. */
export interface CatalogJob {
  id: string;
  kind: CatalogJobInput["kind"];
  status: CatalogJobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseUntil: number | null;
  progress: CatalogJobProgress | null;
  result: unknown;
  error: CatalogJobError | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface CatalogJobFence { jobId: string; leaseToken: string; leaseVersion: number }
export interface CatalogJobLease extends CatalogJob { input: CatalogJobInput; fence: CatalogJobFence }
export interface CatalogJobEnqueue {
  actorId: string;
  actorMode: CatalogJobActorMode;
  requestId: string;
  input: CatalogJobInput;
}
export interface CatalogJobSqlGuard { sql: string; bindings: (string | number)[] }
