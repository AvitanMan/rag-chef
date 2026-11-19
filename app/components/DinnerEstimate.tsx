import type { ReactNode } from "react";
import type { PlannedMeal } from "../lib/kitchen-types";
import type { MealReadiness } from "../lib/quantities";

/** Comparison and confirmation both show the estimate captured for this dinner. */
export function DinnerEstimate({ readiness, meal, reason, frozenCoverage = [], compact, choice, children }: {
  readiness: MealReadiness;
  meal?: PlannedMeal;
  reason?: string | null;
  frozenCoverage?: string[];
  compact?: boolean;
  choice?: ReactNode;
  children?: ReactNode;
}) {
  const shortages = readiness.shopping;
  const frozenNote = frozenCoverage.length > 0 && <p><strong>Includes frozen stock:</strong> {frozenCoverage.join(", ")}. Check preparation before cooking.</p>;
  const counts = <p>{readiness.coveredCount} covered · {readiness.partialCount} partial · {readiness.missingCount} missing · {readiness.reviewCount} need review</p>;
  const basis = <>
    {meal && <small>{meal.baseServings ? `${meal.servings} servings` : "Yield unknown · 1 recipe batch; servings cannot be scaled"}</small>}
    {counts}
    {reason && <p className="dinner-ranking-reason">{reason}</p>}
    <small>After reserving stock for other saved dinners this week. Estimates use the selected day and portions.</small>
    {readiness.personalAmountsApplied && <small>Includes personal amounts scaled for this dinner.</small>}
  </>;
  const rows = shortages.length > 0 && <ul>{shortages.map((item, index) => <li key={index}>
    <strong>{item.name}</strong>: {item.measure}{item.needsReview ? " · review amount" : ""}
    {item.preparationNote && <small>{item.preparationNote}</small>}
    {item.notes?.filter(note => note !== item.preparationNote).map(note => <small key={note}>{note}</small>)}
  </li>)}</ul>;
  const covered = !shortages.length && !readiness.reviewCount && readiness.coveredCount > 0;

  if (compact) {
    const confirmed = shortages.filter(item => !item.needsReview);
    const review = shortages.filter(item => item.needsReview);
    const reviewAmount = [...new Set(review.map(item => item.name))];
    const reviewPreparation = [...new Set(review.flatMap(item => item.preparationNote ? [item.preparationNote] : []))];
    const first = confirmed[0];
    return <div className="recipe-readiness compact-estimate">
      <p className="estimate-outcome">{first ? `Needs ${first.measure} more ${first.name}`
        : covered ? "Known quantities are covered." : review.length || readiness.reviewCount ? "Check the amounts for this dinner" : "No measured estimate available."}
        {confirmed.length > 1 && <small>Plus {confirmed.length - 1} other {confirmed.length === 2 ? "shortage" : "shortages"}.</small>}
      </p>
      {reviewAmount.length > 0 && <p>Review amount: {reviewAmount.join(", ")}.</p>}
      {readiness.reviewCount > 0 && !review.length && <p>{readiness.reviewCount} {readiness.reviewCount === 1 ? "amount needs" : "amounts need"} review.</p>}
      {reviewPreparation.map(note => <p key={note}>{note}</p>)}
      {frozenNote}
      {meal && !meal.baseServings && <p>Yield unknown · one recipe batch</p>}
      {choice}
      <details><summary>Shopping needs ({shortages.length})</summary>
        <strong>Pantry amounts for this dinner</strong>{basis}{rows}{children}
      </details>
    </div>;
  }
  return <div className="recipe-readiness">
    <strong>Pantry amounts for this dinner</strong>{basis}{frozenNote}
    {shortages.length > 0 ? <details><summary>Shopping needs ({shortages.length})</summary>{rows}</details>
      : covered ? <p>Known quantities are covered.</p> : null}
  </div>;
}
