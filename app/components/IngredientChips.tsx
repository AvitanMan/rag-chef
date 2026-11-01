"use client";

import { useRef, useState } from "react";

type Chip = { id: number; value: string };
export function IngredientChips({ label, values, onChange }: { label: string; values: string[]; onChange: (values: string[]) => void }) {
  const sequence = useRef(values.length);
  const signature = JSON.stringify(values);
  const [state, setState] = useState(() => ({ source: signature, chips: values.map((value, id) => ({ id, value })) }));
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  if (state.source !== signature) {
    setState({ source: signature, chips: values.map((value, index) => state.chips.find((chip) => chip.value === value) ?? { id: Math.min(-1, ...state.chips.map((chip) => chip.id)) - index - 1, value }) });
  }
  function withDraft(text = draft): Chip[] {
    const additions = text.split(/[,;\n]/).map((value) => value.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean);
    if (!additions.length) return state.chips;
    const inserted = additions.map((value, index) => ({ id: editing !== null && index === 0 ? editing : sequence.current++, value }));
    const index = state.chips.findIndex((chip) => chip.id === editing);
    if (index < 0) return [...state.chips, ...inserted];
    return [...state.chips.slice(0, index), ...inserted, ...state.chips.slice(index + 1)];
  }
  function publish(chips: Chip[]) {
    const seen = new Set<string>();
    const unique = chips.filter((chip) => { if (seen.has(chip.value)) return false; seen.add(chip.value); return true; });
    const values = unique.map((chip) => chip.value);
    setState({ source: JSON.stringify(values), chips: unique });
    onChange(values);
  }
  function commit() { publish(withDraft()); setDraft(""); setEditing(null); }
  function commitText(text: string) { publish(withDraft(text)); setDraft(""); setEditing(null); }

  return <div className="wide ingredient-field" onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) commit(); }}>
    <label>{label}<input ref={input} value={draft} placeholder={editing === null ? "Type an ingredient, then Enter or comma" : "Edit ingredient"}
      onChange={(event) => { const text = event.target.value; if (/[,;\n]$/.test(text)) commitText(text); else setDraft(text); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (event.key === "Escape") { event.preventDefault(); setDraft(""); setEditing(null); }
      }} /></label>
    <ul className="preference-chips" aria-label={`Saved ${label.toLowerCase()}`}>
      {state.chips.map((chip) => <li key={chip.id}>
        <button type="button" data-chip-action onPointerDown={(event) => event.preventDefault()} aria-label={`Edit ${label.toLowerCase()} ${chip.value}`} onClick={() => {
          const next = withDraft(); publish(next);
          const target = next.find((item) => item.id === chip.id);
          setEditing(target?.id ?? null); setDraft(target?.value ?? ""); input.current?.focus();
        }}>{chip.value}</button>
        <button type="button" data-chip-action onPointerDown={(event) => event.preventDefault()} aria-label={`Remove ${label.toLowerCase()} ${chip.value}`} onClick={() => {
          publish((editing === chip.id ? state.chips : withDraft()).filter((item) => item.id !== chip.id));
          setDraft(""); setEditing(null); input.current?.focus();
        }}>×</button>
      </li>)}
    </ul>
    <small>Enter or comma saves an ingredient. Select a chip to edit it; × removes it.{label === "Allergies" && " Ambiguous matches still receive a warning."}</small>
  </div>;
}
