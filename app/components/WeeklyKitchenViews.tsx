"use client";

import { randomId } from "../lib/random-id";

/* eslint-disable @next/next/no-img-element -- Source recipe images are dynamic. */

import { useEffect, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";
import { ValidatedInput } from "./ValidatedInput";
import { measureInputProblem } from "../lib/kitchen-validation";
import { Modal } from "./Modal";
import type { KitchenState, PlannedMeal } from "../lib/kitchen-types";
import { DINNER_AMOUNT_LIMITS, mealScale } from "../lib/kitchen-types";
import type { Recipe } from "../lib/recipe-types";
import { addDateDays, weekStart } from "../lib/kitchen-state";
import { mealAmountLabel, formatMeasure, plannedIngredientMeasure, type ShoppingItem, type MealReadiness } from "../lib/quantities";
import { setShoppingItemBought, undoShoppingCheck } from "../lib/shopping-purchases";
import { ShoppingExport } from "./ShoppingExport";
import { KitchenIcon } from "./KitchenIcon";

type UpdateKitchen = (change: (state: KitchenState) => KitchenState) => void;

export function dateLabel(date: string, options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en", options);
}

export function DurablePlanView({ week, today, setWeek, meals, update, removeMeals, chooseMeal, chooseDay, cookMeal, reviewDate, setReviewDate, generatePlan, preferReviewedMains, setPreferReviewedMains, openMeal, markCooked, undoCooked, goShopping, catalogState, retryCatalog, planningNotice, planningReasons = {}, focusDate, clearFocusDate, shoppingCount = 0, planWithChef, useSoon, setup, todayReadiness }: {
  todayReadiness?: MealReadiness;
  planWithChef?: () => void;
  useSoon?: ReactNode;
  setup?: ReactNode;
  shoppingCount?: number;
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
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());
  const [expandedPastWeek, setExpandedPastWeek] = useState<string | null>(null);
  const currentWeek = Boolean(today && weekStart(today) === week);
  const showPast = expandedPastWeek === week || Boolean(currentWeek && today && ((focusDate && focusDate < today) || (reviewDate && reviewDate < today)));
  useEffect(() => {
    if (!reviewDate) return;
    const frame = requestAnimationFrame(() => document.getElementById(`amounts-${reviewDate}`)?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [reviewDate]);
  useEffect(() => {
    if (!focusDate) return;
    const frame = requestAnimationFrame(() => {
      setExpandedDays(previous => new Set(previous).add(focusDate));
      if (today && focusDate < today) setExpandedPastWeek(week);
      const card = document.getElementById(`dinner-${focusDate}`);
      card?.scrollIntoView({ block: "center", behavior: "instant" });
      card?.focus({ preventScroll: true });
      clearFocusDate?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusDate, clearFocusDate, today, week]);
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
    <div className="plan-workspace">
      <aside className="plan-context" aria-label="Tonight and your pantry">
      {today && weekStart(today) === week && <section className="panel today-summary" aria-label="Today’s dinner">
        <div className="today-copy"><span className="eyebrow">Today · {dateLabel(today)}</span><strong>{meals[today]?.title ?? "What’s for dinner tonight?"}</strong>
          {!meals[today] && <p>Start with what’s in your pantry. We’ll help with the rest.</p>}
          {meals[today] && <small>{meals[today].status === "cooked" ? "Cooked" : meals[today].servings ? `${meals[today].servings} servings` : `${mealScale(meals[today])} recipe batches`}{meals[today].locked ? " · Locked" : ""}</small>}
          {todayReadiness && <p className="today-readiness" aria-label="Tonight’s ingredient summary">{todayReadiness.missingCount + todayReadiness.partialCount ? `${todayReadiness.missingCount + todayReadiness.partialCount} ingredients still needed` : todayReadiness.reviewCount ? "Check your ingredient amounts" : "Known ingredient amounts covered"}{todayReadiness.reviewCount > 0 && ` · ${todayReadiness.reviewCount} amounts to review`}</p>}
        </div>
        <div className="today-actions">{!meals[today] ? <button className="primary-button" onClick={() => chooseDay(today)}>Choose tonight’s dinner</button> : <>
          {meals[today].recipe && meals[today].status !== "cooked" && <button className="primary-button" onClick={() => cookMeal(today)}>Cook this dinner</button>}
          {!meals[today].locked && meals[today].status !== "cooked" && <button className="text-button" onClick={() => chooseDay(today)}>Change</button>}
          {meals[today].status === "cooked" && meals[today].recipe && <button className="text-button" onClick={() => openMeal(today)}>View cooked dinner</button>}
        </>}
          <button className="text-button" aria-label="Review shopping" onClick={goShopping}>Review shopping{shoppingCount ? ` · ${shoppingCount} to buy` : ""}</button>
        </div>
      </section>}
      {setup}
      {useSoon}
      </aside>
      <div className="plan-main">
      <section className="planner-intro" aria-label="Plan actions">
        <div><h2>Your week, at a glance</h2><p>{count} of 7 dinners planned · Choose a day to add dinner.</p></div>
        <div className="planner-actions">{planWithChef && <button className="primary-button" onClick={planWithChef}><KitchenIcon name="chef" />Plan with Chef</button>}<button className="secondary-button" onClick={generatePlan} disabled={count === 7 || catalogState !== "ready"}>Fill empty days</button><details><summary>More</summary><button className="text-button" onClick={() => setClearConfirm(true)}>Clear unlocked</button></details></div>
        <details className="fill-options"><summary>Fill options</summary><label className="planner-preference"><input type="checkbox" checked={preferReviewedMains} onChange={(event) => setPreferReviewedMains(event.target.checked)} />Prefer reviewed mains</label>
        <p className="quantity-note">{preferReviewedMains ? "Reviewed mains come first. If they run out, unreviewed recipes can fill the remaining days; known sides and desserts stay out." : "Use the wider collection, including sides and desserts. Check that each choice makes a complete dinner."}</p></details>
      </section>
      {catalogState !== "ready" && <div className="inline-confirm" role="status"><span>{catalogState === "loading" ? "Loading the full recipe catalog…" : "The full recipe catalog could not load. Your saved dinners are unchanged."}</span>{catalogState === "error" && <button className="secondary-button" onClick={retryCatalog}>Retry catalog</button>}</div>}
      {planningNotice && <p role="status">{planningNotice}</p>}
      {needsReview.length > 0 && <div className="inline-confirm"><span>{needsReview.length} {needsReview.length === 1 ? "dinner needs" : "dinners need"} amount review. Shopping is still available.</span><button className="text-button" onClick={() => { setReviewDate(needsReview[0]); document.getElementById(`amounts-${needsReview[0]}`)?.scrollIntoView({ block: "center" }); }}>Review amounts</button></div>}
      <div className="week-navigation"><div className="week-range"><button className="secondary-button" aria-label="Previous week" onClick={() => setWeek(addDateDays(week, -7))}>←</button><strong>{dateLabel(week, { month: "long", day: "numeric", year: "numeric" })} – {dateLabel(dates[6], { month: "short", day: "numeric" })}</strong><button className="secondary-button" aria-label="Next week" onClick={() => setWeek(addDateDays(week, 7))}>→</button></div><button className="secondary-button" disabled={!today || week === weekStart(today)} onClick={() => { if (today) setWeek(weekStart(today)); }}>This week</button></div>
      {clearConfirm && <div className="inline-confirm" role="alert"><span>Remove this week’s unlocked, uncooked dinners? Locked and cooked meals will stay.</span><button className="secondary-button" onClick={() => setClearConfirm(false)}>Keep meals</button><button className="primary-button" onClick={() => {
        removeMeals(dates);
        setClearConfirm(false);
      }}>Remove unlocked meals</button></div>}
      {currentWeek && today && today > week && <button className="secondary-button earlier-days-toggle" aria-expanded={showPast} onClick={() => {
        setExpandedPastWeek(showPast ? null : week);
        if (showPast && reviewDate && reviewDate < today) setReviewDate(null);
      }}>{showPast ? "Hide earlier days" : "Earlier this week"} · {dates.filter(date => date < today).length}</button>}
      <section className={`week-grid durable-week compact-week${showPast ? " show-past" : ""}`}>
        {dates.map((date) => {
          const meal = meals[date];
          const recipe = meal?.recipe;
          const immutable = meal?.locked || meal?.status === "cooked";
          const expanded = expandedDays.has(date) || focusDate === date || reviewDate === date;
          return <article className={`day-card ${meal ? "filled" : ""} ${date === today ? "is-today" : ""}${currentWeek && today && date < today ? " is-past" : ""}${expanded ? " day-expanded" : ""}`} key={date} id={`dinner-${date}`} tabIndex={-1} aria-label={dateLabel(date)} aria-current={date === today ? "date" : undefined}>
            <div className="day-heading"><span className="day-name">{dateLabel(date)}</span>{date === today && <span className="today-badge">Today</span>}{meal && <span className={`meal-status ${meal.status}`}>{meal.status === "cooked" ? "Cooked" : meal.locked ? "Locked" : "Planned"}</span>}</div>
            <div className="day-row-main">
            {recipe ? <>{recipe.image && <button className="day-image" onClick={() => openMeal(date)} aria-label={`View photo of ${meal.title}`}><img src={recipe.image} alt="" /></button>}<button className="day-recipe-title" onClick={() => openMeal(date)} aria-label={`Open ${meal.title} on ${dateLabel(date)}`}>{meal.title}</button></> : meal ? <div className="missing-recipe"><strong>{meal.title}</strong><p>Recipe unavailable. Choose a replacement to recover its shopping amounts.</p></div> : <div className="open-dinner"><strong>Keep it open</strong><small>No dinner planned</small></div>}
            {meal && <div className="day-compact-summary"><small>{meal.servings ? `${meal.servings} servings` : `${mealScale(meal)} recipe batches`}{needsReview.includes(date) ? " · Amounts need review" : ""}</small><button className="text-button day-options-toggle" aria-label={`${expanded ? "Close details" : "Details"} for ${dateLabel(date)}`} aria-expanded={expanded} aria-controls={`day-actions-${date}`} onClick={() => {
              setExpandedDays(previous => { const next = new Set(previous); if (expanded) next.delete(date); else next.add(date); return next; });
              if (expanded && reviewDate === date) setReviewDate(null);
            }}>{expanded ? "Close details" : "Details"}</button></div>}
            </div>
            <div id={`day-actions-${date}`} className={`day-actions${!meal ? " empty-day-actions" : ""}`}>
            {!immutable && <button className={meal ? "text-button" : "primary-button"} onClick={() => chooseDay(date)} aria-label={`${meal ? "Change dinner" : "Choose dinner"} ${dateLabel(date)}`}>{meal ? "Change dinner" : "Choose dinner"}</button>}
            {meal && planningReasons[date] && <p className="quantity-note">{planningReasons[date]}</p>}
            {meal && <>
              <div className="meal-amounts">
                {meal.baseServings ? <label>Cook for<ValidatedInput type="number" {...DINNER_AMOUNT_LIMITS.servings} aria-label={`Servings ${dateLabel(date)}`} value={meal.servings ?? meal.baseServings} disabled={Boolean(immutable)} onCommit={(value) => patchMeal(date, { servings: Number(value) })} /><span>servings</span></label> : <label>Recipe batches<ValidatedInput type="number" {...DINNER_AMOUNT_LIMITS.batches} aria-label={`Batches ${dateLabel(date)}`} value={meal.batches} disabled={Boolean(immutable)} onCommit={(value) => patchMeal(date, { batches: Number(value) })} /></label>}
              </div>
              {recipe && meal.status === "planned" && <button className="primary-button" onClick={() => cookMeal(date)} aria-label={`Cook ${meal.title} ${dateLabel(date)}`}>Cook</button>}
              {recipe && <details id={`amounts-${date}`} className="meal-review" open={reviewDate === date} onToggle={(event) => { if (event.currentTarget.open) setReviewDate(date); else setReviewDate((current) => current === date ? null : current); }}><summary>Adjust amounts</summary>
                <DinnerAmounts meal={meal} patch={(patch) => patchMeal(date, patch)} /></details>}
              {meal.status === "cooked" && <button className="text-button" onClick={() => undoCooked(date)}>Undo cooked</button>}
              <details className="meal-more"><summary>More options</summary><div className="meal-controls">
                {recipe && meal.status === "planned" && <button className="text-button" onClick={() => markCooked(date)}>Mark cooked without cooking mode</button>}
                {meal.status !== "cooked" && <><button className="text-button" onClick={() => patchMeal(date, { locked: !meal.locked })}>{meal.locked ? "Unlock" : "Lock"}</button><button className="text-button" disabled={meal.locked} onClick={() => removeMeals([date])}>Remove</button></>}
              </div>
              {recipe && <label className="copy-meal">Copy dinner to<select aria-label={`Copy ${dateLabel(date)} dinner`} value="" onChange={(event) => { if (event.target.value) requestChoice(event.target.value, recipe, meal); }}><option value="">Choose day…</option>{dates.filter((target) => target !== date && !meals[target]?.locked && meals[target]?.status !== "cooked").map((target) => <option key={target} value={target}>{dateLabel(target)}{meals[target] ? " (replace)" : ""}</option>)}</select></label>}
              </details>
            </>}
            </div>
          </article>;
        })}
      </section>
      <div className="plan-footer"><p><strong>{count} of 7 dinners planned.</strong></p>{(!today || weekStart(today) !== week) && <button className="primary-button" onClick={goShopping}>Review shopping</button>}</div>
      </div>
      {pending && <Modal className="kitchen-modal-backdrop" label="Replace dinner" close={() => setPending(null)}><section className="panel kitchen-modal"><h2>Replace this dinner?</h2><p>{meals[pending.date]?.title} on {dateLabel(pending.date)} will be replaced with {pending.recipe.title}.</p>{(meals[pending.date]?.id !== pending.expectedId || meals[pending.date]?.locked || meals[pending.date]?.status === "cooked") && <p>This dinner changed or became protected. Cancel and choose again.</p>}<div className="modal-actions"><button className="secondary-button" onClick={() => setPending(null)}>Keep current dinner</button><button className="primary-button" disabled={meals[pending.date]?.id !== pending.expectedId || meals[pending.date]?.locked || meals[pending.date]?.status === "cooked"} onClick={() => { if (chooseMeal(pending.date, pending.recipe, pending.template, pending.expectedId)) setPending(null); }}>Replace dinner</button></div></section></Modal>}
    </div>
  );
}

export function DurableShoppingView({ items, checked, cycles, purchases, update, hasPlan, goPlan, reviewMeal, week, purchaseAction, purchaseHistory }: { items: ShoppingItem[]; checked: Record<string, boolean>; cycles?: KitchenState["shoppingCycles"]; purchases?: KitchenState["shoppingPurchases"]; update: UpdateKitchen; hasPlan: boolean; goPlan: () => void; reviewMeal: (date: string) => void; week: string; purchaseAction?: ReactNode; purchaseHistory?: ReactNode }) {
  const [lastCheck, setLastCheck] = useState<{ key: string; name: string; cycleId: string } | null>(null);
  const canUndoCheck = lastCheck && checked[lastCheck.key] && cycles?.[lastCheck.key] === lastCheck.cycleId && items.some(item => item.key === lastCheck.key) && !purchases?.some(purchase => purchase.items.some(item => item.key === lastCheck.key && item.cycleId === lastCheck.cycleId));
  const toBuy = items.filter((item) => !checked[item.key]).sort((a, b) => Number(b.needsReview) - Number(a.needsReview));
  const bought = items.filter((item) => checked[item.key]);
  const reviewCount = items.filter((item) => item.needsReview).length;
  const renderItem = (item: ShoppingItem) => <div className={`shopping-item ${checked[item.key] ? "checked" : ""}`} key={item.key}>
        <label><input type="checkbox" aria-label={`Bought ${item.name} ${item.measure}`} checked={Boolean(checked[item.key])} onChange={(event) => { const done = event.target.checked, cycleId = randomId(); update((state) => setShoppingItemBought(state, item.key, done, cycleId)); if (done) setLastCheck({ key: item.key, name: item.name, cycleId }); else if (lastCheck?.key === item.key) setLastCheck(null); }} /><span><strong>{item.name}</strong><small>{item.measure}</small></span></label>
        <div className="shopping-detail">
          {item.preparationNote && <small>{item.preparationNote}</small>}
          {item.needsReview && <><b>{item.preparationNote ? "Review preparation" : "Review amount"}</b><div>{item.mealDates.map((date) => <button className="text-button" key={date} aria-label={`Review ${item.name} for ${dateLabel(date)}`} onClick={() => reviewMeal(date)}>Review {dateLabel(date)}</button>)}</div></>}
          <details className="calculation-details"><summary>See calculation</summary><small>Plan: {item.requiredMeasure}{item.pantryMeasure ? ` · Pantry: ${item.pantryMeasure}` : ""}</small>{item.notes.map((note, index) => <small key={index}>{note}</small>)}<small>For: {item.recipeTitles.join(", ")}</small></details>
        </div>
      </div>;
  return <div className="shopping-layout focused-shopping shopping-workspace">
    <section className="panel shopping-panel" onFocusCapture={event => {
      const panel = event.currentTarget, target = event.target;
      if (target.closest(".shopping-progress")) return;
      requestAnimationFrame(() => {
        if (document.activeElement !== target) return;
        const header = panel.querySelector(".shopping-progress")?.getBoundingClientRect();
        const top = target.getBoundingClientRect().top;
        if (header && top < header.bottom + 12) window.scrollBy({ top: top - header.bottom - 12, behavior: "instant" });
      });
    }}>
      <div className="shopping-progress">
      <div className="section-heading"><div><p>Week of {dateLabel(week)}</p><h2 role="status">{toBuy.length} {toBuy.length === 1 ? "item" : "items"} left</h2></div><button className="text-button" onClick={goPlan}>Edit plan</button></div>
      {canUndoCheck && <div className="shopping-check-undo"><span role="status">Checked {lastCheck.name}</span><button className="text-button" aria-label={`Undo checked ${lastCheck.name}`} onClick={() => { update(state => undoShoppingCheck(state, lastCheck.key, lastCheck.cycleId)); setLastCheck(null); }}>Undo</button></div>}
      </div>
      {reviewCount > 0 && <p className="quantity-note" role="status">{reviewCount} {reviewCount === 1 ? "item needs" : "items need"} review. You can still use this list.</p>}
      {items.length ? <>
        {toBuy.length ? <section className="shopping-list" aria-label="To buy"><div className="shopping-column-headings" aria-hidden="true"><span>Ingredient</span><span>Amount to buy</span><span>Details</span></div>{toBuy.map(renderItem)}</section> : <p role="status">Everything on this list is checked.</p>}
        {bought.length > 0 && <details className="bought-items"><summary>Bought ({bought.length})</summary><section className="shopping-list" aria-label="Bought items">{bought.map(renderItem)}</section><button className="text-button" onClick={() => update((state) => ({ ...state, shoppingChecked: Object.fromEntries(Object.entries(state.shoppingChecked).filter(([key]) => !key.startsWith(`${week}:`))) }))}>Uncheck all</button></details>}
      </> : <div className="empty-state"><strong>{hasPlan ? "No remaining shopping for these dinners." : "Plan a few dinners first."}</strong><p>{hasPlan ? "Known quantities are covered or the meals have been cooked." : "Choose dinners to build your shopping totals."}</p><button className="primary-button" onClick={goPlan}>Go to weekly plan</button></div>}
    </section>
    <aside className="shopping-context" aria-label="Shopping context">
      <section className="shopping-week-summary">
        <span className="eyebrow">For your dinners</span>
        <h2>This week’s shop</h2>
        <p>Week of {dateLabel(week)}</p>
        <dl><div><dt>Still to buy</dt><dd>{toBuy.length}</dd></div><div><dt>Checked off</dt><dd>{bought.length}</dd></div>{reviewCount > 0 && <div><dt>Need review</dt><dd>{reviewCount}</dd></div>}</dl>
      </section>
      {purchaseAction && <div className="purchase-action">{purchaseAction}<small>Review before adding to your pantry.</small></div>}
      <p className="shopping-context-note">Checking an item means it’s picked up. Review your purchases to add actual amounts to the pantry.</p>
      <details className="shopping-help"><summary>How totals work</summary><p>Unfinished dinners in this week are added together, then compatible pantry amounts are subtracted. Cooked and uncooked ingredients stay separate. Unclear amounts and preparation differences need review. Changed quantities become unchecked. Checking an item does not change your pantry.</p></details>
      <details className="shopping-tools"><summary>List tools</summary><ShoppingExport items={toBuy} week={week} /></details>
      {purchaseHistory}
    </aside>
  </div>;
}

export function DinnerAmounts({ meal, patch }: { meal: PlannedMeal; patch: (patch: Partial<PlannedMeal>) => void }) {
  const date = meal.date;
  const immutable = meal.locked || meal.status === "cooked";
  if (!meal.recipe) return null;
  const baseline = { ...meal, ingredientOverrides: {} };
  function yieldChange(baseServings: number | null) {
    const batches = mealScale(meal);
    return {
      baseServings,
      servings: baseServings ? baseServings * batches : null,
      batches,
    };
  }
  function yieldProblem(text: string) {
    const baseServings = text.trim() ? Number(text) : null;
    if (baseServings !== null && (!Number.isSafeInteger(baseServings) || baseServings < 1 || baseServings > 10_000)) return "Enter a whole source yield from 1 to 10000.";
    const next = yieldChange(baseServings);
    const amount = baseServings ? next.servings! : next.batches;
    const limits = DINNER_AMOUNT_LIMITS[baseServings ? "servings" : "batches"];
    const steps = (amount - limits.min) / limits.step;
    const nearest = limits.min + Math.round(steps) * limits.step;
    if (nearest < limits.min || nearest > limits.max || Math.abs(amount - nearest) > 0.000001) {
      return baseServings
        ? "Use a batch size that gives 1–100 whole servings before recording this yield."
        : "Adjust dinner servings to give 0.25–20 batches in quarter-batch increments before clearing the yield.";
    }
    return "";
  }
  return <section className="dinner-amount-editor">
    {immutable && <p className="quantity-note">This dinner is {meal.status === "cooked" ? "cooked" : "locked"}; its saved amounts cannot be edited.</p>}
                <label>Original recipe servings (if known)<ValidatedInput type="number" min={1} max={10000} step={1} allowEmpty validate={yieldProblem} resetKey={meal.baseServings ? `servings:${meal.servings}` : `batches:${meal.batches}`} placeholder="Unknown" aria-label={`Original servings ${dateLabel(date)}`} value={meal.baseServings ?? ""} disabled={Boolean(immutable)} onCommit={(text) => {
                  const baseServings = text.trim() ? Number(text) : null;
                  const next = yieldChange(baseServings);
                  // Validation permits whole servings and quarter batches; normalize floating-point residue.
                  patch({ ...next, servings: next.servings === null ? null : Math.round(next.servings), batches: baseServings ? next.batches : Math.round(next.batches / DINNER_AMOUNT_LIMITS.batches.step) * DINNER_AMOUNT_LIMITS.batches.step });
                }} /></label>
                <p>{meal.baseServings ? "Amounts scale to your serving count." : "Servings are unknown, so quantities use recipe batches."} Enter a final amount below to correct any ingredient. Source wording stays unchanged.</p>{(meal.planningIngredients ?? meal.recipe!.ingredients).map((ingredient, index) => {
                const parsed = plannedIngredientMeasure(baseline, index, ingredient);
                const scaled = parsed ? formatMeasure(parsed.quantity * mealScale(meal), parsed.unit) : ingredient.measure;
                return <label key={index}>{ingredient.name}<small>{mealAmountLabel(baseline, index)} · Baseline: {scaled || "Amount needs review"}</small><ValidatedInput validate={measureInputProblem} value={meal.ingredientOverrides[String(index)] ?? ""} placeholder={scaled || "Amount needs review"} aria-label={`${ingredient.name} amount ${dateLabel(date)}`} disabled={Boolean(immutable)} onCommit={(value) => {
                  const overrides = { ...meal.ingredientOverrides };
                  if (value.trim()) overrides[String(index)] = value;
                  else delete overrides[String(index)];
                  patch({ ingredientOverrides: overrides });
                }} />{Object.hasOwn(meal.ingredientOverrides, String(index)) && <small>Dinner override · final amount for this dinner</small>}{meal.planningIngredients && ingredient.name !== meal.recipe!.ingredients[index].name && <small>Source: {meal.recipe!.ingredients[index].measure} {meal.recipe!.ingredients[index].name}</small>}</label>;
              })}
  </section>;
}
