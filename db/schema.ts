import { sql } from "drizzle-orm";
import {
  index,
  integer,
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

/** One durable document for this local, personal kitchen (not a multi-user store). */
export const kitchenState = sqliteTable("kitchen_state", {
  id: text("id").primaryKey(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
});
