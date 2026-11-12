"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import type { KitchenState, PantryStock, PlannedMeal } from "../lib/kitchen-types";
import { addDateDays, weekStart } from "../lib/kitchen-state";
import { measureInputProblem } from "../lib/kitchen-validation";
import {
  browsePantry, compatiblePantryTotals, groupPantryBatches, pantryBatchProblem, pantryDateInputProblem,
  pantryUsagePreview, pantryWeekReservations, replacePantryBatch, samePantryBatch, pantryBatchUndoProblem, undoPantryBatch,
  type PantryBatchChange, type PantrySort,
} from "../lib/pantry-browser";
import { canonicalIngredient, formatMeasure, pantryAmountDetails, pantryStockEligibility, type ParsedMeasure } from "../lib/quantities";
import { pantryReviewTasks, type PantryReviewTask } from "../lib/pantry-review";
import { pantryDateGroups, type PantryFilter } from "../lib/use-soon";
import { Modal } from "./Modal";
import { dateLabel } from "./WeeklyKitchenViews";

type UpdateKitchen = (change: (state: KitchenState) => KitchenState) => void;

export interface PantryViewProps {
  today: string;
  filter: PantryFilter;
  setFilter: (filter: PantryFilter) => void;
  focusId: string | null;
  focusRequest?: number;
  select: (id: string) => void;
  search: string;
  setSearch: (value: string) => void;
  sort: PantrySort;
  setSort: (value: PantrySort) => void;
  pantry: PantryStock[];
  meals: PlannedMeal[];
  week: string;
  setWeek: (week: string) => void;
  reviewMeal: (date: string) => void;
  draft: string;
  setDraft: (value: string) => void;
  add: () => void;
  remove: (id: string) => void;
  update: UpdateKitchen;
  error?: string;
  notice?: string;
  addedIds?: string[];
}

function totalsText(totals: ParsedMeasure[], empty: string) {
  return totals.filter(amount => amount.quantity > 0).map(amount => formatMeasure(amount.quantity, amount.unit)).join(" · ") || empty;
}

function withDate(stock: PantryStock, useBy: string): PantryStock {
  const next = { ...stock };
  if (useBy) next.useBy = useBy; else delete next.useBy;
  return next;
}

function fieldValue(stock: PantryStock, field: "measure" | "useBy") {
  return stock[field] ?? "";
}

const INCOMPLETE_DATE = "Complete the calendar date, or clear it if it is unknown.";

function focusDisclosure(event: MouseEvent<HTMLButtonElement>) {
  if (event.button !== 0) return;
  // Preserve a pinned draft through Safari's mouse focus default, including synthesized touch clicks.
  // Canceling pointerdown instead would suppress WebKit's tap-generated click entirely.
  event.preventDefault();
  event.currentTarget.focus({ preventScroll: true });
}

type FieldDraft = { snapshot: PantryStock; draft: string; problem: string; badDate: boolean; submitted?: PantryStock };

