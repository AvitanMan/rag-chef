import type { KitchenCommandCommit, KitchenCommandResult } from "./kitchen-command-types";
import { DEFAULT_COOKING_PROFILE, type KitchenDocument } from "./kitchen-types";
import { validateKitchenState, validateKitchenWrite } from "./kitchen-validation";
import { getKitchenDocument, KitchenConflictError } from "./kitchen-store";
import { householdDb, HouseholdAuthError, validateHouseholdContext, type HouseholdContext } from "./household";

type ReceiptRow = { request_hash: string; document_json: string; applied: number; attempt_token: string };
type SqlGuard = { sql: string; bindings: (string | number)[] };

export class KitchenCommandReuseError extends Error {
  readonly status = 409;
  readonly code = "COMMAND_ID_REUSED";
  constructor() {
    super("This command ID was already used for a different request. Refresh before continuing.");
    this.name = "KitchenCommandReuseError";
  }
}

function accessGuard(household: HouseholdContext, now: string): SqlGuard {
  if (household.mode === "local") return { sql: "1=1", bindings: [] };
  return {
    sql: `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId JOIN user u ON u.id=m.userId JOIN household_settings h ON h.organizationId=m.organizationId WHERE m.organizationId=? AND m.userId=? AND m.role=? AND s.id=? AND s.expiresAt>? AND u.emailVerified=1 AND h.timezone=? AND h.assistantEnabled=?)`,
    bindings: [household.householdId, household.userId, household.role, household.sessionId ?? "", now, household.timezone, Number(household.assistantEnabled)],
  };
}

function receiptQuery(db: D1Database, household: HouseholdContext, commandId: string, now: string): D1PreparedStatement {
  const access = accessGuard(household, now);
  return db.prepare(`SELECT request_hash,document_json,applied,attempt_token FROM kitchen_command_receipt WHERE household_id=? AND actor_id=? AND command_id=? AND ${access.sql}`)
    .bind(household.householdId, household.userId, commandId, ...access.bindings);
}

function resultFromRow(commandId: string, requestHash: string, row: ReceiptRow, attemptToken?: string): KitchenCommandResult {
  if (row.request_hash !== requestHash) throw new KitchenCommandReuseError();
  const document: KitchenDocument = JSON.parse(row.document_json);
  if (!document || !Number.isSafeInteger(document.revision) || document.revision < 0
    || (document.state === null ? document.revision !== 0 || document.updatedAt !== null : typeof document.updatedAt !== "string")) {
    throw new Error("The saved command receipt is invalid.");
  }
  if (document.state !== null) validateKitchenState(document.state);
  return { commandId, applied: Boolean(row.applied), document, replayed: row.attempt_token !== attemptToken };
}

/** A receipt is visible only to its original actor with current household access. */
export async function findKitchenCommand(commandId: string, requestHash: string, context?: HouseholdContext): Promise<KitchenCommandResult | null> {
  const household = await validateHouseholdContext(context);
  const db = await householdDb();
  const row = await receiptQuery(db, household, commandId, new Date().toISOString()).first<ReceiptRow>();
  if (row) return resultFromRow(commandId, requestHash, row);
  // A revoked session must not look like an unused command after the preflight.
  await validateHouseholdContext(household);
  return null;
}

/**
 * D1 batches are transactions. The receipt's fresh attempt token couples its
 * insertion to this batch's mutation, so a duplicate cannot write a second time.
 * A no-op also claims its command ID only while the original revision is current.
 */
export async function commitKitchenCommand(input: KitchenCommandCommit, context?: HouseholdContext): Promise<KitchenCommandResult> {
  const { commandId, requestHash, current, state, applied } = input;
  validateKitchenWrite({ revision: current.revision, state });
  const household = await validateHouseholdContext(context);
  const db = await householdDb();
  const updatedAt = new Date().toISOString();
  const attemptToken = crypto.randomUUID();
  const document: KitchenDocument = applied
    ? { revision: current.revision + 1, state, updatedAt }
    : current;
  const access = accessGuard(household, updatedAt);
  const revisionGuard = current.revision === 0
    ? "NOT EXISTS(SELECT 1 FROM kitchen_state WHERE id=?)"
    : "EXISTS(SELECT 1 FROM kitchen_state WHERE id=? AND revision=?)";
  const revisionBindings = current.revision === 0 ? [household.householdId] : [household.householdId, current.revision];
  const profile = JSON.stringify(state.cookingProfile ?? DEFAULT_COOKING_PROFILE);
  const requirements: SqlGuard = household.mode === "hosted" && household.role !== "owner"
    ? {
      sql: "COALESCE((SELECT json_extract(state_json,'$.cookingProfile') FROM kitchen_state WHERE id=?),?)=json(?)",
      bindings: [household.householdId, JSON.stringify(DEFAULT_COOKING_PROFILE), profile],
    }
    : { sql: "1=1", bindings: [] };
  const insertReceipt = db.prepare(`INSERT INTO kitchen_command_receipt(household_id,actor_id,command_id,request_hash,document_json,applied,attempt_token,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${revisionGuard} AND ${access.sql} AND ${requirements.sql}
    ON CONFLICT(household_id,actor_id,command_id) DO NOTHING`)
    .bind(household.householdId, household.userId, commandId, requestHash, JSON.stringify(document), Number(applied), attemptToken, updatedAt,
      ...revisionBindings, ...access.bindings, ...requirements.bindings);
  const claimed = "EXISTS(SELECT 1 FROM kitchen_command_receipt WHERE household_id=? AND actor_id=? AND command_id=? AND attempt_token=?)";
  const claimBindings = [household.householdId, household.userId, commandId, attemptToken];
  const writeKitchen = current.revision === 0
    ? db.prepare(`INSERT INTO kitchen_state(id,state_json,revision,updated_at) SELECT ?,?,1,? WHERE ?=1 AND ${claimed}`)
      .bind(household.householdId, JSON.stringify(state), updatedAt, Number(applied), ...claimBindings)
    : db.prepare(`UPDATE kitchen_state SET state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND ?=1 AND ${claimed}`)
      .bind(JSON.stringify(state), updatedAt, household.householdId, current.revision, Number(applied), ...claimBindings);
  const results = await db.batch<ReceiptRow>([
    insertReceipt,
    writeKitchen,
    receiptQuery(db, household, commandId, updatedAt),
  ]);
  const row = results[2].results[0];
  if (row) return resultFromRow(commandId, requestHash, row, attemptToken);

  // Neither rejected revisions nor changed authorization consume a command ID.
  await validateHouseholdContext(household);
  const latest = await getKitchenDocument(household);
  if (latest.revision === current.revision && household.mode === "hosted" && household.role !== "owner"
    && JSON.stringify(latest.state?.cookingProfile ?? DEFAULT_COOKING_PROFILE) !== profile) {
    throw new HouseholdAuthError("OWNER_REQUIRED", "Only the household owner can change shared cooking requirements.");
  }
  throw new KitchenConflictError(latest);
}
