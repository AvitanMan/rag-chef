import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
const dir = await mkdtemp(join(tmpdir(), "chef-plan-"));
after(() => rm(dir, { recursive: true, force: true }));
// All pure helper imports use their production implementation.
for (const file of (await readdir(new URL('../app/lib/', import.meta.url))).filter(name => name.endsWith('.ts'))) {
  const source = await readFile(new URL(`../app/lib/${file}`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
  await writeFile(join(dir, file.replace('.ts', '.mjs')), code);
}
const { buildChefPlanDraft, applyChefPlanDraft, validatePlanIntent } = await import(pathToFileURL(join(dir, 'chef-plan.mjs')));
const { resolveChefPlanIntent } = await import(pathToFileURL(join(dir, 'chef-plan-intent.mjs')));
const { createPlannedMeal } = await import(pathToFileURL(join(dir, 'kitchen-state.mjs')));
const { shoppingForWeek } = await import(pathToFileURL(join(dir, 'shopping-purchases.mjs')));
const { DEFAULT_COOKING_PROFILE } = await import(pathToFileURL(join(dir, 'kitchen-types.mjs')));
const recipe = (id, name = id, measure = '100 g', servings = 2) => ({ id, title: `Dinner ${id}`, ingredients: [{ name, measure }], instructions: ['Follow source directions.'], servings, source: { name: 'Original test', url: 'https://example.com' }, sourceUrl: 'https://example.com', tags: [], image: null, category: 'Dinner', cuisine: 'Home' });
const intent = (patch = {}) => ({ week: '2026-11-02', today: '2026-11-03', count: 2, dates: [], servings: null, batches: null, excludedIngredients: [], diets: [], excludedEquipment: [], priority: 'use_soon', allowRepeats: false, replaceDates: [], keepDates: [], perDate: {}, ...patch });
const kitchen = (pantry = [], meals = {}) => ({ schemaVersion: 2, pantry, meals, cookingProfile: { ...DEFAULT_COOKING_PROFILE }, shoppingChecked: {}, migratedLegacy: true });
const catalog = (recipes) => ({ recipes, metadata: {}, contentHashes: Object.fromEntries(recipes.map(row => [row.id, 'test-source-hash'])) });
const input = (recipes, options = {}) => ({ kitchen: kitchen(), revision: 3, catalog: catalog(recipes), intent: intent(), ...options });
const stock = (id, name, measure, useBy) => ({ id, name, measure, ...(useBy ? { useBy } : {}) });
// The review digest detects accidental edits; it is public, so Apply must also
// validate the requested targets and pinned identities independently of it.
async function rehashReview(draft, catalog) {
  const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
  const { version, kitchenRevision, intent, changes, shopping, beforeShopping, unresolved, warnings } = draft;
  const metadata = changes.map(change => ({ id: change.meal.recipeId, metadata: catalog.metadata[change.meal.recipeId] ?? null, contentHash: catalog.contentHashes[change.meal.recipeId] ?? null }));
  draft.reviewHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable({ version, kitchenRevision, intent, changes, shopping, beforeShopping, unresolved, warnings, metadata })))).toString('hex');
}

test('draft is deterministic, read-only, and Apply matches its complete shopping preview', async () => {
  const data = input([recipe('rice'), recipe('beans'), recipe('pasta')], { kitchen: kitchen([stock('rice', 'rice', '150 g')]) });
  const before = structuredClone(data);
  const first = await buildChefPlanDraft(data), second = await buildChefPlanDraft(data);
  assert.deepEqual(first, second); assert.deepEqual(data, before);
  assert.equal(first.changes.length, 2); assert.deepEqual(first.changes.map(row => row.date), ['2026-11-03', '2026-11-04']); assert.deepEqual(first.intent.dates, ['2026-11-03', '2026-11-04']);
  const next = await applyChefPlanDraft({ ...data, draft: first });
  assert.deepEqual(shoppingForWeek(next, first.intent.week, first.intent.today), first.shopping);
  assert.deepEqual(next.pantry, before.kitchen.pantry); assert.deepEqual(data, before);
  await assert.rejects(applyChefPlanDraft({ ...data, revision: 4, kitchen: next, draft: first }), /changed/);
});

