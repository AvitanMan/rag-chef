import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { qualityCases } from "./quality-cases.mjs";
import { cases as regressionCases } from "./evaluation-cases.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCAL_OLLAMA = "http://127.0.0.1:11434";
const TARGET = 0.95;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const metricsOnly = (metrics) => Object.fromEntries(Object.entries(metrics).filter(([key]) => key !== "results"));

/** Compare the actual context shape, including the previous Chef's exact-title filtering. */
export function compareRetrievalReports(baseline, current) {
  if (baseline.corpus?.sha256 !== current.corpus?.sha256 || baseline.labels?.sha256 !== current.labels?.sha256
    || baseline.embedding?.digest !== current.embedding?.digest || baseline.embedding?.dimension !== current.embedding?.dimension) {
    throw new Error("Compare only reports with matching corpus, labels and embedding model.");
  }
  const metrics = {};
  for (const mode of ["semantic", "forcedLexical"]) {
    metrics[mode] = {};
    for (const split of ["calibration", "heldout"]) {
      const before = baseline[mode][split];
      const after = current[mode][split];
      const matching = new Map(after.results.map((row) => [row.id, row]));
      if (before.results.length !== after.results.length || before.results.some((row) => matching.get(row.id)?.query !== row.query
        || JSON.stringify(matching.get(row.id)?.expectedTitles) !== JSON.stringify(row.expectedTitles))) throw new Error("Report query labels differ.");
      const titled = before.results.filter((row) => row.expectedTitles.length);
      let precisionBefore = 0, precisionAfter = 0, sizeBefore = 0, sizeAfter = 0;
      for (const row of titled) {
        if (row.exactTitleTopOnePass === false) throw new Error("The baseline cannot reconstruct its old exact-title context.");
        const oldContext = row.exactTitleTopOnePass === true ? row.top3.slice(0, 1) : row.top3;
        const newContext = matching.get(row.id).top3;
        precisionBefore += oldContext.filter((item) => row.expectedTitles.includes(item.title)).length / Math.max(oldContext.length, 1);
        precisionAfter += newContext.filter((item) => row.expectedTitles.includes(item.title)).length / Math.max(newContext.length, 1);
        sizeBefore += oldContext.length;
        sizeAfter += newContext.length;
      }
      const count = Math.max(titled.length, 1);
      metrics[mode][split] = { labeledCases: titled.length,
        baselineRawRankerPrecisionAt3: before.labeledPrecisionAt3,
        baselineChefContextPrecisionAt3: precisionBefore / count, currentChefContextPrecisionAt3: precisionAfter / count,
        meanContextSizeBefore: sizeBefore / count, meanContextSizeAfter: sizeAfter / count,
        retentionBefore: before.retention, retentionAfter: after.retention, abstentionBefore: before.abstention, abstentionAfter: after.abstention };
    }
  }
  return { definition: "Candidate-context precision under the same non-exhaustive title labels, not generated-answer accuracy. Baseline Chef exact-title filtering is accounted for.", metrics };
}

