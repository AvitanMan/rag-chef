"use client";

import { useState, type ReactNode } from "react";
import type { PantryDinnerMatch, PantryPick } from "../lib/pantry-dinner";
import { isBasicSeasoning } from "../lib/pantry-recipe-fit";
import { PantrySelectionChips } from "./PantrySelectionChips";

export function PantryDinnerResults({ picks, matches, removePick, catalogState, setup, change, browse, retry, renderCard, context, title = "Dinner ideas for tonight" }: {
  picks: PantryPick[];
  matches: PantryDinnerMatch[];
  removePick: (key: string) => void;
  catalogState: "loading" | "ready" | "error";
  setup?: ReactNode;
  change: () => void;
  browse: () => void;
  retry: () => void;
  renderCard: (match: PantryDinnerMatch) => ReactNode;
  context?: ReactNode;
  title?: string;
}) {
  const selection = JSON.stringify(picks.map(pick => pick.key));
  const [page, setPage] = useState({ selection, limit: 3 });
  const limit = page.selection === selection ? page.limit : 3;
  const hasFood = picks.some(pick => pick.available && !isBasicSeasoning(pick.key));
  const unavailable = picks.some(pick => !pick.available);
  return <section className="recipe-section pantry-dinner-results" aria-label={title}>
    <div className="pantry-dinner-header">
      {context}
      <PantrySelectionChips picks={picks} remove={removePick} />
      {unavailable && <p role="status">Some picks are no longer available. Suggestions use your remaining available food.</p>}
      <div className="pantry-dinner-actions">
        <button className="secondary-button" onClick={change}>{hasFood && matches.length ? "Change ingredients" : "Choose other ingredients"}</button>
        {catalogState === "ready" && !setup && !matches.length && <button className="text-button" onClick={browse}>Browse dinners</button>}
      </div>
      {!hasFood ? <p role="status">{picks.some(pick => pick.available) ? "Choose a food ingredient to find dinner ideas. Salt, oil and other basics can support a meal." : "Choose available ingredients from your pantry to find dinner ideas."}</p>
        : catalogState === "loading" ? <p role="status">Looking through your recipes…</p>
        : catalogState === "error" ? <p role="alert">Recipes could not load. <button className="text-button" onClick={retry}>Retry recipes</button></p>
        : setup ? null
        : matches.length ? null
        : <div className="empty-state"><strong>No dinners use these picks with your saved requirements.</strong><p>Choose other ingredients or browse your dinners.</p></div>}
    </div>
    {catalogState === "ready" && setup}
    {hasFood && catalogState === "ready" && <div className="recipe-grid">{matches.slice(0, limit).map(match => <div key={match.recipe.id}>{renderCard(match)}</div>)}</div>}
    {hasFood && catalogState === "ready" && matches.length > limit && <button className="secondary-button" onClick={() => setPage({ selection, limit: limit + 3 })}>Show more dinners</button>}
  </section>;
}
