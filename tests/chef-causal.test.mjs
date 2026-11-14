import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "chef-causal" });
after(() => sources.dispose());
const { verifyChefAnswer, unsupportedCausalClaim } = await sources.import("app/lib/chef-verification.ts");
const evidence = [{ recipeId: "chowder", evidenceId: "S1", text: "Heat thoroughly but not boiling." }];
const answer = text => ({ answer: text, recommendations: [], warnings: [], sourceFacts: [], chefChanges: [] });
const claim = text => [{ id: "A1", text }];
const options = { sourceFocus: { recipeId: "chowder", stepEvidenceId: "S1" }, techniqueGuidance: [{ recipeId: "chowder", explanation: "Boiling means heating liquid until large bubbles rise continuously to the surface." }] };

test("an agreeing verifier cannot authorize a new causal explanation absent from chowder evidence", async () => {
  for (const text of [
    "Avoid boiling the milk to prevent curdling.",
    "Keeping the milk below a boil prevents curdling.",
    "It prevents the milk from curdling.",
    "This helps avoid curdling.",
    "Boiling can cause the milk to curdle.",
    "Boiling leads to curdling.",
    "Boiling milk makes it curdle.",
    "Heating keeps the milk smooth.",
    "Do not boil because the milk may curdle.",
    "Heating without boiling keeps the milk from curdling.",
    "Heating the soup protects its vitamins.",
    "Do not boil so that the flavor stays fresh.",
  ]) {
    let requests = 0;
    const result = await verifyChefAnswer(answer(text), evidence, { ...options, baseUrl: "http://127.0.0.1:11434", model: "mock", metadata: {},
      fetchImpl: async () => { requests++; return Response.json({ message: { content: JSON.stringify({ sentences: [{ id: "A1", verdict: "supported", supportRefs: ["E1"] }] }) } }); } });
    assert.equal(result.verification.status, "rejected", text);
    assert.equal(result.verification.reason, "unsupported_causal_claim", text);
    assert.equal(requests, 0, "A deterministic mismatch must not be overturned by a model");
  }
});

test("canonical explanations and inflection-preserving paraphrases still reach entailment verification", async () => {
  for (const [text, paraphrase] of [
    ["Adding sugar helps balance the acidity.", "Sugar balances acidity."],
    ["Grease the pan to prevent the batter from sticking.", "Greasing the pan prevents batter sticking."],
    ["Do not boil because the milk may curdle.", "Do not boil because milk can curdle."],
    ["Not boiling the milk prevents curdling.", "Not boiling prevents curdling."],
    ["Heating without boiling keeps milk from curdling.", "Heating without boiling prevents milk curdling."],
  ]) {
    for (const response of [text, paraphrase]) {
      let requests = 0;
      const result = await verifyChefAnswer(answer(response), [{ ...evidence[0], text }], { baseUrl: "http://127.0.0.1:11434", model: "mock", metadata: {},
        fetchImpl: async () => { requests++; return Response.json({ message: { content: JSON.stringify({ sentences: [{ id: "A1", verdict: "supported", supportRefs: ["E1"] }] }) } }); } });
      assert.equal(result.verification.status, "checked", `${text} -> ${response}`);
      assert.equal(requests, 1, "Lexical support is necessary, not a substitute for semantic checking");
      assert.equal(result.sourceFacts[0].fact, text);
    }
  }
});

test("causal anchors cannot be borrowed across sentences, steps, recipes, or opposite negations", () => {
  const text = "Grease the pan to prevent sticking.";
  assert.equal(unsupportedCausalClaim(claim(text), [{ ...evidence[0], text: "Grease the pan. Sugar prevents sticking." }]), true);
  assert.equal(unsupportedCausalClaim(claim(text), [{ ...evidence[0], recipeId: "other", text }], options), true);
  assert.equal(unsupportedCausalClaim(claim(text), [{ ...evidence[0], evidenceId: "S2", text }], options), true);
  const negative = [{ ...evidence[0], text: "Not boiling prevents curdling." }];
  assert.equal(unsupportedCausalClaim(claim("Boiling prevents curdling."), negative), true);
  assert.equal(unsupportedCausalClaim(claim("Not boiling causes curdling."), negative), true);
  assert.equal(unsupportedCausalClaim(claim("Not boiling prevents milk curdling."), negative), true, "A new causal participant is not supplied evidence");
  assert.equal(unsupportedCausalClaim(claim("Not boiling prevents curdling."), negative), false);
});

