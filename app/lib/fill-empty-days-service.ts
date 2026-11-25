import { catalogReadService } from "./catalog-read-service";
import type { FillEmptyDaysApplyRequest, FillEmptyDaysPreviewRequest, FillEmptyDaysPreviewResponse } from "./fill-empty-days-contract";
import { buildFillEmptyDaysPreview } from "./fill-empty-days-review";
import { validateHouseholdContext, type HouseholdContext } from "./household";
import { commitKitchenCommand, findKitchenCommand, getPlanningCatalogRevision, KitchenReviewStaleError } from "./kitchen-command-store";
import { kitchenCommandHash } from "./kitchen-command-validation";
import { KitchenConflictError, kitchenService } from "./kitchen-service";
import { validateKitchenWrite } from "./kitchen-validation";
import { EMPTY_KITCHEN } from "./kitchen-types";
import { householdDate } from "./private-storage";

function planningTimezone(input: FillEmptyDaysPreviewRequest, context: HouseholdContext): string {
  return context.mode === "hosted" ? context.timezone : input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Find the actual change of civil day, including short or long days at a DST transition. */
function dayExpiresAt(today: string, timezone: string): number {
  let lower = Math.floor(Date.now() / 1_000);
  let upper = lower + 48 * 3600;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (householdDate(timezone, new Date(middle * 1_000)) === today) lower = middle + 1;
    else upper = middle;
  }
  return upper;
}

async function prepare(input: FillEmptyDaysPreviewRequest, context: HouseholdContext, reviewedCatalogRevision?: number) {
  const current = await kitchenService.read(context);
  if (current.revision !== input.expectedRevision) throw new KitchenConflictError(current);
  const state = current.state ?? EMPTY_KITCHEN;
  const catalogRevision = await getPlanningCatalogRevision();
  if (reviewedCatalogRevision !== undefined && catalogRevision !== reviewedCatalogRevision) throw new KitchenReviewStaleError();
  const stored = await catalogReadService.list(1000, { forKitchen: true });
  const timezone = planningTimezone(input, context);
  const today = householdDate(timezone);
  const { expectedRevision, week, seed, preferReviewedMains } = input;
  const options = { expectedRevision, week, seed, preferReviewedMains, timezone, today, catalogRevision };
  const preview = buildFillEmptyDaysPreview({
    state, week, seed, preferReviewedMains, today,
    recipes: stored.map(item => item.recipe),
    contentHashesByRecipeId: Object.fromEntries(stored.map(item => [item.recipe.id, item.contentHash])),
    metadataByRecipeId: Object.fromEntries(stored.flatMap(item => item.metadata ? [[item.recipe.id, item.metadata]] : [])),
  });
  const usedRecipes = new Set(preview.additions.map(meal => meal.recipeId));
  const sources = stored.filter(item => usedRecipes.has(item.recipe.id))
    .map(item => ({ id: item.recipe.id, sourceId: item.sourceId, version: item.version, hash: item.contentHash, metadata: item.metadata ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const applied = preview.additions.length > 0;
  const additions = Object.fromEntries(preview.additions.map(meal => [meal.date, meal]));
  const next = applied ? { ...state, meals: { ...state.meals, ...additions } } : state;
  // The review must fit the same recipe, meal and document limits as the final write.
  validateKitchenWrite({ revision: current.revision, state: next });
  const digest = await kitchenCommandHash({ options, preview, sources, householdId: context.householdId, actorId: context.userId });
  return { current, next, applied, preview, review: { ...options, digest } };
}

export async function previewFillEmptyDays(input: FillEmptyDaysPreviewRequest, context: HouseholdContext): Promise<FillEmptyDaysPreviewResponse> {
  const { preview, review } = await prepare(input, context);
  // Recheck after the catalog request before returning shared kitchen details.
  if (review.catalogRevision !== await getPlanningCatalogRevision()) throw new KitchenReviewStaleError();
  await validateHouseholdContext(context);
  return { preview, review };
}

export async function applyFillEmptyDays(input: FillEmptyDaysApplyRequest, context: HouseholdContext) {
  const { commandId, review } = input;
  const requestHash = await kitchenCommandHash({ type: "ApplyFillEmptyDays", commandId, review });
  const existing = await findKitchenCommand(commandId, requestHash, context);
  if (existing) return existing;
  try {
    const plan = await prepare(review, context, review.catalogRevision);
    if (plan.review.digest !== review.digest || plan.review.today !== review.today || plan.review.timezone !== review.timezone) {
      throw new KitchenReviewStaleError();
    }
    return await commitKitchenCommand({
      current: plan.current, commandId, requestHash, applied: plan.applied, state: plan.next,
      reviewedPlan: { catalogRevision: review.catalogRevision, expiresAt: dayExpiresAt(review.today, plan.review.timezone) },
    }, context);
  } catch (error) {
    if (error instanceof KitchenConflictError || error instanceof KitchenReviewStaleError) {
      // A duplicate may finish between our initial lookup and revalidation.
      const concurrent = await findKitchenCommand(commandId, requestHash, context);
      if (concurrent) return concurrent;
    }
    throw error;
  }
}
