"use client";

import { useEffect, useId, useRef } from "react";
import type { PantryPick } from "../lib/pantry-dinner";

/** The selected identities stay visible even when their pantry entry becomes unavailable. */
export function PantrySelectionChips({ picks, remove, clear }: { picks: PantryPick[]; remove: (key: string) => void; clear?: () => void }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<{ key: string; index: number } | null>(null);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || picks.some(pick => pick.key === pending.key)) return;
    pendingFocus.current = null;
    const target = picks[Math.min(pending.index, picks.length - 1)];
    (target ? buttons.current.get(target.key) : heading.current)?.focus({ preventScroll: true });
  }, [picks]);
  return <section className="pantry-selection-chips" aria-labelledby={`${id}-heading`}>
    <div className="pantry-picks-heading"><h3 ref={heading} id={`${id}-heading`} tabIndex={-1}>Your picks</h3>
      {picks.length > 0 && clear && <button className="text-button" type="button" onClick={clear}>Clear selection</button>}
    </div>
    {picks.length ? <ul>{picks.map((pick, index) => <li key={pick.key}>
      <button type="button" ref={element => { if (element) buttons.current.set(pick.key, element); else buttons.current.delete(pick.key); }}
        className={pick.available ? "pantry-pick-chip" : "pantry-pick-chip pantry-pick-unavailable"}
        aria-label={`Remove ${pick.name} from picks`} aria-describedby={!pick.available ? `${id}-unavailable-${index}` : undefined}
        onClick={() => { pendingFocus.current = { key: pick.key, index }; remove(pick.key); }}>
        <span>{pick.name}{!pick.available && <small id={`${id}-unavailable-${index}`}>Unavailable</small>}</span><span aria-hidden="true">×</span>
      </button>
    </li>)}</ul> : <p>No ingredients picked yet.</p>}
  </section>;
}
