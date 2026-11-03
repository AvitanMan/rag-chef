import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const dir = await mkdtemp(join(tmpdir(), "jff-cooking-session-"));
after(() => rm(dir, { recursive: true, force: true }));
for (const name of ["cooking-session", "kitchen-validation", "kitchen-types", "quantities"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(dir, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const { COOKING_SESSION_KEY, writeCookingSession, createCookingSession, parseCookingSession, remainingTimerMs, timerAction, parseTimerDuration, stepTimerSeconds, MAX_TIMER_MS, MAX_COOKING_TIMERS, canCompleteCookingSession, finishElapsedTimers, cookingHasRunningTimer } = await import(pathToFileURL(join(dir, "cooking-session.mjs")));
const recipe = () => ({ id: "rice", title: "Test Rice", image: null, category: "Dinner", cuisine: "International", source: { name: "Wikibooks", url: "https://en.wikibooks.org/" }, sourceUrl: "https://en.wikibooks.org/wiki/Cookbook:Rice", ingredients: [{ name: "rice", measure: "100 g" }], instructions: ["Rinse rice.", "Simmer for 10 minutes."], tags: [], servings: 2 });
const planned = (source) => ({ id: "meal-1", date: "2026-10-22", recipeId: source.id, recipe: source, title: source.title, baseServings: 2, servings: 4, batches: 1, locked: false, status: "planned", ingredientOverrides: {} });
const fresh = () => { const source = recipe(); return createCookingSession(source, source.instructions, "Main method", planned(source)); };
const parse = (value) => parseCookingSession(JSON.stringify(value));

test("starting an already-cooked dinner creates an unattached session without changing its captured amounts", () => {
  const source = recipe();
  const cooked = { ...planned(source), status: "cooked", ingredientOverrides: { "0": "350 g" }, completion: { id: "done", at: "2026-10-22T10:00:00.000Z", deductions: [] } };
  const before = structuredClone(cooked);
  const session = createCookingSession(source, source.instructions, "Main method", cooked);
  assert.equal(session.plannedMeal, undefined);
  assert.deepEqual(session.recipe, source);
  assert.deepEqual(parse(session), session);
  assert.deepEqual(cooked, before);
  const next = createCookingSession(source, source.instructions, "Main method", planned(source));
  assert.deepEqual(next.plannedMeal, planned(source), "planned dinners still capture portions and overrides");
});

test("custom timer fields distinguish minute and second limits and accept up to 24 hours", () => {
  for (const [minutes, seconds, duration] of [["0", "1", 1], ["90", "15", 5415], ["1440", "0", 86400], [" 60 ", " 0 ", 3600]]) {
    assert.equal(parseTimerDuration(minutes, seconds), duration);
  }
  for (const minutes of ["", " ", "-1", "1.5", "1441", "NaN", "Infinity"]) {
    assert.throws(() => parseTimerDuration(minutes, "0"), /whole minutes from 0 to 1440/);
  }
  for (const seconds of ["", " ", "-1", "0.5", "60", "NaN", "Infinity"]) {
    assert.throws(() => parseTimerDuration("90", seconds), /whole seconds from 0 to 59/);
  }
  for (const [minutes, seconds] of [["0", "0"], ["1440", "1"]]) {
    assert.throws(() => parseTimerDuration(minutes, seconds), /between 1 second and 24 hours/);
  }
});

test("multiple named timers survive reload and simultaneous deadlines finish in one immutable update", () => {
  const session = fresh();
  session.timerLabel = "Sauce";
  session.timer = timerAction(session.timer, "start", 1000, 3000);
  session.extraTimers = [
    { ...timerAction(fresh().timer, "start", 1000, 3000), id: "rice", label: "Rice" },
    { ...timerAction(fresh().timer, "start", 1000, 10_000), id: "oven", label: "Oven" },
  ];
  const before = structuredClone(session);
  const restored = parse(session);
  assert.deepEqual(restored, before);
  assert.equal(finishElapsedTimers(restored, 2000), restored);
  const next = finishElapsedTimers(restored, 5000);
  assert.equal(next.timer.status, "finished"); assert.equal(next.extraTimers[0].status, "finished");
  assert.equal(next.extraTimers[1].status, "running"); assert.equal(remainingTimerMs(next.extraTimers[1], 5000), 6000);
  assert.equal(cookingHasRunningTimer(next), true);
  assert.deepEqual(session, before);
  assert.equal(cookingHasRunningTimer(finishElapsedTimers(next, 20_000)), false);
});

test("named timers reject corrupt labels, duplicate IDs and excessive counts while legacy sessions remain valid", () => {
  const original = fresh();
  assert.deepEqual(parse(original), original);
  const extra = { ...original.timer, id: "rice", label: "Rice" };
  for (const patch of [
    { timerLabel: "" }, { timerLabel: "x".repeat(81) }, { extraTimers: null },
    { extraTimers: [extra, extra] }, { extraTimers: [{ ...extra, id: "main" }] },
    { extraTimers: [{ ...extra, label: "" }] }, { extraTimers: [{ ...extra, status: "running", endAt: null }] },
    { extraTimers: Array.from({ length: MAX_COOKING_TIMERS }, (_, index) => ({ ...extra, id: String(index) })) },
  ]) assert.equal(parse({ ...original, ...patch }), null);
  assert.ok(parse({ ...original, extraTimers: Array.from({ length: MAX_COOKING_TIMERS - 1 }, (_, index) => ({ ...extra, id: String(index) })) }));
});

test("completion requires the same dinner and the same source and final quantities shown while cooking", () => {
  const session = fresh();
  const current = structuredClone(session.plannedMeal);
  assert.equal(canCompleteCookingSession(session, current), true);
  for (const patch of [{ id: "replacement" }, { status: "cooked" }, { servings: 8 }, { batches: 2 }, { ingredientOverrides: { "0": "350 g" } }, { recipe: { ...current.recipe, title: "Changed source" } }]) {
    assert.equal(canCompleteCookingSession(session, { ...current, ...patch }), false);
  }
  assert.equal(canCompleteCookingSession(session, undefined), false);
  assert.equal(canCompleteCookingSession(session, { ...current, locked: true }), true, "Locking does not alter cooking quantities");
});

test("a cooking session captures independent recipe, meal and directions without changing kitchen schema", () => {
  const source = recipe(); const meal = planned(source); const instructions = [...source.instructions];
  const session = createCookingSession(source, instructions, "Main method", meal);
  assert.equal(session.version, 1); assert.equal(session.step, 0); assert.equal(session.soundEnabled, false);
  assert.equal(session.timer.status, "idle"); assert.equal(session.timer.durationMs, 300_000);
  source.ingredients[0].measure = "900 g"; meal.servings = 8; instructions[0] = "Changed";
  assert.equal(session.recipe.ingredients[0].measure, "100 g"); assert.equal(session.plannedMeal.servings, 4); assert.equal(session.instructions[0], "Rinse rice.");
  assert.deepEqual(parse(session), session);
  assert.equal(Object.hasOwn(session, "schemaVersion"), false);
});

test("timer deadlines survive reload and pause/resume counts only running time", () => {
  const base = fresh().timer;
  const running = timerAction(base, "start", 100_000, 10_000);
  assert.equal(running.endAt, 110_000); assert.equal(remainingTimerMs(running, 102_500), 7500);
  const paused = timerAction(running, "pause", 102_500);
  assert.equal(paused.status, "paused"); assert.equal(paused.endAt, null); assert.equal(remainingTimerMs(paused, 999_999), 7500);
  const resumed = timerAction(paused, "start", 200_000);
  assert.equal(resumed.endAt, 207_500); assert.equal(resumed.remainingMs, 7500);
  const restored = parse({ ...fresh(), timer: resumed });
  assert.ok(restored); assert.equal(remainingTimerMs(restored.timer, 202_500), 5000);
  assert.equal(remainingTimerMs(restored.timer, 500_000), 0, "Elapsed time is measured by saved deadline, not interval ticks");
  const expired = timerAction(restored.timer, "pause", 500_000);
  assert.equal(expired.status, "finished"); assert.equal(expired.remainingMs, 0);
  assert.deepEqual(timerAction(restored.timer, "finish", 500_000), expired);
});

test("reset restores the configured duration; a changed custom duration starts a new timer", () => {
  const running = timerAction(fresh().timer, "start", 1000, 10_000);
  const paused = timerAction(running, "pause", 4000);
  const reset = timerAction(paused, "reset", 5000);
  assert.equal(reset.durationMs, 10_000); assert.equal(reset.remainingMs, 10_000); assert.equal(reset.status, "idle"); assert.equal(reset.endAt, null);
  const changed = timerAction(paused, "start", 6000, 20_000);
  assert.equal(changed.endAt, 26_000); assert.equal(changed.remainingMs, 20_000);
});

test("timer starts enforce finite duration boundaries from one second to 24 hours", () => {
  for (const duration of [0, -1000, 999, MAX_TIMER_MS + 1, NaN, Infinity, -Infinity]) assert.throws(() => timerAction(fresh().timer, "start", 1000, duration), /1 second and 24 hours/);
  for (const duration of [1000, MAX_TIMER_MS]) {
    const timer = timerAction(fresh().timer, "start", 1000, duration);
    assert.equal(timer.endAt, 1000 + duration); assert.ok(parse({ ...fresh(), timer }));
  }
});

test("corrupt, oversized and incompatible cooking snapshots are rejected without changing a valid session", () => {
  for (const input of [null, "", "null", "[]", "{", "x".repeat(2_000_001)]) assert.equal(parseCookingSession(input), null);
  const original = fresh();
  for (const mutate of [
    (s) => { s.version = 2; }, (s) => { s.id = ""; }, (s) => { s.soundEnabled = "true"; },
    (s) => { s.recipe.sourceUrl = "javascript:alert(1)"; }, (s) => { s.instructions = []; }, (s) => { s.instructions[0] = ""; },
    (s) => { s.step = 2; }, (s) => { s.step = -1; }, (s) => { s.step = 0.5; },
    (s) => { s.timer.durationMs = MAX_TIMER_MS + 1; }, (s) => { s.timer.remainingMs = s.timer.durationMs + 1; },
    (s) => { s.timer.status = "running"; s.timer.endAt = null; },
    (s) => { s.timer.status = "paused"; s.timer.endAt = 1000; },
    (s) => { s.timer.status = "finished"; s.timer.remainingMs = 1; },
    (s) => { s.plannedMeal = null; }, (s) => { s.plannedMeal.recipeId = "another"; },
    (s) => { s.plannedMeal.recipe.title = "Changed source"; }, (s) => { s.plannedMeal.servings = -1; },
  ]) { const value = structuredClone(original); mutate(value); assert.equal(parse(value), null); }
  assert.deepEqual(parse(original), original);
});

test("source timer shortcuts accept a single point duration and reject ranges, fractions, compound or ambiguous durations", () => {
  for (const [text, seconds] of [["Simmer for about 10 minutes.", 600], ["Rest 30 seconds.", 30], ["Bake 1 hour at 180 C.", 3600], ["Heat for 24 hours.", 86400]]) assert.equal(stepTimerSeconds(text), seconds, text);
  for (const text of ["Cook until tender.", "Cook 5–10 minutes.", "Cook 5-10 minutes.", "Cook 5 to 10 minutes.", "Cook 5 or 10 minutes.", "Cook 1.5 minutes.", "Cook 1/2 hour.", "Cook 1½ hours.", "Cook 1 hour 30 minutes.", "Simmer 5 minutes, then rest 10 minutes.", "Wait 0 seconds.", "Cook 25 hours."]) assert.equal(stepTimerSeconds(text), null, text);
  for (const text of ["Simmer between 5 and 10 minutes.", "Rest between 20 and 30 seconds.", "Bake between 1 and 2 hours.", "Simmer BETWEEN 5 AND 10 minutes.", "Rest between 5\nand\n10 minutes."]) assert.equal(stepTimerSeconds(text), null, text);
});


test("stale tabs cannot replace, edit or delete another cooking snapshot", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, text) => values.set(key, text), removeItem: key => values.delete(key) };
  const active = fresh(); active.step = 1; active.timer = timerAction(active.timer, "start", 1000, 600000);
  const first = writeCookingSession(storage, null, active);
  assert.equal(first.saved, true);
  for (const next of [fresh(), null]) {
    assert.deepEqual(writeCookingSession(storage, null, next), { saved: false, stored: first.stored });
    assert.deepEqual(parseCookingSession(storage.getItem(COOKING_SESSION_KEY)), active);
  }
  const paused = { ...active, timer: timerAction(active.timer, "pause", 2000) };
  const second = writeCookingSession(storage, first.stored, paused);
  assert.equal(second.saved, true);
  assert.equal(writeCookingSession(storage, first.stored, { ...active, step: 0 }).saved, false);
  assert.equal(writeCookingSession(storage, first.stored, null).saved, false);
  assert.deepEqual(parseCookingSession(storage.getItem(COOKING_SESSION_KEY)), paused);
  assert.equal(writeCookingSession(storage, second.stored, null).saved, true);
  assert.equal(storage.getItem(COOKING_SESSION_KEY), null);
});
