import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { gradeJourneyAnswer, parseJourneyOptions, summarizeJourneys } from "../tools/recipes/journey-grading.mjs";
import { journeyCases, journeyTitles } from "../tools/recipes/journey-cases.mjs";
import { fixtureSql } from "../tools/testing/fixtures.mjs";

const source = { id: "bake", title: "Bake", source: { name: "Original test", url: "https://example.invalid/bake" }, sourceUrl: "https://example.invalid/bake", ingredients: [{ name: "pasta", measure: "400 g" }], instructions: ["Bake at 180°C for 20 minutes."] };
const data = () => ({ recipes: [structuredClone(source)], recommendations: [{ recipeId: "bake", reason: "A source-backed dinner." }], sourceFacts: [{ recipeId: "bake", evidenceId: "S1", fact: source.instructions[0] }], citations: [{ recipeId: "bake", title: "Bake", sourceName: source.source.name, sourceUrl: source.sourceUrl }], selectedEvidenceByRecipeId: { bake: ["S1"] }, answer: "Bake at 180°C for 20 minutes.", answerStatus: "answered", generation: "ai", verification: { status: "checked" }, chefChanges: [], readinessByRecipeId: { bake: { coveredCount: 1, shopping: [] } } });
const expected = { only: "bake", first: "bake", minRecommendations: 1, factual: true, evidence: ["S1"], answerPatterns: ["180", "20 minutes"], readiness: { coveredCount: 1 } };
const grade = (answer, expectation = expected, unchanged = true) => gradeJourneyAnswer({ status: 200, data: answer, expected: expectation, catalog: [source], aliases: { bake: source }, unchanged });
const failed = rows => rows.filter(row => !row.passed).map(row => row.name);

test("journey grading requires expected answers as well as exact canonical evidence", () => {
  assert.deepEqual(failed(grade(data())), []);
  for (const [mutate, failure] of [
    [answer => { answer.answer = "Bake at 250°C for 5 minutes."; }, "expected_answer:180"],
    [answer => { answer.sourceFacts[0].fact = "An invented source quote."; }, "exact_selected_quotes"],
    [answer => { answer.selectedEvidenceByRecipeId.bake = []; }, "exact_selected_quotes"],
    [answer => { answer.sourceFacts[0].recipeId = "another"; }, "valid_references"],
    [answer => { answer.recipes[0].instructions[0] = "Changed."; }, "canonical_recipes"],
    [answer => { answer.citations[0].sourceUrl = "https://example.invalid/invented"; }, "canonical_citations"],
    [answer => { answer.citations = []; }, "source_links_present"],
    [answer => { answer.sourceFacts = []; }, "supported_answer_available"],
    [answer => { answer.chefChanges = [{ recipeId: "bake", change: "Use another ingredient" }]; }, "no_unsolicited_changes"],
    [answer => { answer.verification.status = "unavailable"; }, "pipeline_evidence_check"],
  ]) { const answer = data(); mutate(answer); assert.ok(failed(grade(answer)).includes(failure), failure); }
  assert.ok(failed(grade(data(), expected, false)).includes("kitchen_unchanged"));
});

test("journey grading distinguishes correct refusals, wrong recipes, and stale-context rejection", () => {
  const refusal = { ...data(), answerStatus: "unsupported", recommendations: [], sourceFacts: [], generation: "catalog_fallback" };
  assert.deepEqual(failed(grade(refusal, { only: "bake", status: "unsupported", generation: "catalog_fallback", maxRecommendations: 0 })), []);
  const stale = gradeJourneyAnswer({ status: 409, data: { error: { code: "context_changed" } }, expected: { httpStatus: 409, errorCode: "context_changed" }, unchanged: true });
  assert.deepEqual(failed(stale), []);
  const answer = data(); answer.recipes = []; answer.recommendations = [];
  assert.ok(failed(grade(answer)).includes("recipe_scope"));
  assert.ok(failed(grade(answer)).includes("useful_suggestions"));
});

