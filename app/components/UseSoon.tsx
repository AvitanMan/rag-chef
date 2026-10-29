"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PantryStock } from "../lib/kitchen-types";
import type { PantryFilter, rankUseSoonDinners } from "../lib/use-soon";
import { parseMeasure } from "../lib/quantities";
import { dateLabel } from "./WeeklyKitchenViews";

export function UseSoonSummary({ items, pastCount, select, review }: {
  items: PantryStock[]; pastCount: number; select: (id: string) => void; review: (filter: PantryFilter, id?: string) => void;
}) {
  return <section className="panel use-soon-panel" aria-label="Use soon">
    <div className="section-heading"><h2>Use soon</h2><button className="text-button" onClick={() => review("soon")}>Review pantry</button></div>
    <p>Pick food dated within the next three days to find dinner ideas.</p>
    {items.length ? <ul className="use-soon-items">{items.slice(0, 5).map(item => <li key={item.id}>
      <button className="secondary-button" onClick={() => select(item.id)} aria-label={`Find dinners using ${item.name}`}>
        <strong>{item.name}</strong><span>{item.measure || "Amount unknown"}{item.measure && !parseMeasure(item.measure) ? " · Amount unknown" : ""} · Use by {dateLabel(item.useBy!)}</span>
      </button>
    </li>)}</ul> : <p>No food with an entered date is due in the next three days.</p>}
    {items.length > 5 && <button className="text-button" onClick={() => review("soon")}>Review all {items.length} items</button>}
    {pastCount > 0 && <button className="text-button" onClick={() => review("past")}>Past entered date: {pastCount} · Review</button>}
  </section>;
}

export function UseSoonResults({ result, renderCard, clear, review, browse, catalogState, retry }: {
  result: ReturnType<typeof rankUseSoonDinners>;
  renderCard: (candidate: ReturnType<typeof rankUseSoonDinners>["candidates"][number]) => ReactNode;
  clear: () => void; review: () => void; browse: () => void;
  catalogState: "loading" | "ready" | "error"; retry: () => void;
}) {
  const [limit, setLimit] = useState(3);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { heading.current?.scrollIntoView({ block: "center" }); heading.current?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, []);
  if (!result.selected) return null;
  return <section className="use-soon-results" aria-label={`Dinners using ${result.selected.name}`}>
    <div className="panel"><h2 ref={heading} tabIndex={-1}>Dinners using {result.selected.name}</h2>
      <p>Use by {dateLabel(result.selected.useBy!)} · {result.stock?.measure || "Amount unknown"} remaining after other saved dinners in this week.</p>
      <div className="modal-actions"><button className="secondary-button" onClick={clear}>Choose another ingredient</button><button className="text-button" onClick={review}>Review this item</button><button className="text-button" onClick={browse}>Browse all recipes</button></div>
      {result.status === "reserved" && <p role="status">This stock is fully reserved for other saved dinners. Review your plan or choose another ingredient.</p>}
      {result.status === "past_dinner" && <p role="status">This item’s entered use-by date is before the selected dinner day. Choose an earlier day or another ingredient.</p>}
      {catalogState === "loading" && <p role="status">Loading recipe collection…</p>}
      {catalogState === "error" && <p role="alert">Could not load the recipe collection. <button className="text-button" onClick={retry}>Retry collection</button></p>}
      {catalogState === "ready" && result.status === "ready" && !result.candidates.length && <p role="status">No matching recipes meet your saved requirements. Choose another ingredient or browse your collection.</p>}
    </div>
    {catalogState === "ready" && <div className="recipe-grid">{result.candidates.slice(0, limit).map(candidate => <div className="use-soon-candidate" key={candidate.recipe.id}>
      <p className="quantity-note">{candidate.usedMeasure ? `Estimated use from this pantry item: ${candidate.usedMeasure}.` : `Contains ${result.selected!.name} · Check amount; no use from this pantry item can be confirmed.`}</p>
      {renderCard(candidate)}
    </div>)}</div>}
    {catalogState === "ready" && result.candidates.length > limit && <button className="secondary-button" onClick={() => setLimit(value => value + 3)}>Show more dinners</button>}
  </section>;
}