/** Strict labeled precision uses listed acceptable titles, not inferred relevance. */
export function evaluateRecords(records, thresholds, decide, select) {
  const results = records.map(({ item, ranked, broad }) => {
    const relevant = select ? select(ranked, item.query, 3, thresholds) : ranked.filter((row) => decide ? decide(row, item.query, thresholds) : broad || row.exactTitle || row.lexicalScore >= thresholds.lexical || row.semanticScore !== null && row.semanticScore >= thresholds.semantic);
    const top3 = relevant.slice(0, 3);
    const accepted = relevant.length > 0;
    const expected = item.expectedTitles ?? item.expected ?? [];
    const hits = top3.filter((row) => expected.includes(row.recipe.title)).length;
    const forbidden = item.forbidden ?? [];
    const exclusionsPass = !relevant.some((row) => forbidden.includes(row.recipe.title) || row.eligibility?.allergyMatches?.length);
    return { id: item.id, split: item.split, query: item.query, expectedOutcome: item.expectedOutcome ?? "matches", expectedTitles: expected,
      ...(item.constraints ? { constraints: item.constraints } : {}), ...(item.allergies ? { allergies: item.allergies } : {}),
      accepted, outcomePass: accepted === (item.expectedOutcome !== "no_match"), expectedHitAt3: expected.length ? hits > 0 : null,
      exactTitleTopOnePass: item.exactTitleId ? top3[0]?.recipe.id === item.exactTitleId : null,
      labeledPrecisionAt3: expected.length ? hits / Math.max(top3.length, 1) : null, exclusionsPass,
      top3: top3.map((row) => ({ id: row.recipe.id, title: row.recipe.title, lexicalScore: row.lexicalScore, semanticScore: row.semanticScore, queryCoverage: row.queryCoverage, matchedQueryTerms: row.matchedQueryTerms, missingQueryTerms: row.missingQueryTerms })),
      relevantCount: relevant.length, maxLexicalScore: Math.max(0, ...ranked.map((row) => row.lexicalScore)),
      maxSemanticScore: ranked.some((row) => row.semanticScore !== null) ? Math.max(...ranked.map((row) => row.semanticScore ?? -1)) : null,
      broad };
  });
  const positive = results.filter((item) => item.expectedOutcome === "matches");
  const negative = results.filter((item) => item.expectedOutcome === "no_match");
  const titled = positive.filter((item) => item.expectedHitAt3 !== null);
  const retention = positive.length ? positive.filter((item) => item.accepted).length / positive.length : 1;
  const abstention = negative.length ? negative.filter((item) => !item.accepted).length / negative.length : 1;
  const hitAt3 = titled.length ? titled.filter((item) => item.expectedHitAt3).length / titled.length : 1;
  const precision = titled.length ? titled.reduce((sum, item) => sum + item.labeledPrecisionAt3, 0) / titled.length : 1;
  const exact = results.filter((item) => item.exactTitleTopOnePass !== null);
  return { total: results.length, supported: positive.length, unsupported: negative.length, retention, abstention,
    expectedTitleCases: titled.length, expectedHitAt3: hitAt3, exactTitleCases: exact.length, exactTitleTopOne: exact.length ? exact.filter((item) => item.exactTitleTopOnePass).length / exact.length : 1, labeledPrecisionAt3: precision, labeledPrecisionPenalty: 1 - precision,
    gatesPassed: retention >= TARGET && abstention >= TARGET && results.every((item) => item.exclusionsPass && item.exactTitleTopOnePass !== false), results };
}

function boundaries(scores) {
  return [...new Set([0.000001, 1, ...scores.flatMap((score) => [Math.floor(score * 1e6) / 1e6, Math.ceil((score + 1e-9) * 1e6) / 1e6])])].filter((score) => score > 0 && score <= 1).sort((a, b) => a - b);
}

/** Held-out records are discarded here, even if a caller supplies them. */
export function calibrateThresholds(semanticRecords, lexicalRecords, { decide, select } = {}) {
  const calibration = semanticRecords.filter((row) => row.item.split === "calibration");
  const fallback = lexicalRecords.filter((row) => row.item.split === "calibration");
  if (!calibration.length || !fallback.length) throw new Error("Calibration requires its fixed calibration split.");
  const candidateRows = (records) => records.flatMap(({ ranked, item }) => [...ranked.slice(0, 3), ...ranked.filter((row) => (item.expectedTitles ?? []).includes(row.recipe.title))]);
  const lex = boundaries(candidateRows(fallback).map((row) => row.lexicalScore));
  const sem = boundaries(candidateRows(calibration).flatMap((row) => row.semanticScore === null ? [] : [row.semanticScore]));
  let best = null;
  for (const lexical of lex) {
    const lexicalMetrics = evaluateRecords(fallback, { lexical, semantic: 1.000001 }, decide, select);
    for (const semantic of sem) {
      const metrics = evaluateRecords(calibration, { lexical, semantic }, decide, select);
      const score = [Number(metrics.gatesPassed && lexicalMetrics.gatesPassed),
        Math.min(metrics.retention, metrics.abstention, lexicalMetrics.retention, lexicalMetrics.abstention),
        metrics.retention + metrics.abstention + lexicalMetrics.retention + lexicalMetrics.abstention,
        metrics.expectedHitAt3 + lexicalMetrics.expectedHitAt3, metrics.labeledPrecisionAt3 + lexicalMetrics.labeledPrecisionAt3,
        metrics.abstention + lexicalMetrics.abstention, lexical, -semantic];
      if (!best || score.some((value, index) => value !== best.score[index] && score.slice(0, index).every((before, i) => before === best.score[i]) && value > best.score[index])) {
        best = { thresholds: { lexical, semantic }, score, calibration: metrics, forcedLexicalCalibration: lexicalMetrics };
      }
    }
  }
  return { ...best, selectionSplit: "calibration", searchedPairs: lex.length * sem.length };
}

