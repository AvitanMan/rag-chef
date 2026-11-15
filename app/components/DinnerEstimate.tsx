import type { PlannedMeal } from "../lib/kitchen-types";
import type { MealReadiness } from "../lib/quantities";

/** The same estimate is shown while comparing and confirming a dinner. */
export function DinnerEstimate({ readiness, meal, reason, frozenCoverage = [] }: {
  readiness: MealReadiness;
  meal?: PlannedMeal;
  reason?: string | null;
  frozenCoverage?: string[];
}) {
  return <div className="recipe-readiness">
    <strong>Pantry amounts for this dinner</strong>
    {meal && <small>{meal.baseServings ? `${meal.servings} servings` : "Yield unknown · 1 recipe batch; servings cannot be scaled"}</small>}
    <p>{readiness.coveredCount} covered · {readiness.partialCount} partial · {readiness.missingCount} missing · {readiness.reviewCount} need review</p>
    {reason && <p className="dinner-ranking-reason">{reason}</p>}
    <small>After reserving stock for other saved dinners this week. Estimates use the selected day and portions.</small>
    {readiness.personalAmountsApplied && <small>Includes personal amounts scaled for this dinner.</small>}
    {frozenCoverage.length > 0 && <p><strong>Includes frozen stock:</strong> {frozenCoverage.join(", ")}. Check preparation before cooking.</p>}
    {readiness.shopping.length > 0 ? <details><summary>Shopping needs ({readiness.shopping.length})</summary>
      <ul>{readiness.shopping.map((item, index) => <li key={index}>
        <strong>{item.name}</strong>: {item.measure}{item.needsReview ? " · review amount" : ""}
        {item.preparationNote && <small>{item.preparationNote}</small>}
        {item.notes?.filter(note => note !== item.preparationNote).map(note => <small key={note}>{note}</small>)}
      </li>)}</ul>
    </details> : readiness.reviewCount === 0 ? <p>Known quantities are covered.</p> : null}
  </div>;
}
