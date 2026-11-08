/** Answerable fixture requests need dinners or date-specific explanations for every target. */
export function planningRequestedDates(draft, expectedDates, { requireProposal = true } = {}) {
  if (!Array.isArray(draft?.changes) || requireProposal && !draft.changes.length || !Array.isArray(draft.intent?.dates) || !Array.isArray(draft.unresolved)) return false;
  const proposed = draft.changes.map(change => change?.date);
  return draft.intent.dates.length === expectedDates.length
    && draft.intent.dates.every((date, index) => date === expectedDates[index])
    && proposed.every(date => expectedDates.includes(date))
    && new Set(proposed).size === proposed.length
    && expectedDates.every(date => proposed.includes(date) || draft.unresolved.some(reason => typeof reason === "string" && reason.startsWith(`${date}:`) && reason.slice(date.length + 1).trim().length > 0));
}

/** Latency is valid release evidence only when every expected model request completed. */
export function planningLatency(records, cases, budgetMs = 15000) {
  const expected = cases.filter(row => !row.clarification).map(row => row.id);
  const attempted = records.filter(row => expected.includes(row.id));
  const successful = attempted.filter(row => row.response?.draft?.interpretation === "ollama" && row.checks.some(check => check.name === "http_200" && check.passed) && Number.isFinite(row.milliseconds) && row.milliseconds >= 0);
  const coveragePassed = attempted.length === expected.length && new Set(attempted.map(row => row.id)).size === expected.length && successful.length === expected.length;
  const first = attempted[0];
  const warm = successful.filter(row => row.id !== first?.id).map(row => row.milliseconds).sort((a, b) => a - b);
  const warmP95Ms = warm[Math.max(0, Math.ceil(warm.length * .95) - 1)] ?? null;
  return { firstModelRequestMs: first?.milliseconds ?? null, firstModelRequestSucceeded: Boolean(first && successful.includes(first)), warmP95Ms, warmSamples: warm.length, expectedModelRequests: expected.length, successfulModelRequests: successful.length, failedModelRequests: attempted.length - successful.length, coveragePassed, budgetMs, gatePassed: coveragePassed && warmP95Ms !== null && warmP95Ms < budgetMs };
}
