import type { KitchenDocument, KitchenState } from "./kitchen-types";
import { validateKitchenState, validateKitchenWrite } from "./kitchen-validation";
export { KitchenValidationError, MAX_KITCHEN_BODY_BYTES, validateKitchenState, validateKitchenWrite, validateRecipeSnapshot } from "./kitchen-validation";

// Deliberately one personal household; there is no implied account isolation.
const HOUSEHOLD_ID = "local-household";
type KitchenRow = { state_json: string; revision: number; updated_at: string };

export class KitchenConflictError extends Error {
  constructor(public readonly current: KitchenDocument) {
    super("The kitchen changed in another tab. Reload the latest saved kitchen.");
    this.name = "KitchenConflictError";
  }
}

async function kitchenDb(): Promise<D1Database> {
  // Keep the Worker-only module out of Node's static rendering environment.
  const runtime = await import("cloudflare:workers");
  const binding = (runtime.env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("The kitchen D1 binding is unavailable.");
  return binding;
}

function documentFromRow(row: KitchenRow | null): KitchenDocument {
  if (!row) return { revision: 0, state: null, updatedAt: null };
  const state: unknown = JSON.parse(row.state_json);
  validateKitchenState(state);
  return { revision: row.revision, state, updatedAt: row.updated_at };
}

export async function getKitchenDocument(): Promise<KitchenDocument> {
  const db = await kitchenDb();
  const row = await db.prepare(
    "SELECT state_json, revision, updated_at FROM kitchen_state WHERE id = ?",
  ).bind(HOUSEHOLD_ID).first<KitchenRow>();
  return documentFromRow(row);
}

export async function saveKitchenDocument(
  revision: number,
  state: KitchenState,
): Promise<KitchenDocument> {
  validateKitchenWrite({ revision, state });
  const db = await kitchenDb();
  const serialized = JSON.stringify(state);
  const updatedAt = new Date().toISOString();
  // Each write is one atomic statement. A preflight SELECT would lose updates
  // if two browser tabs read the same revision before writing.
  const statement = revision === 0
    ? db.prepare(
      `INSERT INTO kitchen_state (id, state_json, revision, updated_at)
       VALUES (?, ?, 1, ?) ON CONFLICT(id) DO NOTHING
       RETURNING state_json, revision, updated_at`,
    ).bind(HOUSEHOLD_ID, serialized, updatedAt)
    : db.prepare(
      `UPDATE kitchen_state
       SET state_json = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?
       RETURNING state_json, revision, updated_at`,
    ).bind(serialized, updatedAt, HOUSEHOLD_ID, revision);
  const row = await statement.first<KitchenRow>();
  if (row) return documentFromRow(row);
  throw new KitchenConflictError(await getKitchenDocument());
}