/** A valid intermediate keystroke is still a draft, not an inventory change. */
function PantryBatchField({ stock, field, descriptionId, update }: {
  stock: PantryStock; field: "measure" | "useBy"; descriptionId: string; update: UpdateKitchen;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const fresh = (): FieldDraft => ({ snapshot: { ...stock }, draft: fieldValue(stock, field), problem: "", badDate: false });
  const [edit, setEdit] = useState<FieldDraft>(fresh);
  const dirty = edit.draft !== fieldValue(edit.snapshot, field) || edit.badDate;
  const changed = !samePantryBatch(stock, edit.snapshot);
  if (changed && ((edit.submitted && samePantryBatch(stock, edit.submitted)) || (!dirty && !edit.problem))) setEdit(fresh());
  const problem = changed && dirty ? "This batch changed while you were editing. Restore the current value before trying again." : edit.problem;

  function readDraft(input: HTMLInputElement) {
    const value = input.value, badDate = field === "useBy" && !input.validity.valid;
    const problem = field === "measure" ? measureInputProblem(value) : badDate ? INCOMPLETE_DATE : pantryDateInputProblem(value);
    setEdit(current => ({ ...current, draft: value, problem, badDate, submitted: undefined }));
  }

  function restore() {
    // A partial native date can have value="" already, so a React reset alone may not clear its segments.
    if (field === "useBy" && inputRef.current) inputRef.current.value = fieldValue(stock, field);
    setEdit(fresh());
  }

  function commit(input: HTMLInputElement) {
    const value = input.value.trim(), valid = input.checkValidity();
    const invalid = field === "measure" ? measureInputProblem(value) : !valid ? INCOMPLETE_DATE : pantryDateInputProblem(value);
    if (invalid) { setEdit(current => ({ ...current, draft: value, badDate: field === "useBy" && !valid, problem: invalid })); return; }
    if (value === fieldValue(stock, field)) { setEdit(fresh()); return; }
    if (!samePantryBatch(stock, edit.snapshot)) {
      setEdit(current => ({ ...current, problem: "This batch changed. Restore the current value before trying again." }));
      return;
    }
    const next = field === "measure" ? { ...edit.snapshot, measure: value } : withDate(edit.snapshot, value);
    const invalidBatch = pantryBatchProblem(next);
    if (invalidBatch) { setEdit(current => ({ ...current, problem: invalidBatch })); return; }
    setEdit(current => ({ ...current, draft: value, problem: "", submitted: next }));
    update(state => replacePantryBatch(state, edit.snapshot, next));
  }

  return <div className="pantry-batch-field">
    <label htmlFor={id}><span>{field === "measure" ? "Amount on hand" : "Use by · entered date"}</span>
    <input ref={inputRef} id={id} type={field === "useBy" ? "date" : "text"}
      aria-label={`${field === "measure" ? "Available" : "Use by"} ${stock.name}`}
      aria-invalid={Boolean(problem)} aria-describedby={`${descriptionId}${problem ? ` ${id}-error` : ""}`}
      value={edit.draft} placeholder={field === "measure" ? "Amount unknown" : undefined}
      maxLength={field === "measure" ? 160 : undefined}
      min={field === "useBy" ? "0001-01-01" : undefined} max={field === "useBy" ? "9999-12-31" : undefined}
      onChange={event => readDraft(event.currentTarget)}
      onInput={event => readDraft(event.currentTarget)}
      onInvalid={event => readDraft(event.currentTarget)}
      onBlur={event => commit(event.currentTarget)}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); restore(); }
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      }} /></label>
    {problem && <><small id={`${id}-error`} className="field-error" role="alert">Not saved: {problem}</small>
      <button className="text-button" type="button" onClick={restore}>Restore current value</button></>}
  </div>;
}

