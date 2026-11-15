"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { PantryStock } from "../lib/kitchen-types";
import { pantryLocationLabel } from "../lib/pantry-location";
import { pantryAmountDetails } from "../lib/quantities";
import { Modal } from "./Modal";
import { dateLabel } from "./WeeklyKitchenViews";

export function PantryIngredientDetails({ name, stocks, today, notice, undo, close, action, manage, focusStockId, focusRequest = 0 }: {
  name: string;
  stocks: PantryStock[];
  today: string;
  notice?: string;
  undo?: ReactNode;
  close: () => void;
  action: (stock: PantryStock, action: "move" | "use" | "finish" | "correct") => void;
  manage: () => void;
  focusStockId?: string;
  focusRequest?: number;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const batchHeadings = useRef(new Map<string, HTMLHeadingElement>());
  useEffect(() => {
    const initialFocus = !focusStockId && focusRequest === 0;
    const activeWhenScheduled = document.activeElement;
    // Wait until Modal has opened the native dialog before placing focus.
    const frame = requestAnimationFrame(() => {
      // Native dialog focus can already let someone Tab before this frame runs.
      // Preserve that navigation; explicit return-to-batch requests still win.
      if (initialFocus && document.activeElement !== activeWhenScheduled) return;
      const target = focusStockId ? batchHeadings.current.get(focusStockId) ?? heading.current : heading.current;
      target?.focus({ preventScroll: true });
      if (focusStockId && target !== heading.current) target?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusStockId, focusRequest]);

  return <Modal className="kitchen-modal-backdrop pantry-details-backdrop" label={`Details for ${name}`} close={close}>
    <section className="panel kitchen-modal pantry-details-panel">
      <header className="pantry-details-heading">
        <h2 ref={heading} tabIndex={-1}>{name}</h2>
        <p>Saved batches in all locations. Choose the batch you want to update.</p>
      </header>
      {notice && <p className="pantry-details-notice" role="status">{notice}</p>}
      {stocks.length ? <div className="pantry-details-batches">
        {stocks.map((stock, index) => {
          const amount = pantryAmountDetails(stock.measure);
          const past = Boolean(stock.useBy && stock.useBy < today);
          const canUse = amount.kind === "known" && Boolean(amount.parsed && amount.parsed.quantity > 0);
          return <section className="pantry-details-batch" role="region" aria-label={`Batch ${index + 1}: ${stock.name}`} key={stock.id}>
            <header><h3 tabIndex={-1} ref={element => {
              if (element) batchHeadings.current.set(stock.id, element); else batchHeadings.current.delete(stock.id);
            }}>Batch {index + 1}: {stock.name}</h3>
              {(amount.kind === "empty" || past) && <div className="pantry-details-status">
                {amount.kind === "empty" && <span>Finished</span>}
                {past && <span>Past entered date</span>}
              </div>}
            </header>
            <dl className="pantry-details-facts">
              <div><dt>Location</dt><dd>{pantryLocationLabel(stock.location)}</dd></div>
              <div><dt>Amount on hand</dt><dd>{stock.measure || "Amount unknown"}
                {amount.kind === "unknown" && stock.measure && <small>Amount unknown · saved as a note</small>}</dd></div>
              <div><dt>Use by · entered date</dt><dd>{stock.useBy ? <time dateTime={stock.useBy}>{dateLabel(stock.useBy, { month: "short", day: "numeric", year: "numeric" })}</time> : "No date entered"}</dd></div>
            </dl>
            <div className="pantry-details-actions">
              <button className="secondary-button" type="button" onClick={() => action(stock, "move")}>Move</button>
              <button className="secondary-button" type="button" disabled={!canUse} onClick={() => action(stock, "use")}>Use some</button>
              <button className="secondary-button" type="button" disabled={amount.kind === "empty"} onClick={() => action(stock, "finish")}>Mark finished</button>
              <button className="text-button" type="button" onClick={() => action(stock, "correct")}>Edit details</button>
            </div>
            {amount.kind === "unknown" && <p className="quantity-note">Enter a known amount in Edit details before recording usage.</p>}
          </section>;
        })}
      </div> : <p className="pantry-details-empty" role="status">This ingredient is no longer in your saved pantry.</p>}
      {stocks.length > 0 && <p className="quantity-note">Amounts shown are physical stock before planned reservations. Dates are planning reminders, not a food-safety assessment.</p>}
      {undo && <div className="pantry-details-undo">{undo}</div>}
      <footer className="modal-actions pantry-details-footer">
        <button className="primary-button" type="button" onClick={close}>Close</button>
        <button className="secondary-button" type="button" disabled={!stocks.length} onClick={manage}>Manage batches</button>
      </footer>
    </section>
  </Modal>;
}
