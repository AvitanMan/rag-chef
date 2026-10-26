import type { Recipe, RecipeMetadata } from "./recipe-types";
import { RECIPE_EMBEDDING_KIND, RECIPE_STEP_EMBEDDING_KIND, isValidEmbeddingVector } from "./recipe-embeddings";
import type {
  RecipeEmbeddingRecord,
  StoredRecipeEmbedding,
} from "./recipe-embeddings";

const DEFAULT_CATALOG_LIMIT = 250;
const MAX_CATALOG_LIMIT = 1_000;

export interface ApprovedRecipeSourceInput {
  id: string;
  name: string;
  url: string;
  licenseId: string;
  licenseUrl?: string | null;
  attributionText?: string | null;
  termsUrl?: string | null;
  termsSnapshotSha256?: string | null;
  permissionBasis: string;
  permissionDocumentRef?: string | null;
  approvalStatus: "approved";
  approvedBy: string;
  approvedAt?: number;
  approvalNotes?: string | null;
  allowDisplay: true;
  allowCache: true;
  allowIndexText: true;
  allowEmbed: true;
  allowDerive?: boolean;
  allowCommercial?: boolean;
  allowImages?: boolean;
}

export interface StoredCatalogRecipe {
  recipe: Recipe;
  catalogId: string;
  sourceId: string;
  sourceRecordId: string;
  version: number;
  contentHash: string;
  searchText: string;
  metadata?: RecipeMetadata;
}

export interface CatalogRecipeUpsertResult {
  catalogId: string;
  sourceRecordId: string;
  version: number;
  contentChanged: boolean;
}

export interface RecipeMetadataReview {
  recipeId: string;
  reviewed: true;
  metadata: RecipeMetadata;
}

export interface CatalogSyncResult {
  recordsSeen: number;
  recordsUpserted: number;
  recordsQuarantined?: number;
  errorMessage?: string | null;
}

export interface CatalogStatus {
  approvedSourceCount: number;
  activeRecipeCount: number;
  embeddingCount: number;
  staleEmbeddingCount: number;
  stepEmbeddingCount: number;
  staleStepEmbeddingCount: number;
  embeddingModel: string;
  embeddingKind: string;
  lastSync: {
    id: string;
    sourceId: string;
    status: "running" | "succeeded" | "failed";
    recordsSeen: number;
    recordsUpserted: number;
    startedAt: number;
    finishedAt: number | null;
    errorMessage: string | null;
  } | null;
}

type RecipeRow = {
  id: string;
  source_id: string;
  source_record_id: string;
  source_url: string;
  title: string;
  image_url: string | null;
  category: string;
  cuisine: string;
  tags_json: string;
  search_text: string;
  normalized_content_sha256: string;
  version: number;
  source_name: string;
  source_homepage: string;
  servings: number | null;
  license_id: string;
  license_url: string | null;
  attribution_text: string | null;
};

type IngredientRow = {
  recipe_id: string;
  position: number;
  original_name: string;
  original_measure: string;
};

type SectionRow = {
  id: string;
  recipe_id: string;
  position: number;
  title: string | null;
};

type StepRow = {
  recipe_id: string;
  section_id: string;
  position: number;
  text: string;
};

type EmbeddingRow = {
  chunk_index: number;
  kind: string;
  recipe_id: string;
  content_sha256: string;
  model: string;
  dimensions: number;
  vector_json: string;
};


let schemaReady: Promise<void> | null = null;

async function catalogDb(): Promise<D1Database> {
  const runtime = await import("cloudflare:workers");
  const binding = (runtime.env as unknown as { DB?: D1Database }).DB;
  if (!binding) {
    throw new Error(
      "The D1 recipe catalog binding is unavailable. Set .openai/hosting.json d1 to DB.",
    );
  }
  return binding;
}

export async function isRecipeCatalogConfigured(): Promise<boolean> {
  try {
    const runtime = await import("cloudflare:workers");
    return Boolean((runtime.env as unknown as { DB?: D1Database }).DB);
  } catch {
    return false;
  }
}

