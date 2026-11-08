"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { pantryInputProblem, type PantryInputRow } from "../lib/pantry-input";
import { measureInputProblem } from "../lib/kitchen-validation";
import { canonicalIngredient, parseMeasure } from "../lib/quantities";
import type { PantryStock } from "../lib/kitchen-types";

export function PantryImportPreview({ rows, pantry, change, close, confirm, disabled, editExisting }: {
  rows: PantryInputRow[]; pantry: PantryStock[]; change: (rows: PantryInputRow[]) => void;
  close: () => void; confirm: () => void; disabled: boolean; editExisting?: (id: string) => void;
}) {
  const [nativeDateErrors, setNativeDateErrors] = useState<string[]>([]);
  const error = pantryInputProblem(rows, pantry);
  const names = rows.map((row) => canonicalIngredient(row.name));
  const repeated = names.filter((name, index) => name && names.indexOf(name) !== index);
  const matching = names.map((name) => name ? pantry.filter((stock) => canonicalIngredient(stock.name) === name) : []);
  const confirmLabel = repeated.length || matching.some((stocks) => stocks.length)
    ? rows.length === 1 ? "Confirm new batch" : "Confirm new batches"
    : "Confirm ingredients";

  function captureDateValidity(index: number, input: HTMLInputElement) {
    const problem = input.validity.valid ? "" : "Enter a complete, valid use-by date, or clear the date.";
    setNativeDateErrors((errors) => rows.map((_, i) => i === index ? problem : errors[i] ?? ""));
  }

  function inputDate(index: number, input: HTMLInputElement) {
    const useBy = input.value;
    captureDateValidity(index, input);
    // Partial dates and explicit clearing both have value=""; only native validity distinguishes them.
    if (useBy !== (rows[index].useBy ?? "")) change(rows.map((row, i) => i === index ? { ...row, useBy } : row));
  }

  return <Modal className="kitchen-modal-backdrop" label="Review pantry ingredients" close={close}>
    <form className="panel kitchen-modal pantry-import-modal" onSubmit={(event) => {
      event.preventDefault();
      if (!event.currentTarget.reportValidity() || error || nativeDateErrors.some(Boolean) || disabled) return;
      confirm();
    }}>
      <header><h2>Review pantry ingredients</h2><p>{rows.length} ingredients · Edit names, optional amounts and use-by dates. Each row adds a separate batch; existing stock stays as it is.</p></header>
      <div className="pantry-import-rows" role="region" aria-label="Ingredients to import" tabIndex={0}>
        {rows.map((row, index) => {
          const rowError = pantryInputProblem([row], []).replace(/^Ingredient 1 /, `Ingredient ${index + 1} `);
          const dateError = nativeDateErrors[index] || (row.useBy ? pantryInputProblem([{ name: "Ingredient", measure: "", useBy: row.useBy }], []) : "");
          const description = [rowError && `pantry-preview-error-${index}`, row.reviewReasons?.length && `pantry-preview-review-${index}`].filter(Boolean).join(" ") || undefined;
          const dateDescription = [description, nativeDateErrors[index] && `pantry-preview-date-error-${index}`].filter(Boolean).join(" ") || undefined;
          return <div className="pantry-preview-row" key={index}>
            <label>Ingredient {index + 1}<input value={row.name} aria-invalid={rowError.startsWith(`Ingredient ${index + 1} name `)} aria-describedby={description} maxLength={200} onChange={(event) => change(rows.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} /></label>
            <label>Amount {index + 1}<input value={row.measure} maxLength={160} aria-invalid={Boolean(measureInputProblem(row.measure))} aria-describedby={description} placeholder="Unknown" onChange={(event) => change(rows.map((item, i) => i === index ? { ...item, measure: event.target.value } : item))} /></label>
            <label>Use by {index + 1}<input type="date" min="0001-01-01" max="9999-12-31" value={row.useBy ?? ""} aria-invalid={Boolean(dateError)} aria-describedby={dateDescription}
              onInput={(event) => inputDate(index, event.currentTarget)} onInvalid={(event) => captureDateValidity(index, event.currentTarget)} /></label>
            <button type="button" className="text-button" aria-label={`Remove preview ingredient ${index + 1}`} onClick={() => {
              setNativeDateErrors((errors) => errors.filter((_, i) => i !== index));
              change(rows.filter((_, i) => i !== index));
            }}>Remove</button>
            {nativeDateErrors[index] && <small id={`pantry-preview-date-error-${index}`} className="field-error" role="alert">{nativeDateErrors[index]}</small>}
            {row.originalText && <small>Original input: {row.originalText}</small>}
            {Boolean(row.reviewReasons?.length) && <small id={`pantry-preview-review-${index}`}>{row.reviewReasons?.join(" ")}</small>}
            {repeated.includes(names[index]) && <small role="status">This ingredient appears in more than one preview row. Each row will be added as a separate batch; amounts and dates will not be merged.</small>}
            {matching[index].length > 0 && <small>Already in your pantry. {editExisting && "Correct an existing batch instead if you are updating it. "}Confirming adds a new batch without changing existing stock.</small>}
            {matching[index].map((stock, stockIndex) => <small key={stock.id}>
              Existing batch {stockIndex + 1}: <strong>{stock.name}</strong> · {stock.measure || "Amount unknown"} · {stock.useBy ? `Use by ${stock.useBy}` : "Use-by date unknown"}
              {editExisting && <> <button type="button" className="text-button" disabled={disabled} aria-label={`Correct existing ${stock.name} batch ${stockIndex + 1} for ingredient ${index + 1}`} onClick={() => editExisting(stock.id)}>Correct existing batch</button></>}
            </small>)}
            {rowError ? <small id={`pantry-preview-error-${index}`} className="field-error">{rowError}</small> : row.measure && !parseMeasure(row.measure) && <small>Amount kept as a note; check units before shopping.</small>}
          </div>;
        })}
      </div>
      <footer>{error && <p role="alert" className="field-error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={Boolean(error) || disabled}>{confirmLabel}</button></div></footer>
    </form>
  </Modal>;
}
