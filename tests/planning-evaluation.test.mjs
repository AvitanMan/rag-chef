import assert from "node:assert/strict";
import { test } from "node:test";
import { planningLatency, planningRequestedDates } from "../tools/recipes/planning-grading.mjs";
const cases = [{ id:"cold" }, { id:"warm" }, { id:"clarification", clarification:true }];
const success = (id,milliseconds=100) => ({ id,milliseconds,response:{draft:{interpretation:"ollama"}},checks:[{name:"http_200",passed:true}] });
test("failed, missing or duplicated planning responses cannot pass latency even when fast", () => {
  assert.equal(planningLatency([success("cold"),success("warm")],cases).gatePassed,true);
  for (const records of [[],[success("cold")],[success("cold"),success("cold")],[success("cold"),{id:"warm",milliseconds:2,response:{error:{code:"planner_unavailable"}},checks:[{name:"http_200",passed:false}]}]]) {
    assert.equal(planningLatency(records,cases).gatePassed,false);
    assert.equal(planningLatency(records,cases).coveragePassed,false);
  }
  const unavailable = planningLatency([{id:"cold",milliseconds:2,checks:[]},{id:"warm",milliseconds:2,checks:[]}],cases);
  assert.equal(unavailable.warmSamples,0); assert.equal(unavailable.warmP95Ms,null); assert.equal(unavailable.successfulModelRequests,0);
});
test("cold start is separate and warm model response latency must meet the budget",()=>{
  const result=planningLatency([success("cold",25000),success("warm",2000)],cases);
  assert.equal(result.firstModelRequestMs,25000); assert.equal(result.warmP95Ms,2000); assert.equal(result.gatePassed,true);
  assert.equal(planningLatency([success("cold"),success("warm",15000)],cases).gatePassed,false);
});

test("planning dates require actual dinners and explanations for omitted expected dates", () => {
  const dates = ["2026-11-03", "2026-11-05"];
  const draft = { intent: { dates }, changes: dates.map(date => ({ date })), unresolved: [] };
  assert.equal(planningRequestedDates(draft, dates), true);
  const partial = { ...draft, changes: [{ date: dates[0] }] };
  assert.equal(planningRequestedDates({ ...partial, unresolved: [`${dates[1]}: saved dinner is protected.`] }, dates), true);
  for (const unresolved of [[], ["Not enough eligible recipes."], ["2026-11-06: no eligible dinner."], [`${dates[1]}: `]]) {
    assert.equal(planningRequestedDates({ ...partial, unresolved }, dates), false);
  }
  assert.equal(planningRequestedDates({ ...draft, changes: [], unresolved: dates.map(date => `${date}: no eligible dinner.`) }, dates), false);
  assert.equal(planningRequestedDates({ ...draft, intent: { dates: [] }, changes: [] }, []), false);
});

test("planning date grading rejects wrong self-reported targets, duplicates and unrequested dinners", () => {
  const dates = ["2026-11-03", "2026-11-05"];
  const draft = { intent: { dates }, changes: dates.map(date => ({ date })), unresolved: [] };
  for (const candidate of [
    { ...draft, intent: { dates: [dates[0]] } },
    { ...draft, intent: { dates: [dates[0], "2026-11-06"] } },
    { ...draft, changes: [{ date: dates[0] }, { date: dates[0] }] },
    { ...draft, changes: [...draft.changes, { date: "2026-11-06" }] },
  ]) assert.equal(planningRequestedDates(candidate, dates), false);
});

test("an empty plan needs independently unavailable choices and an explanation for every date", () => {
  const dates = ["2026-11-03", "2026-11-05"];
  const empty = { intent: { dates }, changes: [], unresolved: [] };
  assert.equal(planningRequestedDates(empty, dates, { requireProposal: false }), false);
  const explained = { ...empty, unresolved: dates.map(date => `${date}: no source-verified recipe meets the time limit.`) };
  assert.equal(planningRequestedDates(explained, dates, { requireProposal: true }), false);
  assert.equal(planningRequestedDates(explained, dates, { requireProposal: false }), true);
  assert.equal(planningRequestedDates({ ...explained, unresolved: explained.unresolved.slice(0, 1) }, dates, { requireProposal: false }), false);
});