export async function ensureRecipeCatalogSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = await catalogDb();
      await db.prepare("SELECT id FROM recipes LIMIT 1").first();
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function upsertApprovedRecipeSource(
  source: ApprovedRecipeSourceInput,
): Promise<void> {
  assertApprovedSource(source);
  await ensureRecipeCatalogSchema();
  const now = Date.now();
  await (await catalogDb())
    .prepare(
      `INSERT INTO recipe_sources (
        id, name, url, license_id, license_url, attribution_text, terms_url,
        terms_snapshot_sha256, permission_basis, permission_document_ref,
        approval_status, approved_by, approved_at, approval_notes,
        allow_display, allow_cache, allow_index_text, allow_embed, allow_derive,
        allow_commercial, allow_images, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, 1, 1, 1, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        url = excluded.url,
        license_id = excluded.license_id,
        license_url = excluded.license_url,
        attribution_text = excluded.attribution_text,
        terms_url = excluded.terms_url,
        terms_snapshot_sha256 = excluded.terms_snapshot_sha256,
        permission_basis = excluded.permission_basis,
        permission_document_ref = excluded.permission_document_ref,
        approval_status = 'approved',
        approved_by = excluded.approved_by,
        approved_at = COALESCE(recipe_sources.approved_at, excluded.approved_at),
        approval_notes = excluded.approval_notes,
        allow_display = 1,
        allow_cache = 1,
        allow_index_text = 1,
        allow_embed = 1,
        allow_derive = excluded.allow_derive,
        allow_commercial = excluded.allow_commercial,
        allow_images = excluded.allow_images,
        updated_at = excluded.updated_at`,
    )
    .bind(
      source.id,
      source.name,
      source.url,
      source.licenseId,
      source.licenseUrl ?? null,
      source.attributionText ?? null,
      source.termsUrl ?? null,
      source.termsSnapshotSha256 ?? null,
      source.permissionBasis,
      source.permissionDocumentRef ?? null,
      source.approvedBy,
      source.approvedAt ?? now,
      source.approvalNotes ?? null,
      Number(source.allowDerive ?? false),
      Number(source.allowCommercial ?? false),
      Number(source.allowImages ?? false),
      now,
      now,
    )
    .run();
}

export async function startCatalogSync(sourceId: string): Promise<string> {
  await ensureRecipeCatalogSchema();
  const id = crypto.randomUUID();
  await (await catalogDb())
    .prepare(
      `INSERT INTO recipe_sync_runs (id, source_id, status, started_at)
       SELECT ?, id, 'running', ? FROM recipe_sources
       WHERE id = ? AND approval_status = 'approved'`,
    )
    .bind(id, Date.now(), sourceId)
    .run();
  return id;
}

export async function getRecipeSourcePolicy(sourceId: string) {
  return (await catalogDb()).prepare(
    `SELECT approval_status, allow_display, allow_cache, allow_index_text, allow_embed
     FROM recipe_sources WHERE id = ?`,
  ).bind(sourceId).first<{ approval_status: string; allow_display: number; allow_cache: number; allow_index_text: number; allow_embed: number }>();
}

