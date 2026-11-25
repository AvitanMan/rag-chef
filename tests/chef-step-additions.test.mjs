import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "chef-step-additions" });
after(() => sources.dispose());
const { focusedStepAdditionAnswer } = await sources.import("app/lib/chef-step-additions.ts");

const milk = { name: "milk", measure: "200 ml" };
const starch = { name: "cornstarch", measure: "10 g" };
const history = [{ role: "user", content: "How much milk do I need for this dinner?" },
  { role: "assistant", content: "Add 700 ml of cornstarch." }];
const now = "How much goes in now?", rest = "What about the rest?";
function ask(instructions, query, options = {}) {
  const recipe = { id: "pudding", instructions, ingredients: [milk, starch], servings: 2, ...options.recipe };
  const meal = { recipe, recipeId: recipe.id, servings: 2, baseServings: 2, batches: 1, ingredientOverrides: { 0: "300 ml" }, ...options.meal };
  return focusedStepAdditionAnswer({ recipe, meal, query, history: options.history ?? history,
    step: options.step ?? { number: 1, evidenceId: "S1", text: instructions[0] } });
}

test("the source action supplies each allocation and the override only supplies the dinner total", () => {
  for (const [steps, status] of [
    [["Whisk 50 ml of milk with the cornstarch.", "Stir in 150 ml of milk and simmer until thick."], "answered"],
    [["Whisk some of the milk with the cornstarch.", "Stir in the remaining milk and simmer until thick."], "unsupported"],
  ]) {
    const current = ask(steps, now);
    const later = ask(steps, rest, { history: [...history, { role: "user", content: now }, { role: "assistant", content: current.answer }] });
    assert.deepEqual(current.evidenceIds, ["I1", "S1"]);
    assert.deepEqual(later.evidenceIds, ["I1", "S1", "S2"]);
    for (const [i, result] of [current, later].entries()) {
      assert.equal(result.answerStatus, status);
      assert.ok(result.answer.includes(steps[i]));
      assert.match(result.answer, /Saved dinner total: 300 ml milk/);
      assert.doesNotMatch(result.answer, /(?:75|225|250|700) ml/);
      assert.equal(result.planningFacts[0].basis, "saved_override");
    }
  }
});

test("ambiguous references, method boundaries and unrelated follow-ups retain their scope", () => {
  const steps = ["Stovetop:", "Add milk and cornstarch.", "Oven:", "Add 100 ml of milk."];
  const step = { number: 1, evidenceId: "S2", text: steps[1] };
  assert.equal(ask(steps, now, { step, history: [] }).answerStatus, "needs_clarification");
  const otherMethod = ask(steps, rest, { step });
  assert.equal(otherMethod.answerStatus, "needs_clarification");
  assert.ok(!otherMethod.evidenceIds.includes("S4"));
  const multiple = ask(["Add 10 ml milk.", "Add 20 ml milk.", "Mix in the rest."], rest);
  assert.equal(multiple.answerStatus, "needs_clarification");
  const otherIngredient = ask(["Add 10 ml milk.", "Stir in the rest of the cornstarch."], rest);
  assert.equal(otherIngredient.answerStatus, "needs_clarification");
  assert.ok(!otherIngredient.evidenceIds.includes("S2"));
  assert.deepEqual(ask(steps, now, { step: { ...step, text: "Add honey." } }).evidenceIds, []);
  assert.equal(ask(steps, rest, { step, history: [{ role: "user", content: "How long do I let it rest?" }] }), undefined);
  assert.equal(ask(steps, "How much milk do I need for this dinner?", { step }), undefined);
});

test("only the ingredient's affirmative addition can establish its quantity or an unstated measure", () => {
  for (const instruction of [
    "Whisk some milk. Use a tablespoon.", "If needed, add 50 ml of milk.", "Do not add 50 ml of milk.",
    "Add 50 g of cornstarch to the milk.", "Whisk half the milk with the cornstarch.",
  ]) {
    const answer = ask([instruction], "How much of the milk goes in now?", { history: [] });
    assert.equal(answer.answerStatus, "unsupported");
    assert.ok(answer.answer.includes(instruction));
    assert.doesNotMatch(answer.answer, /no measured amount|which ingredient/i);
  }
  const changed = ask(["Add 50 ml of milk."], "How much of the milk goes in now?", { history: [],
    meal: { planningIngredients: [{ name: "cream", measure: "200 ml" }, starch] } });
  assert.equal(changed.answerStatus, "answered");
  assert.deepEqual(changed.planningFacts, []);
  assert.doesNotMatch(changed.answer, /300 ml/);
});
