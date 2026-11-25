import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const sources = await createSourceLoader({ name: "chef-cutting-help" });
after(() => sources.dispose());
const { cuttingHelp } = await sources.import("app/lib/chef-cutting-help.ts");

function ask(names, instructions, query, step) {
  const recipe = { ingredients: names.map(name => ({ name, measure: "2" })), instructions };
  return cuttingHelp({ recipe, query, step });
}

test("two foods in the same step keep their distinct cuts and sizes", () => {
  const text = "Scrub the potatoes and cut them into wedges no thicker than 2 cm. Peel the onion and cut it into thick wedges.";
  const names = ["potatoes", "onion"];
  const potato = ask(names, [text], "How should I cut the potato?");
  assert.equal(potato.answerStatus, "answered");
  assert.match(potato.answer, /wedges no thicker than 2 cm/);
  assert.match(potato.cookingTip, /center.*wedge/i);
  assert.doesNotMatch(potato.cookingTip, /cube|\d/);
  assert.deepEqual(potato.evidenceIds, ["I1", "S1"]);

  const onion = ask(names, [text], "How thick should I slice the onions?", { number: 1, evidenceId: "S1", text });
  assert.match(onion.answer, /onion.*thick wedges/);
  assert.doesNotMatch(onion.answer, /2 cm/);
  assert.match(onion.cookingTip, /wedge/);
  const incomplete = ask(names, [text], "How should I cut the");
  assert.equal(incomplete.answerStatus, "needs_clarification");
  assert.match(incomplete.answer, /potatoes and onion/);
  assert.equal(incomplete.cookingTip, undefined);
});

