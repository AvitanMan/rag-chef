// Selected-step expectations are fixed independently of the app's answer planner.
const recipeId = "fixture-beans-rice";
const gap = /\b(?:unknown|no (?:specific |exact |explicit |stated |baking )*(?:time|duration|cue|description|test|detail|sign)|(?:not|never) (?:given|provided|specified|defined|described|stated)|(?:does not|doesn't|doesn’t|cannot|can't) (?:give|say|specify|provide|describe|define|tell|state|establish|list|include))\b/i;
export const cookingAnswerCases = [
  { id: "focused-duration", step: "S1", query: "How long do I simmer the rice?", answer: /\b11\s*(?:minutes?|mins?)\b/i, direct: true },
  { id: "focused-cue", step: "S1", query: "How can I tell when this step is done?", answer: /(?:liquid.{0,30}absorb|absorb.{0,30}liquid)/i, direct: true },
  { id: "focused-folding-tip", step: "S3", query: "How do I do that?", answer: /\bfold(?:ing)?\b/i, tip: /\b(?:lift|turn|scoop)(?:s|ing)?\b/i,
    forbidTip: /\d|\b(?:minute|second|hour|degree|whisk|beat|mash|stir vigorously)\b/i },
  { id: "focused-rest-is-not-baking", step: "S4", query: "How long do I bake it?", unknown: true, answer: gap,
    restOnly: true, forbid: /\bbak(?:e|ing)(?: it)? (?:takes? |for |about |approximately )*(?:9|nine) (?:min|minutes?)\b/i },
  { id: "focused-vague-cue", step: "S2", query: "How do I know when the beans are ready?", unknown: true, answer: gap,
    forbid: /\b(?:soft|tender|crush|fork|mash|absorb(?:ed)?|golden)\b/i, forbidTip: /\d|\b(?:safe to eat|guarantee[sd]?|must be tender|recipe (?:says|requires))\b/i },
  { id: "focused-prohibited-action", step: "S5", query: "Should I stir the beans?", answer: /\b(?:do not|don't|don’t|avoid|never|without|should not|shouldn't|no)[ ,.!]+(?:stir(?:ring)?|you should not stir)/i,
    forbidTip: /\b(?:stir (?:the beans|them|often|constantly|vigorously)|keep stirring)\b/i },
].map(item => ({ ...item, recipeId, evidence: item.step }));

export function gradeCookingAnswer(item, result) {
  const answer = result.answer ?? "", tip = result.cookingTip ?? "";
  const sourceAnswer = result.generation === "catalog_fallback" && result.verification?.status === "not_required";
  const direct = sourceAnswer && result.timings?.generationMs === 0 && result.timings?.verificationMs === 0;
  const checked = result.generation === "ai" && result.verification?.status === "checked";
  const verifiedTip = result.timings?.generationMs > 0 && result.timings?.verificationMs > 0;
  return {
    stepMatched: result.resolvedContext?.stepEvidenceId === item.step,
    sourceLinked: result.citations?.some(citation => citation.recipeId === item.recipeId && citation.sourceUrl === `https://example.invalid/fixtures/${item.recipeId}`) === true,
    answered: result.answerStatus === "answered" || (item.unknown === true && result.answerStatus === "unsupported"),
    checkedOrDirect: item.direct ? direct : sourceAnswer || checked,
    expectedAnswer: item.answer.test(answer),
    noContradiction: !item.forbid?.test(answer),
    restTimeScoped: !item.restOnly || !/\b(?:9|nine)\s*(?:minutes?|mins?)\b/i.test(answer) || /(?:rest(?:ing)?[^.!?]{0,45}(?:9|nine)\s*(?:minutes?|mins?)|(?:9|nine)\s*(?:minutes?|mins?)[^.!?]{0,45}rest)/i.test(answer),
    tipChecked: !tip || verifiedTip,
    usefulTip: !item.tip || (typeof tip === "string" && item.tip.test(tip) && !answer.includes(tip) && !result.sourceFacts?.some(fact => fact.fact === tip)),
    noForbiddenTip: typeof tip === "string" && !item.forbidTip?.test(tip),
    noAdaptations: result.chefChanges?.length === 0 && result.recommendations?.length === 0,
  };
}
