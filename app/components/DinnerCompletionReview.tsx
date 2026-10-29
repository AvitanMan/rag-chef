"use client";

import type { PlannedMeal } from "../lib/kitchen-types";
import type { consumptionPreview } from "../lib/quantities";

export function DinnerCompletionReview({ meal, preview, valid, deduct, setDeduct, confirm, cancel, pending = false, retry }: {
  meal: PlannedMeal;
  preview: ReturnType<typeof consumptionPreview>;
  valid: boolean;
  deduct: boolean;
  setDeduct: (value: boolean) => void;
  confirm: () => void;
  cancel: () => void;
  pending?: boolean;
  retry: () => void;
}) {
  return <section className="completion-review" aria-label="Complete dinner">
    <span className="eyebrow">Dinner finished</span><h2>{meal.title}</h2>
    <p>Mark this dinner cooked to remove its remaining needs from shopping. You can undo this afterward.</p>
    {!valid && !pending && <p role="alert">This dinner changed. Return to the current dinner before completing it.</p>}
    <label className="deduct-checkbox"><input type="checkbox" checked={deduct} disabled={pending || !valid} onChange={event => setDeduct(event.target.checked)} />Deduct the matching pantry amounts shown below</label>
    <ul>{preview.deductions.map((item, index) => <li key={`${item.pantryId}:${index}`}>{item.name}: {item.before} → {item.after}</li>)}</ul>
    {preview.notes.map((note, index) => <p className="quantity-note" key={index}>{note}</p>)}
    {!preview.deductions.length && <p>No compatible, measured pantry stock to deduct.</p>}
    {pending && <p role="status">Keeping your completion safe. If saving is unavailable, keep this session open and retry.</p>}
    <div className="modal-actions"><button className="secondary-button" disabled={pending} onClick={cancel}>Back to directions</button>
      {pending ? <button className="primary-button" onClick={retry}>Retry save</button> : <button className="primary-button" disabled={!valid} onClick={confirm}>Mark dinner cooked</button>}
    </div>
  </section>;
}