test('uses confirmed due-soon stock before alphabetical choice and avoids expired stock', async () => {
  const data = input([recipe('a-rice', 'rice'), recipe('z-beans', 'beans')], { intent: intent({ count: 1 }), kitchen: kitchen([stock('rice', 'rice', '100 g'), stock('beans', 'beans', '100 g', '2026-11-03')]) });
  assert.equal((await buildChefPlanDraft(data)).changes[0].meal.recipeId, 'z-beans');
  data.kitchen.pantry[1].useBy = '2026-11-02';
  const expired = await buildChefPlanDraft(data); assert.equal(expired.changes[0].meal.recipeId, 'a-rice');
  assert.equal(expired.changes[0].readiness.useSoonCoverage, 0);
});

test('later saved dinner stock is reserved and duplicate batches are never spent twice', async () => {
  const saved = createPlannedMeal('2026-11-06', recipe('saved', 'rice'));
  const data = input([recipe('rice', 'rice'), recipe('beans', 'beans')], { kitchen: kitchen([stock('r', 'rice', '100 g')], { [saved.date]: saved }), intent: intent({ count: 1 }) });
  const draft = await buildChefPlanDraft(data); assert.equal(draft.changes[0].meal.recipeId, 'beans');
  const next = await applyChefPlanDraft({ ...data, draft }); assert.deepEqual(next.meals[saved.date], saved);
  const shared = input([recipe('a', 'rice'), recipe('b', 'rice')], { kitchen: kitchen([stock('r1', 'rice', '75 g'), stock('r2', 'rice', '75 g')]) });
  const preview = await buildChefPlanDraft(shared);
  assert.equal(preview.shopping[0].measure, '50 g'); assert.equal(preview.changes[1].readiness.partialCount, 1);
});

test('unknown amounts and incompatible units stay reviewable rather than fully covered', async () => {
  const data = input([recipe('oil', 'oil', 'to taste'), recipe('flour', 'flour', '100 g')], { kitchen: kitchen([stock('oil', 'oil', '500 ml'), stock('flour', 'flour', '1 cup')]) });
  const draft = await buildChefPlanDraft(data);
  assert.equal(draft.changes.find(row => row.meal.recipeId === 'oil').readiness.reviewCount, 1);
  assert.equal(draft.changes.find(row => row.meal.recipeId === 'flour').readiness.coveredCount, 0);
  assert.ok(draft.shopping.every(row => row.needsReview || row.pantryMeasure !== row.requiredMeasure));
});

test('unknown yields require explicit batches when servings were requested', async () => {
  const unknown = recipe('unknown'); delete unknown.servings;
  const data = input([unknown], { intent: intent({ count: 1, servings: 4 }) });
  const draft = await buildChefPlanDraft(data); assert.equal(draft.changes.length, 0); assert.match(draft.unresolved.join(' '), /batch/);
  data.intent = intent({ count: 1, batches: 1.5 });
  const batch = await buildChefPlanDraft(data); assert.equal(batch.changes[0].meal.batches, 1.5);
  const next = await applyChefPlanDraft({ ...data, draft: batch }); assert.equal(next.meals['2026-11-03'].servings, null);
});

test('allergies, diets, unavailable equipment, and source-backed times are hard constraints', async () => {
  const data = input([recipe('nut', 'peanuts'), recipe('beef'), recipe('rice')], { intent: intent({ count: 2, diets: ['vegetarian'], maxTotalMinutes: 20 }) });
  data.kitchen.cookingProfile.allergies = ['peanuts'];
  const metadata = { revision: 1, sourceContentHash: 'test-source-hash', coreDinner: true, dinnerRole: 'main', diets: { vegan: 'unknown', vegetarian: 'unknown', gluten_free: 'unknown', low_carb: 'unknown' }, totalMinutes: 15, equipment: ['Stovetop'], provenance: { totalMinutes: { basis: 'curator_estimate', evidence: 'estimate' } }, reviewedBy: 'Test', reviewedAt: '2026-11-03' };
  for (const row of data.catalog.recipes) data.catalog.metadata[row.id] = structuredClone(metadata);
  assert.equal((await buildChefPlanDraft(data)).changes.length, 0);
  data.catalog.metadata.rice.provenance.totalMinutes.basis = 'source';
  const draft = await buildChefPlanDraft(data); assert.deepEqual(draft.changes.map(row => row.meal.recipeId), ['rice']); assert.ok(draft.unresolved.length);
  data.intent.excludedEquipment = ['Stovetop']; assert.equal((await buildChefPlanDraft(data)).changes.length, 0);
});

