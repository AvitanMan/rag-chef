"use client";

import { useId, useState } from "react";
import type { PersonalRecipeAmounts } from "../lib/kitchen-types";
import type { Recipe } from "../lib/recipe-types";
import { personalAmountInputProblem, personalAmountsMatch } from "../lib/quantities";

function referenceLabel(servings: number | null) {
  return servings ? `${servings} source servings` : "one recipe batch (source yield unknown)";
}

/** Drafts live only in this editor until the complete set passes validation. */
export function PersonalRecipeAmountsEditor({ recipe, contentHash, saved, disabled, save }: {
  recipe: Recipe; contentHash?: string; saved?: PersonalRecipeAmounts; disabled: boolean;
  save: (amounts: PersonalRecipeAmounts | undefined) => void;
}) {
  const matches = personalAmountsMatch(recipe, saved, contentHash);
  const baseline = recipe.ingredients.map((_, index) => matches ? saved!.amounts.find(item => item.ingredientIndex === index)?.measure ?? "" : "");
  const [drafts, setDrafts] = useState(baseline);
  const [notice, setNotice] = useState("");
  const id = useId();
  const problems = drafts.map(personalAmountInputProblem);
  const unavailable = disabled || !contentHash;
  return <section className="personal-amounts" aria-label="Personal amounts">
    <h3>Personal amounts</h3>
    <p>Amounts for {referenceLabel(recipe.servings ?? null)}. Blank fields use source amounts.</p>
    <p className="quantity-note">New dinners scale these to your chosen portions. Saved dinners keep their captured amounts; dinner overrides take priority.</p>
    {matches && <p role="status">Personal amounts saved for this source version.</p>}
    {saved && !matches && <section className="stale-personal-amounts" aria-label="Previous personal amounts">
      <h4>Previous personal amounts · inactive</h4>
      <p>The source version changed or cannot be verified. These amounts will not apply to new dinners. Enter amounts against the current rows and save again.</p>
      <p>Previous reference: {referenceLabel(saved.referenceServings)}.</p>
      <ul className="ingredient-list">{saved.amounts.map(item => <li key={item.ingredientIndex}><strong>{item.originalName}</strong><small>{item.measure}</small></li>)}</ul>
    </section>}
    {!contentHash && <p role="status">Open the current recipe from the recipe collection to edit personal amounts.</p>}
    <form noValidate onSubmit={event => {
      event.preventDefault();
      if (unavailable || problems.some(Boolean)) return;
      const amounts = drafts.flatMap((measure, ingredientIndex) => measure.trim() ? [{ ingredientIndex, originalName: recipe.ingredients[ingredientIndex].name, measure: measure.trim() }] : []);
      save(amounts.length ? { contentHash: contentHash!, referenceServings: recipe.servings ?? null, amounts } : undefined);
      setNotice("Personal amounts saved. Future dinners use these amounts.");
    }}>
      {recipe.ingredients.map((ingredient, index) => <div className="personal-amount-row" key={index}>
        <div><strong>{ingredient.name}</strong><small>Source: {ingredient.measure || "Amount not stated"}</small></div>
        <label>Personal amount<input aria-label={`Personal amount for ${ingredient.name}`} maxLength={160} value={drafts[index]} disabled={unavailable}
          placeholder={ingredient.measure || "e.g. 300 g"} aria-invalid={Boolean(problems[index])} aria-describedby={problems[index] ? `${id}-${index}` : undefined}
          onChange={event => { setDrafts(current => current.map((value, row) => row === index ? event.target.value : value)); setNotice(""); }} />
          {problems[index] && <small className="field-error" id={`${id}-${index}`} role="alert">{problems[index]}</small>}
        </label>
      </div>)}
      <div className="modal-actions">
        <button className="primary-button" disabled={unavailable || problems.some(Boolean)}>Save personal amounts</button>
        <button className="secondary-button" type="button" onClick={() => { setDrafts(baseline); setNotice("Draft cancelled."); }}>Cancel</button>
        <button className="text-button" type="button" disabled={disabled || !saved} onClick={() => { save(undefined); setDrafts(recipe.ingredients.map(() => "")); setNotice("Future dinners use source amounts."); }}>Reset to source amounts</button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </form>
  </section>;
}
