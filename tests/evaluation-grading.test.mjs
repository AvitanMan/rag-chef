import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ragCases } from "../tools/recipes/rag-cases.mjs";
import { summarizeGroundingResults, summarizeRagResults } from "../tools/recipes/evaluation-grading.mjs";
import { fingerprintFiles } from "../tools/recipes/evaluation-fingerprints.mjs";

const passingRag = () => ragCases.map(item => ({ ...item, accepted: item.supported, evidenceHit: true, baselineEvidenceHit: true, baselineAccepted: item.supported }));

test("a held-out acceptance regression fails even when aggregate acceptance meets 90 percent", () => {
  const rows = passingRag();
  for (const row of rows.filter(row => row.split === "heldout" && row.supported).slice(0, 2)) row.accepted = false;
  const report = summarizeRagResults(rows);
  assert.equal(report.overall.supportedAnswerAcceptance, 0.9);
  assert.equal(report.heldout.supportedAnswerAcceptance, 0.8);
  assert.equal(report.gates.overall, true);
  assert.equal(report.gates.heldout, false);
  assert.equal(report.gatesPassed, false);
});

test("a held-out false acceptance fails even when aggregate false acceptance meets five percent", () => {
  const rows = passingRag();
  rows.find(row => row.split === "heldout" && !row.supported).accepted = true;
  const report = summarizeRagResults(rows);
  assert.equal(report.overall.unsupportedClaimAcceptance, 0.05);
  assert.equal(report.heldout.unsupportedClaimAcceptance, 0.1);
  assert.equal(report.gates.overall, true);
  assert.equal(report.gates.heldout, false);
  assert.equal(report.gatesPassed, false);
});

test("evidence recall is gated separately and exact supported-acceptance boundaries remain valid", () => {
  const rows = passingRag();
  rows.find(row => row.split === "heldout" && row.supported).accepted = false;
  assert.equal(summarizeRagResults(rows).gatesPassed, true);
  for (const row of rows.filter(row => row.split === "development" && row.supported).slice(0, 2)) row.evidenceHit = false;
  const report = summarizeRagResults(rows);
  assert.equal(report.overall.evidenceRecallAt6, 0.9);
  assert.equal(report.gates.development, false);
  assert.equal(report.gatesPassed, false);
});

test("partial, duplicated, unexpected, relabeled and malformed case sets cannot pass", () => {
  assert.equal(summarizeRagResults(passingRag()).gatesPassed, true);
  const duplicates = passingRag();
  duplicates[0] = { ...duplicates[1] };
  const unexpected = passingRag(); unexpected[0].id = "unreviewed-case";
  const relabeled = passingRag(); relabeled[0].split = "heldout";
  const malformed = passingRag(); delete malformed[0].accepted;
  for (const rows of [[], passingRag().slice(1), duplicates, unexpected, relabeled, malformed]) {
    const report = summarizeRagResults(rows);
    assert.equal(report.caseCoverage.valid, false);
    assert.equal(report.gatesPassed, false);
  }
  assert.equal(summarizeRagResults([]).overall.supportedAnswerAcceptance, null);
});

const groundingCases = [{ id: "answer" }, { id: "missing", unsupported: true }, { id: "unknown", unknown: true }, { id: "guard", allowWithheld: true }];
const groundingResults = () => [
  { id: "answer", passed: true, answerStatus: "answered" },
  { id: "missing", passed: true, answerStatus: "unsupported" },
  { id: "unknown", passed: true, answerStatus: "answered" },
  { id: "guard", passed: true, answerStatus: "unverified", withheldSafely: true },
];

test("safe withholding passes its guard without inflating useful answers or correct refusals", () => {
  const report = summarizeGroundingResults(groundingCases, groundingResults());
  assert.equal(report.contractChecksPassed, true);
  assert.deepEqual(report.checks, { passed: 4, total: 4, rate: 1 });
  assert.deepEqual(report.usefulAnswers, { passed: 1, total: 2, rate: 0.5 });
  assert.deepEqual(report.correctRefusals, { passed: 2, total: 2, rate: 1 });
  assert.deepEqual(report.guardChecks, { passed: 1, total: 1, rate: 1 });
  assert.deepEqual(report.withheldAnswers, { total: 1, permitted: 1, unexpected: 0 });
  const corrected = groundingResults();
  corrected[3] = { id: "guard", passed: true, answerStatus: "answered" };
  assert.equal(summarizeGroundingResults(groundingCases, corrected).usefulAnswers.passed, 2);
});

test("failed, withheld and missing grounding responses stay in the intended denominators", () => {
  const rows = groundingResults();
  rows[0] = { id: "answer", passed: false, answerStatus: "unverified", withheldSafely: false };
  rows[1] = { id: "missing", passed: false, error: "timeout" };
  const report = summarizeGroundingResults(groundingCases, rows);
  assert.equal(report.contractChecksPassed, false);
  assert.deepEqual(report.usefulAnswers, { passed: 0, total: 2, rate: 0 });
  assert.deepEqual(report.correctRefusals, { passed: 1, total: 2, rate: 0.5 });
  assert.equal(report.withheldAnswers.unexpected, 1);
  assert.equal(report.executionFailures, 1);
  const incomplete = summarizeGroundingResults(groundingCases, rows.slice(1));
  assert.equal(incomplete.caseCoverage.valid, false);
  assert.equal(incomplete.usefulAnswers.total, 2);
  assert.equal(incomplete.contractChecksPassed, false);
});

test("evaluation fingerprints detect changed source and renamed paths without depending on input order", async () => {
  const root = await mkdtemp(join(tmpdir(), "rag-fingerprint-test-"));
  try {
    await writeFile(join(root, "a.ts"), "first"); await writeFile(join(root, "b.ts"), "second");
    const before = await fingerprintFiles(root, ["a.ts", "b.ts"]);
    assert.deepEqual(await fingerprintFiles(root, ["b.ts", "a.ts"]), before);
    await writeFile(join(root, "a.ts"), "changed");
    const edited = await fingerprintFiles(root, ["a.ts", "b.ts"]);
    assert.notEqual(edited.sha256, before.sha256);
    await rename(join(root, "a.ts"), join(root, "renamed.ts"));
    assert.notEqual((await fingerprintFiles(root, ["renamed.ts", "b.ts"])).sha256, edited.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
