"use client";

import { useEffect, useRef, useState } from "react";
import { assistantFetch, type AISelection } from "../lib/browser-ai";
import { useAppSession } from "../lib/app-session";
import { Modal } from "./Modal";
import { dateLabel } from "./WeeklyKitchenViews";
import { addDateDays } from "../lib/kitchen-state";
import { DINNER_AMOUNT_LIMITS, type KitchenDocument, type KitchenState } from "../lib/kitchen-types";
import type { ChefPlanDraft, ChefPlanIntent, ChefPlanResponse } from "../lib/chef-plan-types";
import type { Diet } from "../lib/recipe-types";

const diets: Array<[Diet, string]> = [["vegetarian", "Vegetarian"], ["vegan", "Vegan"], ["gluten_free", "Gluten free"], ["low_carb", "Low carb"]];
const names = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);
function initialIntent(week: string, today: string): ChefPlanIntent {
  return { week, today, count: 3, dates: [], servings: null, batches: null, excludedIngredients: [], diets: [], excludedEquipment: [], priority: "use_soon", allowRepeats: false, replaceDates: [], keepDates: [], perDate: {} };
}
// A swap is a one-turn command; subsequent manual edits preserve its reviewed result.
function editableDraftIntent(draft: ChefPlanDraft): ChefPlanIntent {
  return { ...draft.intent, replaceDates: [], authorizedReplacementDates: [...new Set([
    ...(draft.intent.authorizedReplacementDates ?? []), ...draft.changes.filter(change => change.expectedMealId !== null).map(change => change.date),
  ])].sort() };
}