test('saved dinners require explicit replacement and locked/cooked dinners stay protected', async () => {
  const saved = createPlannedMeal('2026-11-03', recipe('old'));
  const data = input([recipe('new')], { kitchen: kitchen([], { [saved.date]: saved }), intent: intent({ count: 1, dates: [saved.date] }) });
  assert.equal((await buildChefPlanDraft(data)).changes.length, 0);
  data.intent.replaceDates = [saved.date]; const draft = await buildChefPlanDraft(data); assert.equal(draft.changes.length, 1);
  for (const patch of [{ locked: true }, { status: 'cooked' }]) {
    const altered = { ...data, kitchen: kitchen([], { [saved.date]: { ...saved, ...patch } }) };
    assert.equal((await buildChefPlanDraft(altered)).changes.length, 0);
    await assert.rejects(applyChefPlanDraft({ ...altered, draft }), /protected|changed/);
  }
});

test('draft follow-ups preserve kept recipes/portions and change only requested days', async () => {
  const data = input([recipe('a'), recipe('b'), recipe('c'), recipe('d')]);
  const first = await buildChefPlanDraft(data);
  const revised = await buildChefPlanDraft({ ...data, previousDraft: first, intent: intent({ dates: first.changes.map(row => row.date), replaceDates: ['2026-11-04'], keepDates: ['2026-11-03'], servings: 4 }) });
  assert.equal(revised.changes[0].meal.recipeId, first.changes[0].meal.recipeId);
  assert.equal(revised.changes[0].meal.servings, first.changes[0].meal.servings);
  assert.notEqual(revised.changes[1].meal.recipeId, first.changes[1].meal.recipeId);
  assert.equal(revised.changes[1].meal.servings, 4);
  const next = await applyChefPlanDraft({ ...data, draft: revised }); assert.deepEqual(shoppingForWeek(next, revised.intent.week, revised.intent.today), revised.shopping);
  // The UI consumes the previous turn's swap command before later manual edits.
  const resized = await buildChefPlanDraft({ ...data, previousDraft: revised, intent: { ...revised.intent, replaceDates: [], authorizedReplacementDates: [], servings: 6 } });
  assert.deepEqual(resized.changes.map(row => row.meal.recipeId), revised.changes.map(row => row.meal.recipeId));
  assert.equal(resized.changes[1].meal.servings, 6);
});

test('review hash binds quantities, shopping, source versions and reviewed metadata', async () => {
  const data = input([recipe('a')], { intent: intent({ count: 1 }) }); const draft = await buildChefPlanDraft(data);
  for (const mutate of [row => row.changes[0].meal.servings = 99, row => row.shopping[0].measure = '1 g', row => row.intent.servings = 8, row => row.changes[0].expectedMealId = 'other']) {
    const changed = structuredClone(draft); mutate(changed); await assert.rejects(applyChefPlanDraft({ ...data, draft: changed }), /changed/);
  }
  const altered = structuredClone(data); altered.catalog.recipes[0].instructions = ['New source direction.'];
  await assert.rejects(applyChefPlanDraft({ ...altered, draft }), /changed/);
  const metadata = structuredClone(data); metadata.catalog.contentHashes.a = 'new-source-hash';
  await assert.rejects(applyChefPlanDraft({ ...metadata, draft }), /changed/);
});