export async function loadPureRanker() {
  const directory = await mkdtemp(join(tmpdir(), "rag-chef-relevance-"));
  const names = ["catalog-search", "recipe-embeddings", "recipe-browser", "recipe-constraints", "recipe-safety", "quantities", "kitchen-types"];
  try {
    for (const name of names) {
      const source = await readFile(join(ROOT, "app/lib", `${name}.ts`), "utf8");
      const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
        .replaceAll('"./recipe-store"', '"./evaluation-store.mjs"').replace(/"\.\/([\w-]+)"/g, '"./$1.mjs"');
      await writeFile(join(directory, `${name}.mjs`), code);
    }
    await writeFile(join(directory, "evaluation-store.mjs"), 'export function listCatalogRecipes(){throw Error("Database access is disabled in relevance evaluation")} export function listStoredRecipeEmbeddings(){throw Error("Database access is disabled in relevance evaluation")}');
    return { search: await import(pathToFileURL(join(directory, "catalog-search.mjs")).href),
      embeddings: await import(pathToFileURL(join(directory, "recipe-embeddings.mjs")).href),
      constraints: await import(pathToFileURL(join(directory, "recipe-constraints.mjs")).href),
      dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

async function localEmbeddings(texts, embeddings, model) {
  const [tags, version] = await Promise.all(["tags", "version"].map(async (endpoint) => {
    const response = await fetch(`${LOCAL_OLLAMA}/api/${endpoint}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Local Ollama ${endpoint} returned HTTP ${response.status}`);
    return response.json();
  }));
  const installed = tags.models?.find((item) => item.name === model || item.name === `${model}:latest`);
  if (!installed?.digest) throw new Error(`Install ${model} in local Ollama before evaluating semantic relevance.`);
  const cacheFile = join(ROOT, "work", `relevance-vectors-${hash(`${installed.digest}:${embeddings.RECIPE_EMBEDDING_KIND}`).slice(0, 16)}.json`);
  let cached = {};
  try { cached = JSON.parse(await readFile(cacheFile, "utf8")).vectors ?? {}; } catch { /* First run computes the frozen inputs. */ }
  const unique = [...new Set(texts)];
  const missing = unique.filter((text) => !embeddings.isValidEmbeddingVector(cached[hash(text)]));
  await mkdir(dirname(cacheFile), { recursive: true });
  for (let offset = 0; offset < missing.length; offset += 16) {
    const batch = missing.slice(offset, offset + 16);
    const result = await embeddings.embedTextsWithOllama(batch, { baseUrl: LOCAL_OLLAMA, model, batchSize: 16, timeoutMs: 60_000 });
    batch.forEach((text, index) => { cached[hash(text)] = result.vectors[index]; });
    await writeFile(cacheFile, JSON.stringify({ model, digest: installed.digest, kind: embeddings.RECIPE_EMBEDDING_KIND, vectors: cached }));
    process.stderr.write(`Local embeddings: ${Math.min(offset + batch.length, missing.length)}/${missing.length} new inputs\n`);
  }
  const dimension = cached[hash(unique[0])]?.length;
  if (!unique.every((text) => embeddings.isValidEmbeddingVector(cached[hash(text)], dimension))) throw new Error("Cached embedding dimensions differ; remove the ignored relevance vector cache and retry.");
  return { vectors: new Map(unique.map((text) => [text, cached[hash(text)]])), model: installed.name, digest: installed.digest,
    ollamaVersion: version.version, dimension, kind: embeddings.RECIPE_EMBEDDING_KIND, newInputs: missing.length, totalInputs: unique.length };
}

export async function runEvaluation({ reportPath = join(ROOT, "tools/recipes/relevance-report.json"), model = "nomic-embed-text", calibrate = false, baselinePath } = {}) {
  const fixturePath = join(ROOT, "tools/recipes/fixtures/relevance-catalog.json");
  const corpusText = await readFile(fixturePath, "utf8");
  const { recipes } = JSON.parse(corpusText);
  if (qualityCases.length !== 80 || ["calibration", "heldout"].some((split) => ["matches", "no_match"].some((outcome) => qualityCases.filter((item) => item.split === split && item.expectedOutcome === outcome).length !== 20))) {
    throw new Error("Relevance evaluation requires the fixed balanced 40 calibration / 40 held-out cases.");
  }
  const titles = new Set(recipes.map((recipe) => recipe.title));
  for (const item of [...qualityCases, ...regressionCases]) for (const title of item.expectedTitles ?? item.expected ?? []) {
    if (!titles.has(title)) throw new Error(`Evaluation label names a missing catalog recipe: ${title}`);
  }
  const pure = await loadPureRanker();
  try {
    const { search, embeddings, constraints } = pure;
    const queryText = (query) => embeddings.buildRecipeQueryText(search.recipeRetrievalQuery(query, Boolean(search.focusedRecipeId(query, recipes))), []);
    const documentTexts = recipes.map(embeddings.buildRecipeEmbeddingText);
    const embeddingRun = await localEmbeddings([...documentTexts, ...qualityCases.map((item) => queryText(item.query)), ...regressionCases.map((item) => queryText(item.query))], embeddings, model);
    const vectors = new Map(recipes.map((recipe, index) => [recipe.id, embeddingRun.vectors.get(documentTexts[index])]));
    const record = (item, semantic, pantry = item.pantry ?? []) => ({ item: { ...item, exactTitleId: search.focusedRecipeId(item.query, recipes) }, broad: search.recipeQueryIntent(item.query).broad,
      ranked: search.rankCatalogRecipes(recipes, { query: item.query, pantry,
        constraints: constraints.normalizeConstraints({ ...item.constraints, allergies: [...(item.constraints?.allergies ?? []), ...(item.allergies ?? [])] }) },
      semantic ? vectors : new Map(), semantic ? embeddingRun.vectors.get(queryText(item.query)) : null) });
    const semantic = qualityCases.map((item) => record(item, true));
    const lexical = qualityCases.map((item) => record(item, false));
    const calibrated = calibrate ? calibrateThresholds(semantic, lexical, { decide: search.queryRelevanceDecision, select: search.selectCatalogShortlist }) : null;
    // Normal verification tests the deployed configuration. Recalibration is an
    // explicit experiment and never silently rewrites thresholds or uses held-out labels.
    const thresholds = calibrated ? calibrated.thresholds : search.catalogRelevanceThresholds;
    const score = (records) => evaluateRecords(records, thresholds, search.queryRelevanceDecision, search.selectCatalogShortlist);
    const regression = score(regressionCases.map((item, index) => record({ ...item, id: `regression-${index + 1}`, split: "regression", expectedOutcome: "matches" }, true)));
    const allPantry = [...new Set(recipes.flatMap((recipe) => recipe.ingredients.map((item) => item.name)))];
    const guards = [];
    for (const query of ["", "What can I cook with my pantry?", "Find me dinner ideas"]) {
      const item = { id: `broad:${query}`, query, expectedOutcome: "matches", expectedTitles: [] };
      guards.push(...score([record(item, false)]).results.map((result) => ({ ...result, guardPass: result.accepted })));
    }
    for (const query of ["zzzxxyy quantum spaceship", "asdfgh qwerty zxcvbn"]) {
      for (const semanticMode of [true, false]) {
        const item = { id: `pantry-gibberish:${semanticMode}:${query}`, query, expectedOutcome: "no_match", expectedTitles: [] };
        guards.push(...score([record(item, semanticMode, allPantry)]).results.map((result) => ({ ...result, guardPass: !result.accepted, mode: semanticMode ? "semantic" : "forced_lexical", pantryNames: allPantry.length })));
      }
    }
    const report = { reportVersion: 1, generatedAt: new Date().toISOString(), evaluatorSha256: hash(await readFile(fileURLToPath(import.meta.url), "utf8")),
      corpus: { file: "tools/recipes/fixtures/relevance-catalog.json", sha256: hash(corpusText), recipeCount: recipes.length, attributionPreserved: true },
      labels: { file: "tools/recipes/quality-cases.mjs", sha256: hash(await readFile(join(ROOT, "tools/recipes/quality-cases.mjs"), "utf8")), total: qualityCases.length, splitBeforeCalibration: true },
      ranker: { sourceSha256: hash(await readFile(join(ROOT, "app/lib/catalog-search.ts"), "utf8")),
        embeddingSourceSha256: hash(await readFile(join(ROOT, "app/lib/recipe-embeddings.ts"), "utf8")),
        constraintsSourceSha256: hash(await readFile(join(ROOT, "app/lib/recipe-constraints.ts"), "utf8")),
        safetySourceSha256: hash(await readFile(join(ROOT, "app/lib/recipe-safety.ts"), "utf8")),
        regressionLabelsSha256: hash(await readFile(join(ROOT, "tools/recipes/evaluation-cases.mjs"), "utf8")) },
      embedding: { ...embeddingRun, vectors: undefined, baseUrl: LOCAL_OLLAMA, queryPantryContext: "empty" },
      thresholds: { ...thresholds, version: search.catalogRelevanceThresholds.version, configured: search.catalogRelevanceThresholds,
        configurationMatchesSelection: thresholds.lexical === search.catalogRelevanceThresholds.lexical && thresholds.semantic === search.catalogRelevanceThresholds.semantic },
      shortlist: { ...search.catalogShortlistPolicy, countDefinition: "Returned shortlist capped at three for evaluation; the same selector is used by production." },
      selection: { split: "calibration", mode: calibrate ? "calibration_candidate" : "frozen_configured", calibrationCandidate: calibrated?.thresholds ?? null, targetRetention: TARGET, targetAbstention: TARGET, searchedPairs: calibrated?.searchedPairs ?? 0,
        objective: calibrate ? "Both semantic and forced-lexical calibration gates, worst classification rate, total classification rates, expected hit@3, labeled precision@3. Equal metrics favor the stricter lexical boundary, then the least restrictive semantic boundary within (0,1]. Held-out labels never select thresholds." : "Verify configured thresholds and shortlist policy without searching parameters. Held-out labels never select thresholds." },
      precisionDefinition: "Mean precision among returned top-three titles for supported cases with explicit acceptable-title labels. Labels are not exhaustive culinary judgments; unlabeled titles count as a penalty. Broad queries are excluded.",
      semantic: { calibration: score(semantic.filter((row) => row.item.split === "calibration")), heldout: score(semantic.filter((row) => row.item.split === "heldout")) },
      forcedLexical: { method: "All document/query embeddings deliberately absent", calibration: score(lexical.filter((row) => row.item.split === "calibration")), heldout: score(lexical.filter((row) => row.item.split === "heldout")) },
      regression, guards };
    report.gatesPassed = [report.semantic.calibration, report.semantic.heldout, report.forcedLexical.calibration, report.forcedLexical.heldout].every((item) => item.gatesPassed)
      && regression.results.every((item) => item.expectedHitAt3 && item.exclusionsPass) && guards.every((item) => item.guardPass)
      && report.thresholds.configurationMatchesSelection;
    if (baselinePath) {
      const baselineText = await readFile(baselinePath, "utf8");
      report.comparison = { baselineReportSha256: hash(baselineText), ...compareRetrievalReports(JSON.parse(baselineText), report) };
    }
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally { await pure.dispose(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let reportPath;
    let baselinePath;
    let calibrate = false;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--calibrate") calibrate = true;
      else if (args[index] === "--report" && args[index + 1] && !args[index + 1].startsWith("--")) reportPath = resolve(args[++index]);
      else if (args[index] === "--baseline" && args[index + 1] && !args[index + 1].startsWith("--")) baselinePath = resolve(args[++index]);
      else throw new Error("Usage: evaluate-relevance.mjs [--report PATH] [--baseline PATH] [--calibrate]");
    }
    const report = await runEvaluation({ ...(reportPath ? { reportPath } : {}), ...(baselinePath ? { baselinePath } : {}), calibrate });
    console.log(JSON.stringify({ gatesPassed: report.gatesPassed, thresholds: report.thresholds,
      semantic: Object.fromEntries(Object.entries(report.semantic).map(([name, metrics]) => [name, metricsOnly(metrics)])),
      forcedLexical: Object.fromEntries(["calibration", "heldout"].map((name) => [name, metricsOnly(report.forcedLexical[name])])),
      regression: { hits: report.regression.results.filter((item) => item.expectedHitAt3).length, total: report.regression.total, exclusionsPass: report.regression.results.every((item) => item.exclusionsPass) },
      failedCases: [...report.semantic.calibration.results, ...report.semantic.heldout.results, ...report.forcedLexical.calibration.results, ...report.forcedLexical.heldout.results, ...report.guards].filter((item) => !item.outcomePass || item.guardPass === false).map((item) => ({ split: item.split, query: item.query, expectedOutcome: item.expectedOutcome, accepted: item.accepted })) }, null, 2));
    if (!report.gatesPassed) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
