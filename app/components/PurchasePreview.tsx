"use client";

import { useState } from "react";
import type { KitchenState } from "../lib/kitchen-types";
import type { ShoppingItem } from "../lib/quantities";
import { parseMeasure } from "../lib/quantities";
import { purchasePreviewProblem, type PurchaseDraft } from "../lib/shopping-purchases";
import { Modal } from "./Modal";

export function PurchasePreview({ items, state, week, today, close, confirm }: {
  items: ShoppingItem[]; state: KitchenState; week: string; today: string;
  close: () => void; confirm: (drafts: PurchaseDraft[]) => void;
}) {
  const [drafts, setDrafts] = useState<PurchaseDraft[]>(() => items.map((item) => ({ key: item.key, name: item.name,
    cycleId: state.shoppingCycles?.[item.key], measure: parseMeasure(item.measure) ? item.measure : "", pantryId: crypto.randomUUID() })));
  const error = purchasePreviewProblem(state, week, today, drafts);
  return <Modal className="kitchen-modal-backdrop" label="Add bought items to pantry" close={close}>
    <section className="panel kitchen-modal pantry-import-modal">
      <header><h2>Review your purchases</h2><p>Enter what you actually bought. Each item becomes a separate pantry batch; existing amounts and dates stay as entered.</p></header>
      <div className="pantry-import-rows" role="region" aria-label="Purchased ingredients" tabIndex={0}>
        {drafts.map((draft) => {
          const item = items.find((item) => item.key === draft.key)!;
          return <div className="purchase-preview-row" key={draft.key}>
            <strong>{draft.name}</strong>
            <label>Amount bought<input aria-label={`Amount bought ${draft.name}`} value={draft.measure} maxLength={160} placeholder="Unknown amount"
              onChange={(event) => setDrafts((rows) => rows.map((row) => row.key === draft.key ? { ...row, measure: event.target.value } : row))} /></label>
            {item.preparationNote && <p className="quantity-note">{item.preparationNote}</p>}
            {state.pantry.some((stock) => stock.name.toLowerCase() === draft.name.toLowerCase()) && <small>Existing stock stays separate; this adds the amount you purchased.</small>}
            {!parseMeasure(draft.measure) && <small>Unknown or note-only amounts are kept for review and won’t be subtracted from shopping.</small>}
            <button className="text-button" aria-label={`Skip purchased ${draft.name}`} onClick={() => setDrafts((rows) => rows.filter((row) => row.key !== draft.key))}>Skip item</button>
          </div>;
        })}
      </div>
      <footer>{error && <p role="alert">{error}</p>}<div className="modal-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" disabled={Boolean(error)} onClick={() => confirm(drafts)}>Confirm pantry additions</button></div></footer>
    </section>
  </Modal>;
}
