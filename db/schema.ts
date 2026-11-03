import { sql } from "drizzle-orm";
import {
  index,
  check,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export type RecipeSourceApprovalStatus =
  | "pending"
  | "approved"
  | "suspended"
  | "revoked";
export type RecipeRecordStatus = "active" | "withdrawn" | "quarantined";
export type RecipeSyncStatus = "running" | "succeeded" | "failed";

/**
 * A source is admitted to the catalog only after an explicit rights review.
 * Permission flags are deliberately granular because display, persistence,
 * search indexing, embeddings, and derivative use may have different grants.
 */
export const recipeSources = sqliteTable(
  "recipe_sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    licenseId: text("license_id").notNull(),
    licenseUrl: text("license_url"),
    attributionText: text("attribution_text"),
    termsUrl: text("terms_url"),
    termsSnapshotSha256: text("terms_snapshot_sha256"),
    permissionBasis: text("permission_basis").notNull(),
    permissionDocumentRef: text("permission_document_ref"),
    approvalStatus: text("approval_status")
      .$type<RecipeSourceApprovalStatus>()
      .notNull()
      .default("pending"),
    approvedBy: text("approved_by"),
    approvedAt: integer("approved_at"),
    approvalNotes: text("approval_notes"),
    allowDisplay: integer("allow_display", { mode: "boolean" })
      .notNull()
      .default(false),
    allowCache: integer("allow_cache", { mode: "boolean" })
      .notNull()
      .default(false),
    allowIndexText: integer("allow_index_text", { mode: "boolean" })
      .notNull()
      .default(false),
    allowEmbed: integer("allow_embed", { mode: "boolean" })
      .notNull()
      .default(false),
    allowDerive: integer("allow_derive", { mode: "boolean" })
      .notNull()
      .default(false),
    allowCommercial: integer("allow_commercial", { mode: "boolean" })
      .notNull()
      .default(false),
    allowImages: integer("allow_images", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("recipe_sources_approval_idx").on(table.approvalStatus),
  ],
);

export const recipeSyncRuns = sqliteTable(
  "recipe_sync_runs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => recipeSources.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<RecipeSyncStatus>()
      .notNull()
      .default("running"),
    cursor: text("cursor"),
    recordsSeen: integer("records_seen").notNull().default(0),
    recordsUpserted: integer("records_upserted").notNull().default(0),
    recordsQuarantined: integer("records_quarantined").notNull().default(0),
    errorMessage: text("error_message"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    index("recipe_sync_runs_source_started_idx").on(
      table.sourceId,
      table.startedAt,
    ),
  ],
);

export const recipes = sqliteTable(
  "recipes",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => recipeSources.id, { onDelete: "restrict" }),
    sourceRecordId: text("source_record_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceUpdatedAt: integer("source_updated_at"),
    syncRunId: text("sync_run_id").references(() => recipeSyncRuns.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    servings: real("servings"),
    sourceNotesJson: text("source_notes_json", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    imageUrl: text("image_url"),
    category: text("category").notNull().default("Other"),
    cuisine: text("cuisine").notNull().default("International"),
    language: text("language").notNull().default("en"),
    tagsJson: text("tags_json", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    searchText: text("search_text").notNull(),
    rawSnapshotSha256: text("raw_snapshot_sha256"),
    normalizedContentSha256: text("normalized_content_sha256").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status")
      .$type<RecipeRecordStatus>()
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("recipes_source_record_uidx").on(
      table.sourceId,
      table.sourceRecordId,
    ),
    index("recipes_source_status_idx").on(table.sourceId, table.status),
    index("recipes_updated_idx").on(table.updatedAt),
  ],
);

export const recipeIngredients = sqliteTable(
  "recipe_ingredients",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    sectionTitle: text("section_title"),
    originalName: text("original_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    originalMeasure: text("original_measure").notNull().default(""),
    quantityValue: real("quantity_value"),
    quantityMin: real("quantity_min"),
    quantityMax: real("quantity_max"),
    unit: text("unit"),
    preparation: text("preparation"),
    optional: integer("optional", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex("recipe_ingredients_recipe_position_uidx").on(
      table.recipeId,
      table.position,
    ),
    index("recipe_ingredients_normalized_name_idx").on(table.normalizedName),
  ],
);

export const recipeInstructionSections = sqliteTable(
  "recipe_instruction_sections",
  {
    id: text("id").primaryKey(),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    title: text("title"),
  },
  (table) => [
    uniqueIndex("recipe_instruction_sections_recipe_position_uidx").on(
      table.recipeId,
      table.position,
    ),
  ],
);

export const recipeInstructionSteps = sqliteTable(
  "recipe_instruction_steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    sectionId: text("section_id")
      .notNull()
      .references(() => recipeInstructionSections.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    durationSeconds: integer("duration_seconds"),
    temperatureCelsius: real("temperature_celsius"),
  },
  (table) => [
    uniqueIndex("recipe_instruction_steps_section_position_uidx").on(
      table.sectionId,
      table.position,
    ),
    index("recipe_instruction_steps_recipe_idx").on(table.recipeId),
  ],
);

export const recipeEmbeddings = sqliteTable(
  "recipe_embeddings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipeId: text("recipe_id")
      .notNull()
      .references(() => recipes.id, { onDelete: "cascade" }),
    recipeVersion: integer("recipe_version").notNull(),
    kind: text("kind").notNull().default("recipe"),
    chunkIndex: integer("chunk_index").notNull().default(0),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    contentSha256: text("content_sha256").notNull(),
    vectorJson: text("vector_json", { mode: "json" })
      .$type<number[]>()
      .notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("recipe_embeddings_identity_uidx").on(
      table.recipeId,
      table.model,
      table.kind,
      table.chunkIndex,
    ),
    index("recipe_embeddings_model_idx").on(table.model),
    index("recipe_embeddings_recipe_version_idx").on(
      table.recipeId,
      table.recipeVersion,
    ),
  ],
);

/** Reviewed annotations are versioned independently from immutable source text. */
export const recipeMetadata = sqliteTable("recipe_metadata", {
  recipeId: text("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  sourceContentSha256: text("source_content_sha256").notNull(),
  payloadJson: text("payload_json").notNull(),
  reviewedBy: text("reviewed_by").notNull(),
  reviewedAt: text("reviewed_at").notNull(),
}, (table) => [
  uniqueIndex("recipe_metadata_recipe_revision_uidx").on(table.recipeId, table.revision),
  index("recipe_metadata_hash_idx").on(table.recipeId, table.sourceContentSha256),
]);

/** One revisioned document per authenticated household; local mode has its own ID. */
export const kitchenState = sqliteTable("kitchen_state", {
  id: text("id").primaryKey(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Incremented by canonical catalog mutation triggers, and checked at Apply's CAS. */
export const recipeCatalogRevision = sqliteTable("recipe_catalog_revision", {
  id: integer("id").primaryKey(),
  revision: integer("revision").notNull().default(0),
}, (table) => [check("recipe_catalog_revision_singleton", sql`${table.id}=1`)]);

/** Better Auth's native D1 adapter uses these exact table/column names. */
export const authUser = sqliteTable("user", {
  id: text("id").primaryKey(), name: text("name").notNull(), email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false), image: text("image"),
  createdAt: text("createdAt").notNull(), updatedAt: text("updatedAt").notNull(),
});
export const authSession = sqliteTable("session", {
  id: text("id").primaryKey(), expiresAt: text("expiresAt").notNull(), token: text("token").notNull().unique(),
  createdAt: text("createdAt").notNull(), updatedAt: text("updatedAt").notNull(), ipAddress: text("ipAddress"), userAgent: text("userAgent"),
  userId: text("userId").notNull().references(() => authUser.id, { onDelete: "cascade" }), activeOrganizationId: text("activeOrganizationId"),
}, (table) => [index("session_user_idx").on(table.userId)]);
export const authAccount = sqliteTable("account", {
  id: text("id").primaryKey(), accountId: text("accountId").notNull(), providerId: text("providerId").notNull(),
  userId: text("userId").notNull().references(() => authUser.id, { onDelete: "cascade" }), accessToken: text("accessToken"), refreshToken: text("refreshToken"), idToken: text("idToken"),
  accessTokenExpiresAt: text("accessTokenExpiresAt"), refreshTokenExpiresAt: text("refreshTokenExpiresAt"), scope: text("scope"), password: text("password"), createdAt: text("createdAt").notNull(), updatedAt: text("updatedAt").notNull(),
}, (table) => [index("account_user_idx").on(table.userId), uniqueIndex("account_provider_uidx").on(table.providerId, table.accountId)]);
export const authVerification = sqliteTable("verification", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(), expiresAt: text("expiresAt").notNull(), createdAt: text("createdAt").notNull(), updatedAt: text("updatedAt").notNull(),
}, (table) => [index("verification_identifier_idx").on(table.identifier)]);
export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(), name: text("name").notNull(), slug: text("slug").notNull().unique(), logo: text("logo"), metadata: text("metadata"), createdAt: text("createdAt").notNull(),
});
export const member = sqliteTable("member", {
  id: text("id").primaryKey(), organizationId: text("organizationId").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: text("userId").notNull().references(() => authUser.id, { onDelete: "cascade" }), role: text("role").$type<"owner" | "member">().notNull(), createdAt: text("createdAt").notNull(),
}, (table) => [check("member_role_check", sql`${table.role} IN ('owner','member')`), uniqueIndex("member_one_household_uidx").on(table.userId), index("member_org_idx").on(table.organizationId), uniqueIndex("household_one_owner_uidx").on(table.organizationId).where(sql`${table.role}='owner'`)]);
export const invitation = sqliteTable("invitation", {
  id: text("id").primaryKey(), organizationId: text("organizationId").notNull().references(() => organization.id, { onDelete: "cascade" }), email: text("email").notNull(), role: text("role"), status: text("status").notNull().default("pending"), expiresAt: text("expiresAt").notNull(), createdAt: text("createdAt").notNull(), inviterId: text("inviterId").notNull().references(() => authUser.id, { onDelete: "cascade" }),
}, (table) => [index("invitation_org_idx").on(table.organizationId), index("invitation_email_idx").on(table.email)]);
export const householdSettings = sqliteTable("household_settings", {
  organizationId: text("organizationId").primaryKey().references(() => organization.id, { onDelete: "cascade" }), timezone: text("timezone").notNull().default("UTC"), assistantEnabled: integer("assistantEnabled", { mode: "boolean" }).notNull().default(false),
});

export const aiConnections = sqliteTable("ai_connections", {
  userId: text("user_id").notNull(), provider: text("provider").notNull(), cipherText: text("cipher_text").notNull(), iv: text("iv").notNull(), keyVersion: text("key_version").notNull(), lastFour: text("last_four").notNull(), model: text("model").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.provider] }), check("ai_connections_provider_check", sql`${table.provider}='openai'`)]);
export const aiModelTasks = sqliteTable("ai_model_tasks", {
  id: text("id").primaryKey(), workflowId: text("workflow_id").notNull(), actorId: text("actor_id").notNull(), householdId: text("household_id").notNull(), operation: text("operation").notNull(), tokenHash: text("token_hash").notNull(), requestHash: text("request_hash").notNull(), kitchenRevision: integer("kitchen_revision").notNull(), inputJson: text("input_json").notNull(), transcriptJson: text("transcript_json").notNull(), status: text("status").notNull(), expiresAt: text("expires_at").notNull(), createdAt: text("created_at").notNull(), outputHash: text("output_hash"), responseJson: text("response_json"), responseStatus: integer("response_status"),
}, (table) => [check("ai_model_tasks_status_check", sql`${table.status} IN ('pending','processing','completed','cancelled')`), index("ai_model_tasks_actor").on(table.actorId, table.householdId, table.workflowId), index("ai_model_tasks_expiry").on(table.expiresAt)]);