test('Apply enforces the reviewed dates and pinned recipe even with a recomputed public digest', async () => {
  const data = input([recipe('a'), recipe('b')], { intent: intent({ count: 1 }) });
  const draft = await buildChefPlanDraft(data);
  for (const mutate of [row => row.intent.dates = ['2026-11-04'], row => row.intent.perDate['2026-11-03'] = { recipeId: 'b' }]) {
    const altered = structuredClone(draft); mutate(altered); await rehashReview(altered, data.catalog);
    await assert.rejects(applyChefPlanDraft({ ...data, draft: altered }), error => error.status === 409);
  }
  assert.deepEqual(data.kitchen.meals, {});
});

test('Keep freezes the reviewed recipe identity and releasing it allows a newly scoped diet', async () => {
  const data = input([recipe('a-beef', 'beef'), recipe('b-rice', 'rice')], { intent: intent({ count: 1 }) });
  const first = await buildChefPlanDraft(data), day = first.changes[0].date;
  const kept = await buildChefPlanDraft({ ...data, previousDraft: first, intent: intent({ count: 1, dates: [day], keepDates: [day], perDate: { [day]: { recipeId: 'b-rice' } } }) });
  assert.equal(kept.changes[0].meal.recipeId, 'a-beef');
  assert.equal(kept.intent.perDate[day].recipeId, 'a-beef');
  await applyChefPlanDraft({ ...data, draft: kept });
  const released = await buildChefPlanDraft({ ...data, previousDraft: kept, intent: { ...kept.intent, keepDates: [], perDate: { ...kept.intent.perDate, [day]: { ...kept.intent.perDate[day], diet: 'vegetarian' } } } });
  assert.equal(released.changes[0].meal.recipeId, 'b-rice');
  assert.equal(released.intent.perDate[day].recipeId, undefined);
  await applyChefPlanDraft({ ...data, draft: released });
});

test('small catalogs produce safe partial drafts and repeats require an explicit preference', async () => {
  const data = input([recipe('a')]); const partial = await buildChefPlanDraft(data);
  assert.equal(partial.changes.length, 1); assert.equal(partial.unresolved.length, 1);
  assert.equal(Object.keys((await applyChefPlanDraft({ ...data, draft: partial })).meals).length, 1);
  data.intent.allowRepeats = true; const repeated = await buildChefPlanDraft(data); assert.equal(repeated.changes.length, 2);
});

test('reject invalid dates, bounds, invalid diets and contradictory keep/replace requests', () => {
  for (const patch of [{ week: '2026-11-03' }, { today: '2026-02-29' }, { count: 8 }, { dates: ['2026-11-09'] }, { dates: ['2026-11-02'] }, { servings: 0 }, { batches: 0.3 }, { diets: ['made-up'] }, { keepDates: ['2026-11-04'], replaceDates: ['2026-11-04'] }, { perDate: { '2026-11-04': { servings: 2, batches: 2 } } }]) assert.throws(() => validatePlanIntent(intent(patch)));
});

test('batch scaling cannot create invalid servings on a recipe with a known yield', async () => {
  for (const [yieldCount, batches] of [[2, 0.25], [100, 20]]) {
    const data = input([recipe('rice', 'rice', '100 g', yieldCount)], { intent: intent({ count: 1, batches }) });
    const draft = await buildChefPlanDraft(data); assert.equal(draft.changes.length, 0); assert.ok(draft.unresolved.length);
  }
});

test('malformed previews produce a validation error rather than a hash-time exception', async () => {
  const data = input([recipe('a')], { intent: intent({ count: 1 }) }); const draft = await buildChefPlanDraft(data);
  for (const patch of [{ changes: [null] }, { changes: [{}] }, { changes: [{ meal: null }] }, { warnings: null }, { shopping: 'not shopping' }]) {
    await assert.rejects(applyChefPlanDraft({ ...data, draft: { ...draft, ...patch } }), error => error.status === 400);
  }
});

test('later revisions preserve authorization and identity for already reviewed saved replacements', async () => {
  const saved = createPlannedMeal('2026-11-03', recipe('old'));
  const data = input([recipe('old'), recipe('new'), recipe('third')], { kitchen: kitchen([], { [saved.date]: saved }), intent: intent({ count: 1, dates: [saved.date], replaceDates: [saved.date] }) });
  const first = await buildChefPlanDraft(data);
  const revised = await buildChefPlanDraft({ ...data, previousDraft: first, intent: intent({ count: 1, dates: [saved.date], servings: 4 }) });
  assert.equal(revised.changes.length, 1); assert.equal(revised.changes[0].meal.recipeId, first.changes[0].meal.recipeId);
  assert.equal(revised.changes[0].meal.servings, 4); assert.deepEqual(revised.intent.authorizedReplacementDates, [saved.date]);
  assert.equal((await applyChefPlanDraft({ ...data, draft: revised })).meals[saved.date].servings, 4);
});

