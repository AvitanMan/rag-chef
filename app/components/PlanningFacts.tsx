import type { ChefApiResponse } from "../lib/chef-schema";

export function PlanningFacts({ result }: { result: Pick<ChefApiResponse, "planningFacts" | "resolvedContext"> }) {
  const context = result.resolvedContext;
  return <section className="planning-facts" aria-label="Your dinner amounts">
    <h4>Your dinner amounts</h4>
    <p className="quantity-note">{context?.servings ? `${context.servings} servings` : `${context?.batches ?? 1} recipe batches`} · Calculated from your saved dinner</p>
    {Boolean(result.planningFacts?.length) && <ul className="ingredient-list">{result.planningFacts!.map(fact => <li key={`${fact.recipeId}-${fact.ingredientIndex}`}>
      <strong>{fact.name}</strong><span>{fact.needsReview ? "Amount needs review" : fact.measure}<small>{fact.basis === "saved_override" ? "Saved amount override" : "Scaled from original recipe"}{fact.needsReview && fact.measure ? ` · Saved wording: ${fact.measure}` : ""}</small></span>
    </li>)}</ul>}
    <p className="quantity-note">Original source quantities and directions stay unchanged. Read the source excerpts separately below.</p>
  </section>;
}
