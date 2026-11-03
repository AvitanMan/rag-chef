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

export class KitchenCatalogChangedError extends Error {
  readonly code = "catalog_changed";
  readonly status = 409;
  constructor() { super("The approved recipe catalog changed while applying. Review a new draft before saving."); this.name = "KitchenCatalogChangedError"; }
}

class KitchenCatalogUnavailableError extends Error {
  readonly code = "catalog_migration_required";
  readonly status = 503;
  constructor() { super("Catalog consistency checks are not initialized. Apply the database migrations, then review the draft again."); this.name = "KitchenCatalogUnavailableError"; }
}

/** Capture before loading recipes; the same token is checked by the atomic kitchen write. */
export async function readCatalogRevision(): Promise<number> {
  try {
    const row = await (await kitchenDb()).prepare("SELECT revision FROM recipe_catalog_revision WHERE id=1").first<{ revision: number }>();
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new KitchenCatalogUnavailableError();
    return row.revision;
  } catch (error) {
    if (error instanceof KitchenCatalogUnavailableError || error instanceof Error && /no such table.*recipe_catalog_revision/i.test(error.message)) throw new KitchenCatalogUnavailableError();
    throw error;
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
  return documentFromRow(row);
}

export async function saveKitchenDocument(
  revision: number,
  state: KitchenState,
  context?: HouseholdContext,
  options: { assistantAction?: boolean; catalogRevision?: number } = {},
): Promise<KitchenDocument> {
  validateKitchenWrite({ revision, state });
  const household = await validateHouseholdContext(context);
  const db = await kitchenDb();
  const serialized = JSON.stringify(state);
  const updatedAt = new Date().toISOString();
  if (options.catalogRevision !== undefined && (!Number.isSafeInteger(options.catalogRevision) || options.catalogRevision < 0)) throw new KitchenCatalogChangedError();
  const catalogGuard = options.catalogRevision === undefined ? "" : " AND (SELECT revision FROM recipe_catalog_revision WHERE id=1)=?";
  const catalogBindings = options.catalogRevision === undefined ? [] : [options.catalogRevision];
  const checkCatalog = async () => {
    if (options.catalogRevision !== undefined && await readCatalogRevision() !== options.catalogRevision) throw new KitchenCatalogChangedError();
  };
  if (household.mode === "hosted") {
    const before = await getKitchenDocument(household);
    if (before.revision !== revision) throw new KitchenConflictError(before);
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
    const otherTastes = (value: KitchenState | null) => (value?.tastePreferences ?? []).filter(item => item.memberId !== household.userId).sort((a, b) => `${a.memberId}:${a.recipeId}`.localeCompare(`${b.memberId}:${b.recipeId}`));
    if (JSON.stringify(stable(otherTastes(before.state))) !== JSON.stringify(stable(otherTastes(state)))) throw new HouseholdAuthError("MEMBER_ATTRIBUTION_REQUIRED", "Each member can change only their own taste preferences.");
    if (!options.assistantAction && JSON.stringify(stable(before.state?.tastePreferences ?? [])) !== JSON.stringify(stable(state.tastePreferences ?? []))) throw new HouseholdAuthError("TASTE_FEEDBACK_PROTECTED", "Taste preferences can only change through a reviewed assistant action.");
    if (!options.assistantAction && JSON.stringify(stable(before.state?.recentActionReceipts ?? [])) !== JSON.stringify(stable(state.recentActionReceipts ?? []))) throw new HouseholdAuthError("ACTION_RECEIPT_PROTECTED", "Applied-action history can only change through a reviewed assistant action.");
    // Membership, live session, role and hard requirements are checked inside
    // the same SQL statement as the revision CAS, closing removal/change races.
    const profile = JSON.stringify(state.cookingProfile ?? DEFAULT_COOKING_PROFILE);
    const access = `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId JOIN user u ON u.id=m.userId JOIN household_settings h ON h.organizationId=m.organizationId WHERE m.organizationId=? AND m.userId=? AND m.role=? AND s.id=? AND s.expiresAt>? AND u.emailVerified=1 AND h.timezone=? AND h.assistantEnabled=?)`;
    const bindings = [household.householdId, household.userId, household.role, household.sessionId ?? "", updatedAt, household.timezone, Number(household.assistantEnabled)];
    const requirementGuard = household.role === "owner" ? "1=1" : `COALESCE(json_extract(state_json,'$.cookingProfile'),?)=json(?)`;
    const guardBindings = household.role === "owner" ? [] : [JSON.stringify(DEFAULT_COOKING_PROFILE), profile];
    const statement = revision === 0
      ? db.prepare(`INSERT INTO kitchen_state(id,state_json,revision,updated_at) SELECT ?,?,1,? WHERE ${access} AND (?='owner' OR json(?)=json(?))${catalogGuard} ON CONFLICT(id) DO NOTHING RETURNING state_json,revision,updated_at`).bind(household.householdId, serialized, updatedAt, ...bindings, household.role, profile, JSON.stringify(DEFAULT_COOKING_PROFILE), ...catalogBindings)
      : db.prepare(`UPDATE kitchen_state SET state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND ${access} AND ${requirementGuard}${catalogGuard} RETURNING state_json,revision,updated_at`).bind(serialized, updatedAt, household.householdId, revision, ...bindings, ...guardBindings, ...catalogBindings);
    const row = await statement.first<KitchenRow>();
    if (row) return documentFromRow(row);
    await validateHouseholdContext(household);
    await checkCatalog();
    const current = await getKitchenDocument(household);
    if (current.revision === revision && household.role !== "owner" && JSON.stringify(current.state?.cookingProfile ?? DEFAULT_COOKING_PROFILE) !== profile) throw new HouseholdAuthError("OWNER_REQUIRED", "Only the household owner can change shared cooking requirements.");
    throw new KitchenConflictError(current);
  }
  // Each write is one atomic statement. A preflight SELECT would lose updates
  // if two browser tabs read the same revision before writing.
  const statement = revision === 0
    ? db.prepare(
      `INSERT INTO kitchen_state (id, state_json, revision, updated_at)
       SELECT ?, ?, 1, ? WHERE 1=1${catalogGuard} ON CONFLICT(id) DO NOTHING
       RETURNING state_json, revision, updated_at`,
    ).bind(household.householdId, serialized, updatedAt, ...catalogBindings)
    : db.prepare(
      `UPDATE kitchen_state
       SET state_json = ?, revision = revision + 1, updated_at = ?
       WHERE id = ? AND revision = ?${catalogGuard}
       RETURNING state_json, revision, updated_at`,
    ).bind(serialized, updatedAt, household.householdId, revision, ...catalogBindings);
  const row = await statement.first<KitchenRow>();
  if (row) return documentFromRow(row);
  await checkCatalog();
  throw new KitchenConflictError(await getKitchenDocument(household));
}
