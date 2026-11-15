"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { PantryLocation, PantryStock } from "../lib/kitchen-types";
import type { KitchenCommandSender } from "../lib/kitchen-commands";
import { pantryDraftRows, type PantryInputRow } from "../lib/pantry-input";
import { pantryLocationLabel, SPICE_RACK_ITEMS, suggestPantryLocation, withPantryLocation } from "../lib/pantry-location";
import { canonicalIngredient, pantryAmountDetails } from "../lib/quantities";
import { samePantryBatch, type PantryBatchChange } from "../lib/pantry-browser";
import { PantryLocationSelect } from "./PantryLocationSelect";
import { Modal } from "./Modal";

export type PantryLocationFilter = "all" | "unsorted" | PantryLocation;
export type PantryDraftLocations = Record<string, PantryLocation | "">;

export function PantryAddForm({ draft, setDraft, draftLocations, setDraftLocation, inputRef, location, pantry, add, error }: {
  draft: string; setDraft: (value: string) => void; inputRef: RefObject<HTMLTextAreaElement | null>;
  draftLocations: PantryDraftLocations; setDraftLocation: (key: string, location: PantryLocation | undefined) => void;
  location: PantryLocationFilter; pantry: PantryStock[]; add: (rows: PantryInputRow[]) => boolean;
  error?: string;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if ((!pantry.length || draft || error) && disclosure.current) disclosure.current.open = true;
  }, [pantry.length, draft, error]);
  const entries = pantryDraftRows(draft);
  const rows = entries.map(({ row, key }) => {
    const suggested = location === "all" ? suggestPantryLocation(row.name) : location === "unsorted" ? undefined : location;
    return withPantryLocation(row, Object.hasOwn(draftLocations, key) ? draftLocations[key] || undefined : suggested);
  });
  return <details ref={disclosure} className="pantry-add-disclosure" open={!pantry.length}>
    <summary>Add ingredients</summary>
    <form className="pantry-storage-add" onSubmit={event => {
    event.preventDefault();
    add(rows);
  }}>
    <div className="add-form">
      <textarea ref={inputRef} value={draft} onChange={event => setDraft(event.target.value)}
        placeholder="rice, tomatoes, garlic" aria-label="New pantry ingredient" rows={2} aria-describedby="pantry-storage-add-help" />
      <button className="primary-button" type="submit">Add to pantry</button>
    </div>
    <p id="pantry-storage-add-help" className="quantity-note">Ingredient names are enough. Separate them with commas or new lines; amounts and dates are optional. You can also enter “rice: 300 g”. Use “cooked rice” for leftovers.</p>
    {rows.length > 0 && <fieldset className="pantry-placement-drafts"><legend>{location === "all" ? "Suggested locations · change before adding" : "Where to save these ingredients"}</legend>
      {rows.map((row, index) => {
        const elsewhere = [...new Set(pantry.filter(stock => canonicalIngredient(stock.name) === canonicalIngredient(row.name) && stock.location !== row.location).map(stock => pantryLocationLabel(stock.location)))];
        return <div key={entries[index].key}>
          <strong>{row.name || `Ingredient ${index + 1}`}</strong>
          <PantryLocationSelect label={`Location for ingredient ${index + 1}`} value={row.location}
            onChange={value => setDraftLocation(entries[index].key, value)} />
          {elsewhere.length > 0 && <small>Also saved in {elsewhere.join(", ")}. Adding here keeps a separate entry.</small>}
        </div>;
      })}
    </fieldset>}
  </form></details>;
}

