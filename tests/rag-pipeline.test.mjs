import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { ragCases, ragRecipes } from "../tools/recipes/rag-cases.mjs";
const directory = await mkdtemp(join(tmpdir(), "rag-pipeline-"));
after(() => rm(directory, { recursive: true, force: true }));
for (const name of ["retrieval-ranking", "chef-evidence", "chef-context", "chef-verification", "recipe-embeddings", "quantities", "kitchen-types"]) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(directory, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
}
const load = (name) => import(pathToFileURL(join(directory, `${name}.mjs`)).href);
const { bm25Scores, reciprocalRanks, retrievalTerms } = await load("retrieval-ranking");
const { selectRecipeEvidence } = await load("chef-evidence");
const { precomputeRecipeStepEmbeddings } = await load("recipe-embeddings");
const { verificationClaims, validateVerification, verifyChefAnswer } = await load("chef-verification");
const recipe = ragRecipes[0];
const answer = { answer: "Rest the dough before rolling it.", sourceFacts: [], chefChanges: [], recommendations: [], citations: [], warnings: [] };
const evidence = [{ recipeId: recipe.id, evidenceId: "S12", text: recipe.instructions[11] }];

test("field BM25 weights titles and ingredients and RRF combines independent rankings", () => {
  const scores = bm25Scores([{ id: "title", title: "mushroom", ingredients: "", other: "" }, { id: "ingredient", title: "", ingredients: "mushroom", other: "" }, { id: "other", title: "", ingredients: "", other: "mushroom" }], "mushrooms");
  assert.ok(scores.get("title") > scores.get("ingredient")); assert.ok(scores.get("ingredient") > scores.get("other"));
  const fused = reciprocalRanks([["a", "b", "b"], ["b", "a"]]);
  assert.equal(fused.get("a"), 1 / 61 + 1 / 62); assert.equal(fused.get("b"), fused.get("a"));
  assert.equal(reciprocalRanks([["a", "b"]], 1).has("b"), false);
  assert.deepEqual(retrievalTerms("Black-Eyed Peas"), ["bean"]);
  assert.ok(!retrievalTerms("rice noodles").includes("rice"));
  assert.ok(!retrievalTerms("rice stick noodles").includes("rice"));
  assert.ok(retrievalTerms("rice noodles").includes(retrievalTerms("noodles")[0]));
});
test("whole step vectors refresh incrementally and never rewrite recipe source", async () => {
  const source = { ...recipe, instructions: ["Mix the ingredients.", "Rest for 20 minutes."] }, before = structuredClone(source), calls = [];
  const options = { model: "test", fetchImpl: async (_url, request) => { const body = JSON.parse(request.body); calls.push(body); return Response.json({ embeddings: body.input.map(() => [1, 2, 3]) }); } };
  const first = await precomputeRecipeStepEmbeddings([source], [], options);
  assert.equal(first.completedCount, 2); assert.deepEqual(first.embeddings.map((row) => row.chunkIndex), [0, 1]);
  assert.ok(first.embeddings.every((row) => row.kind === "recipe-step-v1")); assert.equal(calls[0].truncate, false);
  assert.match(calls[0].input[1], /Source step 2: Rest for 20 minutes\.$/);
  assert.equal((await precomputeRecipeStepEmbeddings([source], first.embeddings, options)).requestedCount, 0);
  assert.equal(calls.length, 1);
  assert.equal((await precomputeRecipeStepEmbeddings([source], [{ ...first.embeddings[0], vector: [] }, first.embeddings[1]], options)).requestedCount, 1);
  assert.equal((await precomputeRecipeStepEmbeddings([{ ...source, instructions: ["Changed."] }], first.embeddings, options)).requestedCount, 1);
  assert.deepEqual(source, before);
});
test("semantic step retrieval finds paraphrases and obeys whole-chunk budgets", () => {
  const source = { ...recipe, instructions: Array.from({ length: 200 }, (_, index) => index === 149 ? "Slowly whisk oil to form an emulsion." : `Direction ${index + 1}: ${"Arrange preparation items. ".repeat(8)}`) };
  const vectors = new Map(source.instructions.map((_, index) => [index, index === 149 ? [1, 0] : [0, 1]]));
  const selection = selectRecipeEvidence(source, "How does it become smooth?", { vectors, queryVector: [1, 0], budget: 3000 });
  assert.equal(selection.method, "semantic_steps"); assert.ok(selection.coreStepIds.includes("S150"));
  assert.ok(selection.items.some((item) => item.evidenceId === "S150" && item.text === source.instructions[149]));
  assert.ok(selection.items.reduce((sum, item) => sum + item.text.length, 0) <= 3000); assert.equal(selection.complete, false);
  const active = selectRecipeEvidence(source, "Explain this step", { stepId: "S150", vectors, queryVector: [0, 1], budget: 3000 });
  for (const id of ["S149", "S150", "S151"]) assert.ok(active.items.some((item) => item.evidenceId === id));
});
test("missing or wrong-dimension vectors fall back without inventing semantic coverage", () => {
  const selection = selectRecipeEvidence(recipe, "How hot should the oven be?", { vectors: new Map([[15, [1, 0, 0]]]), queryVector: [1, 0] });
  assert.equal(selection.method, "lexical_steps"); assert.equal(selection.indexedSteps, 0);
  assert.ok(selection.items.some((item) => item.evidenceId === "S16"));
});
test("verification requires exhaustive unique coverage and valid scoped support", () => {
  const claims = [{ id: "A1", text: "A factual sentence." }, { id: "R1.1", text: "A reason.", recipeId: "one" }];
  const supports = [{ ref: "E1", recipeId: "one", text: "Source" }, { ref: "E2", recipeId: "two", text: "Other" }];
  const valid = { sentences: claims.map((claim) => ({ id: claim.id, verdict: "supported", supportRefs: ["E1"] })) };
  assert.equal(validateVerification(valid, claims, supports).status, "checked");
  for (const invalid of [
    { sentences: valid.sentences.slice(0, 1) }, { sentences: [valid.sentences[0], valid.sentences[0]] },
    { sentences: [valid.sentences[0], { id: "R1.1", verdict: "supported", supportRefs: ["E999"] }] },
    { sentences: [valid.sentences[0], { id: "R1.1", verdict: "supported", supportRefs: ["E2"] }] },
    { sentences: [valid.sentences[0], { id: "R1.1", verdict: "supported", supportRefs: [] }] },
  ]) assert.throws(() => validateVerification(invalid, claims, supports));
  assert.equal(validateVerification({ sentences: valid.sentences.map((item) => ({ ...item, verdict: "unsupported", supportRefs: [] })) }, claims, supports).status, "rejected");
  assert.equal(verificationClaims({ ...answer, answer: "Bake at 180.5°C. Then rest." }).length, 2);
});
test("local verifier returns canonical source facts and permits no rewritten fact prose", async () => {
  const result = await verifyChefAnswer(answer, evidence, { baseUrl: "http://127.0.0.1:1234", model: "local-model", metadata: {}, fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body), data = JSON.parse(body.messages[1].content);
    assert.equal(data.task, "verify_recipe_answer"); assert.equal(body.model, "local-model"); assert.equal(body.stream, false);
    return Response.json({ message: { content: JSON.stringify({ sentences: data.sentences.map((claim) => ({ id: claim.id, verdict: "supported", supportRefs: [data.evidence[0].ref] })) }) } });
  } });
  assert.equal(result.verification.status, "checked"); assert.equal(result.sourceFacts[0].fact, evidence[0].text);
});
test("verifier refusal, timeout, malformed output, and cancellation fail closed without retry", async () => {
  for (const kind of ["unavailable", "malformed", "timeout", "cancelled"]) {
    let calls = 0; const controller = new AbortController(); if (kind === "cancelled") controller.abort();
    const result = await verifyChefAnswer(answer, evidence, { baseUrl: "http://localhost:1234", model: "local", metadata: {}, timeoutMs: 5, signal: controller.signal,
      fetchImpl: async (_url, request) => {
        calls++;
        if (kind === "unavailable") return Response.json({}, { status: 503 });
        if (kind === "malformed") return Response.json({ message: { content: "{}" } });
        if (request.signal.aborted) throw new Error("Cancelled");
        return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
      } });
    assert.equal(result.verification.status, "unavailable", kind); assert.deepEqual(result.sourceFacts, []); assert.equal(calls, 1);
  }
  const remote = await verifyChefAnswer(answer, evidence, { baseUrl: "https://api.openai.com", model: "local", metadata: {}, fetchImpl: () => { throw new Error("Must never call a remote verifier"); } });
  assert.equal(remote.verification.status, "unavailable");
});
test("verification excludes unrelated metadata and cannot pass with only nonfactual prose", async () => {
  const result = await verifyChefAnswer({ ...answer, answer: "Read the source below." }, evidence, {
    baseUrl: "http://localhost:1234", model: "local", metadata: { unrelated: { totalMinutes: 99, provenance: {}, equipment: null, diets: {} } },
    completeByRecipe: { [recipe.id]: false }, planningRecipeId: recipe.id, planningAmounts: [{ name: "rice", measure: "about a cup", needsReview: true }],
    fetchImpl: async (_url, request) => {
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      assert.ok(data.evidence.every((item) => item.recipeId === recipe.id));
      assert.ok(data.evidence.some((item) => /cannot be asserted as exact/.test(item.text)));
      assert.equal(data.sourceCompleteness[recipe.id], false);
      return Response.json({ message: { content: JSON.stringify({ sentences: data.sentences.map((claim) => ({ id: claim.id, verdict: "not_factual", supportRefs: [] })) }) } });
    },
  });
  assert.equal(result.verification.status, "rejected"); assert.equal(result.verification.reason, "no_supported_claim");
});
test("RAG labels have disjoint recipe splits and balanced fixed positive and negative cases", () => {
  assert.equal(ragCases.length, 40); assert.equal(new Set(ragCases.map((item) => item.id)).size, 40);
  for (const split of ["development", "heldout"]) {
    const rows = ragCases.filter((item) => item.split === split); assert.equal(rows.length, 20); assert.equal(rows.filter((item) => item.supported).length, 10);
    assert.equal(new Set(rows.map((item) => item.recipeId)).size, 1);
    for (const row of rows) assert.ok(ragRecipes.find((recipe) => recipe.id === row.recipeId).instructions[Number(row.expectedEvidenceId.slice(1)) - 1]);
  }
});

