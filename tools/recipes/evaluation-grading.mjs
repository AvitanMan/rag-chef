import { ragCases } from "./rag-cases.mjs";

function caseCoverage(cases, results) {
  const expected = new Map(cases.map(item => [item.id, item]));
  const counts = new Map();
  for (const row of results) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const missingIds = [...expected.keys()].filter(id => !counts.has(id));
  const duplicateIds = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  const unexpectedIds = [...counts.keys()].filter(id => !expected.has(id));
  return { valid: cases.length > 0 && expected.size === cases.length && results.length === cases.length && !missingIds.length && !duplicateIds.length && !unexpectedIds.length,
    expected: cases.length, actual: results.length, missingIds, duplicateIds, unexpectedIds };
}

const rate = (count, total) => total ? count / total : null;

/** Fixed labels and each split must pass; good development results cannot hide a held-out regression. */
export function summarizeRagResults(results) {
  const coverage = caseCoverage(ragCases, results);
  const labels = new Map(ragCases.map(item => [item.id, item]));
  coverage.invalidIds = results.filter(row => {
    const label = labels.get(row.id);
    return !label || row.split !== label.split || row.supported !== label.supported
      || typeof row.accepted !== "boolean" || typeof row.evidenceHit !== "boolean";
  }).map(row => row.id);
  coverage.valid &&= coverage.invalidIds.length === 0;
  const metrics = rows => {
    const positive = rows.filter(row => row.supported === true), negative = rows.filter(row => row.supported === false);
    return { cases: rows.length, supportedCases: positive.length, unsupportedCases: negative.length,
      evidenceRecallAt6: rate(positive.filter(row => row.evidenceHit === true).length, positive.length),
      baselineEvidenceRecallAt6: rate(positive.filter(row => row.baselineEvidenceHit === true).length, positive.length),
      supportedAnswerAcceptance: rate(positive.filter(row => row.accepted === true).length, positive.length),
      unsupportedClaimAcceptance: rate(negative.filter(row => row.accepted === true).length, negative.length),
      baselineUnsupportedClaimAcceptance: rate(negative.filter(row => row.baselineAccepted === true).length, negative.length) };
  };
  const overall = metrics(results), development = metrics(results.filter(row => row.split === "development")), heldout = metrics(results.filter(row => row.split === "heldout"));
  const passes = value => value.supportedCases > 0 && value.unsupportedCases > 0
    && value.evidenceRecallAt6 >= 0.9 && value.supportedAnswerAcceptance >= 0.9 && value.unsupportedClaimAcceptance <= 0.05;
  const gates = { caseCoverage: coverage.valid, overall: passes(overall), development: passes(development), heldout: passes(heldout) };
  return { caseCoverage: coverage, overall, development, heldout, gates, gatesPassed: Object.values(gates).every(Boolean) };
}

/** Passing a guard by withholding an answer never counts as a useful answer. */
export function summarizeGroundingResults(cases, results) {
  const coverage = caseCoverage(cases, results);
  const byId = new Map(results.map(row => [row.id, row]));
  const answers = cases.filter(item => !item.unsupported && !item.unknown);
  const refusals = cases.filter(item => item.unsupported || item.unknown);
  const guards = cases.filter(item => item.allowWithheld);
  const passed = item => byId.get(item.id)?.passed === true;
  const score = (items, predicate) => {
    const count = items.filter(predicate).length;
    return { passed: count, total: items.length, rate: rate(count, items.length) };
  };
  const withheld = results.filter(row => row.answerStatus === "unverified");
  const safelyWithheld = withheld.filter(row => row.passed === true && row.withheldSafely === true && guards.some(item => item.id === row.id));
  return { caseCoverage: coverage,
    checks: score(cases, passed),
    usefulAnswers: score(answers, item => passed(item) && byId.get(item.id)?.answerStatus === "answered" && !byId.get(item.id)?.withheldSafely),
    correctRefusals: score(refusals, passed),
    guardChecks: score(guards, passed),
    withheldAnswers: { total: withheld.length, permitted: safelyWithheld.length, unexpected: withheld.length - safelyWithheld.length },
    executionFailures: results.filter(row => row.error).length,
    contractChecksPassed: coverage.valid && cases.every(passed) };
}
