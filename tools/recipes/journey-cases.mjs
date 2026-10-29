// Evaluation contract v2: saved amounts are calculated facts, other factual turns require AI verification.
// Fixed journey expectations. They are not derived from the model's responses.
export const JOURNEY_DATE = "2026-10-26";
export const journeyTitles = { bake: "Zucchini Pasta Bake", soup: "Red Lentil Soup" };
const pantry = [
  { id: "pasta", name: "pasta", measure: "500 g" },
  { id: "zucchini", name: "zucchini", measure: "3" },
  { id: "cheese", name: "cheese", measure: "300 g" },
  { id: "leftovers", name: "cooked pasta", measure: "900 g" },
];
const bake = { first: "bake", only: "bake", minRecommendations: 1, readiness: { coveredCount: 3, partialCount: 0, missingCount: 3, reviewCount: 3 } };
const oven = { only: "bake", factual: true, evidence: ["S8"], answerPatterns: ["(?:200\\s*°?\\s*(?:c\\b|celsius)|400\\s*°?\\s*(?:f\\b|fahrenheit))", "(?:30|thirty)\\s*(?:minutes?|mins?)"] };
const excluded = { outcome: "constraints_unsatisfied", status: "unsupported", emptyRecipes: true, generation: "catalog_fallback" };
export const journeyCases = [
  { id: "natural-discovery", title: "Ask ordinary dinner questions, choose an ingredient, then discuss the source", pantry, steps: [
    { id: "default-dinner", query: "What can I cook with what I have?", expect: { minRecommendations: 1, maxRecommendations: 3 } },
    { id: "ingredient-question", query: "What can I cook with lentils?", clearHistory: true, expect: { first: "soup", only: "soup", minRecommendations: 1, maxRecommendations: 1 } },
    { id: "source-follow-up", query: "How long should I simmer it, and what should the lentils feel like?", previous: true, expect: { only: "soup", factual: true, evidence: ["S3"], answerPatterns: ["20\\s*(?:–|—|-|to)\\s*30\\s*(?:minutes?|mins?)", "soft|tender"] } },
  ] },
  { id: "pantry-plan-cook", title: "Use ordinary pantry names, choose dinner, change portions, and ask during cooking", pantry, steps: [
    { id: "find-dinner", query: "Recommend Zucchini Pasta Bake for tonight.", expect: bake },
    { id: "follow-up", query: "How hot should the oven be, and how long do I bake it?", previous: true, expect: oven },
    { id: "save-dinner", action: "plan", recipe: "bake", servings: 2, overrides: { "3": "80 ml" } },
    { id: "final-amounts", query: "How much pasta and milk do I need for this saved dinner?", savedMeal: true, expect: { only: "bake", calculated: [{ ingredientIndex: 0, measure: "200 g", basis: "source_scaled" }, { ingredientIndex: 3, measure: "80 ml", basis: "saved_override" }], maxRecommendations: 0, answerPatterns: ["200\\s*(?:g\\b|grams?)", "80\\s*(?:ml\\b|millilit)"], servings: 2 } },
    { id: "cooking-help", query: "Does this step specify how many minutes to boil the pasta?", savedMeal: true, purpose: "cooking", stepEvidenceId: "S1", expect: { only: "bake", factual: true, evidence: ["S1"], answerPatterns: ["packag"], forbiddenAnswerPatterns: ["\\b\\d+\\s*(?:minutes?|mins?)\\b"] } },
  ] },
  { id: "saved-preferences", title: "Change saved preferences without allowing an excluded recipe back in", pantry, steps: [
    { id: "milk-allergy", query: "Recommend Zucchini Pasta Bake.", profile: { allergies: ["milk"] }, expect: excluded },
    { id: "vegan-choice", query: "Recommend Red Lentil Soup.", profile: { allergies: ["peanut", "milk"], diet: "Vegan" }, clearHistory: true, expect: { first: "soup", only: "soup", minRecommendations: 1 } },
  ] },
  { id: "conflicting-request", title: "A requested adaptation cannot override saved exclusions or unavailable equipment", pantry, steps: [
    { id: "no-oven", query: "Recommend Zucchini Pasta Bake without an oven.", profile: { equipment: ["Stovetop"] }, expect: excluded },
    { id: "allergy-beats-adaptation", query: "Make Zucchini Pasta Bake dairy-free.", profile: { allergies: ["milk"], equipment: ["Oven", "Stovetop"] }, expect: excluded },
  ] },
  { id: "uncertain-stock", title: "Unknown amounts and cooked leftovers are not uncooked pantry coverage", pantry: [
    { id: "pasta", name: "pasta", measure: "some" }, { id: "leftovers", name: "cooked pasta", measure: "900 g" },
    { id: "zucchini", name: "zucchini", measure: "0" }, { id: "cheese", name: "cheese", measure: "300 g" },
  ], steps: [
    { id: "unknown-is-not-enough", query: "Recommend Zucchini Pasta Bake.", expect: { first: "bake", only: "bake", minRecommendations: 1, readiness: { coveredCount: 1, partialCount: 0, missingCount: 5, reviewCount: 3 }, shopping: [{ name: "any small pasta", measure: "400 g", needsReview: true }] } },
    { id: "measure-stock", action: "pantry", patch: { id: "pasta", measure: "200 g" } },
    { id: "partial-is-not-enough", query: "Recommend Zucchini Pasta Bake again with my updated pantry.", expect: { first: "bake", only: "bake", minRecommendations: 1, readiness: { coveredCount: 1, partialCount: 1, missingCount: 4, reviewCount: 3 }, shopping: [{ name: "any small pasta", measure: "200 g", needsReview: true }] } },
  ] },
  { id: "source-gaps", title: "Ask missing facts, then correct a mistaken cooking detail", pantry, steps: [
    { id: "total-time", query: "What is the total recipe time from start to finish?", focus: "bake", expect: { only: "bake", status: "unsupported", generation: "catalog_fallback", maxRecommendations: 0 } },
    { id: "nutrition", query: "How many calories are in one serving?", focus: "bake", expect: { only: "bake", status: "unsupported", maxRecommendations: 0, forbiddenAnswerPatterns: ["\\b\\d+\\s*(?:kcal|calories?)\\b"] } },
    { id: "mistaken-temperature", query: "I thought it baked at 250°C for 5 minutes. What does the source actually say?", focus: "bake", expect: oven },
  ] },
  { id: "choose-and-switch", title: "Clarify an ambiguous follow-up, then switch to a different recipe", pantry, steps: [
    { id: "several-choices", query: "Suggest three different vegetarian dinners for tonight.", profile: { diet: "Vegetarian" }, expect: { minRecommendations: 2, maxRecommendations: 3 } },
    { id: "ambiguous-it", query: "How long does it take?", previous: true, requiresMultipleChoices: true, expect: { status: "needs_clarification", generation: "catalog_fallback" } },
    { id: "switch-to-soup", query: "How long should I simmer it, and what should the lentils feel like?", focus: "soup", expect: { only: "soup", factual: true, evidence: ["S3"], answerPatterns: ["20\\s*(?:–|—|-|to)\\s*30\\s*(?:minutes?|mins?)", "soft|tender"] } },
  ] },
  { id: "stale-context", title: "Reject stale kitchen and dinner context, then recover with the current dinner", pantry, steps: [
    { id: "save-dinner", action: "plan", recipe: "bake", servings: 4, checkpoint: true },
    { id: "edit-portions", action: "meal", servings: 2 },
    { id: "old-kitchen", query: "How hot should the oven be?", savedMeal: true, stale: "revision", expect: { httpStatus: 409, errorCode: "kitchen_changed" } },
    { id: "old-dinner", query: "How hot should the oven be?", savedMeal: true, stale: "meal", expect: { httpStatus: 409, errorCode: "context_changed" } },
    { id: "fresh-retry", query: "How hot should the oven be, and how long do I bake it?", savedMeal: true, expect: { ...oven, servings: 2 } },
  ] },
  { id: "stock-reservations", title: "Respect other saved dinners and expiry dates while previewing another day", pantry: pantry.map(row => row.id === "pasta" ? { ...row, useBy: JOURNEY_DATE } : row), steps: [
    { id: "reserve-tonight", action: "plan", recipe: "bake", servings: 4 },
    { id: "tomorrow", query: "Recommend Zucchini Pasta Bake for tomorrow.", targetDate: "2026-10-27", expect: { first: "bake", only: "bake", minRecommendations: 1, readiness: { coveredCount: 0, partialCount: 1, missingCount: 5, reviewCount: 3 }, shopping: [{ name: "any small pasta", measure: "400 g", needsReview: true }, { name: "cheese, grated", measure: "200 g", needsReview: false }] } },
    { id: "replace-tonight", query: "Recommend Zucchini Pasta Bake for tonight instead.", targetDate: JOURNEY_DATE, expect: bake },
  ] },
];