export function SpiceRackChecklist({ pantry, today, add, move }: {
  pantry: PantryStock[]; today: string; add: (rows: PantryInputRow[], preserveDraft?: boolean) => boolean; move: (stocks: PantryStock[]) => void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  // An entered planning date does not remove food the user still physically owns.
  const owned = (name: string) => pantry.filter(stock => canonicalIngredient(stock.name) === canonicalIngredient(name) && pantryAmountDetails(stock.measure).kind !== "empty");
  const additions = checked.filter(name => !owned(name).length);
  return <details className="pantry-spice-checklist" open={!pantry.length}>
    <summary>Stock your spice rack</summary>
    <p>Check only the spices you own. Add other names above; amounts can stay unknown.</p>
    <div className="pantry-spice-options">{SPICE_RACK_ITEMS.map(name => {
      const stocks = owned(name);
      return <div key={name}>
        <label><input type="checkbox" checked={stocks.length > 0 || checked.includes(name)} disabled={stocks.length > 0}
          onChange={event => setChecked(current => event.target.checked ? [...current, name] : current.filter(item => item !== name))} />{name}</label>
        {stocks.length > 0 && <small>Saved in {[...new Set(stocks.map(stock => pantryLocationLabel(stock.location)))].join(", ")}
          {stocks.some(stock => stock.useBy && stock.useBy < today) && <span>Past entered date · review dates in batch details.</span>}
          {stocks.some(stock => stock.location !== "spice-rack") && <button type="button" className="text-button" aria-label={`Move saved ${name}`} onClick={() => move(stocks)}>Move</button>}</small>}
      </div>;
    })}</div>
    <button type="button" className="secondary-button" disabled={!additions.length} onClick={() => {
      if (add(additions.map(name => ({ name, measure: "", location: "spice-rack" })), true)) setChecked([]);
    }}>Add selected spices</button>
  </details>;
}

export function PantryMoveDialog({ snapshots, pantry, command, recordChange, close, done }: {
  snapshots: PantryStock[]; pantry: PantryStock[]; command: KitchenCommandSender;
  recordChange: (change: PantryBatchChange) => void; close: () => void; done: (stock: PantryStock) => void;
}) {
  const [snapshot, setSnapshot] = useState<PantryStock | null>(snapshots.length === 1 ? snapshots[0] : null);
  const [location, setLocation] = useState<PantryLocation | undefined>(snapshot?.location);
  const [requested, setRequested] = useState<PantryStock | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [observedApplied, setObservedApplied] = useState(false);
  const recorded = useRef(false);
  const current = snapshot ? pantry.find(stock => stock.id === snapshot.id) : undefined;
  const applied = Boolean(requested && samePantryBatch(current, requested));
  // A later external reversal still conflicts, even if it restores the original snapshot.
  if (applied && !observedApplied) setObservedApplied(true);
  const stale = Boolean(snapshot && (!samePantryBatch(current, snapshot) || (observedApplied && !applied)));
  useEffect(() => {
    if (!applied || !snapshot || !requested || recorded.current) return;
    recorded.current = true;
    recordChange({ before: snapshot, after: requested });
  }, [applied, snapshot, requested, recordChange]);
  return <Modal label={`Move ${snapshots[0]?.name ?? "ingredient"}`} className="kitchen-modal-backdrop pantry-batch-backdrop" close={close}>
    <form className="panel kitchen-modal pantry-move-dialog" onSubmit={event => {
      event.preventDefault();
      if (!snapshot || stale || requested || snapshot.location === location) return;
      const replacement = withPantryLocation(snapshot, location);
      if (!command({ type: "ReplacePantryBatch", snapshot, replacement })) {
        setSubmitError("This entry was not moved. Your choices are kept. Resolve pending kitchen changes and try again.");
        return;
      }
      setSubmitError("");
      setRequested(replacement);
    }}>
      <h2>Move food</h2>
      <p>Move one whole saved entry. Its amount, date and ingredient name stay the same.</p>
      {applied && requested ? <>
        <p role="status">Moved {requested.name} to {pantryLocationLabel(requested.location)}.</p>
        <button type="button" className="primary-button" onClick={() => done(requested)}>Done</button>
      </> : <>
        {snapshots.length > 1 && <label>Batch to move<select value={snapshot?.id ?? ""} disabled={Boolean(requested)} onChange={event => {
          const next = snapshots.find(stock => stock.id === event.target.value) ?? null;
          setSnapshot(next); setLocation(next?.location); setObservedApplied(false);
        }}><option value="">Choose an entry</option>{snapshots.map((stock, index) => <option key={stock.id} value={stock.id}>
          {index + 1}. {stock.name} · {pantryLocationLabel(stock.location)} · {stock.measure || "Amount unknown"}{stock.useBy ? ` · ${stock.useBy}` : ""}
        </option>)}</select></label>}
        {snapshot && <p>{snapshot.name} · {pantryLocationLabel(snapshot.location)} · {snapshot.measure || "Amount unknown"}{snapshot.useBy ? ` · ${snapshot.useBy}` : ""}</p>}
        {stale && <div role="alert"><p>{current ? "This entry changed while the move was open. Load the current entry before moving it." : "This entry was removed. Close this dialog; it will not be recreated."}</p>
          {current && <button type="button" className="secondary-button" onClick={() => { setSnapshot({ ...current }); setLocation(current.location); setRequested(null); setSubmitError(""); setObservedApplied(false); recorded.current = false; }}>Load current entry</button>}</div>}
        <PantryLocationSelect label="Move to" value={location} onChange={setLocation} disabled={!snapshot || stale || Boolean(requested)} />
        {requested && !stale && <p role="status">Moving entry…</p>}
        {submitError && <p role="alert" className="field-error">{submitError}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={close}>Cancel</button>
          <button className="primary-button" disabled={!snapshot || stale || Boolean(requested) || snapshot.location === location}>Move entry</button></div>
      </>}
    </form>
  </Modal>;
}
