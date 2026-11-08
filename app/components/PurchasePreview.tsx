"use client";

import { useState } from "react";
import type { KitchenState } from "../lib/kitchen-types";
import type { ShoppingItem } from "../lib/quantities";
import { parseMeasure } from "../lib/quantities";
import { purchaseDraftProblems, purchasePreviewProblem, type PurchaseDraft } from "../lib/shopping-purchases";
import { Modal } from "./Modal";

export function PurchasePreview({ items, state, week, today, close, confirm }: {
  items: ShoppingItem[]; state: KitchenState; week: string; today: string;
  close: () => void; confirm: (drafts: PurchaseDraft[]) => void;
}) {
  const [drafts, setDrafts] = useState<PurchaseDraft[]>(() => items.map((item) => ({ key: item.key, name: item.name,
    cycleId: state.shoppingCycles?.[item.key], measure: parseMeasure(item.measure) ? item.measure : "", pantryId: crypto.randomUUID() })));
  const [dateErrors, setDateErrors] = useState<Record<string, string>>({});
  const error = purchasePreviewProblem(state, week, today, drafts) || (drafts.some((draft) => dateErrors[draft.key]) ? "Review the use-by dates below." : "");
  function updateDate(key: string, input: HTMLInputElement) {
    const value = input.value;
    // Partial date segments can have value="" without triggering React onChange.
    const problem = input.validity.valid ? "" : "Enter a complete, valid use-by date, or clear the date.";
    setDateErrors((errors) => ({ ...errors, [key]: problem }));
    setDrafts((rows) => rows.map((row) => row.key === key ? { ...row, useBy: value } : row));
  }
  return <Modal className="kitchen-modal-backdrop" label="Add bought items to pantry" close={close}>
    <form className="panel kitchen-modal pantry-import-modal" onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const submitted: PurchaseDraft[] = [];
      for (const draft of drafts) {
        const input = form.elements.namedItem(`useBy-${draft.pantryId}`) as HTMLInputElement | null;
        if (!input || !input.validity.valid) return;
        submitted.push({ ...draft, useBy: input.value });
      }
      if (!purchasePreviewProblem(state, week, today, submitted)) confirm(submitted);
    }}>
      <header><h2>Review your purchases</h2><p>Enter what you actually bought. Each item becomes a separate pantry batch; existing amounts and dates stay as entered.</p></header>
      <div className="pantry-import-rows" role="region" aria-label="Purchased ingredients" tabIndex={0}>
        {drafts.map((draft) => {
          const item = items.find((item) => item.key === draft.key)!;
          const problems = purchaseDraftProblems(draft), dateError = problems.useBy || dateErrors[draft.key];
          const amountErrorId = `purchase-amount-${draft.pantryId}`, dateErrorId = `purchase-date-${draft.pantryId}`;
          return <div className="purchase-preview-row" key={draft.key}>
            <strong>{draft.name}</strong>
            <label>Amount bought<input aria-label={`Amount bought ${draft.name}`} value={draft.measure} maxLength={160} placeholder="Unknown amount"
              aria-invalid={Boolean(problems.measure)} aria-describedby={problems.measure ? amountErrorId : undefined}
              onChange={(event) => setDrafts((rows) => rows.map((row) => row.key === draft.key ? { ...row, measure: event.target.value } : row))} />
              {problems.measure && <small className="field-error" id={amountErrorId} role="alert">{problems.measure}</small>}</label>
            <label>Use by (optional)<input type="date" name={`useBy-${draft.pantryId}`} aria-label={`Use by ${draft.name}`} value={draft.useBy ?? ""} min="0001-01-01" max="9999-12-31"
              aria-invalid={Boolean(dateError)} aria-describedby={dateError ? dateErrorId : undefined}
              onChange={(event) => updateDate(draft.key, event.currentTarget)}
              onInput={(event) => updateDate(draft.key, event.currentTarget)}
              onInvalid={(event) => updateDate(draft.key, event.currentTarget)} />
              {dateError && <small className="field-error" id={dateErrorId} role="alert">{dateError}</small>}</label>
            <small>Leave the date blank if unknown. Each batch keeps its own entered date.</small>
            {draft.useBy && !dateError && draft.useBy < today && <small>Past entered use-by date; this batch won’t count toward available stock.</small>}
            {item.preparationNote && <p className="quantity-note">{item.preparationNote}</p>}
            {state.pantry.some((stock) => stock.name.toLowerCase() === draft.name.toLowerCase()) && <small>Existing stock stays separate; this adds the amount you purchased.</small>}
            {!problems.measure && !parseMeasure(draft.measure) && <small>Unknown or note-only amounts are kept for review and won’t be subtracted from shopping.</small>}
            <button type="button" className="text-button" aria-label={`Skip purchased ${draft.name}`} onClick={() => setDrafts((rows) => rows.filter((row) => row.key !== draft.key))}>Skip item</button>
          </div>;
        })}
      </div>
      <footer>{error && <p className="field-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={Boolean(error)}>Confirm pantry additions</button></div></footer>
    </form>
  </Modal>;
}
