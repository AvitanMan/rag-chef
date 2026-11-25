import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "chef-cooking-tip" });
after(() => sources.dispose());
const { generateCookingTip } = await sources.import("app/lib/chef-cooking-tip.ts");

const step = "Fold the beans into the rice. Keep the beans whole.";
const goodTip = "Slide a spoon underneath and gently turn the rice over the beans.";
const profile = { allergies: ["peanuts"], diet: [], dislikes: ["cilantro"], equipment: [] };

function fixture(draft, review = { suitable: true }, overrides = {}) {
  const calls = [];
  const models = {
    checkVerifier: async () => ({ ready: true }),
    generate: async request => {
      calls.push(request);
      return request.operation === "verification" ? review : draft;
    },
    ...overrides.models,
  };
  const run = () => generateCookingTip({ provider: "ollama", model: "test-chat", verifierModel: "test-local",
    query: "How do I do that?", step, profile, signal: new AbortController().signal, ...overrides, models });
  return { calls, run };
}

test("a single practical suggestion is independently checked against the step and profile", async () => {
  const { run, calls } = fixture({ tip: goodTip }, { suitable: true }, { provider: "openai" });
  assert.equal((await run()).cookingTip, goodTip);
  assert.deepEqual(calls.map(call => [call.provider, call.model]), [["openai", "test-chat"], ["ollama", "test-local"]]);
  assert.ok(calls[1].userPrompt.includes(step));
  assert.ok(calls[1].userPrompt.includes(goodTip));
  assert.ok(calls[1].userPrompt.includes("peanuts"));
});

test("omit a conflicting, unreviewable or malformed tip", async () => {
  for (const verdict of [{ suitable: false }, {}, { suitable: "yes" }, { suitable: true, instruction: "display" }]) {
    assert.equal((await fixture({ tip: "Mash the beans with a fork." }, verdict).run()).cookingTip, undefined);
  }
  const unavailable = fixture({ tip: goodTip }, {}, { provider: "openai", models: { checkVerifier: async () => ({ ready: false }) } });
  assert.equal((await unavailable.run()).cookingTip, undefined);
  assert.equal(unavailable.calls.length, 0);
});

test("reject invented measurements, unsafe assurances, exclusions and malformed drafts before review", async () => {
  for (const draft of [
    { tip: "Stir for 5 minutes." }, { tip: "Wait twenty seconds." }, { tip: "Repeat for half an hour." },
    { tip: "Mix in peanut butter." }, { tip: "Fold in cilantro." }, { tip: "Pink chicken is safe to eat." },
    { tip: goodTip, extra: true }, { tip: "" }, { tip: goodTip + " Add more butter." },
  ]) {
    const { run, calls } = fixture(draft);
    assert.equal((await run()).cookingTip, undefined, JSON.stringify(draft));
    assert.equal(calls.length, 1, JSON.stringify(draft));
  }
});

test("a failed review only drops the optional suggestion", async () => {
  const failed = fixture({}, {}, { models: { generate: async request => {
    if (request.operation === "verification") throw new Error("Verifier unavailable");
    return { tip: goodTip };
  } } });
  assert.equal((await failed.run()).cookingTip, undefined);
});

test("an approving model cannot reverse an explicit prohibition in the recipe", async () => {
  for (const query of ["What does this step mean?", "How do I whisk it?"]) {
    const { calls, run } = fixture({ tip: "Whisk briskly in circles." }, { suitable: true },
      { step: "Do not whisk the milk. Fold it in gently.", query });
    assert.equal((await run()).cookingTip, undefined);
    assert.equal(calls.length, 0);
  }
});
