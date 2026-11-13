import type { KitchenDocument, KitchenState } from "./kitchen-types";
import { validateKitchenState, validateKitchenWrite } from "./kitchen-validation";
import { DEFAULT_COOKING_PROFILE } from "./kitchen-types";
import { householdDb, HouseholdAuthError, validateHouseholdContext, type HouseholdContext } from "./household";
export { KitchenValidationError, MAX_KITCHEN_BODY_BYTES, validateKitchenState, validateKitchenWrite, validateRecipeSnapshot } from "./kitchen-validation";

type KitchenRow = { state_json: string; revision: number; updated_at: string };

export class KitchenConflictError extends Error {
  constructor(public readonly current: KitchenDocument) {
    super("The kitchen changed in another tab. Reload the latest saved kitchen.");
    this.name = "KitchenConflictError";
  }
}

async function kitchenDb(): Promise<D1Database> {
  return householdDb();
}

function documentFromRow(row: KitchenRow | null): KitchenDocument {
  if (!row) return { revision: 0, state: null, updatedAt: null };
  const state: unknown = JSON.parse(row.state_json);
  validateKitchenState(state);
  return { revision: row.revision, state, updatedAt: row.updated_at };
}

export async function getKitchenDocument(context?: HouseholdContext): Promise<KitchenDocument> {
  const household = await validateHouseholdContext(context);
  const db = await kitchenDb();
  const row = await db.prepare(
    "SELECT state_json, revision, updated_at FROM kitchen_state WHERE id = ?",
  ).bind(household.householdId).first<KitchenRow>();
  // Access can change after the preflight while the document read is in flight.
  // Do not return shared state to a removed member or revoked session.
  if (household.mode === "hosted") await validateHouseholdContext(household);
  return documentFromRow(row);
}

export async function saveKitchenDocument(
  revision: number,
  state: KitchenState,
  context?: HouseholdContext,
): Promise<KitchenDocument> {
  validateKitchenWrite({ revision, state });
  const household = await validateHouseholdContext(context);
  const db = await kitchenDb();
  const serialized = JSON.stringify(state);
  const updatedAt = new Date().toISOString();
  if (household.mode === "hosted") {
    // Membership, live session, role and shared requirements are checked inside
    // the same SQL statement as the revision CAS, closing removal/change races.
    const profile = JSON.stringify(state.cookingProfile ?? DEFAULT_COOKING_PROFILE);
    const access = `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId JOIN user u ON u.id=m.userId JOIN household_settings h ON h.organizationId=m.organizationId WHERE m.organizationId=? AND m.userId=? AND m.role=? AND s.id=? AND s.expiresAt>? AND u.emailVerified=1 AND h.timezone=? AND h.assistantEnabled=?)`;
    const bindings = [household.householdId, household.userId, household.role, household.sessionId ?? "", updatedAt, household.timezone, Number(household.assistantEnabled)];
    const requirementGuard = household.role === "owner" ? "1=1" : `COALESCE(json_extract(state_json,'$.cookingProfile'),?)=json(?)`;
    const guardBindings = household.role === "owner" ? [] : [JSON.stringify(DEFAULT_COOKING_PROFILE), profile];
    const statement = revision === 0
      ? db.prepare(`INSERT INTO kitchen_state(id,state_json,revision,updated_at) SELECT ?,?,1,? WHERE ${access} AND (?='owner' OR json(?)=json(?)) ON CONFLICT(id) DO NOTHING RETURNING state_json,revision,updated_at`).bind(household.householdId, serialized, updatedAt, ...bindings, household.role, profile, JSON.stringify(DEFAULT_COOKING_PROFILE))
      : db.prepare(`UPDATE kitchen_state SET state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND ${access} AND ${requirementGuard} RETURNING state_json,revision,updated_at`).bind(serialized, updatedAt, household.householdId, revision, ...bindings, ...guardBindings);
    const row = await statement.first<KitchenRow>();
    if (row) return documentFromRow(row);
    await validateHouseholdContext(household);
    const current = await getKitchenDocument(household);
    if (current.revision === revision && household.role !== "owner" && JSON.stringify(current.state?.cookingProfile ?? DEFAULT_COOKING_PROFILE) !== profile) throw new HouseholdAuthError("OWNER_REQUIRED", "Only the household owner can change shared cooking requirements.");
    throw new KitchenConflictError(current);
  }
  // Each write is one atomic statement. A preflight SELECT would lose updates
  // if two browser tabs read the same revision before writing.
  const statement = revision === 0
    ? db.prepare(
      `INSERT INTO kitchen_state (id, state_json, revision, updated_at)
       VALUES (?, ?, 1, ?) ON CONFLICT(id) DO NOTHING
       RETURNING state_json, revision, updated_at`,
    ).bind(household.householdId, serialized, updatedAt)
    : db.prepare(
      `UPDATE kitchen_state
       SET state_json = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?
       RETURNING state_json, revision, updated_at`,
    ).bind(serialized, updatedAt, household.householdId, revision);
  const row = await statement.first<KitchenRow>();
  if (row) return documentFromRow(row);
  throw new KitchenConflictError(await getKitchenDocument(household));
}
