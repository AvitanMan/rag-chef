import type { HouseholdContext } from "./household";

export type ModelProvider = "ollama" | "openai";
export type ModelPermit = { id: string; provider: ModelProvider; expiresAt: number };
export type ModelPermitContext = { requestId?: string };
export type ModelPermitLimits = { concurrency: number };
export type ChefUsageContext = Pick<HouseholdContext, "mode" | "householdId">;
/** Null disables that window; hosted runtime defaults always enable both. */
export type ChefUsageLimits = { minute: number | null; day: number | null };

export interface RuntimeAdmissionStore {
  acquireModelPermit(provider: ModelProvider, context?: ModelPermitContext, limits?: ModelPermitLimits): Promise<ModelPermit>;
  releaseModelPermit(permit: ModelPermit): Promise<void>;
  authorizeChefUsage(context: ChefUsageContext, limits?: ChefUsageLimits): Promise<void>;
}

export class RuntimeAdmissionError extends Error {
  constructor(
    readonly code: "service_busy" | "usage_limit_exceeded" | "runtime_policy_invalid",
    message: string,
    readonly status: 429 | 503,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "RuntimeAdmissionError";
  }
}
