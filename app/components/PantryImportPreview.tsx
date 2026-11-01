"use client";

import { Modal } from "./Modal";
import { pantryInputProblem, type PantryInputRow } from "../lib/pantry-input";
import { measureInputProblem } from "../lib/kitchen-validation";
import { parseMeasure } from "../lib/quantities";
import type { PantryStock } from "../lib/kitchen-types";

export function PantryImportPreview({ rows, pantry, change, close, confirm, disabled }: {
  rows: PantryInputRow[]; pantry: PantryStock[]; change: (rows: PantryInputRow[]) => void;
  close: () => void; confirm: () => void; disabled: boolean;
}) {
  const error = pantryInputProblem(rows, pantry);
  return <Modal className="kitchen-modal-backdrop" label="Review pantry ingredients" close={close}>
    <section className="panel kitchen-modal pantry-import-modal">
      <header><h2>Review pantry ingredients</h2><p>{rows.length} ingredients · Edit names and optional amounts. Existing stock stays as it is.</p></header>
      <div className="pantry-import-rows" role="region" aria-label="Ingredients to import" tabIndex={0}>
        {rows.map((row, index) => {
          const rowError = pantryInputProblem([row], []);
          return <div className="pantry-preview-row" key={index}>
            <label>Ingredient {index + 1}<input value={row.name} aria-invalid={!row.name.trim()} maxLength={200} onChange={(event) => change(rows.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} /></label>
            <label>Amount {index + 1}<input value={row.measure} maxLength={160} aria-invalid={Boolean(measureInputProblem(row.measure))} placeholder="Unknown" onChange={(event) => change(rows.map((item, i) => i === index ? { ...item, measure: event.target.value } : item))} /></label>
            <button className="text-button" aria-label={`Remove preview ingredient ${index + 1}`} onClick={() => change(rows.filter((_, i) => i !== index))}>Remove</button>
            {rowError ? <small className="field-error">{rowError}</small> : row.measure && !parseMeasure(row.measure) && <small>Amount kept as a note; check units before shopping.</small>}
          </div>;
        })}
      </div>
      <footer>{error && <p role="alert" className="field-error">{error}</p>}<div className="modal-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" disabled={Boolean(error) || disabled} onClick={confirm}>Confirm ingredients</button></div></footer>
    </section>
  </Modal>;
}
