import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { ragCases, ragRecipes } from "./rag-cases.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (text) => createHash("sha256").update(text).digest("hex");

export async function evaluateRag({ reportPath = join(ROOT, "output/playwright/rag-quality.json"), model = "qwen3.5:9b" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rag-quality-"));
  try {
    const names = ["chef-context", "chef-evidence", "chef-verification", "chef-grounding", "retrieval-ranking", "recipe-embeddings", "quantities", "kitchen-types"];
    for (const name of names) {
      const source = await readFile(join(ROOT, "app/lib", `${name}.ts`), "utf8");
      await writeFile(join(directory, `${name}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"'));
    }
    const load = (name) => import(pathToFileURL(join(directory, `${name}.mjs`)).href);
    const [embedding, context, evidence, verifier, grounding] = await Promise.all([load("recipe-embeddings"), load("chef-context"), load("chef-evidence"), load("chef-verification"), load("chef-grounding")]);
    const tags = await (await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(5000) })).json();
    const installed = tags.models?.find((entry) => entry.name === model || entry.name === `${model}:latest`);
    const embedModel = tags.models?.find((entry) => entry.name === "nomic-embed-text:latest" || entry.name === "nomic-embed-text");
    if (!installed || !embedModel) throw new Error("Install the configured local chat model and nomic-embed-text first.");
    const cacheFile = join(ROOT, "work", `rag-vectors-${hash(embedModel.digest).slice(0, 16)}.json`);
    let cached = {}; try { cached = JSON.parse(await readFile(cacheFile, "utf8")); } catch { /* First evaluation. */ }
    const queryText = (query) => embedding.buildRecipeQueryText(query, []);
    const texts = [...new Set([...ragRecipes.flatMap((recipe) => recipe.instructions.map((_, index) => embedding.buildRecipeStepText(recipe, index))), ...ragCases.map((item) => queryText(item.query))])];
    const missing = texts.filter((text) => !embedding.isValidEmbeddingVector(cached[hash(text)]));
    await mkdir(dirname(cacheFile), { recursive: true });
    for (let offset = 0; offset < missing.length; offset += 16) {
      const batch = missing.slice(offset, offset + 16);
      const result = await embedding.embedTextsWithOllama(batch, { model: embedModel.name, baseUrl: "http://127.0.0.1:11434", timeoutMs: 60_000 });
      batch.forEach((text, index) => { cached[hash(text)] = result.vectors[index]; });
      await writeFile(cacheFile, JSON.stringify(cached));
    }
    const results = [];
    for (const item of ragCases) {
      const recipe = ragRecipes.find((recipe) => recipe.id === item.recipeId);
      const vectors = new Map(recipe.instructions.map((_, index) => [index, cached[hash(embedding.buildRecipeStepText(recipe, index))]]));
      const selection = evidence.selectRecipeEvidence(recipe, item.query, { vectors, queryVector: cached[hash(queryText(item.query))] });
      const original = context.recipeEvidence(recipe).find((row) => row.evidenceId === item.expectedEvidenceId);
      const answer = { answer: `The source says: ${item.claim}`, sourceFacts: [{ recipeId: recipe.id, evidenceId: original.evidenceId, fact: original.text }], recommendations: [], chefChanges: [], citations: [], warnings: [], answerStatus: "answered" };
      const checked = await verifier.verifyChefAnswer(answer, selection.items.map((row) => ({ recipeId: recipe.id, ...row })), { baseUrl: "http://127.0.0.1:11434", model: installed.name, question: item.query, metadata: {}, completeByRecipe: { [recipe.id]: selection.complete } });
      const accepted = checked.verification.status === "checked" && grounding.chefGroundingIssue({ ...answer, sourceFacts: checked.sourceFacts }, [{ recipeId: recipe.id, evidence: selection.items }], {}, { cookingStep: false }) === null;
      const legacy = context.selectQuestionEvidence(recipe, item.query).filter((row) => row.evidenceId.startsWith("S")).slice(0, 6);
      const baselineAccepted = grounding.chefGroundingIssue(answer, [{ recipeId: recipe.id, evidence: context.recipeEvidence(recipe) }], {}, { cookingStep: false }) === null;
      results.push({ ...item, accepted, correct: accepted === item.supported, evidenceHit: selection.coreStepIds.includes(item.expectedEvidenceId),
        baselineEvidenceHit: legacy.some((row) => row.evidenceId === item.expectedEvidenceId), baselineAccepted,
        verification: checked.verification, verificationMs: checked.milliseconds, sourceFacts: checked.sourceFacts,
        coreStepIds: selection.coreStepIds, selectedIds: selection.items.map((row) => row.evidenceId), contextCharacters: selection.items.reduce((sum, row) => sum + row.text.length, 0) });
      console.error(`${item.id}: ${results.at(-1).correct ? "pass" : "FAIL"} · ${checked.verification.status} (${checked.milliseconds} ms)`);
    }
    const metrics = (rows) => {
      const positive = rows.filter((row) => row.supported), negative = rows.filter((row) => !row.supported);
      return { cases: rows.length, evidenceRecallAt6: positive.filter((row) => row.evidenceHit).length / positive.length,
        baselineEvidenceRecallAt6: positive.filter((row) => row.baselineEvidenceHit).length / positive.length,
        supportedAnswerAcceptance: positive.filter((row) => row.accepted).length / positive.length,
        unsupportedClaimAcceptance: negative.filter((row) => row.accepted).length / negative.length,
        baselineUnsupportedClaimAcceptance: negative.filter((row) => row.baselineAccepted).length / negative.length };
    };
    const overall = metrics(results), latency = results.map((row) => row.verificationMs).sort((a, b) => a - b);
    const report = { reportVersion: 1, generatedAt: new Date().toISOString(), labelsSha256: hash(await readFile(join(ROOT, "tools/recipes/rag-cases.mjs"), "utf8")),
      model: installed.name, modelDigest: installed.digest, embeddingModel: embedModel.name, embeddingDigest: embedModel.digest,
      sourceSha256: hash((await Promise.all(names.map((name) => readFile(join(ROOT, `app/lib/${name}.ts`), "utf8")))).join("\n")),
      overall, development: metrics(results.filter((row) => row.split === "development")), heldout: metrics(results.filter((row) => row.split === "heldout")),
      latency: { medianMs: latency[Math.floor(latency.length / 2)], p95Ms: latency[Math.ceil(latency.length * 0.95) - 1] },
      gatesPassed: overall.evidenceRecallAt6 >= 0.9 && overall.supportedAnswerAcceptance >= 0.9 && overall.unsupportedClaimAcceptance <= 0.05,
      scope: "40 fixed original synthetic cases, split by recipe. No application database or paid provider is accessed. Baseline is the unchanged lexical evidence selector and numeric-only guard.", results };
    await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); let model, reportPath;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--model") model = args[++index];
      else if (args[index] === "--report") reportPath = resolve(args[++index]);
      else throw new Error("Usage: evaluate-rag.mjs [--model NAME] [--report PATH]");
    }
    const report = await evaluateRag({ ...(model ? { model } : {}), ...(reportPath ? { reportPath } : {}) });
    console.log(JSON.stringify({ gatesPassed: report.gatesPassed, overall: report.overall, heldout: report.heldout, latency: report.latency }, null, 2));
    if (!report.gatesPassed) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
