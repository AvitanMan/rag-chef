import type { Recipe } from "./recipe-types";
import { recipeEvidence, selectQuestionEvidence } from "./chef-context";
import { bm25Scores, reciprocalRanks } from "./retrieval-ranking";
import { cosineSimilarity, isValidEmbeddingVector } from "./recipe-embeddings";

export type EvidenceSelection = {
  items: Array<{ evidenceId: string; text: string }>;
  coreStepIds: string[];
  method: "semantic_steps" | "lexical_steps" | "full_recipe";
  complete: boolean;
  indexedSteps: number;
  totalSteps: number;
};
export function selectRecipeEvidence(recipe: Recipe, query: string, options: { stepId?: string; vectors?: Map<number, number[]>; queryVector?: number[] | null; budget?: number; full?: boolean } = {}): EvidenceSelection {
  const all = recipeEvidence(recipe), budget = Math.max(0, options.budget ?? 16_000);
  const vectors = new Map([...(options.vectors ?? [])].filter(([index, vector]) => recipe.instructions[index] !== undefined && isValidEmbeddingVector(vector, options.queryVector?.length)));
  const semantic = Boolean(options.queryVector && vectors.size);
  const totalSize = all.reduce((sum, item) => sum + item.text.length, 0);
  const full = options.full || all.length <= 12 || !options.stepId && /\b(?:full|complete|all)\s+(?:directions|instructions|method)|\bhow\b.*\b(?:make|cook|prepare)\b/i.test(query);
  if (full && totalSize <= budget) return { items: all, coreStepIds: recipe.instructions.map((_, index) => `S${index + 1}`).slice(0, 6), method: "full_recipe", complete: true, indexedSteps: vectors.size, totalSteps: recipe.instructions.length };
  const legacy = selectQuestionEvidence(recipe, query, options.stepId);
  const hinted = new Set(legacy.length < all.length ? legacy.map((item) => item.evidenceId) : []);
  const scores = bm25Scores(recipe.instructions.map((text, index) => ({ id: `S${index + 1}`, title: "", ingredients: "", other: text })), query);
  const lexical = recipe.instructions.map((_, index) => `S${index + 1}`).filter((id) => (scores.get(id) ?? 0) > 0 || hinted.has(id))
    .sort((a, b) => (scores.get(b) ?? 0) + Number(hinted.has(b)) - (scores.get(a) ?? 0) - Number(hinted.has(a)) || Number(a.slice(1)) - Number(b.slice(1)));
  const meaning = semantic ? [...vectors].map(([index, vector]) => ({ id: `S${index + 1}`, score: cosineSimilarity(vector, options.queryVector!) }))
    .sort((a, b) => b.score - a.score || Number(a.id.slice(1)) - Number(b.id.slice(1))).map((item) => item.id) : [];
  const fused = reciprocalRanks([lexical, meaning]);
  const core = [...fused].sort((a, b) => b[1] - a[1] || Number(a[0].slice(1)) - Number(b[0].slice(1))).slice(0, 6).map(([id]) => id);
  const priority: string[] = [];
  const neighbors = (id: string) => {
    const index = Number(id.slice(1));
    for (const value of [index, index - 1, index + 1]) if (recipe.instructions[value - 1]) priority.push(`S${value}`);
  };
  if (options.stepId) neighbors(options.stepId);
  const explicit = query.match(/\b(?:step|direction|instruction)\s*#?\s*(\d{1,3})\b/i);
  if (explicit) neighbors(`S${Number(explicit[1])}`);
  const ingredientScores = bm25Scores(recipe.ingredients.map((item, index) => ({ id: `I${index + 1}`, title: item.name, ingredients: "", other: "" })), query);
  priority.push(...[...ingredientScores].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]).map(([id]) => id));
  for (const id of core) neighbors(id);
  if (!core.length && !options.stepId && totalSize <= budget) return { items: all, coreStepIds: [], method: "full_recipe", complete: true, indexedSteps: vectors.size, totalSteps: recipe.instructions.length };
  priority.push(...all.map((item) => item.evidenceId).filter((id) => id.startsWith("I")));
  if (full || !core.length) priority.push(...all.map((item) => item.evidenceId));
  const byId = new Map(all.map((item) => [item.evidenceId, item]));
  const selected = new Set<string>(); let size = 0;
  for (const id of priority) {
    const item = byId.get(id);
    if (!item || selected.has(id) || size + item.text.length > budget) continue;
    selected.add(id); size += item.text.length;
  }
  return { items: all.filter((item) => selected.has(item.evidenceId)), coreStepIds: core.filter((id) => selected.has(id)), method: semantic ? "semantic_steps" : "lexical_steps", complete: selected.size === all.length, indexedSteps: vectors.size, totalSteps: recipe.instructions.length };
}
