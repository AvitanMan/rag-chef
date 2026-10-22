import type { KitchenState } from "./kitchen-types";
import { KitchenValidationError, MAX_KITCHEN_BODY_BYTES, validateKitchenWrite } from "./kitchen-validation";

export interface KitchenBackup {
  backupVersion: 1;
  exportedAt: string;
  state: KitchenState;
}

export function parseKitchenBackup(text: string): KitchenBackup {
  if (new TextEncoder().encode(text).byteLength > MAX_KITCHEN_BODY_BYTES) {
    throw new KitchenValidationError("The backup exceeds the kitchen storage limit.");
  }
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { throw new KitchenValidationError("The backup must contain valid JSON."); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new KitchenValidationError("Choose a kitchen backup file.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["backupVersion", "exportedAt", "state"].includes(key)) || (value.backupVersion !== undefined && value.backupVersion !== 1)) {
    throw new KitchenValidationError("This backup format is not supported.");
  }
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt)) || new Date(value.exportedAt).toISOString() !== value.exportedAt) {
    throw new KitchenValidationError("The backup has an invalid export date.");
  }
  validateKitchenWrite({ revision: 0, state: value.state });
  return { backupVersion: 1, exportedAt: value.exportedAt, state: structuredClone(value.state as KitchenState) };
}

export function serializeKitchenBackup(state: KitchenState, exportedAt = new Date().toISOString()): string {
  validateKitchenWrite({ revision: 0, state });
  const text = JSON.stringify({ backupVersion: 1, exportedAt, state }, null, 2);
  // Do not produce a file that the restore flow cannot read.
  parseKitchenBackup(text);
  return text;
}