test("empty or blocked runs cannot pass and latency uses actual answer groups", () => {
  const empty = summarizeJourneys([], 60_000);
  assert.equal(empty.qualityPassed, false); assert.equal(empty.latencyPassed, false); assert.equal(empty.factualTurnPassRate, null);
  const blocked = { id: "blocked", kind: "ask", category: "factual", executed: false, passed: false, checks: [] };
  const good = { id: "good", kind: "ask", category: "factual", generation: "ai", executed: true, passed: true, milliseconds: 70_000, factCount: 1, checks: [{ name: "exact_selected_quotes", passed: true }, { name: "kitchen_unchanged", passed: true }] };
  const refusal = { id: "refusal", kind: "ask", category: "control", expectedStatus: "unsupported", executed: true, passed: true, milliseconds: 10, checks: [] };
  const result = summarizeJourneys([{ steps: [good, blocked, refusal] }], 60_000);
  assert.equal(result.factualTurnPassRate, 0.5); assert.equal(result.exactQuoteTurnRate, 1);
  assert.equal(result.blocked, 1); assert.equal(result.qualityPassed, false); assert.equal(result.latencyPassed, false);
  assert.equal(result.latency.factual.p95Ms, 70_000); assert.equal(result.latency.refusal.p95Ms, 10);
  assert.equal(summarizeJourneys([{ steps: [{ kind: "action", passed: true }] }], 60_000).qualityPassed, false);
  const broken = summarizeJourneys([{ steps: [good, { ...good, error: "Timed out", generation: undefined, milliseconds: 900000, timingReliable: false, checks: [] }] }], 100000);
  const controls = summarizeJourneys([{ steps: [{ kind: "ask", category: "control", executed: true, passed: true, milliseconds: 5 }] }], 60000);
  assert.equal(controls.latencyApplicable, false); assert.equal(controls.latencyPassed, true);
  assert.equal(broken.latencyPassed, false); assert.equal(broken.executionFailures, 1); assert.equal(broken.unreliableTimings, 1);
  assert.equal(broken.kitchenChecks.unchecked, 1); assert.equal(broken.latency.modelAttempted.count, 1);
});

test("journey manifests keep fixed unique labels, real follow-ups and isolated fixture opt-in", () => {
  assert.equal(journeyCases.length, 9);
  assert.equal(new Set(journeyCases.map(row => row.id)).size, 9);
  let turns = 0;
  for (const journey of journeyCases) {
    assert.equal(new Set(journey.steps.map(row => row.id)).size, journey.steps.length);
    for (const step of journey.steps) {
      if (step.action) continue;
      turns++; assert.ok(step.query && step.expect);
      for (const pattern of [...(step.expect.answerPatterns ?? []), ...(step.expect.forbiddenAnswerPatterns ?? [])]) assert.doesNotThrow(() => new RegExp(pattern));
    }
  }
  assert.equal(turns, 24);
  assert.ok(journeyCases.some(journey => journey.steps.some(step => step.requiresMultipleChoices)));
  assert.ok(journeyCases.some(journey => journey.steps.some(step => step.purpose === "cooking")));
  assert.equal(Object.keys(journeyTitles).length, 2);
  assert.doesNotMatch(fixtureSql(), /journey-pasta-bake/);
  assert.match(fixtureSql({ journeys: true }), /journey-pasta-bake/);
  assert.match(fixtureSql({ journeys: true }), /INSERT INTO recipe_metadata/);
});

test("journey options reject remote corpus choices, missing arguments and invalid budgets", () => {
  assert.deepEqual(parseJourneyOptions([]), { catalog: "fixtures", model: "qwen3.5:9b", latencyBudgetMs: 60_000 });
  assert.equal(parseJourneyOptions(["--journey", "stock-reservations"]).journey, "stock-reservations");
  assert.throws(() => parseJourneyOptions(["--journey", "unknown-journey"]));
  assert.equal(parseJourneyOptions(["--catalog", "local", "--latency-budget-ms", "45000"]).latencyBudgetMs, 45_000);
  for (const args of [["--catalog", "https://example.com"], ["--model"], ["--latency-budget-ms", "NaN"], ["--latency-budget-ms", "0"], ["--unknown", "value"]]) assert.throws(() => parseJourneyOptions(args));
});