test("ingredient-only preparation and a single focused cut can answer an incomplete question", () => {
  const prep = ask(["finely diced carrot", "stock"], ["Warm the stock."], "How should I cut the carrots?");
  assert.equal(prep.answerStatus, "answered");
  assert.match(prep.answer, /finely diced carrot/);
  assert.deepEqual(prep.evidenceIds, ["I1"]);
  assert.match(prep.cookingTip, /slices.*strips.*across.*cubes/);
  const instruction = "Slice the carrots and add the onion whole.";
  const focused = ask(["carrots", "onion"], [instruction], "How should I cut them?", { evidenceId: "S1", number: 1, text: instruction });
  assert.equal(focused.answerStatus, "answered");
  assert.match(focused.cookingTip, /slice/);
  const plain = ask(["onion, chopped"], ["Warm the pan."], "How should I cut the onion?");
  assert.match(plain.answer, /ingredient list doesn't give an exact piece size/);
  assert.doesNotMatch(plain.cookingTip, /\d/);
});

test("halves and quarters keep the recipe's shape across directions and ingredient lines", () => {
  const halves = ask(["potatoes"], ["Halve the potatoes lengthwise."], "How should I cut them?");
  assert.deepEqual(halves.evidenceIds, ["I1", "S1"]);
  assert.match(halves.answer, /lengthwise/);
  assert.match(halves.cookingTip, /two halves/);
  for (const name of ["quartered potatoes", "potatoes, quartered", "potatoes cut into quarters"]) {
    const quarters = ask([name], ["Steam the potatoes."], "How should I cut the potatoes?");
    assert.equal(quarters.answerStatus, "answered");
    assert.match(quarters.cookingTip, /each half.*four pieces/);
    assert.deepEqual(quarters.evidenceIds, ["I1"]);
  }
  const two = ask(["onion cut in half"], ["Warm the pan."], "How should I cut the onion?");
  assert.match(two.cookingTip, /two halves/);
  const thick = ask(["potatoes"], ["Cut the potatoes into quarter-inch slices."], "How should I cut them?");
  assert.match(thick.cookingTip, /slice/);
  assert.doesNotMatch(thick.cookingTip, /four pieces/);
});

test("whole or grated source forms don't suggest a conflicting knife technique", () => {
  for (const [name, text] of [["carrot, grated", "Warm the pan."], ["carrot", "Grate the carrot."],
    ["carrot", "Add the grated carrot."], ["whole carrot", "Use the carrot whole."]]) {
    const result = ask([name], [text], "How do I dice the carrot?");
    assert.match(result.answer, /grat|whole/i);
    assert.equal(result.cookingTip, undefined);
  }
  const recipe = { ingredients: [{ name: "onion", measure: "1" }, { name: "carrot", measure: "1" }], instructions: ["Warm the pan."] };
  assert.equal(cuttingHelp({ recipe, query: "How do I dice them?" }).answerStatus, "needs_clarification");
  assert.match(cuttingHelp({ recipe, query: "How do I dice them?", ingredient: "onion" }).cookingTip, /cubes/);
});

test("conflicts, method choices and prohibitions never produce an unconditional technique", () => {
  const conflict = ask(["carrots, thinly sliced"], ["Dice the carrots into cubes."], "How should I cut the carrots?");
  assert.equal(conflict.answerStatus, "needs_clarification");
  assert.deepEqual(conflict.evidenceIds, ["I1", "S1"]);
  assert.equal(conflict.cookingTip, undefined);
  const methods = ["Oven:", "Dice the carrot.", "Stovetop:", "Slice the carrot into rounds."];
  assert.equal(ask(["carrot"], methods, "How should I cut the carrot?").answerStatus, "needs_clarification");
  const chosen = ask(["carrot"], methods, "How should I cut it?", { evidenceId: "S4", text: methods[3], number: 1 });
  assert.deepEqual(chosen.evidenceIds, ["I1", "S4"]);
  assert.match(chosen.cookingTip, /rounds/);
  for (const text of ["Do not cut the carrots.", "Leave the carrots whole.", "Use whole carrots.", "Slice the carrots or dice them."]) {
    const guarded = ask(["carrots"], [text], "How should I cut the carrots?");
    assert.ok(guarded.answer.includes(text));
    assert.equal(guarded.cookingTip, undefined);
  }
});

test("an unassigned cut, a kitchen idiom and a compound question keep their own meaning", () => {
  const unstated = ask(["carrots", "onion"], ["Chop the onion and serve with the carrots."], "How should I cut the carrots?");
  assert.equal(unstated.answerStatus, "unsupported");
  assert.doesNotMatch(unstated.answer, /Chop the onion/);
  assert.equal(unstated.cookingTip, undefined);
  const optionalDice = ask(["onion"], ["Warm the pan."], "How do I dice the onion?");
  assert.equal(optionalDice.answerStatus, "unsupported");
  assert.match(optionalDice.cookingTip, /strips.*cubes/);
  assert.equal(ask(["stock"], ["Warm the stock."], "How do I chop the stock?").cookingTip, undefined);
  assert.equal(ask(["carrots"], [], "How should I cut the heat?"), undefined);
  assert.equal(ask(["carrots"], [], "How should I cut the carrots and should I boil the water?"), undefined);
});

test("a source note can qualify a cut for the same ingredient", () => {
  const direction = "Slice the carrots into rounds.";
  const recipe = { ingredients: [{ name: "carrots", measure: "2" }, { name: "onion", measure: "1" }], instructions: [direction] };
  const query = "How should I cut the carrots?";
  const exception = "If using baby carrots, leave the carrots whole.";
  const qualified = cuttingHelp({ recipe: { ...recipe, sourceNotes: [exception] }, query });
  assert.equal(qualified.answerStatus, "needs_clarification");
  assert.ok(qualified.answer.includes(exception));
  assert.deepEqual(qualified.evidenceIds, ["I1", "S1", "N1"]);
  assert.equal(qualified.cookingTip, undefined);

  const separate = cuttingHelp({ recipe: { ...recipe, sourceNotes: ["Leave the onion whole."] }, query });
  assert.equal(separate.answerStatus, "answered");
  assert.deepEqual(separate.evidenceIds, ["I1", "S1"]);
  assert.match(separate.cookingTip, /rounds/i);
});
