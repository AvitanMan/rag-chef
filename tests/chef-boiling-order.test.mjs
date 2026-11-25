import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createSourceLoader } from "../tools/testing/load-source.mjs";

const loader = await createSourceLoader({ name: "boiling-order" });
after(() => loader.dispose());
const { boilingOrderHelp } = await loader.import("app/lib/chef-boiling-order.ts");
const ingredients = ["water", "pasta", "potatoes", "salt"].map(name => ({ name, measure: "" }));
function ask(instructions, query = "Should I boil the water before adding the pasta?", step) {
  return boilingOrderHelp({ recipe: { ingredients, instructions }, query, step });
}

test("water order answers identify the addition, preserve the cooking cue, and cite both directions", () => {
  const steps = ["Bring the water to a boil.", "Add the pasta and cook for 8 minutes."];
  for (const query of ["Should I boil the water before adding the pasta?", "should i boil the water before", "Do I need to boil water before I add it?"]) {
    const result = ask(steps, query);
    assert.equal(result.answerStatus, "answered");
    assert.match(result.answer, /yes\b/i);
    assert.match(result.answer, /Add the pasta and cook/i);
    assert.equal(result.technique, "Boiling");
    assert.match(result.answer, /cook for 8 minutes/);
    assert.deepEqual(result.evidenceIds, ["S1", "S2"]);
  }
  const everyday = ask(["Bring the water to a boil in a saucepan on the stovetop. Add the pasta and cook according to its package directions until just tender. Drain the pasta."]);
  assert.match(everyday.answer, /yes\b.*just tender/i);
  assert.deepEqual(everyday.evidenceIds, ["S1"]);
  const direct = ask(["Add pasta to the boiling water."]);
  assert.equal(direct.answerStatus, "answered");
});

test("cold starts, heating together, and prohibitions keep their actual sequence", () => {
  for (const steps of [
    ["Put the potatoes in cold water, then bring to a boil."],
    ["Cover the potatoes with cold water.", "Bring to a boil."],
    ["Combine the potatoes and water in a pot.", "Bring everything to a boil."],
    ["Put the potatoes and water in a saucepan.", "Bring the water to a boil."],
  ]) {
    const result = ask(steps, "Should I boil water before adding the potatoes?");
    assert.match(result.answer, /^No\. /);
    assert.equal(result.answerStatus, "answered");
    assert.match(result.answer, /bring .*boil/i);
    assert.equal(result.evidenceIds.length, steps.length);
  }
  const ban = ask(["Do not boil the water.", "Add the pasta."], "Should I boil water first?");
  assert.equal(ban.answerStatus, "answered");
  assert.match(ban.answer, /Do not boil the water/);
});

test("unrelated liquids, separate pans, conditionals and multiple methods do not establish an order", () => {
  for (const steps of [
    ["Bring the stock to a boil.", "Add the pasta."],
    ["Bring the water to a boil.", "Add the pasta to the sauce."],
    ["If making soup, bring the water to a boil, then add pasta."],
    ["Cook the pasta."],
    ["Bring the water to a boil.", "Add the pasta.", "Alternatively, put the pasta in cold water."],
  ]) {
    const gap = ask(steps);
    assert.equal(gap.answerStatus, "unsupported");
    assert.doesNotMatch(gap.answer, /^Yes|^No\./);
  }
  assert.equal(ask(["Cook the potatoes."], "should i boil the water before").answerStatus, "needs_clarification");
  const methods = ["Stovetop", "Bring water to a boil. Add pasta.", "Oven", "Cover pasta with cold water."];
  assert.equal(ask(methods).answerStatus, "needs_clarification");
  const step = { number: 1, evidenceId: "S4", text: methods[3] };
  assert.match(ask(methods, "Should I boil the water before adding the pasta?", step).answer, /^No\./);
  assert.deepEqual(ask(methods, "Should I boil water first?", step).evidenceIds, ["S4"]);
  assert.equal(ask(["Boil water. Add pasta.", "Cover potatoes with cold water."], "Should I boil the water before").answerStatus, "needs_clarification");
  assert.equal(ask([], "Should I boil the water before adding the pasta and how much salt should I use?"), undefined);
});

test("a cold preparation and a later boiling-water cooking step keep their separate evidence", () => {
  const directions = ["Put the potatoes in cold water.", "Drain them.", "Cook the potatoes in boiling water until tender."];
  const cooking = ask(directions, "Should I boil the water before cooking the potatoes?");
  assert.equal(cooking.answerStatus, "answered");
  assert.match(cooking.answer, /^Yes\. .*boiling water until tender/i);
  assert.deepEqual(cooking.evidenceIds, ["S3"]);
  const addition = ask(directions, "Should I boil the water before adding the potatoes?");
  assert.equal(addition.answerStatus, "needs_clarification");
  assert.match(addition.answer, /cold water.*boiling water/i);
  assert.deepEqual(addition.evidenceIds, ["S1", "S3"]);
  const soakOnly = ask(directions.slice(0, 2), "Should I boil the water before cooking the potatoes?");
  assert.equal(soakOnly.answerStatus, "unsupported");
});

test("a later sauce adjustment does not override the pasta's boiling-water instruction", () => {
  const directions = ["Cook the pasta in boiling water until just tender.", "If needed, loosen the sauce with cold water."];
  for (const query of ["Should I boil the water before adding the pasta?", "Should I boil the water before putting in the pasta?", "Should I boil the water before I put the pasta in the pot?"]) {
    const result = ask(directions, query);
    assert.equal(result.answerStatus, "answered");
    assert.deepEqual(result.evidenceIds, ["S1"]);
    assert.match(result.answer, /until just tender/);
  }
  assert.equal(ask(["Do not boil the water.", "Add potatoes to the stock."]).answerStatus, "unsupported");
});

test("recipe notes can qualify a boiling-water or cold-start instruction for the selected ingredient", () => {
  const instructions = ["Bring the water to a boil.", "Add the pasta."];
  const askWithNote = (note, steps = instructions) => boilingOrderHelp({
    recipe: { ingredients, instructions: steps, sourceNotes: [note] },
    query: "Should I boil the water before adding the pasta?",
  });
  for (const note of ["If using fresh pasta, start the pasta in cold water.", "If using fresh pasta, start in cold water.", "Start in cold water."]) {
    const result = askWithNote(note);
    assert.equal(result.answerStatus, "needs_clarification");
    assert.ok(result.answer.includes(note));
    assert.match(result.answer, /Does that note apply/);
    assert.deepEqual(result.evidenceIds, ["S1", "S2", "N1"]);
    assert.equal(result.technique, undefined);
  }
  for (const note of ["Start the potatoes in cold water.", "For the potatoes, start in cold water.",
    "If making the pasta, start the potatoes in cold water.", "Rinse the colander in cold water.", "Do not start the pasta in cold water."]) {
    const unchanged = askWithNote(note);
    assert.match(unchanged.answer, /^Yes\./);
    assert.deepEqual(unchanged.evidenceIds, ["S1", "S2"]);
  }
  const opposite = askWithNote("If using dried pasta, add the pasta to boiling water.", ["Cover the pasta with cold water."]);
  assert.equal(opposite.answerStatus, "needs_clarification");
  assert.deepEqual(opposite.evidenceIds, ["S1", "N1"]);
});