test("generic recommendation prose may pass without source claims while factual questions require support", async () => {
  for (const requireSupport of [true, false]) {
    const result = await verifyChefAnswer({ ...answer, answer: "Read the source below.", recommendations: [] }, evidence, { baseUrl: "http://localhost:1234", model: "local", metadata: {}, requireSupport,
      fetchImpl: async (_url, request) => {
        const data = JSON.parse(JSON.parse(request.body).messages[1].content);
        return Response.json({ message: { content: JSON.stringify({ sentences: data.sentences.map(claim => ({ id: claim.id, verdict: "not_factual", supportRefs: [] })) }) } });
      } });
    assert.equal(result.verification.status, requireSupport ? "rejected" : "checked");
  }
});

test("verification receives only relevant server kitchen facts and keeps name matches distinct from quantities", async () => {
  await verifyChefAnswer(answer, evidence, { baseUrl: "http://localhost:1234", model: "local", metadata: {}, recordsByRecipe: { [recipe.id]: { title: recipe.title, servings: 2 }, unrelated: { title: "private other record", servings: 9 } }, question: "An untrusted assumed method", sourceFocus: { recipeId: recipe.id, stepEvidenceId: "S1", quantityBasis: "final_dinner" }, kitchenByRecipe: { [recipe.id]: { pantryMatch: ["rice"], missingIngredients: ["milk"] }, unrelated: { pantryMatch: ["private other recipe"], missingIngredients: [] } },
    fetchImpl: async (_url, request) => {
      const data = JSON.parse(JSON.parse(request.body).messages[1].content);
      const records = data.evidence.filter(item => item.ref.startsWith("C"));
      assert.equal(records.length, 1); assert.match(records[0].text, /original source yield/); assert.doesNotMatch(JSON.stringify(data), /private other record/);
      assert.equal(data.question, undefined, "Answer relevance does not override source entailment");
      assert.deepEqual(data.sourceFocus, { recipeId: recipe.id, stepEvidenceId: "S1", quantityBasis: "final_dinner" });
      const pantry = data.evidence.filter(item => item.ref.startsWith("P"));
      assert.equal(pantry.length, 1); assert.equal(pantry[0].recipeId, recipe.id); assert.match(pantry[0].text, /ingredient-name matches only/); assert.match(pantry[0].text, /"milk"/); assert.doesNotMatch(JSON.stringify(data), /private other recipe/);
      return Response.json({ message: { content: JSON.stringify({ sentences: data.sentences.map(claim => ({ id: claim.id, verdict: "supported", supportRefs: [data.evidence[0].ref] })) }) } });
    } });
});
