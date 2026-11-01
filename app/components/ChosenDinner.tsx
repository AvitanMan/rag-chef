"use client";

import { useEffect, useRef, useState } from "react";
import type { PlannedMeal } from "../lib/kitchen-types";
import { mealScale } from "../lib/kitchen-types";
import type { MealReadiness } from "../lib/quantities";
import type { RecipeEligibility } from "../lib/recipe-constraints";
import { ValidatedInput } from "./ValidatedInput";
import { DinnerAmounts, dateLabel } from "./WeeklyKitchenViews";

export function ChosenDinner({ meal, today, readiness, eligibility, patch, cook, change, details, shop, undo, methods, selectMethod, cancelMethod, methodsOpen }: {
  meal: PlannedMeal; today: string; readiness: MealReadiness | null;
  eligibility?: RecipeEligibility;
  patch: (patch: Partial<PlannedMeal>) => void; cook: () => void; change: () => void;
  details: () => void; shop: () => void; undo: () => void;
  methods: Array<{ title: string; steps: string[] }>; selectMethod: (index: number) => void;
  methodsOpen: boolean; cancelMethod: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [adjusting, setAdjusting] = useState(false);
  useEffect(() => { heading.current?.closest(".chosen-dinner")?.scrollIntoView({ block: "start", behavior: "instant" }); heading.current?.focus({ preventScroll: true }); }, [meal.id]);
  return <section className="panel chosen-dinner" aria-label="Chosen dinner">
    <span className="eyebrow">{meal.date === today ? "Tonight’s dinner" : `Dinner for ${dateLabel(meal.date)}`}</span>
    <h2 ref={heading} tabIndex={-1}>{meal.title}</h2>
    <p>{meal.servings ? `${meal.servings} servings` : `${mealScale(meal)} recipe batches`}{meal.locked ? " · Locked" : ""}{meal.status === "cooked" ? " · Cooked" : ""}</p>
    {eligibility && !eligibility.eligible && <p className="diet-note" role="alert">This saved recipe conflicts with your current requirements. {eligibility.reasons.join(" ")}</p>}
    {Boolean(eligibility?.dietUnknowns.length) && <p className="diet-note">Diet not verified: {eligibility!.dietUnknowns.map(diet => diet.replaceAll("_", " ")).join(", ")}</p>}
    {meal.status === "cooked" ? <><p role="status">Cooked. Your shopping list is up to date.</p><button className="secondary-button" onClick={undo}>Undo cooked</button></> : <>
      {readiness && <section className="dinner-needs" aria-label="Dinner shopping needs"><h3>What’s missing?</h3>
        <p>{readiness.coveredCount} covered · {readiness.partialCount} partial · {readiness.missingCount} missing · {readiness.reviewCount} need review</p>
        <p className="quantity-note">After reserving stock for your other saved dinners this week. Missing ingredients do not block cooking.</p>
        {readiness.shopping.length ? <ul>{readiness.shopping.map((item, index) => <li key={index}><strong>{item.name}</strong>: {item.measure}{item.needsReview ? " · Review amount" : ""}{item.preparationNote && <small>{item.preparationNote}</small>}</li>)}</ul> : <p>Known quantities are covered.</p>}
      </section>}
      {!meal.recipe && <p role="alert">This saved recipe is unavailable. Choose a replacement to recover its shopping amounts.</p>}
      {methodsOpen ? <section className="method-picker" aria-label="Choose cooking method"><h3>Choose a cooking method</h3>{methods.map((method, index) => <button className="primary-button" key={index} onClick={() => selectMethod(index)}>Cook · {method.title}</button>)}<button className="text-button" onClick={cancelMethod}>Cancel method selection</button></section>
        : meal.recipe && <button className="primary-button" onClick={cook}>Cook dinner</button>}
      {!meal.locked && <button className="text-button" onClick={change}>Change dinner</button>}
      {meal.recipe && <details open={adjusting} onToggle={event => setAdjusting(event.currentTarget.open)}><summary>Adjust amounts</summary>
        <label>{meal.baseServings ? "Servings" : "Recipe batches"}<ValidatedInput aria-label="Dinner portions" type="number" min={1} max={100} step={1} value={meal.baseServings ? meal.servings ?? 1 : meal.batches} disabled={meal.locked} onCommit={text => { const value = Number(text); patch(meal.baseServings ? { servings: value } : { batches: value }); }} /></label>
        <DinnerAmounts meal={meal} patch={patch} />
      </details>}
    </>}
    <div className="dinner-secondary-actions">{meal.recipe && <button className="text-button" onClick={details}>Recipe details</button>}<button className="text-button" onClick={shop}>Weekly shopping</button></div>
  </section>;
}