export async function finishCatalogSync(
  syncRunId: string,
  status: "succeeded" | "failed",
  result: CatalogSyncResult,
): Promise<void> {
  await ensureRecipeCatalogSchema();
  await (await catalogDb())
    .prepare(
      `UPDATE recipe_sync_runs SET
        status = ?, records_seen = ?, records_upserted = ?,
        records_quarantined = ?, error_message = ?, finished_at = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      result.recordsSeen,
      result.recordsUpserted,
      result.recordsQuarantined ?? 0,
      result.errorMessage ?? null,
      Date.now(),
      syncRunId,
    )
    .run();
}

export async function upsertCatalogRecipe(input: {
  sourceId: string;
  recipe: Recipe;
  contentHash: string;
  searchText: string;
  syncRunId?: string | null;
}): Promise<CatalogRecipeUpsertResult> {
  await ensureRecipeCatalogSchema();
  const { sourceId, recipe, contentHash, searchText } = input;
  const catalogId = catalogRecipeId(sourceId, recipe.id);
  const db = await catalogDb();
  const previous = await db
    .prepare(
      "SELECT normalized_content_sha256 AS content_hash, version FROM recipes WHERE id = ?",
    )
    .bind(catalogId)
    .first<{ content_hash: string; version: number }>();
  const now = Date.now();
  const sections = sourceId === "wikibooks"
    ? [{ title: "Main method", steps: recipe.instructions }]
    : normalizeInstructionSections(recipe);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO recipes (
          id, source_id, source_record_id, source_url, sync_run_id, title,
          image_url, category, cuisine, language, tags_json, search_text,
          normalized_content_sha256, version, status, created_at, updated_at,
          last_seen_at, servings
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'en', ?, ?, ?, 1, 'active', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_url = excluded.source_url,
          sync_run_id = excluded.sync_run_id,
          title = excluded.title,
          image_url = excluded.image_url,
          category = excluded.category,
          cuisine = excluded.cuisine,
          servings = excluded.servings,
          tags_json = excluded.tags_json,
          search_text = excluded.search_text,
          version = CASE
            WHEN recipes.normalized_content_sha256 <> excluded.normalized_content_sha256
            THEN recipes.version + 1 ELSE recipes.version END,
          normalized_content_sha256 = excluded.normalized_content_sha256,
          status = 'active',
          updated_at = CASE
            WHEN recipes.normalized_content_sha256 <> excluded.normalized_content_sha256
            THEN excluded.updated_at ELSE recipes.updated_at END,
          last_seen_at = excluded.last_seen_at`,
      )
      .bind(
        catalogId,
        sourceId,
        recipe.id,
        recipe.sourceUrl,
        input.syncRunId ?? null,
        recipe.title,
        recipe.image || null,
        recipe.category || "Other",
        recipe.cuisine || "International",
        JSON.stringify(uniqueStrings(recipe.tags)),
        searchText,
        contentHash,
        now,
        now,
        now,
        recipe.servings ?? null,
      ),
    db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").bind(catalogId),
    db.prepare("DELETE FROM recipe_instruction_sections WHERE recipe_id = ?").bind(catalogId),
  ];

  recipe.ingredients.forEach((ingredient, position) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO recipe_ingredients (
            recipe_id, position, original_name, normalized_name, original_measure
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          catalogId,
          position,
          ingredient.name.trim(),
          normalizeIngredientName(ingredient.name),
          ingredient.measure.trim(),
        ),
    );
  });

  sections.forEach((section, sectionPosition) => {
    const sectionId = `${catalogId}:section:${sectionPosition}`;
    statements.push(
      db
        .prepare(
          `INSERT INTO recipe_instruction_sections (id, recipe_id, position, title)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(sectionId, catalogId, sectionPosition, section.title),
    );
    section.steps.forEach((step, stepPosition) => {
      statements.push(
        db
          .prepare(
            `INSERT INTO recipe_instruction_steps (
              recipe_id, section_id, position, text
            ) VALUES (?, ?, ?, ?)`,
          )
          .bind(catalogId, sectionId, stepPosition, step),
      );
    });
  });

  await db.batch(statements);
  const current = await db
    .prepare("SELECT version FROM recipes WHERE id = ?")
    .bind(catalogId)
    .first<{ version: number }>();
  if (!current) throw new Error(`Recipe ${catalogId} was not persisted.`);

  return {
    catalogId,
    sourceRecordId: recipe.id,
    version: current.version,
    contentChanged: previous?.content_hash !== contentHash,
  };
}

export async function listCatalogRecipes(
  limit = DEFAULT_CATALOG_LIMIT,
  options: { forEmbedding?: boolean } = {},
): Promise<StoredCatalogRecipe[]> {
  await ensureRecipeCatalogSchema();
  const boundedLimit = Math.min(
    Math.max(Math.floor(limit), 1),
    MAX_CATALOG_LIMIT,
  );
  const db = await catalogDb();
  const recipeRows = await allRows<RecipeRow>(
    db
      .prepare(
        `SELECT r.id, r.source_id, r.source_record_id, r.source_url, r.title, r.servings,
          r.image_url, r.category, r.cuisine, r.tags_json, r.search_text,
          r.normalized_content_sha256, r.version, s.name AS source_name,
          s.url AS source_homepage, s.license_id, s.license_url, s.attribution_text
         FROM recipes r
         JOIN recipe_sources s ON s.id = r.source_id
         WHERE r.status = 'active'
           AND s.approval_status = 'approved'
           AND s.allow_display = 1
           AND s.allow_index_text = 1
           ${options.forEmbedding ? "AND s.allow_embed = 1 AND s.allow_cache = 1" : ""}
         ORDER BY r.updated_at DESC, r.id ASC
         LIMIT ?`,
      )
      .bind(boundedLimit),
  );
  if (recipeRows.length === 0) return [];

  const ids = recipeRows.map((row) => row.id);
  const [ingredients, sections, steps, metadata] = await Promise.all([
    rowsForRecipeIds<IngredientRow>(
      db, ids,
      `SELECT recipe_id, position, original_name, original_measure
       FROM recipe_ingredients WHERE recipe_id IN`,
      "ORDER BY recipe_id, position",
    ),
    rowsForRecipeIds<SectionRow>(
      db, ids,
      `SELECT id, recipe_id, position, title
       FROM recipe_instruction_sections WHERE recipe_id IN`,
      "ORDER BY recipe_id, position",
    ),
    rowsForRecipeIds<StepRow>(
      db, ids,
      `SELECT recipe_id, section_id, position, text
       FROM recipe_instruction_steps WHERE recipe_id IN`,
      "ORDER BY recipe_id, section_id, position",
    ),
    listRecipeMetadata(),
  ]);

  return recipeRows.map((row) => ({
    recipe: {
      id: row.id,
      title: row.title,
      image: row.image_url,
      category: row.category,
      cuisine: row.cuisine,
      source: {
        name: row.source_name, url: row.source_homepage,
        ...(row.license_url ? { licenseId: row.license_id, licenseUrl: row.license_url } : {}),
        ...(row.attribution_text ? { attributionText: row.attribution_text } : {}),
      },
      ...(row.servings !== null ? { servings: row.servings } : {}),
      sourceUrl: row.source_url,
      ingredients: ingredients
        .filter((item) => item.recipe_id === row.id)
        .map((item) => ({
          name: item.original_name,
          measure: item.original_measure,
        })),
      instructions: reconstructInstructions(
        sections.filter((item) => item.recipe_id === row.id),
        steps.filter((item) => item.recipe_id === row.id),
      ),
      tags: parseStringArray(row.tags_json),
    },
    catalogId: row.id,
    sourceId: row.source_id,
    sourceRecordId: row.source_record_id,
    version: row.version,
    contentHash: row.normalized_content_sha256,
    searchText: row.search_text,
    ...(metadata[row.id] ? { metadata: metadata[row.id] } : {}),
  }));
}

export async function listRecipeMetadata(): Promise<Record<string, RecipeMetadata>> {
  const db = await catalogDb();
  let rows: { recipe_id: string; payload_json: string; source_content_sha256: string; revision: number }[];
  try {
    rows = await allRows(db.prepare(
      `SELECT m.recipe_id, m.payload_json, m.source_content_sha256, m.revision FROM recipe_metadata m
       JOIN recipes r ON r.id = m.recipe_id
       JOIN recipe_sources s ON s.id = r.source_id
       WHERE r.status = 'active' AND s.approval_status = 'approved'
         AND s.allow_display = 1 AND s.allow_index_text = 1
         AND m.source_content_sha256 = r.normalized_content_sha256
         AND m.revision = (SELECT MAX(m2.revision) FROM recipe_metadata m2 WHERE m2.recipe_id = m.recipe_id)`,
    ));
  } catch (error) {
    // A pre-migration local installation remains usable with explicit unknowns.
    if (error instanceof Error && /no such table.*recipe_metadata/i.test(error.message)) return {};
    throw error;
  }
  return Object.fromEntries(rows.flatMap((row) => {
    try {
      const metadata = validateRecipeMetadata(JSON.parse(row.payload_json));
      return metadata.sourceContentHash === row.source_content_sha256 && metadata.revision === row.revision ? [[row.recipe_id, metadata]] : [];
    }
    catch { return []; } // Invalid annotations cannot be used as dietary evidence.
  }));
}

const METADATA_FIELDS = ["coreDinner", "dinnerRole", "diets.vegan", "diets.vegetarian", "diets.gluten_free", "diets.low_carb", "totalMinutes", "equipment", "servings", "ingredients"];
const EQUIPMENT = new Set(["oven", "stovetop", "microwave", "blender", "slow cooker", "pressure cooker", "air fryer", "grill"]);

export function validateRecipeMetadata(value: unknown): RecipeMetadata {
  const object = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Metadata must be an object.");
    return item as Record<string, unknown>;
  };
  const exact = (item: Record<string, unknown>, names: string[]) => {
    if (Object.keys(item).some((key) => !names.includes(key)) || names.some((key) => !Object.hasOwn(item, key))) throw new Error("Metadata fields are missing or unsupported.");
  };
  const text = (item: unknown, maximum: number) => {
    if (typeof item !== "string" || !item.trim() || item.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item)) throw new Error("Metadata evidence must be nonempty bounded text.");
    return item;
  };
  const row = object(value);
  exact(row, ["revision", "sourceContentHash", "coreDinner", "dinnerRole", "diets", "totalMinutes", "equipment", "provenance", "reviewedBy", "reviewedAt"]);
  if (!Number.isInteger(row.revision) || Number(row.revision) < 1 || Number(row.revision) > 1_000_000 || !/^[a-f0-9]{64}$/.test(String(row.sourceContentHash))) throw new Error("Metadata requires a revision and source content hash.");
  if (typeof row.coreDinner !== "boolean" || !["main", "side", "component", "dessert", "unknown"].includes(String(row.dinnerRole))) throw new Error("Invalid dinner classification.");
  if (row.coreDinner && row.dinnerRole !== "main") throw new Error("A core dinner must be reviewed as a main dish.");
  const diets = object(row.diets);
  exact(diets, ["vegan", "vegetarian", "gluten_free", "low_carb"]);
  if (Object.values(diets).some((x) => !["fits", "conflicts", "unknown"].includes(String(x)))) throw new Error("Diet suitability must be fits, conflicts, or unknown.");
  if (row.totalMinutes !== null && (typeof row.totalMinutes !== "number" || !Number.isFinite(row.totalMinutes) || row.totalMinutes <= 0 || row.totalMinutes > 20_160)) throw new Error("Invalid total time.");
  if (row.equipment !== null && (!Array.isArray(row.equipment) || row.equipment.length > 8 || row.equipment.some((x) => typeof x !== "string" || !EQUIPMENT.has(x.toLowerCase())) || new Set(row.equipment).size !== row.equipment.length)) throw new Error("Equipment must use supported appliance names or null.");
  const provenance = object(row.provenance);
  exact(provenance, METADATA_FIELDS);
  for (const field of METADATA_FIELDS) {
    const evidence = object(provenance[field]);
    exact(evidence, ["basis", "evidence"]);
    if (!["source", "curator_assessment", "curator_estimate"].includes(String(evidence.basis))) throw new Error("Invalid evidence basis.");
    text(evidence.evidence, 6000);
  }
  text(row.reviewedBy, 200);
  if (typeof row.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.reviewedAt) || !Number.isFinite(Date.parse(row.reviewedAt))) throw new Error("Metadata review time must be a UTC ISO timestamp.");
  return structuredClone(row) as unknown as RecipeMetadata;
}

/** All entries validate before any write; source recipes and saved meals are untouched. */
export async function reviewRecipeMetadata(entries: unknown[], preview = false) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new Error("Review 1–100 metadata entries at a time.");
  const catalog = new Map((await listCatalogRecipes(1000)).map((item) => [item.recipe.id, item]));
  const db = await catalogDb();
  const seen = new Set<string>();
  const prepared = [];
  for (const value of entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid metadata review.");
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((x) => !["recipeId", "reviewed", "metadata"].includes(x)) || row.reviewed !== true || typeof row.recipeId !== "string" || seen.has(row.recipeId)) throw new Error("Each unique recipe requires explicit review approval.");
    seen.add(row.recipeId);
    const current = catalog.get(row.recipeId);
    const metadata = validateRecipeMetadata(row.metadata);
    if (!current || current.contentHash !== metadata.sourceContentHash) throw new Error(`Source changed or is unavailable: ${row.recipeId}. Review again.`);
    // A source claim must actually occur in the captured source representation.
    for (const evidence of Object.values(metadata.provenance)) if (evidence.basis === "source" && !current.searchText.includes(evidence.evidence)) throw new Error(`Unsupported source evidence for ${current.recipe.title}.`);
    const previous = await db.prepare("SELECT revision, payload_json FROM recipe_metadata WHERE recipe_id = ? ORDER BY revision DESC LIMIT 1").bind(row.recipeId).first<{ revision: number; payload_json: string }>();
    const stable = (item: unknown): string => item && typeof item === "object" ? Array.isArray(item) ? `[${item.map(stable).join(",")}]` : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable((item as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(item);
    const compare = (item: RecipeMetadata) => stable({ ...item, revision: 0 });
    const changed = !previous || compare(validateRecipeMetadata(JSON.parse(previous.payload_json))) !== compare(metadata);
    const revision = changed ? (previous?.revision ?? 0) + 1 : previous!.revision;
    prepared.push({ recipeId: row.recipeId, metadata: { ...metadata, revision }, before: current.metadata ?? null, changed, revision });
  }
  if (!preview) {
    const statements = prepared.filter((item) => item.changed).map(({ recipeId, metadata, revision }) => db.prepare(
      `INSERT INTO recipe_metadata (recipe_id, revision, source_content_sha256, payload_json, reviewed_by, reviewed_at)
       VALUES ((SELECT r.id FROM recipes r JOIN recipe_sources s ON s.id = r.source_id
         WHERE r.id = ? AND r.normalized_content_sha256 = ? AND r.status = 'active'
           AND s.approval_status = 'approved' AND s.allow_display = 1 AND s.allow_index_text = 1), ?, ?, ?, ?, ?)`,
    ).bind(recipeId, metadata.sourceContentHash, revision, metadata.sourceContentHash, JSON.stringify(metadata), metadata.reviewedBy, metadata.reviewedAt));
    if (statements.length) {
      const result = await db.batch(statements);
      if (result.some((item) => item.meta?.changes === 0)) throw new Error("A source changed during review; refresh the preview before retrying.");
    }
  }
  return prepared.map(({ recipeId, metadata, before, changed, revision }) => ({ recipeId, metadata, before, changed, revision }));
}

export async function listStoredRecipeEmbeddings(
  model?: string,
  kind = RECIPE_EMBEDDING_KIND,
  recipeId?: string,
): Promise<StoredRecipeEmbedding[]> {
  await ensureRecipeCatalogSchema();
  const db = await catalogDb();
  const condition = model ? "AND e.model = ?" : "";
  const statement = db.prepare(
    `SELECT e.recipe_id, e.content_sha256, e.model, e.dimensions, e.vector_json, e.kind, e.chunk_index
     FROM recipe_embeddings e
     JOIN recipes r ON r.id = e.recipe_id
     JOIN recipe_sources s ON s.id = r.source_id
     WHERE r.status = 'active'
       AND s.approval_status = 'approved'
       AND s.allow_embed = 1
       AND s.allow_display = 1 AND s.allow_cache = 1 AND s.allow_index_text = 1
       AND e.kind = ?
       AND e.recipe_version = r.version
       AND e.content_sha256 = r.normalized_content_sha256
       ${condition} ${recipeId ? "AND e.recipe_id = ?" : ""}
     ORDER BY e.recipe_id, e.chunk_index`,
  );
  const rows = await allRows<EmbeddingRow>(statement.bind(kind, ...(model ? [model] : []), ...(recipeId ? [recipeId] : [])));
  return rows.map((row) => ({
    recipeId: row.recipe_id,
    chunkIndex: row.chunk_index,
    contentHash: row.content_sha256,
    model: row.model,
    vector: parseNumberArray(row.vector_json, row.dimensions),
    kind: row.kind,
  }));
}

export async function saveRecipeEmbeddings(
  records: readonly RecipeEmbeddingRecord[],
): Promise<void> {
  if (records.length === 0) return;
  // D1 limits each statement to 100 bound parameters. A full-catalog refresh
  // must also bound the version lookup, not only embedding-provider batches.
  if (records.length > 80) {
    for (let offset = 0; offset < records.length; offset += 80) await saveRecipeEmbeddings(records.slice(offset, offset + 80));
    return;
  }
  await ensureRecipeCatalogSchema();
  const db = await catalogDb();
  const ids = [...new Set(records.map((record) => record.recipeId))];
  const placeholders = ids.map(() => "?").join(", ");
  const versions = await allRows<{ id: string; version: number; content_hash: string; permitted: number; step_count: number }>(
    db
      .prepare(`SELECT r.id, r.version, r.normalized_content_sha256 AS content_hash,
          (r.status = 'active' AND s.approval_status = 'approved' AND s.allow_display = 1 AND s.allow_cache = 1 AND s.allow_index_text = 1 AND s.allow_embed = 1) AS permitted,
          ((SELECT COUNT(*) FROM recipe_instruction_steps st WHERE st.recipe_id = r.id) +
            CASE WHEN (SELECT COUNT(*) FROM recipe_instruction_sections se WHERE se.recipe_id = r.id) > 1
              THEN (SELECT COUNT(*) FROM recipe_instruction_sections se WHERE se.recipe_id = r.id AND se.title IS NOT NULL AND se.title <> '') ELSE 0 END) AS step_count
          FROM recipes r JOIN recipe_sources s ON s.id = r.source_id WHERE r.id IN (${placeholders})`)
      .bind(...ids),
  );
  const versionById = new Map(versions.map((row) => [row.id, row]));
  const statements = records.map((record) => {
    const current = versionById.get(record.recipeId);
    const recipeVersion = current?.version;
    if (!recipeVersion) {
      throw new Error(`Cannot store an embedding for missing recipe ${record.recipeId}.`);
    }
    if (!current?.permitted || record.contentHash !== current.content_hash) throw new Error("Embedding source permission or recipe content changed during refresh.");
    const chunk = record.chunkIndex ?? 0;
    if (!Number.isInteger(chunk) || chunk < 0 || (record.kind === RECIPE_EMBEDDING_KIND ? chunk !== 0 : record.kind !== RECIPE_STEP_EMBEDDING_KIND || chunk >= current.step_count)
      || !isValidEmbeddingVector(record.vector, record.dimensions)) throw new Error("Invalid embedding identity or vector.");
    const timestamp = Number.isFinite(Date.parse(record.embeddedAt))
      ? Date.parse(record.embeddedAt)
      : Date.now();
    return db
      .prepare(
        `INSERT INTO recipe_embeddings (
          recipe_id, recipe_version, kind, chunk_index, model, dimensions,
          content_sha256, vector_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(recipe_id, model, kind, chunk_index) DO UPDATE SET
          recipe_version = excluded.recipe_version,
          dimensions = excluded.dimensions,
          content_sha256 = excluded.content_sha256,
          vector_json = excluded.vector_json,
          updated_at = excluded.updated_at`,
      )
      .bind(
        record.recipeId,
        recipeVersion,
        record.kind,
        record.chunkIndex ?? 0,
        record.model,
        record.dimensions,
        record.contentHash,
        JSON.stringify(record.vector),
        timestamp,
        timestamp,
      );
  });
  await db.batch(statements);
}

export async function getCatalogStatus(model: string): Promise<CatalogStatus> {
  await ensureRecipeCatalogSchema();
  const db = await catalogDb();
  const [counts, lastSync] = await Promise.all([
    db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM recipe_sources
            WHERE approval_status = 'approved') AS approved_source_count,
          (SELECT COUNT(*) FROM recipes r JOIN recipe_sources s ON s.id = r.source_id
            WHERE r.status = 'active' AND s.approval_status = 'approved') AS active_recipe_count,
          (SELECT COUNT(*) FROM recipe_embeddings e
            JOIN recipes r ON r.id = e.recipe_id
            JOIN recipe_sources s ON s.id = r.source_id
            WHERE r.status = 'active' AND s.approval_status = 'approved'
              AND s.allow_embed = 1 AND e.kind = '${RECIPE_EMBEDDING_KIND}' AND e.chunk_index = 0
              AND e.recipe_version = r.version AND e.content_sha256 = r.normalized_content_sha256
              AND e.model = ?) AS embedding_count,
          (SELECT COUNT(*) FROM recipes r
            JOIN recipe_sources s ON s.id = r.source_id
            LEFT JOIN recipe_embeddings e ON e.recipe_id = r.id
              AND e.model = ? AND e.kind = '${RECIPE_EMBEDDING_KIND}' AND e.chunk_index = 0
            WHERE r.status = 'active' AND s.approval_status = 'approved'
              AND s.allow_embed = 1
              AND (e.recipe_id IS NULL OR e.content_sha256 <> r.normalized_content_sha256 OR e.recipe_version <> r.version)
          ) AS stale_embedding_count`,
      )
      .bind(model, model)
      .first<{
        approved_source_count: number;
        active_recipe_count: number;
        embedding_count: number;
        stale_embedding_count: number;
      }>(),
    db
      .prepare(
        `SELECT id, source_id, status, records_seen, records_upserted,
          started_at, finished_at, error_message
         FROM recipe_sync_runs ORDER BY started_at DESC LIMIT 1`,
      )
      .first<{
        id: string;
        source_id: string;
        status: "running" | "succeeded" | "failed";
        records_seen: number;
        records_upserted: number;
        started_at: number;
        finished_at: number | null;
        error_message: string | null;
      }>(),
  ]);

  const [stepRecipes, stepVectors] = await Promise.all([listCatalogRecipes(1000, { forEmbedding: true }), listStoredRecipeEmbeddings(model, RECIPE_STEP_EMBEDDING_KIND)]);
  const stepsByRecipe = new Map(stepRecipes.map((record) => [record.recipe.id, record.recipe.instructions.length]));
  const currentSteps = stepVectors.filter((record) => record.chunkIndex !== undefined && record.chunkIndex >= 0 && record.chunkIndex < (stepsByRecipe.get(record.recipeId) ?? 0) && isValidEmbeddingVector(record.vector)).length;
  const expectedSteps = stepRecipes.reduce((sum, record) => sum + record.recipe.instructions.length, 0);
  return {
    stepEmbeddingCount: currentSteps,
    staleStepEmbeddingCount: expectedSteps - currentSteps,
    approvedSourceCount: counts?.approved_source_count ?? 0,
    activeRecipeCount: counts?.active_recipe_count ?? 0,
    embeddingCount: counts?.embedding_count ?? 0,
    staleEmbeddingCount: counts?.stale_embedding_count ?? 0,
    embeddingModel: model,
    embeddingKind: RECIPE_EMBEDDING_KIND,
    lastSync: lastSync
      ? {
          id: lastSync.id,
          sourceId: lastSync.source_id,
          status: lastSync.status,
          recordsSeen: lastSync.records_seen,
          recordsUpserted: lastSync.records_upserted,
          startedAt: lastSync.started_at,
          finishedAt: lastSync.finished_at,
          errorMessage: lastSync.error_message,
        }
      : null,
  };
}

export function catalogRecipeId(sourceId: string, sourceRecordId: string): string {
  const normalizedSource = sourceId.trim().toLowerCase();
  const normalizedRecord = sourceRecordId.trim();
  if (!normalizedSource || !normalizedRecord) {
    throw new TypeError("A catalog recipe requires source and source record ids.");
  }
  return `${normalizedSource}:${normalizedRecord}`;
}

export function normalizeIngredientName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assertApprovedSource(
  source: ApprovedRecipeSourceInput,
): asserts source is ApprovedRecipeSourceInput {
  if (
    source.approvalStatus !== "approved" ||
    !source.allowDisplay ||
    !source.allowCache ||
    !source.allowIndexText ||
    !source.allowEmbed
  ) {
    throw new Error(
      "A source must be explicitly approved for display, persistence, indexing, and embeddings before import.",
    );
  }
  if (!source.id.trim() || !source.name.trim() || !source.permissionBasis.trim()) {
    throw new TypeError("Approved source identity and permission basis are required.");
  }
}

type InstructionSection = { title: string | null; steps: string[] };

function normalizeInstructionSections(recipe: Recipe): InstructionSection[] {
  const sections: InstructionSection[] = [];
  let current: InstructionSection = {
    title: defaultInstructionTitle(recipe.title),
    steps: [],
  };

  for (const raw of recipe.instructions) {
    const step = raw
      .trim()
      .replace(/^(?:step\s+)?\d+[.)]\s+/i, "")
      .trim();
    if (!step || /^(?:step\s*#?\s*\d+|instructions?|directions?)\s*[:.)-]?$/i.test(step)) {
      continue;
    }
    if (isInstructionHeading(step)) {
      if (current.steps.length > 0) sections.push(current);
      current = { title: instructionHeading(step), steps: [] };
    } else {
      current.steps.push(step);
    }
  }
  if (current.steps.length > 0) sections.push(current);
  return sections.length > 0
    ? sections
    : [{ title: defaultInstructionTitle(recipe.title), steps: [] }];
}

function defaultInstructionTitle(title: string): string {
  const value = title.toLowerCase();
  if (/instant pot|pressure cooker/.test(value)) return "Instant Pot";
  if (/slow cooker|crockpot/.test(value)) return "Slow cooker";
  if (/air fryer/.test(value)) return "Air fryer";
  return "Main method";
}

function isInstructionHeading(value: string): boolean {
  const heading = value.trim().replace(/:$/, "");
  return (
    heading.length <= 80 &&
    (/(?:instructions?|directions?|method)$/i.test(heading) ||
      /^(?:instant pot|pressure cooker|stove ?top|oven|slow cooker|air fryer|grill|hob)$/i.test(
        heading,
      ))
  );
}

function instructionHeading(value: string): string {
  return (
    value
      .trim()
      .replace(/:$/, "")
      .replace(/\s+(?:instructions?|directions?)$/i, "")
      .trim() || "Alternate method"
  );
}

function reconstructInstructions(
  sections: SectionRow[],
  steps: StepRow[],
): string[] {
  const orderedSections = [...sections].sort((a, b) => a.position - b.position);
  const multiple = orderedSections.length > 1;
  return orderedSections.flatMap((section) => {
    const sectionSteps = steps
      .filter((step) => step.section_id === section.id)
      .sort((a, b) => a.position - b.position)
      .map((step) => step.text);
    return multiple && section.title
      ? [section.title, ...sectionSteps]
      : sectionSteps;
  });
}

async function allRows<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  return result.results ?? [];
}

async function rowsForRecipeIds<T>(
  db: D1Database, ids: string[], prefix: string, suffix: string,
): Promise<T[]> {
  const rows: T[] = [];
  // D1 accepts at most 100 bound parameters per statement.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(...await allRows<T>(
      db.prepare(`${prefix} (${placeholders}) ${suffix}`).bind(...chunk),
    ));
  }
  return rows;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseNumberArray(value: string, dimensions: number): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== dimensions ||
      !parsed.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
