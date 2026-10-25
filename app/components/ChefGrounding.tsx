import type { ChefApiResponse } from "../lib/chef-schema";
import type { Recipe } from "../lib/recipe-types";

type GroundingResult = Pick<ChefApiResponse, "recipes" | "citations" | "sourceFacts" | "generation" | "chefChanges">
  & { retrieval?: Partial<ChefApiResponse["retrieval"]>; requestQuery?: string; selectedEvidenceByRecipeId?: ChefApiResponse["selectedEvidenceByRecipeId"]; resolvedContext?: ChefApiResponse["resolvedContext"]; answerStatus?: ChefApiResponse["answerStatus"] };

/** Display completed retrieval and canonical source text, never simulated progress. */
export function ChefGrounding({ result, openRecipe }: { result: GroundingResult; openRecipe: (recipe: Recipe) => void }) {
  const retrieval = result.retrieval;
  const hasMatches = result.recipes.length > 0;
  const semantic = retrieval?.method === "precomputed_embeddings" && retrieval.ranked?.some((item) => typeof item.semanticScore === "number" && Number.isFinite(item.semanticScore));
  const method = result.resolvedContext?.recipeId ? "Selected recipe · Source lookup" : semantic ? "Meaning, keywords and pantry" : retrieval?.method === "lexical_pantry" || retrieval?.method === "precomputed_embeddings"
    ? "Keywords and pantry" : retrieval?.method === "catalog_order" ? "Catalog browsing" : "Catalog checked";
  const citations = [...result.citations, ...result.recipes.filter((recipe) => recipe.id === result.resolvedContext?.recipeId && !result.citations.some((citation) => citation.recipeId === recipe.id))
    .map((recipe) => ({ recipeId: recipe.id, title: recipe.title, sourceName: recipe.source.name, sourceUrl: recipe.sourceUrl }))];
  const sources = citations.flatMap((citation) => {
    const recipe = result.recipes.find((item) => item.id === citation.recipeId);
    return recipe ? [{ citation, recipe, facts: result.sourceFacts.filter((fact) => fact.recipeId === recipe.id) }] : [];
  });
  return <section className="chef-grounding" aria-label="How Chef found this">
    <div className="section-heading compact"><h3>How Chef found this</h3><span className="grounding-label">RAG · Recipes first</span></div>
    {result.requestQuery && <p className="grounding-request" title={result.requestQuery}>For your request: {result.requestQuery.length > 160 ? `${result.requestQuery.slice(0, 160)}…` : result.requestQuery}</p>}
    <ol className="grounding-steps">
      <li><span aria-hidden="true">1</span><div><strong>{result.resolvedContext?.recipeId ? "Use the selected source" : "Search real recipes"}</strong><p>{result.resolvedContext?.recipeId ? "Pinned recipe verified in approved collection" : retrieval?.catalogCount !== undefined ? `${retrieval.catalogCount} approved recipes checked` : "Approved recipe collection"}</p><small>{method}</small></div></li>
      <li><span aria-hidden="true">2</span><div><strong>Match your kitchen</strong><p>{result.recipes.length} source {result.recipes.length === 1 ? "recipe retrieved" : "recipes retrieved"}</p><small>{retrieval?.constraintExcludedCount ? `${retrieval.constraintExcludedCount} excluded by your requirements` : "Requirements applied before ranking"}</small></div></li>
      <li><span aria-hidden="true">3</span><div><strong>{result.answerStatus === "needs_clarification" ? "Clarify the question" : result.answerStatus === "unsupported" && hasMatches ? "Stay within the source" : result.generation === "ai" ? "Answer with sources" : hasMatches ? "Use catalog results" : "Stop without guessing"}</strong><p>{result.answerStatus === "needs_clarification" ? "Select a recipe or clarify the question" : result.answerStatus === "unsupported" && hasMatches ? "Source material available · Question unsupported" : result.generation === "ai" ? "AI answer from retrieved recipes" : hasMatches ? "Catalog fallback · No AI answer used" : "No supported match · No AI answer used"}</p><small>{result.chefChanges.length ? "Proposed changes are labeled separately" : "Original recipes stay unchanged"}</small></div></li>
    </ol>
    {sources.length > 0 && <div className="grounding-sources">
      <h4>Recipe evidence <span>({sources.length} {sources.length === 1 ? "source" : "sources"})</span></h4>
      <p className="quantity-note">{result.answerStatus === "unsupported" ? "The recipe record is available, but it does not establish the requested answer." : "Read the original recipe behind a suggestion. Proposed changes are separate from these excerpts."}</p>
      <div className="grounding-source-grid">{sources.map(({ citation, recipe, facts }) => {
        const selectedIds = result.selectedEvidenceByRecipeId?.[recipe.id] ?? [];
        const preferred = result.resolvedContext?.stepEvidenceId ?? selectedIds.find((id) => id.startsWith("S")) ?? selectedIds[0] ?? "I1";
        const sourceIndex = Number(preferred.slice(1)) - 1;
        const ingredient = recipe.ingredients[sourceIndex];
        const selectedText = preferred.startsWith("S") ? recipe.instructions[sourceIndex] : ingredient && [ingredient.measure, ingredient.name].filter(Boolean).join(" ");
        const excerpt = facts[0]?.fact ?? (result.answerStatus === "unsupported" ? "" : selectedText ?? "");
        return <article className="grounding-source" key={recipe.id}>
          <button className="text-button evidence-recipe" aria-label={`Open evidence for ${recipe.title}`} onClick={() => openRecipe(recipe)}>{recipe.title} <span aria-hidden="true">↗</span></button>
          {excerpt && <><small className="evidence-kind">{facts.length ? "Cited recipe excerpt" : "Retrieved recipe excerpt"}</small><blockquote>{excerpt}</blockquote></>}
          {facts.length > 1 && <details><summary>More excerpts ({facts.length - 1})</summary>{facts.slice(1).map((fact, index) => <blockquote key={`${fact.evidenceId}-${index}`}>{fact.fact}</blockquote>)}</details>}
          <a href={citation.sourceUrl} target={citation.sourceUrl.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{citation.sourceName} · Original source <span aria-hidden="true">↗</span></a>
        </article>;
      })}</div>
    </div>}
  </section>;
}