test("local snapshot includes committed WAL data and cannot overwrite the source", { skip: spawnSync("python3", ["--version"]).status !== 0 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "journey-snapshot-"));
  const helper = fileURLToPath(new URL("../tools/testing/snapshot-local-catalog.py", import.meta.url));
  const keeper = spawn("python3", ["-u", "-c", `import sqlite3,sys,pathlib
folder=pathlib.Path(sys.argv[1])/'.wrangler/state/v3/d1/miniflare-D1DatabaseObject';folder.mkdir(parents=True)
db=sqlite3.connect(folder/'fixture.sqlite');db.execute('pragma journal_mode=wal');db.execute('create table recipes (title text)');db.execute('create table kitchen_state (revision integer)');db.commit();db.execute('pragma wal_checkpoint(truncate)');db.execute("insert into recipes values ('wal-committed-record')");db.commit();print('ready',flush=True);sys.stdin.readline();db.close()`, root]);
  try {
    await new Promise((accept, reject) => { keeper.stdout.once("data", accept); keeper.once("error", reject); keeper.once("exit", code => reject(new Error(`SQLite fixture exited early: ${code}`))); });
    const destination = join(root, "copy");
    const run = mode => spawnSync("python3", [helper, mode, root, destination], { encoding: "utf8" });
    const before = run("snapshot"); assert.equal(before.status, 0, before.stderr);
    const copied = join(destination, "v3/d1/miniflare-D1DatabaseObject/fixture.sqlite");
    const contents = spawnSync("python3", ["-c", "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select title from recipes').fetchone()[0])", copied], { encoding: "utf8" });
    assert.equal(contents.stdout.trim(), "wal-committed-record");
    assert.deepEqual(JSON.parse(run("fingerprint").stdout), JSON.parse(before.stdout));
    const unsafe = spawnSync("python3", [helper, "snapshot", root, join(root, ".wrangler/state")], { encoding: "utf8" });
    assert.equal(unsafe.status, 1); assert.match(unsafe.stderr, /new disposable directory/);
  } finally { const closed = keeper.exitCode === null ? new Promise(accept => keeper.once("exit", accept)) : Promise.resolve(); keeper.stdin.end("done\n"); await closed; await rm(root, { recursive: true, force: true }); }
});

test("calculated journey facts require exact saved amounts, source IDs and zero model calls", () => {
  const expectation = { only: "bake", calculated: [{ ingredientIndex: 0, measure: "200 g", basis: "source_scaled" }], maxRecommendations: 0 };
  const answer = { ...data(), answerKind: "planning_quantities", recommendations: [], generation: "catalog_fallback", verification: { status: "not_required" }, timings: { generationMs: 0, verificationMs: 0 }, planningFacts: [{ recipeId: "bake", ingredientIndex: 0, sourceEvidenceId: "I1", name: "pasta", measure: "200 g", needsReview: false, basis: "source_scaled" }], sourceFacts: [{ recipeId: "bake", evidenceId: "I1", fact: "400 g pasta" }], selectedEvidenceByRecipeId: { bake: ["I1"] } };
  assert.deepEqual(failed(grade(answer, expectation)), []);
  for (const mutate of [row => row.planningFacts[0].measure = "400 g", row => row.planningFacts[0].basis = "saved_override", row => row.planningFacts[0].sourceEvidenceId = "I2"]) {
    const wrong = structuredClone(answer); mutate(wrong); assert.ok(failed(grade(wrong, expectation)).includes("exact_planning_amounts"));
  }
  const generated = structuredClone(answer); generated.timings.generationMs = 1;
  assert.ok(failed(grade(generated, expectation)).includes("no_model_calls"));
});
