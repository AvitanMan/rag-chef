"use client";

/* eslint-disable @next/next/no-img-element -- Source recipe images are dynamic. */

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { ValidatedInput } from "./ValidatedInput";
import { measureInputProblem } from "../lib/kitchen-validation";
import { Modal } from "./Modal";
import type { KitchenState, PlannedMeal } from "../lib/kitchen-types";
import { mealScale } from "../lib/kitchen-types";
import type { Recipe } from "../lib/recipe-types";
import { addDateDays, defaultDinnerDate, localDate, weekStart } from "../lib/kitchen-state";
import { formatMeasure, plannedIngredientMeasure, type ShoppingItem } from "../lib/quantities";

type UpdateKitchen = (change: (state: KitchenState) => KitchenState) => void;

export function dateLabel(date: string, options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en", options);
}

export function DurablePlanView({ week, today, setWeek, meals, update, removeMeals, chooseMeal, chooseDay, cookMeal, reviewDate, setReviewDate, generatePlan, preferReviewedMains, setPreferReviewedMains, openMeal, markCooked, undoCooked, goShopping, catalogState, retryCatalog, planningNotice, planningReasons = {}, focusDate, clearFocusDate }: {
  today?: string;
  focusDate?: string | null;
  clearFocusDate?: () => void;
  catalogState: "loading" | "ready" | "error";
  retryCatalog: () => void;
  planningNotice: string;
  planningReasons?: Record<string, string>;
  week: string;
  setWeek: (week: string) => void;
  meals: Record<string, PlannedMeal>;
  update: UpdateKitchen;
  removeMeals: (dates: string[]) => void;
  chooseMeal: (date: string, recipe: Recipe, template?: PlannedMeal, expectedId?: string | null) => boolean;
  chooseDay: (date: string) => void;
  cookMeal: (date: string) => void;
  reviewDate: string | null;
  setReviewDate: Dispatch<SetStateAction<string | null>>;
  generatePlan: () => void;
  preferReviewedMains: boolean;
  setPreferReviewedMains: (value: boolean) => void;
  openMeal: (date: string) => void;
  markCooked: (date: string) => void;
  undoCooked: (date: string) => void;
  goShopping: () => void;
}) {
  const [pending, setPending] = useState<{ date: string; recipe: Recipe; template?: PlannedMeal; expectedId: string } | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  useEffect(() => {
    if (!reviewDate) return;
    const frame = requestAnimationFrame(() => document.getElementById(`amounts-${reviewDate}`)?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [reviewDate]);
  useEffect(() => {
    if (!focusDate) return;
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(`dinner-${focusDate}`);
      card?.scrollIntoView({ block: "center", behavior: "instant" });
      card?.focus({ preventScroll: true });
      clearFocusDate?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusDate, clearFocusDate]);
  const dates = Array.from({ length: 7 }, (_, index) => addDateDays(week, index));
  const requestChoice = (date: string, recipe: Recipe, template?: PlannedMeal) => {
    if (meals[date]?.locked || meals[date]?.status === "cooked") return;
    if (meals[date]) setPending({ date, recipe, template, expectedId: meals[date].id });
    else chooseMeal(date, recipe, template, null);
  };
  const patchMeal = (date: string, patch: Partial<PlannedMeal>) => update((state) => {
    const meal = state.meals[date];
    if (!meal || meal.status === "cooked" || (meal.locked && patch.locked !== false)) return state;
    return { ...state, meals: { ...state.meals, [date]: { ...meal, ...patch } } };
  });
  const count = dates.filter((date) => meals[date]).length;
  const needsReview = dates.filter((date) => {
    const meal = meals[date];
    return meal && meal.status !== "cooked" && (!meal.recipe || (meal.planningIngredients ?? meal.recipe.ingredients).some((item, index) => !plannedIngredientMeasure(meal, index, item)));
  });

  return (
    <>
      {today && weekStart(today) === week && <section className="panel today-summary" aria-label="Today’s dinner"><div><span className="eyebrow">Today · {dateLabel(today)}</span><strong>{meals[today]?.title ?? "What’s for dinner tonight?"}</strong></div><button className="primary-button" onClick={() => {
        if (!meals[today]) { chooseDay(today); return; }
        const card = document.getElementById(`dinner-${today}`); card?.scrollIntoView({ block: "center" }); card?.focus({ preventScroll: true });
      }}>{meals[today] ? "View today’s dinner" : "Choose tonight’s dinner"}</button></section>}
      <section className="planner-intro" aria-label="Plan actions">
        <p>Choose a day to add dinner.</p>
        <div className="planner-actions"><button className="secondary-button" onClick={generatePlan} disabled={count === 7 || catalogState !== "ready"}>Fill empty days</button><details><summary>More</summary><button className="text-button" onClick={() => setClearConfirm(true)}>Clear unlocked</button></details></div>
        <label className="planner-preference"><input type="checkbox" checked={preferReviewedMains} onChange={(event) => setPreferReviewedMains(event.target.checked)} />Prefer reviewed mains</label>
        <p className="quantity-note">{preferReviewedMains ? "Reviewed mains come first. If they run out, unreviewed recipes can fill the remaining days; known sides and desserts stay out." : "Use the wider collection, including sides and desserts. Check that each choice makes a complete dinner."}</p>
      </section>
      {catalogState !== "ready" && <div className="inline-confirm" role="status"><span>{catalogState === "loading" ? "Loading the full recipe catalog…" : "The full recipe catalog could not load. Your saved dinners are unchanged."}</span>{catalogState === "error" && <button className="secondary-button" onClick={retryCatalog}>Retry catalog</button>}</div>}
      {planningNotice && <p role="status">{planningNotice}</p>}
      {needsReview.length > 0 && <div className="inline-confirm"><span>{needsReview.length} {needsReview.length === 1 ? "dinner needs" : "dinners need"} amount review. Shopping is still available.</span><button className="text-button" onClick={() => { setReviewDate(needsReview[0]); document.getElementById(`amounts-${needsReview[0]}`)?.scrollIntoView({ block: "center" }); }}>Review amounts</button></div>}
      <div className="week-navigation"><div className="week-range"><button className="secondary-button" aria-label="Previous week" onClick={() => setWeek(addDateDays(week, -7))}>←</button><strong>{dateLabel(week, { month: "long", day: "numeric", year: "numeric" })} – {dateLabel(dates[6], { month: "short", day: "numeric" })}</strong><button className="secondary-button" aria-label="Next week" onClick={() => setWeek(addDateDays(week, 7))}>→</button></div><button className="secondary-button" disabled={!today || week === weekStart(today)} onClick={() => { if (today) setWeek(weekStart(today)); }}>This week</button></div>
      {clearConfirm && <div className="inline-confirm" role="alert"><span>Remove this week’s unlocked, uncooked dinners? Locked and cooked meals will stay.</span><button className="secondary-button" onClick={() => setClearConfirm(false)}>Keep meals</button><button className="primary-button" onClick={() => {
        removeMeals(dates);
        setClearConfirm(false);
      }}>Remove unlocked meals</button></div>}
      <section className="week-grid durable-week">
        {dates.map((date) => {
          const meal = meals[date];
          const recipe = meal?.recipe;
          const immutable = meal?.locked || meal?.status === "cooked";
          return <article className={`day-card ${meal ? "filled" : ""} ${date === today ? "is-today" : ""}`} key={date} id={`dinner-${date}`} tabIndex={-1} aria-label={dateLabel(date)} aria-current={date === today ? "date" : undefined}>
            <div className="day-heading"><span className="day-name">{dateLabel(date)}</span>{date === today && <span className="today-badge">Today</span>}{meal && <span className={`meal-status ${meal.status}`}>{meal.status === "cooked" ? "Cooked" : meal.locked ? "Locked" : "Planned"}</span>}</div>
            {recipe ? <>{recipe.image && <button className="day-image" onClick={() => openMeal(date)} aria-label={`View photo of ${meal.title}`}><img src={recipe.image} alt="" /></button>}<button className="day-recipe-title" onClick={() => openMeal(date)} aria-label={`Open ${meal.title} on ${dateLabel(date)}`}>{meal.title}</button></> : meal ? <div className="missing-recipe"><strong>{meal.title}</strong><p>Recipe unavailable. Choose a replacement to recover its shopping amounts.</p></div> : null}
            {!immutable && <button className={meal ? "text-button" : "primary-button"} onClick={() => chooseDay(date)} aria-label={`${meal ? "Change dinner" : "Choose dinner"} ${dateLabel(date)}`}>{meal ? "Change dinner" : "Choose dinner"}</button>}
            {meal && planningReasons[date] && <p className="quantity-note">{planningReasons[date]}</p>}
            {meal && <>
              <div className="meal-amounts">
                {meal.baseServings ? <label>Cook for<ValidatedInput type="number" min={1} max={100} step={1} aria-label={`Servings ${dateLabel(date)}`} value={meal.servings ?? meal.baseServings} disabled={Boolean(immutable)} onCommit={(value) => patchMeal(date, { servings: Number(value) })} /><span>servings</span></label> : <label>Recipe batches<ValidatedInput type="number" min={0.25} max={20} step={0.25} aria-label={`Batches ${dateLabel(date)}`} value={meal.batches} disabled={Boolean(immutable)} onCommit={(value) => patchMeal(date, { batches: Number(value) })} /></label>}
              </div>
              {recipe && meal.status === "planned" && <button className="primary-button" onClick={() => cookMeal(date)} aria-label={`Cook ${meal.title} ${dateLabel(date)}`}>Cook</button>}
              {recipe && <details id={`amounts-${date}`} className="meal-review" open={reviewDate === date} onToggle={(event) => { if (event.currentTarget.open) setReviewDate(date); else setReviewDate((current) => current === date ? null : current); }}><summary>Adjust amounts</summary>
                <label>Original recipe servings (if known)<ValidatedInput type="number" min={1} max={10000} step={1} allowEmpty placeholder="Unknown" aria-label={`Original servings ${dateLabel(date)}`} value={meal.baseServings ?? ""} disabled={Boolean(immutable)} onCommit={(text) => {
                  const baseServings = text.trim() ? Number(text) : null;
                  patchMeal(date, { baseServings, servings: baseServings ? (meal.servings ?? baseServings) : null });
                }} /></label>
                <p>{meal.baseServings ? "Amounts scale to your serving count." : "Servings are unknown, so quantities use recipe batches."} Enter a final amount below to correct any ingredient. Source wording stays unchanged.</p>{(meal.planningIngredients ?? recipe.ingredients).map((ingredient, index) => {
                const parsed = plannedIngredientMeasure(meal, index, ingredient);
                const scaled = parsed ? formatMeasure(parsed.quantity * mealScale(meal), parsed.unit) : ingredient.measure;
                return <label key={index}>{ingredient.name}<ValidatedInput validate={measureInputProblem} value={meal.ingredientOverrides[String(index)] ?? ""} placeholder={scaled || "Amount needs review"} aria-label={`${ingredient.name} amount ${dateLabel(date)}`} disabled={Boolean(immutable)} onCommit={(value) => {
                  const overrides = { ...meal.ingredientOverrides };
                  if (value.trim()) overrides[String(index)] = value;
                  else delete overrides[String(index)];
                  patchMeal(date, { ingredientOverrides: overrides });
                }} />{meal.planningIngredients && ingredient.name !== recipe.ingredients[index].name && <small>Source: {recipe.ingredients[index].measure} {recipe.ingredients[index].name}</small>}</label>;
              })}</details>}
              {meal.status === "cooked" && <button className="text-button" onClick={() => undoCooked(date)}>Undo cooked</button>}
              <details className="meal-more"><summary>More options</summary><div className="meal-controls">
                {recipe && meal.status === "planned" && <button className="text-button" onClick={() => markCooked(date)}>Mark cooked without cooking mode</button>}
                {meal.status !== "cooked" && <><button className="text-button" onClick={() => patchMeal(date, { locked: !meal.locked })}>{meal.locked ? "Unlock" : "Lock"}</button><button className="text-button" disabled={meal.locked} onClick={() => removeMeals([date])}>Remove</button></>}
              </div>
              {recipe && <label className="copy-meal">Copy dinner to<select aria-label={`Copy ${dateLabel(date)} dinner`} value="" onChange={(event) => { if (event.target.value) requestChoice(event.target.value, recipe, meal); }}><option value="">Choose day…</option>{dates.filter((target) => target !== date && !meals[target]?.locked && meals[target]?.status !== "cooked").map((target) => <option key={target} value={target}>{dateLabel(target)}{meals[target] ? " (replace)" : ""}</option>)}</select></label>}
              </details>
            </>}
          </article>;
        })}
      </section>
      <div className="plan-footer"><p><strong>{count} of 7 dinners planned.</strong></p><button className="primary-button" onClick={goShopping}>Open shopping list →</button></div>
      {pending && <Modal className="kitchen-modal-backdrop" label="Replace dinner" close={() => setPending(null)}><section className="panel kitchen-modal"><h2>Replace this dinner?</h2><p>{meals[pending.date]?.title} on {dateLabel(pending.date)} will be replaced with {pending.recipe.title}.</p>{(meals[pending.date]?.id !== pending.expectedId || meals[pending.date]?.locked || meals[pending.date]?.status === "cooked") && <p>This dinner changed or became protected. Cancel and choose again.</p>}<div className="modal-actions"><button className="secondary-button" onClick={() => setPending(null)}>Keep current dinner</button><button className="primary-button" disabled={meals[pending.date]?.id !== pending.expectedId || meals[pending.date]?.locked || meals[pending.date]?.status === "cooked"} onClick={() => { if (chooseMeal(pending.date, pending.recipe, pending.template, pending.expectedId)) setPending(null); }}>Replace dinner</button></div></section></Modal>}
    </>
  );
}

export function PlanPicker({ recipe, week, meals, close, choose, today = localDate() }: { today?: string; recipe: Recipe; week: string; meals: Record<string, PlannedMeal>; close: () => void; choose: (date: string, recipe: Recipe, expectedId: string | null) => boolean }) {
  const dates = Array.from({ length: 7 }, (_, index) => addDateDays(week, index));
  const [date, setDate] = useState(() => defaultDinnerDate(week, today, meals));
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirming = Boolean(meals[date] && confirmingId === meals[date].id);
  const unavailable = !date || meals[date]?.locked || meals[date]?.status === "cooked";
  return <Modal className="kitchen-modal-backdrop" label="Choose dinner day" close={close}><section className="panel kitchen-modal"><span className="eyebrow">Add to this week</span><h2>{recipe.title}</h2><label>Dinner date<select value={date} onChange={(event) => { setDate(event.target.value); setConfirmingId(null); }}><option value="">Choose a date…</option>{dates.map((value) => <option key={value} value={value}>{dateLabel(value)}{meals[value] ? ` · ${meals[value].title}` : " · empty"}</option>)}</select></label>{!date ? <p>No upcoming empty dates in this week. Choose a date to add or replace dinner.</p> : unavailable ? <p>This dinner is locked or cooked. Choose an empty day or unlock it in the plan.</p> : meals[date] && <p>{confirming ? "Confirm replacing" : "This day already has"} {meals[date].title}.</p>}<div className="modal-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" disabled={Boolean(unavailable)} onClick={() => { if (meals[date] && !confirming) { setConfirmingId(meals[date].id); return; } if (choose(date, recipe, meals[date]?.id ?? null)) close(); }}>{meals[date] ? confirming ? "Confirm replacement" : "Replace dinner…" : "Add dinner"}</button></div></section></Modal>;
}

export function DurableShoppingView({ items, checked, update, hasPlan, goPlan, reviewMeal, week }: { items: ShoppingItem[]; checked: Record<string, boolean>; update: UpdateKitchen; hasPlan: boolean; goPlan: () => void; reviewMeal: (date: string) => void; week: string }) {
  const toBuy = items.filter((item) => !checked[item.key]).sort((a, b) => Number(b.needsReview) - Number(a.needsReview));
  const bought = items.filter((item) => checked[item.key]);
  const reviewCount = items.filter((item) => item.needsReview).length;
  const renderItem = (item: ShoppingItem) => <div className={`shopping-item ${checked[item.key] ? "checked" : ""}`} key={item.key}>
        <label><input type="checkbox" aria-label={`Bought ${item.name} ${item.measure}`} checked={Boolean(checked[item.key])} onChange={(event) => { const done = event.target.checked; update((state) => ({ ...state, shoppingChecked: { ...state.shoppingChecked, [item.key]: done } })); }} /><span><strong>{item.name}</strong><small>{item.measure}</small></span></label>
        <div className="shopping-detail">
          {item.preparationNote && <small>{item.preparationNote}</small>}
          {item.needsReview && <><b>{item.preparationNote ? "Review preparation" : "Review amount"}</b><div>{item.mealDates.map((date) => <button className="text-button" key={date} aria-label={`Review ${item.name} for ${dateLabel(date)}`} onClick={() => reviewMeal(date)}>Review {dateLabel(date)}</button>)}</div></>}
          <details className="calculation-details"><summary>See calculation</summary><small>Plan: {item.requiredMeasure}{item.pantryMeasure ? ` · Pantry: ${item.pantryMeasure}` : ""}</small>{item.notes.map((note, index) => <small key={index}>{note}</small>)}<small>For: {item.recipeTitles.join(", ")}</small></details>
        </div>
      </div>;
  return <div className="shopping-layout focused-shopping">
    <section className="panel shopping-panel">
      <div className="section-heading"><div><p>Week of {dateLabel(week)}</p><h2 role="status">{toBuy.length} {toBuy.length === 1 ? "item" : "items"} left</h2></div><button className="text-button" onClick={goPlan}>Edit plan</button></div>
      {reviewCount > 0 && <p className="quantity-note" role="status">{reviewCount} {reviewCount === 1 ? "item needs" : "items need"} review. You can still use this list.</p>}
      {items.length ? <>
        {toBuy.length ? <section className="shopping-list" aria-label="To buy">{toBuy.map(renderItem)}</section> : <p role="status">Everything on this list is checked.</p>}
        {bought.length > 0 && <details className="bought-items"><summary>Bought ({bought.length})</summary><section className="shopping-list" aria-label="Bought items">{bought.map(renderItem)}</section><button className="text-button" onClick={() => update((state) => ({ ...state, shoppingChecked: Object.fromEntries(Object.entries(state.shoppingChecked).filter(([key]) => !key.startsWith(`${week}:`))) }))}>Uncheck all</button></details>}
        <details className="shopping-help"><summary>How totals work</summary><p>Unfinished dinners in this week are added together, then compatible pantry amounts are subtracted. Cooked and uncooked ingredients stay separate. Unclear amounts and preparation differences need review. Changed quantities become unchecked. Checking an item does not change your pantry.</p></details>
      </> : <div className="empty-state"><strong>{hasPlan ? "No remaining shopping for these dinners." : "Plan a few dinners first."}</strong><p>{hasPlan ? "Known quantities are covered or the meals have been cooked." : "Choose dinners to build your shopping totals."}</p><button className="primary-button" onClick={goPlan}>Go to weekly plan</button></div>}
    </section>
  </div>;
}