export function ChefPlanWorkspace({ visible, close, week, today, kitchen, revision, saveState, model, aiSettings, refreshKitchen, applied }: {
  visible: boolean; close: () => void; week: string; today: string; kitchen: KitchenState; revision: number;
  saveState: string; model: string; aiSettings?: AISelection; refreshKitchen: () => Promise<boolean>; applied: (document: KitchenDocument) => Promise<boolean>;
}) {
  const { session, local: storage, fetch: kitchenFetch } = useAppSession();
  const [intent, setIntent] = useState(() => initialIntent(week, today));
  const [excluded, setExcluded] = useState("");
  const [equipment, setEquipment] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ChefPlanDraft | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "apply">("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [invalidated, setInvalidated] = useState(false);
  const [needsClarification, setNeedsClarification] = useState(false);
  const request = useRef<{ id: number; controller?: AbortController }>({ id: 0 });
  const applying = useRef(false);
  const draftHeading = useRef<HTMLHeadingElement>(null);
  const requestField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (draft) { draftHeading.current?.focus({ preventScroll: true }); draftHeading.current?.scrollIntoView({ block: "start" }); }
  }, [draft]);
  useEffect(() => () => { request.current.controller?.abort(); }, []);
  useEffect(() => {
    request.current.id++; request.current.controller?.abort(); request.current.controller = undefined;
    const timer = window.setTimeout(() => setBusy(current => current === "apply" ? current : ""), 0);
    return () => clearTimeout(timer);
  }, [aiSettings?.provider, aiSettings?.ollamaModel, aiSettings?.openaiModel, aiSettings?.lmstudioModel]);
  const editableIntent: ChefPlanIntent = { ...intent, excludedIngredients: names(excluded), excludedEquipment: names(equipment) };
  const edited = JSON.stringify(editableIntent) !== JSON.stringify(draft ? editableDraftIntent(draft) : initialIntent(week, today));
  const stale = invalidated || Boolean(draft && (draft.kitchenRevision !== revision || draft.intent.today !== today));
  const dates = Array.from({ length: 7 }, (_, index) => addDateDays(week, index));
  const canRequest = saveState === "saved" && !busy;

  function cancelPreview() {
    request.current.id++;
    request.current.controller?.abort();
    request.current.controller = undefined;
    setBusy("");
  }
  function closeWorkspace() {
    if (applying.current) return;
    cancelPreview(); close();
  }
  function discard() {
    if (applying.current) return;
    cancelPreview(); setDraft(null); setIntent(initialIntent(week, today)); setExcluded(""); setEquipment(""); setQuery(""); setError(""); setInvalidated(false); setNeedsClarification(false); setMessage("Draft discarded. Your saved dinners are unchanged.");
  }
  async function preview(manual: boolean, manualIntent = editableIntent) {
    if (!canRequest || (!manual && (!query.trim() || edited || stale))) return;
    cancelPreview();
    const id = ++request.current.id;
    const controller = new AbortController(); request.current.controller = controller;
    setBusy("preview"); setError(""); setMessage("");
    try {
      const response = await assistantFetch("/api/chef/plan", { query: manual ? "" : query.trim(), week, today, kitchenRevision: revision, model,
          ...(!stale && draft ? { previousDraft: draft } : {}), ...(manual ? { intent: { ...manualIntent, authorizedReplacementDates: manualIntent.authorizedReplacementDates ?? [] } } : {}) },
          { selection: aiSettings ?? { provider: "ollama", ollamaModel: model, openaiModel: "" }, hosted: session.mode === "hosted", storage, signal: controller.signal, fetcher: kitchenFetch });
      const result = await response.json() as ChefPlanResponse;
      if (id !== request.current.id || controller.signal.aborted) return;
      if (!response.ok) {
        if (response.status === 409) { setInvalidated(true); await refreshKitchen(); }
        throw new Error(result.error?.message ?? "The plan could not be previewed. Try the manual controls below.");
      }
      if (!result.draft) {
        // A question does not invalidate the kitchen or the reviewed draft context.
        setNeedsClarification(Boolean(draft)); setMessage(result.clarification ?? "Choose dates and portions below, then preview the plan."); return;
      }
      setDraft(result.draft); setIntent(editableDraftIntent(result.draft)); setExcluded(result.draft.intent.excludedIngredients.join(", "));
      setEquipment(result.draft.intent.excludedEquipment.join(", ")); setInvalidated(false); setNeedsClarification(false);
      setMessage("Draft ready for review. Nothing has been saved.");
    } catch (cause) {
      if (id !== request.current.id || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "Could not preview the plan. Manual planning remains available.");
    } finally { if (id === request.current.id) { request.current.controller = undefined; setBusy(""); } }
  }
  async function apply() {
    if (!draft || applying.current || !canRequest || edited || stale || needsClarification || !draft.changes.length) return;
    applying.current = true; setBusy("apply"); setError(""); setMessage("");
    try {
      // Do not abort a save after dispatch: its result must be reconciled with the saved kitchen.
      const response = await kitchenFetch("/api/chef/plan/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft }) });
      const result = await response.json() as KitchenDocument & ChefPlanResponse;
      if (!response.ok) {
        setInvalidated(true);
        if (response.status === 409) await refreshKitchen();
        throw new Error(result.error?.message ?? "The plan could not be saved. Refresh the kitchen and preview again.");
      }
      setDraft(null); setIntent(initialIntent(week, today)); setExcluded(""); setEquipment(""); setQuery(""); setInvalidated(false); setNeedsClarification(false);
      const refreshed = await applied(result);
      setMessage(refreshed ? "Plan saved. Your weekly shopping list is ready." : "Plan saved on the server computer. Review the kitchen save status before making more changes.");
    } catch (cause) {
      setInvalidated(true);
      await refreshKitchen();
      setError(cause instanceof Error ? cause.message : "The save result is unknown. Refresh the saved kitchen before trying again.");
    } finally { applying.current = false; setBusy(""); }
  }
  function chooseDate(date: string, selected: boolean) {
    setIntent(current => {
      const next = selected ? [...current.dates, date].sort() : current.dates.filter(value => value !== date);
      return { ...current, dates: next, count: next.length || current.count, replaceDates: current.replaceDates.filter(value => next.includes(value)), authorizedReplacementDates: current.authorizedReplacementDates?.filter(value => next.includes(value)), keepDates: current.keepDates.filter(value => next.includes(value)), perDate: Object.fromEntries(Object.entries(current.perDate).filter(([value]) => next.includes(value))) };
    });
  }
  if (!visible) return null;
  const changedShopping = draft?.shopping.filter(item => {
    const before = draft.beforeShopping.find(previous => previous.key === item.key);
    return !before || before.measure !== item.measure || before.needsReview !== item.needsReview;
  }).length ?? 0;
  const removedShopping = draft?.beforeShopping.filter(item => !draft.shopping.some(next => next.key === item.key)).length ?? 0;
  return <Modal className="kitchen-modal-backdrop chef-plan-backdrop" label="Plan dinners with Chef" close={closeWorkspace}>
    <section className="panel kitchen-modal chef-plan-workspace">
      <header className="chef-plan-heading"><div><h2>Plan dinners with Chef</h2><p>Plan several dinners and review their combined shopping list. Week of {dateLabel(week)}.</p></div><button className="text-button" aria-label="Close planning workspace" disabled={busy === "apply"} onClick={closeWorkspace}>Close</button></header>
      <form className="chef-plan-request" onSubmit={event => { event.preventDefault(); void preview(false); }}>
        <label htmlFor="chef-plan-request">Planning request</label>
        <textarea ref={requestField} id="chef-plan-request" value={query} maxLength={2000} rows={3} disabled={Boolean(busy)} placeholder={draft ? "Keep Tuesday, replace Thursday, and make Friday vegetarian…" : "Plan three dinners for four people using food that expires soon…"} onChange={event => setQuery(event.target.value)} />
        <div className="modal-actions"><button className="primary-button" type="submit" disabled={!canRequest || !query.trim() || edited || stale}>{draft ? "Revise dinner plan" : "Preview dinner plan"}</button>{busy === "preview" && <button type="button" className="secondary-button" onClick={cancelPreview}>Cancel request</button>}</div>
      </form>
      {edited && <p className="quantity-note" role="status">Your controls changed. Preview them before asking Chef to revise or applying.</p>}
      {busy && <p role="status">{busy === "apply" ? "Saving the reviewed plan…" : "Preparing your dinner draft…"}</p>}
      {message && <p role="status">{message}</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {saveState !== "saved" && <p className="quantity-note" role="status">Finish saving or resolve the kitchen conflict before previewing or applying a plan.</p>}
      {stale && <p className="field-error" role="alert">This draft needs a fresh preview. Review the controls, then choose Preview plan before revising or applying.</p>}
      {needsClarification && <p className="quantity-note" role="status">Clarify your request or preview the controls before applying. Your existing draft is still available.</p>}
      <fieldset className="chef-plan-controls" disabled={Boolean(busy)}>
        <legend>{draft ? "Review the interpreted request" : "Plan with controls"}</legend>
        <p>Set dates, portions, and priorities without AI, then preview the plan. Your saved allergy and equipment requirements always apply.</p>
        <div className="chef-plan-fields">
          <label>Number of dinners<input type="number" min={1} max={7} value={intent.count} onChange={event => setIntent({ ...intent, count: Number(event.target.value), dates: [], replaceDates: [], authorizedReplacementDates: [], keepDates: [], perDate: {} })} /></label>
          <label>Plan servings<input type="number" {...DINNER_AMOUNT_LIMITS.servings} placeholder="Source quantities" value={intent.servings ?? ""} onChange={event => setIntent({ ...intent, servings: event.target.value ? Number(event.target.value) : null, batches: null })} /></label>
          <label>Recipe batches<input type="number" {...DINNER_AMOUNT_LIMITS.batches} placeholder="Use for unknown yields" value={intent.batches ?? ""} onChange={event => setIntent({ ...intent, batches: event.target.value ? Number(event.target.value) : null, servings: null })} /></label>
          <label>Planning priority<select value={intent.priority} onChange={event => setIntent({ ...intent, priority: event.target.value as ChefPlanIntent["priority"] })}><option value="use_soon">Use soon, then fewer groceries</option><option value="fewer_groceries">Fewer groceries</option><option value="variety">Variety</option></select></label>
          <label>Excluded ingredients<input maxLength={1000} value={excluded} placeholder="Mushrooms, peanuts" onChange={event => setExcluded(event.target.value)} /></label>
          <label>Unavailable equipment<input maxLength={1000} value={equipment} placeholder="Oven, blender" onChange={event => setEquipment(event.target.value)} /></label>
          <label>Maximum verified total minutes<input type="number" min={1} max={1440} placeholder="Any" value={intent.maxTotalMinutes ?? ""} onChange={event => { const next = { ...intent }; if (event.target.value) next.maxTotalMinutes = Number(event.target.value); else delete next.maxTotalMinutes; setIntent(next); }} /></label>
        </div>
        <p className="quantity-note">Time limits use source-backed totals. Unknown yields require a batch choice when you request servings.</p>
        <div className="chef-plan-checks">{diets.map(([diet, label]) => <label key={diet}><input type="checkbox" checked={intent.diets.includes(diet)} onChange={event => setIntent({ ...intent, diets: event.target.checked ? [...intent.diets, diet] : intent.diets.filter(value => value !== diet) })} />{label}</label>)}<label><input type="checkbox" checked={intent.allowRepeats} onChange={event => setIntent({ ...intent, allowRepeats: event.target.checked })} />Allow repeated recipes</label></div>
        <fieldset className="chef-plan-dates"><legend>Dates and saved dinners</legend><p className="quantity-note">Leave dates unselected to use upcoming empty days. Select Replace explicitly to change a saved dinner.</p>
          {dates.map(date => {
            const meal = kitchen.meals[date];
            const protectedDate = date < today || Boolean(meal?.locked || meal?.status === "cooked");
            return <div className="chef-plan-date" key={date}>
              <label><input type="checkbox" aria-label={`Plan ${date}`} checked={intent.dates.includes(date)} disabled={protectedDate} onChange={event => chooseDate(date, event.target.checked)} />{dateLabel(date, { weekday: "long", month: "short", day: "numeric" })}</label>
              <span>{meal ? `${meal.title}${meal.locked ? " · Locked" : meal.status === "cooked" ? " · Cooked" : " · Saved"}` : date < today ? "Past date" : "Empty"}</span>
              {meal && !protectedDate && <label><input type="checkbox" aria-label={`Replace dinner ${date}`} checked={intent.replaceDates.includes(date) || Boolean(intent.authorizedReplacementDates?.includes(date))} disabled={!intent.dates.includes(date)} onChange={event => setIntent({ ...intent, replaceDates: event.target.checked ? [...intent.replaceDates, date] : intent.replaceDates.filter(value => value !== date), authorizedReplacementDates: event.target.checked ? intent.authorizedReplacementDates : (intent.authorizedReplacementDates ?? []).filter(value => value !== date), keepDates: event.target.checked ? intent.keepDates.filter(value => value !== date) : intent.keepDates })} />Replace</label>}
              {intent.dates.includes(date) && !protectedDate && <div className="chef-plan-day-options">
                {draft?.changes.some(change => change.date === date) && <label><input type="checkbox" aria-label={`Keep dinner ${date}`} checked={intent.keepDates.includes(date)} onChange={event => setIntent({ ...intent, keepDates: event.target.checked ? [...intent.keepDates, date] : intent.keepDates.filter(value => value !== date), replaceDates: event.target.checked ? intent.replaceDates.filter(value => value !== date) : intent.replaceDates, authorizedReplacementDates: event.target.checked && kitchen.meals[date] ? [...new Set([...(intent.authorizedReplacementDates ?? []), date])] : intent.authorizedReplacementDates })} />Keep this draft dinner</label>}
                <label>Diet<select aria-label={`Diet for ${date}`} disabled={intent.keepDates.includes(date)} value={intent.perDate[date]?.diet ?? ""} onChange={event => { const perDate = { ...intent.perDate, [date]: { ...intent.perDate[date] } }; if (event.target.value) perDate[date].diet = event.target.value as Diet; else delete perDate[date].diet; setIntent({ ...intent, perDate }); }}><option value="">Whole-plan diet</option>{diets.map(([diet, label]) => <option key={diet} value={diet}>{label}</option>)}</select></label>
                <label>Servings<input type="number" aria-label={`Servings for ${date}`} {...DINNER_AMOUNT_LIMITS.servings} disabled={intent.keepDates.includes(date)} placeholder="Whole-plan portions" value={intent.perDate[date]?.servings ?? ""} onChange={event => { const perDate = { ...intent.perDate, [date]: { ...intent.perDate[date] } }; if (event.target.value) { perDate[date].servings = Number(event.target.value); delete perDate[date].batches; } else delete perDate[date].servings; setIntent({ ...intent, perDate }); }} /></label>
                <label>Batches<input type="number" aria-label={`Batches for ${date}`} {...DINNER_AMOUNT_LIMITS.batches} disabled={intent.keepDates.includes(date)} placeholder="Whole-plan batches" value={intent.perDate[date]?.batches ?? ""} onChange={event => { const perDate = { ...intent.perDate, [date]: { ...intent.perDate[date] } }; if (event.target.value) { perDate[date].batches = Number(event.target.value); delete perDate[date].servings; } else delete perDate[date].batches; setIntent({ ...intent, perDate }); }} /></label>
              </div>}
            </div>;
          })}
        </fieldset>
        <button className="secondary-button" disabled={!canRequest} onClick={() => void preview(true)}>Preview plan</button>
      </fieldset>
      {draft && <>
        <section className="chef-plan-draft" aria-label="Dinner plan draft"><h3 ref={draftHeading} tabIndex={-1}>Proposed dinners</h3>
          {!draft.changes.length && <p>No eligible dinner changes were found. Adjust the request or controls and preview again.</p>}
          {draft.changes.map(change => <article className="chef-plan-card" aria-label={`Proposed dinner ${change.date}`} key={change.date}>
            <div className="chef-plan-card-heading"><h4>{dateLabel(change.date, { weekday: "long", month: "short", day: "numeric" })} · {change.meal.title}</h4><span>{change.expectedMealId ? "Replace saved dinner" : "New dinner"}</span></div>
            <p>{change.meal.servings ? `${change.meal.servings} servings` : `${change.meal.batches} recipe batches`} · {change.reason}</p>
            {change.meal.recipe && <a href={change.meal.recipe.sourceUrl} target="_blank" rel="noreferrer">Source: {change.meal.recipe.source.name}</a>}
            <div className="modal-actions"><button className="text-button" aria-label={`Replace proposed dinner ${change.date}`} disabled={!canRequest || stale || edited} onClick={() => {
              const perDate = { ...editableIntent.perDate, [change.date]: { ...editableIntent.perDate[change.date] } }; delete perDate[change.date].recipeId;
              const next = { ...editableIntent, perDate, keepDates: editableIntent.keepDates.filter(date => date !== change.date), replaceDates: [...new Set([...editableIntent.replaceDates, change.date])] };
              setIntent(next); void preview(true, next);
            }}>Choose another recipe</button></div>
            <p>{change.readiness.coveredCount} ingredients covered · {change.readiness.partialCount} partially covered · {change.readiness.missingCount} missing · {change.readiness.reviewCount} amounts to review</p>
            {!!change.readiness.shopping.length && <details><summary>Ingredients still needed</summary><ul>{change.readiness.shopping.map((item, index) => <li key={`${item.name}:${index}`}>{item.name}: {item.measure || "Amount unknown"}{item.needsReview ? " · Review amount" : ""}{item.preparationNote ? ` · ${item.preparationNote}` : ""}</li>)}</ul></details>}
          </article>)}
          {(draft.unresolved.length > 0 || draft.warnings.length > 0) && <div className="chef-plan-notices"><h4>Review before applying</h4><ul>{[...draft.unresolved, ...draft.warnings].map((notice, index) => <li key={index}>{notice}</li>)}</ul></div>}
        </section>
        <section className="chef-plan-shopping" aria-label="Plan shopping preview"><h3>Shopping for the whole week</h3><p>{draft.shopping.length} grocery rows · {changedShopping} added or changed · {removedShopping} removed compared with your saved week.</p>
          {draft.shopping.length ? <ul>{draft.shopping.map(item => <li key={item.key}><strong>{item.name}</strong><span>{item.measure || "Amount unknown"}{item.needsReview ? " · Review amount" : ""}</span>{item.preparationNote && <small>{item.preparationNote}</small>}</li>)}</ul> : <p>No additional groceries are listed. Check any unresolved amounts above.</p>}
          <details><summary>Shopping before this draft</summary>{draft.beforeShopping.length ? <ul>{draft.beforeShopping.map(item => <li key={item.key}><strong>{item.name}</strong><span>{item.measure || "Amount unknown"}{item.needsReview ? " · Review amount" : ""}</span></li>)}</ul> : <p>No grocery rows in the saved week.</p>}</details>
        </section>
      </>}
      <footer className="chef-plan-footer"><p>{draft?.changes.length ? `Apply saves ${draft.changes.length} reviewed dinner changes. Pantry stock and purchase checks stay as they are.` : "Drafts stay in this tab until you apply or discard them."}</p><div className="modal-actions">{draft && <button className="secondary-button" disabled={Boolean(busy)} onClick={() => { requestField.current?.focus(); requestField.current?.scrollIntoView({ block: "center" }); }}>Revise draft</button>}<button className="secondary-button" disabled={busy === "apply"} onClick={discard}>Discard draft</button><button className="primary-button" disabled={!draft?.changes.length || !canRequest || edited || stale || needsClarification} onClick={() => void apply()}>Apply plan</button></div></footer>
    </section>
  </Modal>;
}