test("approved explanatory definitions can support a relation; metadata and model claims cannot supply it", async () => {
  const guide = { recipeId: "chowder", explanation: "Grease the pan to prevent sticking." };
  assert.equal(unsupportedCausalClaim(claim(guide.explanation), evidence, { ...options, techniqueGuidance: [guide] }), false);
  assert.equal(unsupportedCausalClaim(claim(guide.explanation), evidence, { techniqueGuidance: [{ ...guide, recipeId: "other" }] }), true);
  const result = await verifyChefAnswer(answer("Grease the pan to prevent sticking."), evidence, { ...options, baseUrl: "http://127.0.0.1:11434", model: "mock",
    metadata: {}, recordsByRecipe: { chowder: { title: guide.explanation, servings: 2 } }, fetchImpl: async () => { throw new Error("Must not consult model"); } });
  assert.equal(result.verification.reason, "unsupported_causal_claim");
});

test("plain directions and source uncertainty keep their existing path", () => {
  for (const text of ["Heat thoroughly but do not boil.", "Avoid boiling.", "The source says to avoid boiling.", "The source gives no reason for that instruction.", "Read the original directions."]) {
    assert.equal(unsupportedCausalClaim(claim(text), evidence, options), false, text);
  }
});

test("sequencing and polite command prefixes preserve source-backed instructions", async () => {
  for (const [text, responses] of [
    ["Keep the sauce warm.", ["Next, keep the sauce warm.", "Now please keep the sauce warm.", "Please, keep the sauce warm."]],
    ["Stop stirring.", ["Now stop stirring.", "Next, please stop stirring."]],
    ["Do not stop stirring.", ["Next, do not stop stirring.", "Please do not stop stirring."]],
    ["Reduce the heat.", ["Finally, reduce the heat."]],
    ["Allow the dough to rest.", ["Please allow the dough to rest."]],
    ["Make a well in the flour.", ["First, make a well in the flour."]],
    ["Grease the pan to prevent sticking.", ["Next, please grease the pan to prevent sticking."]],
  ]) {
    for (const response of responses) {
      let requests = 0;
      const result = await verifyChefAnswer(answer(response), [{ ...evidence[0], text }], { ...options, baseUrl: "http://127.0.0.1:11434", model: "mock", metadata: {},
        fetchImpl: async () => { requests++; return Response.json({ message: { content: JSON.stringify({ sentences: [{ id: "A1", verdict: "supported", supportRefs: ["E1"] }] }) } }); } });
      assert.equal(result.verification.status, "checked", response);
      assert.equal(requests, 1, "The source instruction still requires semantic verification");
      assert.equal(result.sourceFacts[0].fact, text);
    }
  }
});

test("command prefixes cannot hide new causal outcomes or turn subjects into instructions", async () => {
  const source = [{ ...evidence[0], text: "Keep the milk warm. Stop stirring." }];
  for (const text of [
    "Next, keep the milk warm to prevent curdling.",
    "Please keep the milk warm because the milk may curdle.",
    "Now stop stirring so that the milk stays smooth.",
    "Next, keeping the milk warm prevents curdling.",
    "Now, the warm milk prevents curdling.",
    "Next, heat prevents curdling.",
    "Please, this prevents curdling.",
  ]) {
    let requests = 0;
    const result = await verifyChefAnswer(answer(text), source, { ...options, baseUrl: "http://127.0.0.1:11434", model: "mock", metadata: {},
      fetchImpl: async () => { requests++; throw new Error("An absent causal relation must not reach the verifier"); } });
    assert.equal(result.verification.reason, "unsupported_causal_claim", text);
    assert.equal(requests, 0, text);
  }
});

test("prefixed causal commands still require the right source recipe, step and polarity", () => {
  const text = "Grease the pan to prevent sticking.", response = "Next, please grease the pan to prevent sticking.";
  assert.equal(unsupportedCausalClaim(claim(response), [{ ...evidence[0], text }], options), false);
  assert.equal(unsupportedCausalClaim(claim(response), [{ ...evidence[0], recipeId: "other", text }], options), true);
  assert.equal(unsupportedCausalClaim(claim(response), [{ ...evidence[0], evidenceId: "S2", text }], options), true);
  assert.equal(unsupportedCausalClaim(claim("Next, boil because the milk may curdle."), [{ ...evidence[0], text: "Do not boil because the milk may curdle." }], options), true);
  assert.equal(unsupportedCausalClaim(claim("Next, grease the pan to prevent sticking."), [{ ...evidence[0], text: "Do not grease the pan to prevent sticking." }], options), true);
});

test("a prefixed instruction never bypasses an unsupported entailment verdict", async () => {
  let requests = 0;
  const result = await verifyChefAnswer(answer("Now stop stirring."), [{ ...evidence[0], text: "Keep stirring." }], { ...options, baseUrl: "http://127.0.0.1:11434", model: "mock", metadata: {},
    fetchImpl: async () => { requests++; return Response.json({ message: { content: JSON.stringify({ sentences: [{ id: "A1", verdict: "unsupported", supportRefs: [] }] }) } }); } });
  assert.equal(requests, 1);
  assert.equal(result.verification.status, "rejected");
  assert.equal(result.verification.reason, "unsupported_claim");
});