test('a newly scoped diet can replace an incompatible draft recipe while keeping other days', async () => {
  const data = input([recipe('a-beef', 'beef'), recipe('b-rice', 'rice'), recipe('c-lentils', 'lentils')]);
  const first = await buildChefPlanDraft(data);
  assert.equal(first.changes[0].meal.recipeId, 'a-beef');
  const revised = await buildChefPlanDraft({ ...data, previousDraft: first, intent: intent({ dates: first.changes.map(row => row.date), perDate: { '2026-11-03': { diet: 'vegetarian' } } }) });
  assert.equal(revised.changes[0].meal.recipeId, 'c-lentils');
  assert.equal(revised.changes[1].meal.recipeId, first.changes[1].meal.recipeId);
  await applyChefPlanDraft({ ...data, draft: revised });
});


test('keeping a previously reviewed saved replacement preserves its identity and applies', async () => {
  const saved = createPlannedMeal('2026-11-03', recipe('old'));
  const data = input([recipe('old'), recipe('new')], { kitchen: kitchen([], { [saved.date]: saved }), intent: intent({ count: 1, dates: [saved.date], replaceDates: [saved.date] }) });
  const first = await buildChefPlanDraft(data);
  const revised = await buildChefPlanDraft({ ...data, previousDraft: first, intent: intent({ count: 1, dates: [saved.date], keepDates: [saved.date] }) });
  assert.deepEqual(revised.changes[0].meal, first.changes[0].meal);
  assert.equal((await applyChefPlanDraft({ ...data, draft: revised })).meals[saved.date].recipeId, 'new');
});

test('manual controls can revoke a previously reviewed saved replacement', async () => {
  const saved = createPlannedMeal('2026-11-03', recipe('old'));
  const data = input([recipe('old'), recipe('new')], { kitchen: kitchen([], { [saved.date]: saved }), intent: intent({ count: 1, dates: [saved.date], replaceDates: [saved.date] }) });
  const first = await buildChefPlanDraft(data);
  const revised = await buildChefPlanDraft({ ...data, previousDraft: first, intent: intent({ count: 1, dates: [saved.date], authorizedReplacementDates: [] }) });
  assert.equal(revised.changes.length, 0); assert.match(revised.unresolved.join(' '), /preserved/);
});

test('count expansion retains later draft dates and scoped controls while filling only empty dates', async () => {
  const saved = createPlannedMeal('2026-11-05', recipe('saved'));
  for (const controls of [{}, { keepDates: ['2026-11-03'], perDate: { '2026-11-08': { diet: 'vegetarian', servings: 4 } } }]) {
    const data = input(['a', 'b', 'c', 'd', 'e'].map(id => recipe(id, 'rice')), { kitchen: kitchen([], { [saved.date]: saved }), intent: intent({ count: 2, dates: ['2026-11-03', '2026-11-08'], ...controls }) });
    const first = await buildChefPlanDraft(data);
    const expandedIntent = resolveChefPlanIntent('Plan four dinners', first.intent).intent;
    assert.deepEqual(expandedIntent.dates, []);
    const expanded = await buildChefPlanDraft({ ...data, previousDraft: first, intent: expandedIntent });
    assert.deepEqual(expanded.intent.dates, ['2026-11-03', '2026-11-04', '2026-11-06', '2026-11-08']);
    assert.equal(expanded.changes.length, 4); assert.deepEqual(expanded.unresolved, []);
    for (const prior of first.changes) assert.deepEqual(expanded.changes.find(change => change.date === prior.date).meal, prior.meal);
    const next = await applyChefPlanDraft({ ...data, draft: expanded });
    assert.deepEqual(next.meals[saved.date], saved);
  }
});
