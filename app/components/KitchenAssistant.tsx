"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { dateLabel } from "./WeeklyKitchenViews";
import { assistantFetch, aiProviderLabel, selectedAIModel, type AISelection } from "../lib/browser-ai";
import { useAppSession } from "../lib/app-session";
import type { AssistantIntent, AssistantResponse, KitchenActionDraft } from "../lib/assistant-types";
import type { KitchenState } from "../lib/kitchen-types";
import type { ChefPlanIntent } from "../lib/chef-plan-types";
import { addDateDays } from "../lib/kitchen-state";
import { assistantDinnerCount, assistantKeep, assistantReplacement, editableAssistantIntent } from "../lib/assistant-controls";

export type AssistantPreset = { id: string; label: string; intent: AssistantIntent };
const empty = (): AssistantIntent => ({ pantry: [], tastes: [] });
export function KitchenAssistant({ visible, close, week, today, kitchen, revision, saveState, settings, preset, refreshKitchen, applied }: {
  visible: boolean; close: () => void; week: string; today: string; kitchen: KitchenState; revision: number; saveState: string; settings: AISelection;
  preset?: AssistantPreset | null; refreshKitchen: () => Promise<boolean>; applied: () => Promise<boolean>;
}) {
  const { session, local: storage, fetch: kitchenFetch } = useAppSession();
  const [manualOpen, setManualOpen] = useState(Boolean(preset));
  const [query, setQuery] = useState(preset?.label ?? "");
  const [draft, setDraft] = useState<KitchenActionDraft | null>(null);
  const [intent, setIntent] = useState<AssistantIntent>(preset?.intent ?? empty());
  const [busy, setBusy] = useState<"" | "preview" | "apply">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invalidated, setInvalidated] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const request = useRef<{ id: number; controller?: AbortController }>({ id: 0 });
  const applying = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const edited = !!draft && JSON.stringify(intent) !== JSON.stringify(editableAssistantIntent(draft));
  const stale = invalidated || Boolean(draft && (draft.kitchenRevision !== revision || draft.today !== today));
  const ready = saveState === "saved" && !busy;
  const blocking = draft?.unresolved.some(issue => issue.blocking) ?? false;
  const hasChanges = Boolean(draft && (draft.pantryChanges.length || draft.tasteChanges.length || draft.completionChange || draft.planDraft?.changes.length));
  useEffect(() => () => { request.current.id++; request.current.controller?.abort(); }, []);
  useEffect(() => {
    request.current.id++; request.current.controller?.abort(); request.current.controller = undefined;
    const timer = window.setTimeout(() => setBusy(current => current === "apply" ? current : ""), 0);
    return () => clearTimeout(timer);
  }, [settings.provider, settings.ollamaModel, settings.openaiModel, settings.lmstudioModel]);
  function cancel() { request.current.id++; request.current.controller?.abort(); request.current.controller = undefined; setBusy(""); }
  function discard() { if (applying.current) return; cancel(); setDraft(null); setIntent(empty()); setQuery(""); setError(""); setInvalidated(false); setClarifying(false); setNotice("Draft discarded. Your household has not changed."); }
  async function preview(manual: boolean) {
    if (!ready || !manual && !query.trim()) return;
    cancel(); const id = ++request.current.id; const controller = new AbortController(); request.current.controller = controller;
    setBusy("preview"); setError(""); setNotice("");
    try {
      const manualIntent = intent.planning ? { ...intent, planning: { ...intent.planning, authorizedReplacementDates: intent.planning.authorizedReplacementDates ?? [] } } : intent;
      const payload = { query: manual ? "" : query.trim(), week, today, kitchenRevision: revision, ...(!stale && draft ? { previousDraft: draft } : {}), ...(manual ? { intent: manualIntent } : {}) };
      const response = await assistantFetch("/api/assistant", payload, { selection: settings, hosted: session.mode === "hosted", storage, signal: controller.signal, fetcher: kitchenFetch });
      const result = await response.json() as AssistantResponse;
      if (request.current.id !== id || controller.signal.aborted) return;
      if (!response.ok) { if (response.status === 409) { setInvalidated(true); await refreshKitchen(); } throw new Error(result.error?.message ?? "The request could not be prepared. Your kitchen is unchanged."); }
      if (!result.draft) { setClarifying(true); setNotice(result.clarification ?? "Please clarify the request."); return; }
      setDraft(result.draft); setIntent(editableAssistantIntent(result.draft)); setInvalidated(false); setClarifying(false); setNotice("Review these changes. Nothing has been saved.");
    } catch (cause) { if (request.current.id === id && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The assistant is unavailable. Manual controls still work."); }
    finally { if (request.current.id === id) { request.current.controller = undefined; setBusy(""); } }
  }
  async function apply() {
    if (!draft || !ready || applying.current || edited || stale || blocking || clarifying || !hasChanges) return;
    applying.current = true; setBusy("apply"); setError(""); setNotice("");
    try {
      // A dispatched save is reconciled, never cancelled while its outcome is unknown.
      const response = await kitchenFetch("/api/assistant/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft }) });
      const result = await response.json() as AssistantResponse;
      if (!response.ok) { if (response.status === 409) { setInvalidated(true); await refreshKitchen(); } throw new Error(result.error?.message ?? "Changes could not be saved. Retry this reviewed draft."); }
      setDraft(null); setIntent(empty()); setQuery(""); setClarifying(false);
      setNotice(await applied() ? "Reviewed changes saved to your kitchen." : "Changes were saved. Refresh the kitchen to see them; your pending browser edits are preserved.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not confirm the save. Retry this same draft safely."); }
    finally { applying.current = false; setBusy(""); }
  }
  function changePantry(index: number, patch: Partial<AssistantIntent["pantry"][number]>) { setIntent(current => ({ ...current, pantry: current.pantry.map((row, i) => i === index ? { ...row, ...patch } : row) })); }
  function changePlanning(patch: Partial<ChefPlanIntent>) { setIntent(current => current.planning ? { ...current, planning: { ...current.planning, ...patch } } : current); }
  if (!visible) return null;
  return <Modal className="kitchen-modal-backdrop" label="Kitchen assistant" close={() => { if (!applying.current) { cancel(); close(); } }}><section className="panel kitchen-modal chef-plan-workspace assistant-workspace">
    <header className="section-heading"><div><span className="eyebrow">Your kitchen assistant</span><h2>From groceries to dinner</h2><p>Describe what changed or what you want to cook. Review pantry, dinner, and shopping changes together.</p></div><button className="drawer-close" aria-label="Close kitchen assistant" disabled={busy === "apply"} onClick={() => { cancel(); close(); }}>×</button></header>
    <p className="quantity-note">{aiProviderLabel(settings.provider)} · {selectedAIModel(settings) || "Choose a model in Settings"} · Drafts stay in this tab. Applied changes are shared.</p>
    <form onSubmit={event => { event.preventDefault(); void preview(Boolean(preset && !draft && query === preset.label)); }}><label>Your request<textarea ref={field} rows={3} maxLength={2000} value={query} onChange={event => setQuery(event.target.value)} placeholder="We bought 500 g rice and 2 onions. Plan three Mediterranean dinners using food that expires soon." /></label><div className="modal-actions"><button className="primary-button" disabled={!ready || !query.trim() || edited}>{preset && !draft && query === preset.label ? "Preview changes" : draft ? "Revise with Chef" : "Ask Chef"}</button><button type="button" className="text-button" onClick={() => setManualOpen(true)}>Use manual controls</button>{busy === "preview" && <button type="button" className="secondary-button" onClick={cancel}>Cancel request</button>}</div></form>
    {saveState !== "saved" && <p role="status">Finish saving or resolve the kitchen conflict before preparing changes.</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {stale && <div className="inline-confirm" role="alert"><span>The shared kitchen changed. Review a recalculated preview before applying.</span><button className="secondary-button" disabled={!ready} onClick={() => void preview(true)}>Recalculate changes</button></div>}
    {(draft || preset || manualOpen) && <fieldset disabled={Boolean(busy)} className="assistant-interpretation"><legend>Edit the interpretation</legend>
      {intent.pantry.map((row, index) => <div className="assistant-pantry-row" key={index}>
        <label>Action<select value={row.kind} onChange={event => changePantry(index, { kind: event.target.value as typeof row.kind })}>{[["add", "Add purchase"], ["set", "Set amount remaining"], ["subtract", "Subtract used amount"], ["set_use_by", "Change use-by date"], ["remove", "Remove stock"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Ingredient<input value={row.name} onChange={event => changePantry(index, { name: event.target.value })} /></label>
        {row.kind !== "add" && <label>Pantry batch<select value={row.stockId ?? ""} onChange={event => changePantry(index, { stockId: event.target.value || undefined })}><option value="">Match ingredient name</option>{kitchen.pantry.map(stock => <option key={stock.id} value={stock.id}>{stock.name} · {stock.measure || "amount unknown"}{stock.useBy ? ` · use by ${stock.useBy}` : ""}</option>)}</select></label>}
        {!["remove", "set_use_by"].includes(row.kind) && <label>Amount<input value={row.measure ?? ""} placeholder="For example, 500 g" onChange={event => changePantry(index, { measure: event.target.value })} /></label>}
        <label>Entered use-by date<input type="date" value={row.useBy ?? ""} onChange={event => changePantry(index, { useBy: event.target.value || (row.kind === "set_use_by" ? null : undefined) })} /></label>
        <button type="button" className="text-button" onClick={() => setIntent(current => ({ ...current, pantry: current.pantry.filter((_, i) => i !== index) }))}>Remove proposed action</button>
      </div>)}
      <button type="button" className="secondary-button" onClick={() => setIntent(current => ({ ...current, pantry: [...current.pantry, { kind: "add", name: "", measure: "" }] }))}>Add pantry action</button>
      {!intent.planning && <button type="button" className="secondary-button" onClick={() => setIntent(current => ({ ...current, planning: { week, today, count: 3, dates: [], servings: null, batches: null, excludedIngredients: [], diets: [], excludedEquipment: [], priority: "use_soon", allowRepeats: false, replaceDates: [], keepDates: [], perDate: {} } }))}>Add dinner planning</button>}
      {intent.planning && <><h3>Dinner plan</h3><div className="form-grid"><label>Dish, cuisine, or ingredient<input value={intent.planning.recipeQuery ?? ""} onChange={event => changePlanning({ recipeQuery: event.target.value || undefined })} /></label><label>Number of dinners<input type="number" min={1} max={7} value={intent.planning.count} onChange={event => changePlanning(assistantDinnerCount(intent.planning!, Number(event.target.value)))} /></label><label>Servings<input type="number" min={1} max={24} value={intent.planning.servings ?? ""} placeholder="Keep source quantities" onChange={event => changePlanning({ servings: event.target.value ? Number(event.target.value) : null, batches: null })} /></label><label>Recipe batches<input type="number" min={0.25} max={12} step={0.25} value={intent.planning.batches ?? ""} placeholder="Explicit choice for unknown yield" onChange={event => changePlanning({ batches: event.target.value ? Number(event.target.value) : null, servings: null })} /></label><label>Exclusions<input value={intent.planning.excludedIngredients.join(", ")} onChange={event => changePlanning({ excludedIngredients: event.target.value.split(",").map(value => value.trim()).filter(Boolean) })} /></label><label>Priority<select value={intent.planning.priority} onChange={event => changePlanning({ priority: event.target.value as ChefPlanIntent["priority"] })}><option value="use_soon">Use food before its use-by date</option><option value="fewer_groceries">Fewer groceries</option><option value="variety">Variety</option></select></label></div>
        <div className="assistant-dates">{Array.from({ length: 7 }, (_, index) => addDateDays(week, index)).map(date => <div key={date}><strong>{dateLabel(date)}</strong><label><input type="checkbox" checked={intent.planning!.keepDates.includes(date)} disabled={date < today || !draft?.planDraft?.changes.some(change => change.date === date)} onChange={event => changePlanning(assistantKeep(intent.planning!, date, event.target.checked, Boolean(kitchen.meals[date])))} />Keep</label><label><input type="checkbox" disabled={date < today || Boolean(kitchen.meals[date]?.locked || kitchen.meals[date]?.status === "cooked")} checked={intent.planning!.replaceDates.includes(date) || Boolean(intent.planning!.authorizedReplacementDates?.includes(date))} onChange={event => changePlanning(assistantReplacement(intent.planning!, date, event.target.checked))} />Replace</label><label>Diet<select disabled={date < today || intent.planning!.keepDates.includes(date)} value={intent.planning!.perDate[date]?.diet ?? ""} onChange={event => { const perDate = { ...intent.planning!.perDate, [date]: { ...intent.planning!.perDate[date] } }; if (event.target.value) perDate[date].diet = event.target.value as "vegetarian"; else delete perDate[date].diet; changePlanning({ perDate }); }}><option value="">Whole-plan requirements</option><option value="vegetarian">Vegetarian</option><option value="vegan">Vegan</option><option value="gluten_free">Gluten free</option></select></label></div>)}</div></>}
      {!!intent.tastes.length && <ul>{intent.tastes.map((taste, index) => <li key={index}>{kitchen.meals[Object.keys(kitchen.meals).find(date => kitchen.meals[date].recipeId === taste.recipeId) ?? ""]?.title ?? taste.recipeId}: <select aria-label="Taste feedback" value={taste.preference} onChange={event => setIntent(current => ({ ...current, tastes: current.tastes.map((item, i) => i === index ? { ...item, preference: event.target.value as typeof taste.preference } : item) }))}><option value="cook_again">Cook again</option><option value="less_often">Less often</option><option value="clear">Clear my feedback</option></select></li>)}</ul>}
      {intent.completion && <p>Mark the dinner on {dateLabel(intent.completion.date)} cooked. {intent.completion.deductStock ? "Use the calculated pantry deductions below." : "Pantry remains as reviewed in the actions above."}</p>}
      <button className="secondary-button" type="button" disabled={!ready} onClick={() => void preview(true)}>Preview edited changes</button>
    </fieldset>}
    {draft && <>
      <section aria-label="Proposed kitchen changes"><h3>Changes to review</h3><ul>{draft.summary.map((summary, index) => <li key={index}>{summary}</li>)}</ul>
        {draft.pantryChanges.map((change, index) => <article className="chef-plan-card" key={index}><h4>{change.after?.name ?? change.before?.name}</h4><p>{change.before ? `${change.before.measure || "Unknown amount"}${change.before.useBy ? ` · use by ${change.before.useBy}` : ""}` : "New stock"} → {change.after ? `${change.after.measure || "Unknown amount"}${change.after.useBy ? ` · use by ${change.after.useBy}` : ""}` : "Removed"}</p></article>)}
        {draft.planDraft?.changes.map(change => <article className="chef-plan-card" key={change.date}><h4>{dateLabel(change.date)} · {change.meal.title}</h4><p>{change.reason}</p><p>{change.meal.servings ? `${change.meal.servings} servings` : `${change.meal.batches} batches`} · {change.readiness.coveredCount} ingredients covered · {change.readiness.partialCount} partially covered · {change.readiness.missingCount} missing · {change.readiness.reviewCount} amounts to review</p>{change.meal.recipe && <a href={change.meal.recipe.sourceUrl} target="_blank" rel="noreferrer">Source: {change.meal.recipe.source.name}</a>}<ul>{change.readiness.shopping.map((row, index) => <li key={index}>{row.name}: {row.measure || "Amount unknown"}{row.needsReview ? " · Review amount" : ""}</li>)}</ul></article>)}
        {draft.completionChange && <p>Mark {draft.completionChange.before.title} cooked; remove its remaining needs from shopping.</p>}
      </section>
      {!!draft.unresolved.length && <section aria-label="Items requiring review"><h3>Review needed</h3>{draft.unresolved.map(issue => <div key={issue.id}><p>{issue.message}</p>{issue.choices?.map((choice, index) => <button className="secondary-button" key={index} disabled={Boolean(busy) || issue.actionIndex === undefined} onClick={() => { if (issue.actionIndex !== undefined && choice.stockId) changePantry(issue.actionIndex, { stockId: choice.stockId }); }}>{choice.label}</button>)}</div>)}</section>}
      <section className="chef-plan-shopping" aria-label="Assistant shopping preview"><h3>Shopping for the whole week</h3><p>{draft.shopping.length} grocery rows after these changes; {draft.beforeShopping.length} in the saved plan.</p>{draft.shopping.length ? <ul>{draft.shopping.map(row => <li key={row.key}><strong>{row.name}</strong><span>{row.measure || "Amount unknown"}{row.needsReview ? " · Review amount" : ""}</span></li>)}</ul> : <p>No additional groceries listed. Review unknown amounts above.</p>}<details><summary>Compare with saved shopping</summary><ul>{draft.beforeShopping.map(row => <li key={row.key}>{row.name}: {row.measure || "Amount unknown"}</li>)}</ul></details></section>
    </>}
    <footer className="chef-plan-footer"><p>{edited ? "Your edits need a new preview before Apply." : "Apply saves only the reviewed changes. Manual kitchen controls stay available."}</p><div className="modal-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => field.current?.focus()}>Revise</button><button className="secondary-button" disabled={busy === "apply"} onClick={discard}>Discard</button><button className="primary-button" disabled={!ready || !hasChanges || edited || stale || blocking || clarifying} onClick={() => void apply()}>Apply changes</button></div></footer>
  </section></Modal>;
}