function PantryBatchEditor({ snapshot, current, update, close, reload, done, recordChange, review }: {
  snapshot: PantryStock; current: PantryStock | undefined; update: UpdateKitchen;
  close: () => void; reload: () => void; done: (message: string) => void;
  recordChange: (change: PantryBatchChange) => void;
  review?: { position: number; total: number; reasons: string[]; next: () => void; last: boolean };
}) {
  const id = useId();
  const [mode, setMode] = useState<"correct" | "use" | "finish">("correct");
  const [name, setName] = useState(snapshot.name);
  const [measure, setMeasure] = useState(snapshot.measure);
  const [useBy, setUseBy] = useState(snapshot.useBy ?? "");
  const dateInput = useRef<HTMLInputElement>(null);
  const [badDate, setBadDate] = useState(false);
  const [usage, setUsage] = useState("");
  const [requested, setRequested] = useState<{ stock: PantryStock; message: string } | null>(null);
  const recorded = useRef(false);
  const usagePreview = pantryUsagePreview(snapshot, usage);
  const correction = withDate({ ...snapshot, name: name.trim(), measure: measure.trim() }, useBy);
  const snapshotAmount = pantryAmountDetails(snapshot.measure);
  const next = mode === "correct" ? correction : mode === "use" ? usagePreview.stock
    : snapshotAmount.kind === "empty" ? snapshot : { ...snapshot, measure: formatMeasure(0, snapshotAmount.parsed?.unit ?? "count") };
  const dateProblem = badDate ? INCOMPLETE_DATE : pantryDateInputProblem(useBy);
  const problem = mode === "use" ? usagePreview.problem
    : mode === "correct" && dateProblem ? dateProblem : next ? pantryBatchProblem(next) : "Check this batch.";
  const applied = Boolean(requested && samePantryBatch(current, requested.stock));
  const stale = !samePantryBatch(current, snapshot);
  const action = mode === "correct" ? "Save batch correction" : mode === "use" ? "Subtract usage" : "Confirm finished batch";

  useEffect(() => {
    if (!applied || !requested || recorded.current) return;
    recorded.current = true;
    if (!samePantryBatch(snapshot, requested.stock)) recordChange({ before: { ...snapshot }, after: { ...requested.stock } });
  }, [applied, requested, recordChange, snapshot]);

  function readDateDraft(input: HTMLInputElement) {
    setUseBy(input.value);
    setBadDate(!input.validity.valid);
  }

  return <Modal className="kitchen-modal-backdrop pantry-batch-backdrop" label={`${review ? "Review" : "Edit"} batch ${snapshot.name}`} close={close}>
    <section className="panel kitchen-modal pantry-batch-editor">
      <header><h2>{review ? "Review pantry batch" : "Edit batch"}</h2>
        {review && <div className="pantry-review-context"><p>Batch {review.position} of {review.total} in this review pass</p>
          {review.reasons.length ? <ul aria-label="Reasons to review this batch">{review.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
            : <p>No remaining amount, past-date, or selected-week unit issue for this batch. Nothing else needs changing for this review.</p>}
          <p>Reviewing does not change stock. Confirm one change, or skip this batch without saving.</p></div>}
        <p><strong>{snapshot.name}</strong> · {snapshot.measure || "Amount unknown"} · {snapshot.useBy ? `Entered date ${dateLabel(snapshot.useBy)}` : "No date entered"}</p>
        <p className="quantity-note">This changes this batch only. Its ID stays the same; no new stock is created and other batches are not merged.</p></header>
      {applied && requested ? <>
        <p role="status">{requested.message} Follow the kitchen save indicator for sync status.</p>
        <p>{requested.stock.name} · Amount on hand: {requested.stock.measure || "Unknown"} · {requested.stock.useBy ? `Entered date ${dateLabel(requested.stock.useBy)}` : "No date entered"}</p>
        <div className="modal-actions"><button className={review ? "secondary-button" : "primary-button"} onClick={() => done(requested.message)}>Done</button>
          {review && <button className="primary-button" onClick={review.next}>{review.last ? "Finish review" : "Review next"}</button>}</div>
      </> : <>
        {stale && <div className="pantry-batch-conflict" role="alert"><p>{current ? "This batch changed after the editor was opened. Nothing from this editor has overwritten it. Load the current batch and review your correction again." : "This batch was removed. Close the editor; it will not recreate the batch."}</p>
          {current && <button className="secondary-button" onClick={reload}>Load current batch</button>}</div>}
        <div className="pantry-batch-modes" role="group" aria-label="Batch action">
          {([["correct", "Correct batch"], ["use", "Record usage"], ["finish", "Mark finished"]] as const).map(([value, label]) =>
            <button key={value} type="button" className="secondary-button" aria-pressed={mode === value} disabled={Boolean(requested)} onClick={() => setMode(value)}>{label}</button>)}
        </div>
        <form onSubmit={event => {
          event.preventDefault();
          if (!event.currentTarget.reportValidity()) return;
          const replacement = mode === "correct" && dateInput.current ? withDate(correction, dateInput.current.value) : next;
          if (!replacement || problem || pantryBatchProblem(replacement) || stale || requested) return;
          const message = mode === "correct" ? `Batch correction applied for ${replacement.name}.` : mode === "use" ? `Usage subtracted from ${replacement.name}.` : `${replacement.name} marked finished; the empty batch is kept.`;
          setRequested({ stock: replacement, message });
          update(state => replacePantryBatch(state, snapshot, replacement));
        }}>
          <fieldset disabled={stale || Boolean(requested)} className="pantry-batch-editor-fields">
            <legend className="pantry-batch-legend">{mode === "correct" ? "Correct the recorded stock" : mode === "use" ? "Subtract from physical stock" : "Finish this batch"}</legend>
            {mode === "correct" ? <>
              <label htmlFor={`${id}-name`}>Ingredient name / form</label>
              <input id={`${id}-name`} value={name} maxLength={200} aria-describedby={`${id}-form-help`} onChange={event => setName(event.target.value)} />
              <p id={`${id}-form-help`} className="quantity-note">Write the form explicitly, for example “cooked rice” or “uncooked rice”. Plain rice means uncooked. Correcting the name does not cook food or convert its amount.</p>
              <label htmlFor={`${id}-amount`}>Amount on hand</label>
              <input id={`${id}-amount`} value={measure} maxLength={160} placeholder="Amount unknown" aria-describedby={`${id}-amount-help`} onChange={event => setMeasure(event.target.value)} />
              <p id={`${id}-amount-help`} className="quantity-note">{pantryAmountDetails(measure).explanation} Enter the physical amount, before planned reservations.</p>
              <label htmlFor={`${id}-date`}>Use by · entered planning date</label>
              <input ref={dateInput} id={`${id}-date`} type="date" min="0001-01-01" max="9999-12-31" value={useBy}
                aria-invalid={Boolean(dateProblem)} aria-describedby={`${id}-date-help${dateProblem ? ` ${id}-error` : ""}`}
                onInput={event => readDateDraft(event.currentTarget)} onChange={event => readDateDraft(event.currentTarget)}
                onInvalid={event => readDateDraft(event.currentTarget)} />
              <p id={`${id}-date-help`} className="quantity-note">Optional and inclusive. This is your planning date, not a food-safety assessment. Clear it if unknown; past dates exclude stock from planning, not from physical on-hand totals.</p>
            </> : mode === "use" ? <>
              <label htmlFor={`${id}-used`}>Amount used from this batch</label>
              <input id={`${id}-used`} value={usage} maxLength={160} placeholder="e.g. 100 g" aria-describedby={`${id}-usage-help`} onChange={event => setUsage(event.target.value)} />
              <p id={`${id}-usage-help`} className="quantity-note">Subtract only what you actually used, in compatible units. Planned reservations are recalculated, not subtracted a second time. This does not mark a dinner cooked.</p>
            </> : <p>Set the amount on hand to zero. The batch, its name and entered date stay in All items. Use Remove in the pantry if you want to remove it with Undo instead.</p>}
          </fieldset>
          {next && !problem && <p className="pantry-batch-preview">After this change: <strong>{next.name}</strong> · Amount on hand: <strong>{next.measure || "Unknown"}</strong> · {next.useBy ? `Entered date ${dateLabel(next.useBy)}` : "No date entered"}</p>}
          {problem && <p id={`${id}-error`} className="field-error" role="alert">{problem}</p>}
          {requested && !stale && <p role="status">Applying this batch change…</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" onClick={close}>Cancel</button>
            {review && <button className="secondary-button" type="button" onClick={review.next}>Skip batch</button>}
            <button className="primary-button" disabled={Boolean(problem) || stale || Boolean(requested)}>{action}</button></div>
        </form>
      </>}
    </section>
  </Modal>;
}

export function PantryView({ today, filter, setFilter, focusId, focusRequest = 0, select, search, setSearch, sort, setSort,
  pantry, meals, week, setWeek, reviewMeal, draft, setDraft, add, remove, update, error, notice, addedIds = [] }: PantryViewProps) {
  const id = useId();
  const addInput = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const undoFocusId = useRef<string | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const returnToReview = useRef(false);
  const disclosureContext = JSON.stringify([filter, search, focusId, focusRequest, addedIds]);
  const [allExpanded, setAllExpanded] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<{ context: string; values: Record<string, boolean> }>({ context: disclosureContext, values: {} });
  const [review, setReview] = useState<{ tasks: PantryReviewTask[]; index: number } | null>(null);
  const [editing, setEditing] = useState<{ snapshot: PantryStock; version: number } | null>(null);
  const [localNotice, setLocalNotice] = useState("");
  const [lastChange, setLastChange] = useState<PantryBatchChange | null>(null);
  const [undoRequested, setUndoRequested] = useState(false);
  const rememberChange = useCallback((change: PantryBatchChange) => {
    undoFocusId.current = null;
    setLastChange(change); setUndoRequested(false);
    setExpandedGroups(current => ({ context: disclosureContext,
      values: { ...(current.context === disclosureContext ? current.values : {}), [canonicalIngredient(change.after.name)]: true } }));
  }, [disclosureContext]);
  const undoProblem = lastChange ? pantryBatchUndoProblem(pantry, lastChange) : "";
  // Acknowledge the functional update only after its result is visible in pantry props.
  if (undoRequested && lastChange) {
    const current = pantry.find(stock => stock.id === lastChange.before.id);
    if (samePantryBatch(current, lastChange.before)) {
      setLocalNotice(`Undid the last batch edit for ${lastChange.before.name}. Follow the kitchen save indicator for sync status.`);
      setLastChange(null); setUndoRequested(false);
    } else if (undoProblem) {
      setUndoRequested(false);
    }
  }
  const [pin, setPin] = useState<{ id: string; order: string[]; context: string } | null>(null);
  const context = JSON.stringify([filter, search, sort]);
  const dateGroups = useMemo(() => pantryDateGroups(pantry, today), [pantry, today]);
  const fullGroups = useMemo(() => new Map(groupPantryBatches(pantry).map(group => [group.key, group])), [pantry]);
  const reservations = useMemo(() => pantryWeekReservations(pantry, meals, week, today), [pantry, meals, week, today]);
  const reviewTasks = useMemo(() => pantryReviewTasks(pantry, meals, week, today), [pantry, meals, week, today]);
  const reviewById = new Map(reviewTasks.map(task => [task.pantryId, task]));
  const matches = browsePantry(dateGroups[filter], search, sort);
  const visible = new Map(matches.map(stock => [stock.id, stock]));
  const pinned = pin?.context === context ? pantry.find(stock => stock.id === pin.id) : undefined;
  if (pinned) visible.set(pinned.id, pinned);
  // Keep DOM order stable through an inline blur, including Tab to the next field.
  const order = pinned ? [...new Set([...pin!.order, ...visible.keys()])] : [...visible.keys()];
  const displayed = order.flatMap(stockId => { const stock = visible.get(stockId); return stock ? [stock] : []; });
  const displayGroups = groupPantryBatches(displayed);
  const soonIds = new Set(dateGroups.soon.map(stock => stock.id));
  const weekLabel = `${dateLabel(weekStart(week))} – ${dateLabel(addDateDays(weekStart(week), 6))}`;

  function setGroupExpanded(key: string, expanded: boolean) {
    setExpandedGroups(current => ({ context: disclosureContext,
      values: { ...(current.context === disclosureContext ? current.values : {}), [key]: expanded } }));
  }

  function closeEditor() {
    if (review) returnToReview.current = true;
    setReview(null); setEditing(null);
  }

  function startReview() {
    const first = reviewTasks[0], stock = first && pantry.find(item => item.id === first.pantryId);
    if (!stock) return;
    setLocalNotice("");
    setReview({ tasks: reviewTasks, index: 0 });
    setGroupExpanded(canonicalIngredient(stock.name), true);
    setEditing({ snapshot: { ...stock }, version: 0 });
  }

  function advanceReview() {
    if (!review) return;
    // Keep a stable pass; do not unexpectedly add new tasks or revisit a skipped batch.
    const nextIndex = review.tasks.findIndex((task, index) => index > review.index && reviewById.has(task.pantryId));
    const nextTask = review.tasks[nextIndex], stock = nextTask && pantry.find(item => item.id === nextTask.pantryId);
    if (!stock) {
      setLocalNotice(`Review pass finished. ${reviewTasks.length ? `${reviewTasks.length} ${reviewTasks.length === 1 ? "batch still needs" : "batches still need"} review. Skipped or unresolved batches remain available for another pass.` : "No batches currently need amount, past-date, or selected-week unit review."}`);
      closeEditor();
      return;
    }
    setReview({ ...review, index: nextIndex });
    setGroupExpanded(canonicalIngredient(stock.name), true);
    setEditing({ snapshot: { ...stock }, version: 0 });
  }

  useEffect(() => {
    if (editing || !returnToReview.current) return;
    returnToReview.current = false;
    (reviewButton.current && !reviewButton.current.disabled ? reviewButton.current : heading.current)?.focus();
  }, [editing]);

  useEffect(() => {
    if (!focusId) return;
    const frame = requestAnimationFrame(() => {
      const row = document.getElementById(`pantry-row-${focusId}`);
      row?.scrollIntoView({ block: "center" });
      row?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusId, focusRequest, filter]);

  useEffect(() => {
    if (lastChange || !undoFocusId.current) return;
    const target = document.getElementById(`pantry-edit-${undoFocusId.current}`);
    undoFocusId.current = null;
    (target?.getClientRects().length ? target : heading.current)?.focus();
  }, [lastChange]);

  return <div className="pantry-page pantry-batch-browser">
    <section className="panel large-panel">
      <div className="section-heading"><div><h2 ref={heading} tabIndex={-1}>Your pantry</h2><p>Keep the food you physically have, batch by batch. Type or paste ingredients, separated by new lines, commas, or semicolons.</p></div></div>
      <section className="pantry-review-summary" aria-label="Pantry stocktake">
        <div><h3>Keep your pantry accurate</h3>
          <p>{reviewTasks.length ? `${reviewTasks.length} ${reviewTasks.length === 1 ? "batch to review" : "batches to review"}` : "No batches currently need review"} across your full pantry, including batches hidden by search or filters.</p>
          <p className="quantity-note">Unknown amounts, past entered dates, and unit mismatches affecting saved dinners in {weekLabel}. Missing dates alone are not a problem; this is not a food-safety assessment.</p></div>
        <button ref={reviewButton} className="primary-button" type="button" disabled={!reviewTasks.length} onClick={startReview}>Review pantry</button>
      </section>
      <form className="add-form" onSubmit={event => { event.preventDefault(); setLocalNotice(""); add(); }}>
        <textarea ref={addInput} value={draft} onChange={event => setDraft(event.target.value)} placeholder={"rice: 300 g\ncanned tomatoes: 2 cans\ngarlic"} aria-label="New pantry ingredient" rows={3} aria-describedby={`${id}-add-help`} />
        <button className="primary-button" type="submit">Add to pantry</button>
      </form>
      <p id={`${id}-add-help`} className="quantity-note">Try “rice: 300 g”, “300 g rice”, or just “rice”. Use “cooked rice” for leftovers; plain rice means uncooked. Multiple ingredients open a confirmation preview. Unknown amounts are not unlimited and won’t reduce shopping needs.</p>
      {error && <p role="alert" className="field-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {localNotice && <p role="status">{localNotice}</p>}
      {lastChange && <section className="pantry-edit-undo" aria-label="Last pantry batch edit">
        <div><strong>Last batch edit: {lastChange.after.name}</strong>
          <p>{lastChange.before.name}: {lastChange.before.measure || "Amount unknown"} · {lastChange.before.useBy ? `Entered date ${dateLabel(lastChange.before.useBy)}` : "No date entered"} → {lastChange.after.name}: {lastChange.after.measure || "Amount unknown"} · {lastChange.after.useBy ? `Entered date ${dateLabel(lastChange.after.useBy)}` : "No date entered"}</p>
          <small>Undo restores this batch only, if it has not changed again. Available until you leave Pantry, reload, or dismiss it.</small>
          {undoProblem && <p role="status">{undoProblem}</p>}</div>
        <div className="modal-actions"><button type="button" className="secondary-button" disabled={Boolean(undoProblem) || undoRequested || Boolean(editing)} onClick={() => {
          if (pantryBatchUndoProblem(pantry, lastChange)) return;
          undoFocusId.current = lastChange.before.id;
          setGroupExpanded(canonicalIngredient(lastChange.before.name), true);
          setUndoRequested(true);
          update(state => undoPantryBatch(state, lastChange));
        }}>Undo last batch edit</button><button type="button" className="text-button" disabled={undoRequested} onClick={() => {
          undoFocusId.current = lastChange.after.id;
          const current = pantry.find(stock => stock.id === lastChange.after.id);
          if (current) setGroupExpanded(canonicalIngredient(current.name), true);
          setLastChange(null);
        }}>Dismiss edit undo</button></div>
      </section>}
      <details className="pantry-planning-help"><summary>How amounts and reservations work</summary>
        <p><strong>On hand is not the same as available.</strong> Reservations below are estimates for {reservations.mealCount} saved, uncooked {reservations.mealCount === 1 ? "dinner" : "dinners"} in {weekLabel}. They do not change physical stock.</p>
        <p>Only compatible units are totaled. Available today excludes past entered dates and those reservations; each dinner also checks its own date. Entered dates are optional planning dates, not food-safety advice.</p>
        <p>Inline changes apply when you leave the field, or with Enter where supported by the date control. Escape restores the current value.</p>
      </details>
      <div className="pantry-reservation-week" role="group" aria-label="Pantry reservation week">
        <span><strong>Reservation week</strong> · {weekLabel}</span>
        <div><button type="button" className="secondary-button" aria-label="Previous week for pantry reservations" onClick={() => setWeek(addDateDays(weekStart(week), -7))}>Previous week</button>
          <button type="button" className="secondary-button" disabled={weekStart(week) === weekStart(today)} onClick={() => setWeek(weekStart(today))}>Current week</button>
          <button type="button" className="secondary-button" aria-label="Next week for pantry reservations" onClick={() => setWeek(addDateDays(weekStart(week), 7))}>Next week</button></div>
      </div>
      <div className="pantry-browser-controls">
        <label>Search pantry<input type="search" placeholder="Ingredient name…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <button className="secondary-button" disabled={!search} onClick={() => setSearch("")}>Clear pantry search</button>
        <label>Sort pantry<select value={sort} onChange={event => setSort(event.target.value as PantrySort)}><option value="current">Current order</option><option value="name">Name (A–Z)</option><option value="useBy">Earliest use-by date</option></select></label>
      </div>
      <div className="pantry-filters" role="group" aria-label="Pantry review filters">
        {([["all", "All items"], ["soon", "Use soon"], ["past", "Past entered date"], ["undated", "No date entered"], ["unknown", "Unknown amounts"], ["empty", "Finished batches"]] as const).map(([value, label]) =>
          <button key={value} className="secondary-button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label} ({dateGroups[value].length})</button>)}
      </div>
      <div className="pantry-disclosure-actions"><button className="secondary-button" type="button" disabled={!displayGroups.length} onMouseDown={focusDisclosure} onClick={() => {
        setAllExpanded(true); setExpandedGroups({ context: disclosureContext, values: {} });
      }}>Show all batches</button><button className="secondary-button" type="button" disabled={!displayGroups.length} onMouseDown={focusDisclosure} onClick={() => {
        setAllExpanded(false); setExpandedGroups({ context: disclosureContext, values: Object.fromEntries(displayGroups.map(group => [group.key, false])) });
      }}>Hide all batches</button>
        {dateGroups.empty.length > 0 && <button className="text-button" type="button" onClick={() => { setSearch(""); setFilter("empty"); }}>Review finished batches</button>}
      </div>
      <p className="quantity-note" role="status">Showing {matches.length} of {dateGroups[filter].length} batches in this view.{pinned && !matches.some(stock => stock.id === pinned.id) ? " The batch being edited is also kept in view until you leave its group." : ""}</p>
      {/* Removing a large group must not anchor the viewport to the previous batch. */}
      <div className="pantry-ingredient-groups" style={{ overflowAnchor: "none" }}>
        {displayGroups.map(group => {
          const full = fullGroups.get(group.key)!;
          const reserved = compatiblePantryTotals(full.batches.map(stock => reservations.byId.get(stock.id)?.reserved ?? null));
          const available = compatiblePantryTotals(full.batches.map(stock => reservations.byId.get(stock.id)?.available ?? null));
          const groupId = `${id}-group-${encodeURIComponent(group.key)}`;
          const expanded = (expandedGroups.context === disclosureContext ? expandedGroups.values[group.key] : undefined)
            ?? (allExpanded || filter !== "all" || Boolean(search.trim()) || full.batches.some(stock => stock.id === focusId || addedIds.includes(stock.id)));
          const needsReview = full.batches.filter(stock => reviewById.has(stock.id)).length;
          const dueSoon = full.batches.filter(stock => soonIds.has(stock.id)).length;
          return <section className="pantry-ingredient-group" aria-labelledby={groupId} key={group.key}
            onBlurCapture={event => {
              // Disclosure changes must hide, not unmount, a filtered-out row with an active draft.
              if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest(".pantry-disclosure-actions")) return;
              if (!event.currentTarget.contains(event.relatedTarget)) setPin(current => current && full.batches.some(stock => stock.id === current.id) ? null : current);
            }}>
            <header className="pantry-group-heading"><div><h3 id={groupId}>{full.name}</h3><p>{full.batches.length} {full.batches.length === 1 ? "batch" : "batches"}{full.emptyCount > 0 ? ` · ${full.emptyCount} finished` : ""}</p>
                {!expanded && <p className="pantry-on-hand-summary"><strong>On hand: {totalsText(full.onHand, full.unknownCount ? "No known amount" : "0")}</strong>{full.unknownCount > 0 ? ` + ${full.unknownCount} ${full.unknownCount === 1 ? "batch" : "batches"} with unknown amount` : ""}</p>}
                {(needsReview > 0 || dueSoon > 0) && <p className="pantry-attention">{[needsReview ? `${needsReview} to review` : "", dueSoon ? `${dueSoon} use soon` : ""].filter(Boolean).join(" · ")}</p>}</div>
              <div className="pantry-group-actions"><button type="button" className="secondary-button" onMouseDown={focusDisclosure} aria-expanded={expanded} aria-controls={`${groupId}-batches`}
                aria-label={`${expanded ? "Hide" : "Show"} batches for ${full.name}`} onClick={() => setGroupExpanded(group.key, !expanded)}>{expanded ? "Hide batches" : "Show batches"}</button>
              <button className="secondary-button" aria-label={`Add another batch of ${full.name}`} onClick={() => {
                setDraft(full.name); setLocalNotice(`Enter the new amount for ${full.name}, then choose Add to pantry. Existing batches stay separate.`);
                addInput.current?.focus(); addInput.current?.scrollIntoView({ block: "center" });
              }}>Add another batch</button></div></header>
            {group.batches.length !== full.batches.length && <p className="quantity-note">Totals include all {full.batches.length} batches of this ingredient; {group.batches.length} shown in this view.</p>}
            <div id={`${groupId}-batches`} className="pantry-group-body" hidden={!expanded}>
            <dl className="pantry-group-totals">
              <div><dt>Amount on hand</dt><dd>{totalsText(full.onHand, full.unknownCount ? "No known amount" : "0")}{full.unknownCount > 0 && <small>Plus {full.unknownCount} {full.unknownCount === 1 ? "batch" : "batches"} with an unknown amount</small>}</dd></div>
              <div><dt>Reserved for selected week</dt><dd>{totalsText(reserved, "None confirmed")}</dd></div>
              <div><dt>Available today after reservations</dt><dd>{totalsText(available, "0 confirmed")}</dd></div>
            </dl>
            {group.batches.map(item => {
              const amount = pantryAmountDetails(item.measure);
              const eligibility = pantryStockEligibility(item, today);
              const planning = reservations.byId.get(item.id);
              const rowId = `${id}-batch-${encodeURIComponent(item.id)}`;
              return <div className="unified-pantry-item pantry-batch-row" key={item.id} id={`pantry-row-${item.id}`}
                onFocusCapture={() => setPin(current => current?.id === item.id && current.context === context ? current : { id: item.id, order: displayed.map(stock => stock.id), context })}>
                <div className="pantry-batch-identity"><strong>{item.name}</strong><small>Batch {full.batches.findIndex(stock => stock.id === item.id) + 1} of {full.batches.length}</small>
                  {addedIds.includes(item.id) && <span className="pantry-new-batch">Just added</span>}</div>
                <PantryBatchField stock={item} field="measure" update={update} descriptionId={`${rowId}-amount`} />
                <PantryBatchField stock={item} field="useBy" update={update} descriptionId={`${rowId}-date`} />
                <div className="pantry-batch-notes">
                  <p id={`${rowId}-amount`}>{amount.explanation}</p>
                  <p id={`${rowId}-date`}>{!item.useBy ? "No date entered; date is unknown." : !eligibility.eligible && amount.kind !== "empty" ? `${eligibility.reason} Still included in physical on-hand totals.` : "Entered planning date, inclusive; not a food-safety assessment."}</p>
                  {planning?.reserved && planning.available ? <p>Reserved for selected week: {formatMeasure(planning.reserved.quantity, planning.reserved.unit)} · Available today after reservations: {formatMeasure(planning.available.quantity, planning.available.unit)}</p>
                    : <p>No confirmed reservation or availability for an unknown amount.</p>}
                  {Boolean(planning?.reservations.length) && <details className="pantry-reservation-details"><summary>Reserved for {planning!.reservations.length} {planning!.reservations.length === 1 ? "dinner" : "dinners"}</summary>
                    <ul>{planning!.reservations.map(reservation => <li key={reservation.mealId}><span>{dateLabel(reservation.date)} · {reservation.title} · <strong>{reservation.measure}</strong></span>
                      <button type="button" className="text-button" aria-label={`Review dinner: ${reservation.title} on ${reservation.date}`} onClick={() => reviewMeal(reservation.date)}>Review dinner</button></li>)}</ul>
                  </details>}
                </div>
                <div className="pantry-row-actions">
                  {soonIds.has(item.id) && <button className="text-button" onClick={() => select(item.id)} aria-label={`Find dinners using ${item.name}`}>Find dinner</button>}
                  <button id={`pantry-edit-${item.id}`} className="text-button" aria-label={`Edit batch ${item.name}`} onClick={() => setEditing({ snapshot: { ...item }, version: 0 })}>Edit batch</button>
                  <button className="text-button" onClick={() => remove(item.id)} aria-label={`Remove ${item.name}`}>Remove</button>
                </div>
              </div>;
            })}
            </div>
          </section>;
        })}
      </div>
      {!pantry.length ? <div className="pantry-empty-state"><h3>Your pantry is empty</h3><p>Add an ingredient above. You can leave the amount and date unknown and fill them in later.</p><button className="secondary-button" onClick={() => addInput.current?.focus()}>Add your first ingredient</button></div>
        : !displayed.length && <div className="pantry-empty-state"><h3>{!dateGroups[filter].length ? "No batches in this view" : "No pantry items match your search in this view."}</h3>
          <p>{!dateGroups[filter].length && filter === "undated" ? "Every nonempty batch has an entered planning date. Empty batches remain in All items."
                      : !dateGroups[filter].length && filter === "unknown" ? "Every batch has a recognized amount. A known amount still needs compatible recipe units."
                      : !dateGroups[filter].length && filter === "empty" ? "No batches have a known zero amount. Unknown amounts are not treated as finished."
                      : "Clear the search or choose All items to review the rest of your pantry."}</p>
          {search && <button className="secondary-button" onClick={() => setSearch("")}>Clear search</button>}
          {filter !== "all" && <button className="secondary-button" onClick={() => setFilter("all")}>Show all items</button>}</div>}
    </section>
    {editing && <PantryBatchEditor key={`${editing.snapshot.id}:${editing.version}`} snapshot={editing.snapshot} current={pantry.find(stock => stock.id === editing.snapshot.id)} update={update} recordChange={rememberChange}
      close={closeEditor} done={message => { setLocalNotice(message); closeEditor(); }}
      review={review ? { position: review.index + 1, total: review.tasks.length,
        reasons: reviewById.get(editing.snapshot.id)?.reasons.map(reason => reason.message) ?? [], next: advanceReview, last: review.index === review.tasks.length - 1 } : undefined}
      reload={() => { const current = pantry.find(stock => stock.id === editing.snapshot.id); if (current) setEditing({ snapshot: { ...current }, version: editing.version + 1 }); }} />}
  </div>;
}
