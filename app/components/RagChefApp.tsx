"use client";

/* eslint-disable @next/next/no-img-element -- Recipe images come from source adapters with dynamic hostnames. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Recipe, RecipeMetadata, RecipeMetadataMap } from "../lib/recipe-types";
import { evaluateRecipeConstraints, normalizeConstraints } from "../lib/recipe-constraints";
import { availablePantryNames } from "../lib/kitchen-stock";
import { parseKitchenBackup, serializeKitchenBackup } from "../lib/kitchen-backup";
import { ThemeToggle } from "./ThemeToggle";
import { ValidatedInput } from "./ValidatedInput";
import { PantryImportPreview } from "./PantryImportPreview";
import { constraintsForRecipeQuery } from "../lib/recipe-query";
import { measureInputProblem } from "../lib/kitchen-validation";
import { IngredientChips } from "./IngredientChips";
import { Modal } from "./Modal";
import { parsePantryInput, pantryInputProblem, type PantryInputRow } from "../lib/pantry-input";
import { CookingWorkspace } from "./CookingWorkspace";
import { PurchasePreview } from "./PurchasePreview";
import { applyBoughtItems, purchasePreviewProblem, purchaseUndoProblem, shoppingForWeek, unappliedBoughtItems, undoPurchase, type PurchaseDraft } from "../lib/shopping-purchases";
import { PlanningFacts } from "./PlanningFacts";
import { ChefGrounding, recipeEvidenceExcerpt } from "./ChefGrounding";
import { chefMealHash, chefMealPreview, chefRecipeHash, cookingSourceStep } from "../lib/chef-context";
import type { ChefDinnerContext, ChefApiResponse } from "../lib/chef-schema";
import { MAX_CHEF_REFINEMENT_LENGTH } from "../lib/chef-schema";
import { COOKING_SESSION_KEY, canCompleteCookingSession, createCookingSession, parseCookingSession, plannedDinnerFingerprint, type CookingSession } from "../lib/cooking-session";
import { useKitchen } from "../lib/use-kitchen";
import { mealScale, type KitchenState, type PantryStock, type PlannedMeal } from "../lib/kitchen-types";
import { addDateDays, createPlannedMeal, dinnerSelectionStatus, LEGACY_STORAGE_KEY, localDate, placePlannedDinner, weekStart } from "../lib/kitchen-state";
import { fillEmptyDays, planningRandom } from "../lib/kitchen-planning";
import { canonicalIngredient, completeMeal, consumptionPreview, parseMeasure, resolvedMealIngredients, undoMeal } from "../lib/quantities";
import { dateLabel, DinnerAmounts, DurablePlanView, DurableShoppingView, PlanPicker } from "./WeeklyKitchenViews";
import { browseRecipes, recipeCompleteness, recipePantryDetails as pantryDetails, RECIPE_PAGE_SIZE } from "../lib/recipe-browser";

type View = "chef" | "recipes" | "pantry" | "plan" | "shop" | "settings";

function isChefQuestion(text: string): boolean {
  return /\?|^(?:how|why|what|when|where|which|can|could|should|would|does|do|is|are|explain|describe|tell)\b/i.test(text);
}

type Profile = {
  allergies: string[];
  diet: string;
  dislikes: string[];
  skillLevel: string;
  budget: string;
  equipment: string[];
};

type AISettings = {
  provider: "ollama" | "openai";
  ollamaModel: string;
  openaiModel: string;
};

type ChefResponse = {
  answerKind?: ChefApiResponse["answerKind"];
  planningFacts?: ChefApiResponse["planningFacts"];
  verification?: ChefApiResponse["verification"];
  evidenceRetrieval?: ChefApiResponse["evidenceRetrieval"];
  answerStatus?: ChefApiResponse["answerStatus"];
  resolvedContext?: ChefDinnerContext;
  readinessByRecipeId?: ChefApiResponse["readinessByRecipeId"];
  selectedEvidenceByRecipeId?: ChefApiResponse["selectedEvidenceByRecipeId"];
  requestQuery?: string;
  recipes: Recipe[];
  generation: "ai" | "catalog_fallback";
  answer: string;
  sourceFacts: Array<{ recipeId: string; fact: string; evidenceId?: string }>;
  chefChanges: Array<{
    recipeId: string;
    change: string;
    reason: string;
  }>;
  recommendations: Array<{
    recipeId: string;
    reason: string;
    matchReason?: string;
    pantryMatch: string[];
    missingIngredients: string[];
  }>;
  citations: Array<{
    recipeId: string;
    title: string;
    sourceName: string;
    sourceUrl: string;
  }>;
  warnings: string[];
  retrieval?: ChefApiResponse["retrieval"];
  metadataByRecipeId?: RecipeMetadataMap;
  outcome?: "matches" | "no_match" | "constraints_unsatisfied" | "catalog_empty";
};

const DEFAULT_PROFILE: Profile = {
  allergies: [],
  diet: "No restriction",
  dislikes: [],
  skillLevel: "Confident beginner",
  budget: "Medium",
  equipment: ["Oven", "Stovetop"],
};

const DEFAULT_SETTINGS: AISettings = {
  provider: "ollama",
  ollamaModel: "qwen3.5:9b",
  openaiModel: "gpt-5.6-terra",
};

const LOCAL_RECIPES: Recipe[] = [
  {
    id: "local-lemon-pasta",
    title: "Lemon Garlic Pantry Pasta",
    image: "",
    category: "Weeknight dinner",
    cuisine: "Mediterranean",
    ingredients: [
      { name: "spaghetti", measure: "250 g" },
      { name: "garlic", measure: "4 cloves" },
      { name: "lemon", measure: "1" },
      { name: "olive oil", measure: "3 tbsp" },
      { name: "parmesan", measure: "1/2 cup" },
    ],
    instructions: [
      "Boil the pasta in well-salted water until al dente, reserving a cup of cooking water.",
      "Gently cook the garlic in olive oil, then add lemon zest and a splash of pasta water.",
      "Toss in the pasta, lemon juice, and parmesan until glossy. Season and serve.",
    ],
    source: { name: "Local starter", url: "#source-note" },
    sourceUrl: "#source-note",
    tags: ["quick", "vegetarian", "pantry"],
  },
  {
    id: "local-chickpea-skillet",
    title: "Tomato Chickpea Skillet",
    image: "",
    category: "Weeknight dinner",
    cuisine: "Mediterranean",
    ingredients: [
      { name: "chickpeas", measure: "2 cans" },
      { name: "tomatoes", measure: "400 g" },
      { name: "onion", measure: "1" },
      { name: "garlic", measure: "3 cloves" },
      { name: "paprika", measure: "1 tsp" },
    ],
    instructions: [
      "Soften the onion in olive oil, then stir in garlic and paprika.",
      "Add tomatoes and chickpeas and simmer until thickened.",
      "Taste, season, and finish with herbs or yogurt if you have them.",
    ],
    source: { name: "Local starter", url: "#source-note" },
    sourceUrl: "#source-note",
    tags: ["vegan", "one-pan", "budget"],
  },
  {
    id: "local-rice-bowl",
    title: "Golden Chicken Rice Bowl",
    image: "",
    category: "Weeknight dinner",
    cuisine: "Home cooking",
    ingredients: [
      { name: "chicken", measure: "400 g" },
      { name: "rice", measure: "1 cup" },
      { name: "onion", measure: "1" },
      { name: "garlic", measure: "2 cloves" },
      { name: "carrot", measure: "2" },
    ],
    instructions: [
      "Season and brown the chicken, then set it aside.",
      "Cook onion, garlic, and carrot in the same pan before stirring in the rice.",
      "Add water or stock, return the chicken, cover, and cook until the rice is tender.",
    ],
    source: { name: "Local starter", url: "#source-note" },
    sourceUrl: "#source-note",
    tags: ["one-pot", "family", "budget"],
  },
];

const STORAGE_KEY = "rag-chef-preferences-v2";

function tidyIngredient(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function metricMeasure(measure: string, metric: boolean) {
  if (!metric) return measure;
  const normalized = measure.toLowerCase().trim();
  const mixed = normalized.match(/^(\d+(?:\.\d+)?)\s+(\d+)\/(\d+)/);
  const fraction = normalized.match(/^(\d+)\/(\d+)/);
  const decimal = normalized.match(/^(\d+(?:\.\d+)?)/);
  const amount = mixed
    ? Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3])
    : fraction
      ? Number(fraction[1]) / Number(fraction[2])
      : decimal
        ? Number(decimal[1])
        : Number.NaN;
  if (!Number.isFinite(amount)) return measure;
  if (normalized.includes("tbsp")) return `${Math.round(amount * 15)} ml`;
  if (normalized.includes("tsp")) return `${Math.round(amount * 5)} ml`;
  if (/\bcups?\b/.test(normalized)) return `${Math.round(amount * 240)} ml`;
  if (/\boz\b/.test(normalized)) return `${Math.round(amount * 28.35)} g`;
  if (/\blb\b|pound/.test(normalized)) return `${Math.round(amount * 454)} g`;
  return measure;
}

function sourceLabel(recipe: Recipe) {
  return recipe.source?.name || "Recipe source";
}

type InstructionSection = {
  title: string;
  steps: string[];
};

function defaultInstructionTitle(recipe: Recipe) {
  const title = recipe.title.toLowerCase();
  if (/instant pot|pressure cooker/.test(title)) return "Instant Pot";
  if (/slow cooker|crockpot/.test(title)) return "Slow cooker";
  if (/air fryer/.test(title)) return "Air fryer";
  return "Main method";
}

function isInstructionHeading(value: string) {
  const heading = value.trim().replace(/:$/, "");
  return (
    heading.length <= 80 &&
    (/(?:instructions?|directions?|method)$/i.test(heading) ||
      /^(?:instant pot|pressure cooker|stove ?top|oven|slow cooker|air fryer|grill|hob)$/i.test(
        heading,
      ))
  );
}

function instructionHeading(value: string) {
  const cleaned = value
    .trim()
    .replace(/:$/, "")
    .replace(/\s+(?:instructions?|directions?)$/i, "")
    .trim();
  return cleaned || "Alternate method";
}

function instructionSections(recipe: Recipe): InstructionSection[] {
  const sections: InstructionSection[] = [];
  let current: InstructionSection = {
    title: defaultInstructionTitle(recipe),
    steps: [],
  };

  for (const rawStep of recipe.instructions) {
    const step = rawStep.trim();
    if (
      !step ||
      /^(?:step\s*#?\s*\d+|instructions?|directions?)\s*[:.)-]?$/i.test(
        step,
      )
    ) {
      continue;
    }
    if (isInstructionHeading(step)) {
      if (current.steps.length) sections.push(current);
      current = { title: instructionHeading(step), steps: [] };
      continue;
    }
    current.steps.push(step.replace(/^(?:step\s+)?\d+[.)]\s+/i, "").trim());
  }

  if (current.steps.length) sections.push(current);
  return sections;
}

export default function RagChefApp() {
  const [view, setView] = useState<View>("chef");
  const [chefOrigin, setChefOrigin] = useState<"plan" | "recipes" | null>(null);
  const scrollPositions = useRef<Partial<Record<View, number>>>({});
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [today, setToday] = useState(localDate);
  useEffect(() => {
    const refreshDate = () => setToday(localDate());
    const id = window.setInterval(refreshDate, 30_000);
    window.addEventListener("focus", refreshDate);
    document.addEventListener("visibilitychange", refreshDate);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refreshDate);
      document.removeEventListener("visibilitychange", refreshDate);
    };
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => window.scrollTo({ top: scrollPositions.current[view] ?? 0, left: 0, behavior: "instant" }));
    const remember = () => { scrollPositions.current[view] = window.scrollY; };
    window.addEventListener("scroll", remember, { passive: true });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("scroll", remember); };
  }, [view]);
  const kitchen = useKitchen(LOCAL_RECIPES);
  const kitchenRef = useRef(kitchen);
  useEffect(() => { kitchenRef.current = kitchen; }, [kitchen]);
  const [pinnedRecipe, setPinnedRecipe] = useState<Recipe | null>(null);
  const [chefMealDate, setChefMealDate] = useState<string | null>(null);
  const [chefPortions, setChefPortions] = useState("");
  const [chefTurns, setChefTurns] = useState<Array<{ query: string; answer: string }>>([]);
  const [chefRefinements, setChefRefinements] = useState<string[]>([]);
  const pantry = useMemo(() => availablePantryNames(kitchen.state.pantry, today), [kitchen.state.pantry, today]);
  const [pantryDraft, setPantryDraft] = useState("");
  const [pantryPreview, setPantryPreview] = useState<PantryInputRow[] | null>(null);
  const [pantryError, setPantryError] = useState("");
  const [removals, setRemovals] = useState<{ id: string; label: string; pantry: PantryStock[]; meals: PlannedMeal[] }[]>([]);
  const recoveryRef = useRef<HTMLElement>(null);
  const latestRemovalId = removals.at(-1)?.id;
  useEffect(() => {
    if (!latestRemovalId) return;
    const frame = requestAnimationFrame(() => recoveryRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" }));
    return () => cancelAnimationFrame(frame);
  }, [latestRemovalId]);
  const [undoNotice, setUndoNotice] = useState("");

  const [query, setQuery] = useState("");
  const [recipeQuery, setRecipeQuery] = useState("");
  const [recipeLimit, setRecipeLimit] = useState(RECIPE_PAGE_SIZE);
  const [coreDinnersOnly, setCoreDinnersOnly] = useState(false);
  const [maxMinutes, setMaxMinutes] = useState("");
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [settings, setSettings] = useState<AISettings>(DEFAULT_SETTINGS);
  const [catalogRecipes, setCatalogRecipes] = useState<Recipe[]>([]);
  const [metadataByRecipeId, setMetadataByRecipeId] = useState<RecipeMetadataMap>({});
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [planningNotice, setPlanningNotice] = useState("");
  const [preferReviewedMains, setPreferReviewedMains] = useState(true);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  const [planningReasons, setPlanningReasons] = useState<Record<string, string>>({});
  const chefContext = JSON.stringify({ profile, pantry: kitchen.state.pantry, meals: kitchen.state.meals, settings, today });
  const [chefBusyContext, setChefBusyContext] = useState<string | null>(null);
  const askingChef = chefBusyContext === chefContext;
  const [storedChefError, setChefError] = useState<{ contextKey: string; message: string; prompt: string } | null>(null);
  const chefError = storedChefError?.contextKey === chefContext ? storedChefError : null;
  const [storedChefResult, setChefResult] = useState<(ChefResponse & { contextKey: string }) | null>(null);
  const chefResult = storedChefResult?.contextKey === chefContext ? storedChefResult : null;
  const lastChefPrompt = useRef("");
  const chefRequest = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [metric, setMetric] = useState(true);
  const [week, setWeek] = useState(() => weekStart());
  const [planPicker, setPlanPicker] = useState<Recipe | null>(null);
  const [selectionDate, setSelectionDate] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [pendingChoice, setPendingChoice] = useState<{ date: string; recipe: Recipe; expectedId: string } | null>(null);
  const [reviewDate, setReviewDate] = useState<string | null>(null);
  const [shoppingReviewDate, setShoppingReviewDate] = useState<string | null>(null);
  const [purchaseItems, setPurchaseItems] = useState<ReturnType<typeof shoppingForWeek> | null>(null);
  const [purchaseNotice, setPurchaseNotice] = useState("");
  const [cookingMealDate, setCookingMealDate] = useState<string | null>(null);
  const [completionDate, setCompletionDate] = useState<string | null>(null);
  const [completionMealId, setCompletionMealId] = useState<string | null>(null);
  const [completionFingerprint, setCompletionFingerprint] = useState<string | null>(null);
  const [deductStock, setDeductStock] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [cookingSession, setCookingSession] = useState<CookingSession | null>(null);
  const [cookingStorageNotice, setCookingStorageNotice] = useState("");
  const [pendingCookingStart, setPendingCookingStart] = useState<CookingSession | null>(null);
  const [backupExportError, setBackupExportError] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("");
  useEffect(() => () => {
    ++chefRequest.current.id;
    chefRequest.current.controller?.abort();
    chefRequest.current.controller = null;
  }, [chefContext]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (saved) {
          const state = JSON.parse(saved);
          if (state.profile) setProfile({ ...DEFAULT_PROFILE, ...state.profile });
          if (state.settings)
            setSettings({ ...DEFAULT_SETTINGS, ...state.settings });
        }
      } catch {
        // A corrupt local draft should never prevent the app from opening.
      }
      try { setCookingSession(parseCookingSession(window.localStorage.getItem(COOKING_SESSION_KEY))); }
      catch { /* Cooking recovery never prevents the kitchen from opening. */ }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ profile, settings }));
    } catch { /* Kitchen recovery is managed separately from preferences. */ }
  }, [hydrated, profile, settings]);

  const loadPlanningCatalog = useCallback(async () => {
    setCatalogState("loading");
    try {
      const response = await fetch("/api/recipes/catalog", { cache: "no-store" });
      if (!response.ok) throw new Error("Catalog unavailable");
      const data = await response.json() as { recipes: Recipe[]; metadataByRecipeId?: RecipeMetadataMap };
      if (!Array.isArray(data.recipes)) throw new Error("Invalid catalog");
      setCatalogRecipes(data.recipes);
      setMetadataByRecipeId(data.metadataByRecipeId ?? {});
      setCatalogState("ready");
    } catch {
      setCatalogState("error");
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !kitchen.ready) return;
    const id = window.setTimeout(() => void loadPlanningCatalog(), 0);
    return () => window.clearTimeout(id);
  }, [hydrated, kitchen.ready, loadPlanningCatalog]);

  const constraints = useMemo(() => normalizeConstraints(profile), [profile]);
  const metadataForRecipe = (recipe: Recipe) => {
    const current = catalogRecipes.find((item) => item.id === recipe.id);
    return current && JSON.stringify(current) === JSON.stringify(recipe) ? metadataByRecipeId[recipe.id] : undefined;
  };
  const eligibilityFor = (recipe: Recipe) => evaluateRecipeConstraints(recipe, metadataForRecipe(recipe), constraints);
  const rankedRecipes = useMemo(() => {
    return catalogRecipes
      .filter((recipe) => evaluateRecipeConstraints(recipe, metadataByRecipeId[recipe.id], constraints).eligible)
      .sort(
        (a, b) =>
          Number(Boolean(metadataByRecipeId[b.id]?.coreDinner)) - Number(Boolean(metadataByRecipeId[a.id]?.coreDinner)) ||
          evaluateRecipeConstraints(a, metadataByRecipeId[a.id], constraints).dislikedIngredients.length - evaluateRecipeConstraints(b, metadataByRecipeId[b.id], constraints).dislikedIngredients.length || pantryDetails(b, pantry).coverage - pantryDetails(a, pantry).coverage,
      );
  }, [pantry, constraints, metadataByRecipeId, catalogRecipes]);

  const browseCatalog = useMemo(() => catalogRecipes.filter((recipe) => evaluateRecipeConstraints(recipe, metadataByRecipeId[recipe.id], constraints).eligible), [catalogRecipes, constraints, metadataByRecipeId]);
  const browserResults = useMemo(() => browseRecipes(browseCatalog, recipeQuery, pantry).filter((recipe) => {
    const metadata = metadataByRecipeId[recipe.id];
    if (coreDinnersOnly && !metadata?.coreDinner) return false;
    return !maxMinutes || Number(maxMinutes) <= 0 || Boolean(metadata?.provenance.totalMinutes?.basis === "source" && metadata.totalMinutes !== null && metadata.totalMinutes <= Number(maxMinutes));
  }), [browseCatalog, recipeQuery, pantry, coreDinnersOnly, maxMinutes, metadataByRecipeId]);

  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, index) => addDateDays(week, index)), [week]);
  const weekMeals = useMemo(() => weekDates.flatMap((date) => kitchen.state.meals[date] ? [kitchen.state.meals[date]] : []), [kitchen.state.meals, weekDates]);
  const shoppingItems = useMemo(() => shoppingForWeek(kitchen.state, week, today), [kitchen.state, week, today]);
  function recipeAllowed(recipe: Recipe) {
    return evaluateRecipeConstraints(recipe, metadataForRecipe(recipe), view === "chef" ? chefRefinements.reduce((current, refinement) => constraintsForRecipeQuery(refinement, current), constraints) : constraints).eligible;
  }

  function addPantryItem(value = pantryDraft) {
    const rows = parsePantryInput(value);
    setPantryError("");
    if (rows.length > 1 || rows.some((row) => row.measure)) { setPantryPreview(rows); return; }
    const error = pantryInputProblem(rows, kitchen.state.pantry);
    if (error) { setPantryError(error); return; }
    const next = tidyIngredient(rows[0].name);
    if (pantry.some((item) => canonicalIngredient(item) === canonicalIngredient(next))) {
      setPantryError("That ingredient is already available. Edit its amount in Pantry."); return;
    }
    kitchen.update((state) => ({ ...state, pantry: [...state.pantry, { id: crypto.randomUUID(), name: next, measure: "" }] }));
    setPantryDraft("");
  }

  function removePantryItem(id: string) {
    const item = kitchen.state.pantry.find((stock) => stock.id === id);
    if (!item) return;
    setUndoNotice("");
    setRemovals((items) => [...items, { id: crypto.randomUUID(), label: `Removed ${item.name}.`, pantry: [item], meals: [] }]);
    kitchen.update((state) => ({ ...state, pantry: state.pantry.filter((stock) => stock.id !== id) }));
  }

  function removeMeals(dates: string[]) {
    const removed = dates.map((date) => kitchen.state.meals[date]).filter((meal) => meal && !meal.locked && meal.status !== "cooked");
    if (!removed.length) return;
    setUndoNotice("");
    setRemovals((items) => [...items, { id: crypto.randomUUID(), label: removed.length === 1 ? `Removed ${removed[0].title}.` : `Removed ${removed.length} dinners.`, pantry: [], meals: removed }]);
    kitchen.update((state) => ({ ...state, meals: Object.fromEntries(Object.entries(state.meals).filter(([date, meal]) => !dates.includes(date) || meal.locked || meal.status === "cooked")) }));
  }

  function undoRemoval(removal: typeof removals[number]) {
    const blocked = removal.meals.filter((meal) => kitchen.state.meals[meal.date]);
    const restoring = removal.meals.filter((meal) => !kitchen.state.meals[meal.date]);
    const pantryRows = removal.pantry.filter((item) => !kitchen.state.pantry.some((stock) => stock.id === item.id));
    if (kitchen.state.pantry.length + pantryRows.length > 500) { setUndoNotice("Make room in your pantry before restoring these ingredients."); return; }
    kitchen.update((state) => ({ ...state,
      pantry: [...state.pantry, ...pantryRows.filter((item) => !state.pantry.some((stock) => stock.id === item.id))],
      meals: { ...state.meals, ...Object.fromEntries(restoring.filter((meal) => !state.meals[meal.date]).map((meal) => [meal.date, meal])) },
    }));
    setRemovals((items) => blocked.length ? items.map((item) => item.id === removal.id ? { ...item, pantry: [], meals: blocked } : item) : items.filter((item) => item.id !== removal.id));
    setUndoNotice(blocked.length ? "A dinner now occupies a removed dinner’s date. It was kept; free that date to undo the remaining removal." : "Removal undone.");
  }

  async function askChef(prompt = query, override?: ChefDinnerContext, refinementValues = chefRefinements) {
    chefRequest.current.controller?.abort();
    const controller = new AbortController();
    const requestId = ++chefRequest.current.id;
    chefRequest.current.controller = controller;
    const contextKey = chefContext;
    const finalQuery = prompt.trim() || "What can I cook with what I have?";
    lastChefPrompt.current = finalQuery;
    setChefBusyContext(contextKey);
    setChefError(null);
    try {
      const deadline = Date.now() + 6000;
      while (["saving", "pending", "loading"].includes(kitchenRef.current.saveState) && Date.now() < deadline && !controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 100));
      if (controller.signal.aborted) return;
      if (kitchenRef.current.saveState !== "saved") throw new Error("Finish saving your kitchen before asking Chef. Resolve any save conflict, then retry.");
      const uniquePrevious = !pinnedRecipe && chefResult?.recommendations.length === 1 && /\b(it|that one|this recipe)\b/i.test(finalQuery)
        ? chefResult.recipes.find((recipe) => recipe.id === chefResult.recommendations[0].recipeId) : null;
      const target = override?.recipeId ? catalogRecipes.find((recipe) => recipe.id === override.recipeId) ?? cookingSession?.recipe : pinnedRecipe ?? uniquePrevious;
      const mealDate = override ? override.mealDate : chefMealDate;
      const saved = mealDate ? kitchenRef.current.state.meals[mealDate] : undefined;
      const context: ChefDinnerContext = { kitchenRevision: kitchenRef.current.getRevision(), today,
        ...(target ? { recipeId: target.id, recipeHash: await chefRecipeHash(target) } : {}),
        ...(saved ? { mealDate: saved.date, mealId: saved.id, mealHash: await chefMealHash(saved) } : {}),
        ...(override ?? { purpose: "planning", targetDate: selectionDate ?? saved?.date ?? today,
          ...(chefPortions ? { servings: Number(chefPortions) } : {}),
          ...(chefResult ? { previousRecipeIds: chefResult.recommendations.slice(0, 3).map((item) => item.recipeId) } : {}),
        }) };
      const continuingDiscussion = !override || target?.id === pinnedRecipe?.id && (mealDate ?? null) === chefMealDate;
      const history = continuingDiscussion ? chefTurns.flatMap((turn) => [{ role: "user" as const, content: turn.query }, { role: "assistant" as const, content: turn.answer }]).slice(-6) : [];
      const response = await fetch("/api/chef", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          query: finalQuery,
          pantry: kitchen.state.pantry.filter((item) => availablePantryNames([item], today).length > 0).map((item) => ({ name: item.name, quantity: item.measure || undefined })),
          profile,
          context, history, refinements: refinementValues,
          provider: settings.provider,
          model:
            settings.provider === "ollama"
              ? settings.ollamaModel
              : settings.openaiModel,
        }),
      });
      const data = await response.json() as ChefResponse & { error?: { message?: string } };
      if (requestId !== chefRequest.current.id || controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.error?.message || "Chef could not load the approved catalog. Please retry.");
      setChefResult({ ...data, contextKey, requestQuery: finalQuery });
      if (!pinnedRecipe && data.resolvedContext?.recipeId) setPinnedRecipe(data.recipes.find((recipe) => recipe.id === data.resolvedContext!.recipeId) ?? null);
      if (data.answerStatus !== "unverified") setChefTurns((turns) => [...(continuingDiscussion ? turns : []), { query: finalQuery, answer: data.answer }].slice(-3));
      if (data.metadataByRecipeId) setMetadataByRecipeId((current) => ({ ...current, ...data.metadataByRecipeId }));
    } catch (error) {
      if (requestId !== chefRequest.current.id || controller.signal.aborted) return;
      setChefResult(null);
      setChefError({ contextKey, prompt: finalQuery, message: error instanceof Error ? error.message : "Chef could not load suggestions. Please retry." });
    } finally {
      if (requestId === chefRequest.current.id) setChefBusyContext(null);
    }
  }

  function submitChefQuestion(prompt: string) {
    const text = prompt.trim() || (!pinnedRecipe && !chefResult && !chefRefinements.length ? discoveryQuery || "What can I cook with what I have?" : "");
    if (!text) return;
    const question = isChefQuestion(text);
    const refining = !pinnedRecipe && discoveryQuery && (chefResult || chefRefinements.length) && !question;
    if (refining && text.length > MAX_CHEF_REFINEMENT_LENGTH) return;
    if (refining && chefRefinements.length >= 6 && !chefRefinements.includes(text)) return;
    setQuery("");
    if (refining) {
      const values = [...new Set([...chefRefinements, text])];
      setChefRefinements(values); setChefResult(null);
      void askChef(discoveryQuery, undefined, values);
    } else {
      if (!pinnedRecipe) setDiscoveryQuery(text);
      void askChef(text);
    }
  }

  function changeChefRefinements(values: string[]) {
    cancelChef(); setChefRefinements(values); setChefResult(null);
    if (discoveryQuery) void askChef(discoveryQuery, undefined, values);
  }

  function cancelChef() {
    ++chefRequest.current.id;
    chefRequest.current.controller?.abort();
    chefRequest.current.controller = null;
    setChefBusyContext(null);
  }

  function generatePlan() {
    setView("plan");
    if (catalogState !== "ready") {
      setPlanningNotice("Load the full catalog before filling empty days. Your saved dinners are unchanged.");
      return;
    }
    const candidates = catalogRecipes.filter(recipeAllowed);
    const options = { metadataByRecipeId, preferReviewedMains };
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const proposed = fillEmptyDays(candidates, kitchen.state.pantry, week, kitchen.state.meals, today, planningRandom(seed), options);
    const emptyDays = weekDates.filter((date) => date >= today && !kitchen.state.meals[date]).length;
    setPlanningReasons(proposed.reasons);
    setPlanningNotice(emptyDays === 0 ? "No upcoming empty days in this week. Past dinners can be added manually." : proposed.additions.length < emptyDays ? `Added ${proposed.additions.length} different eligible dinners. Remaining days were left empty.` : "Upcoming empty days filled without repeats. Saved dinners reserve their pantry stock first.");
    kitchen.update((state) => ({ ...state, meals: fillEmptyDays(candidates, state.pantry, week, state.meals, today, planningRandom(seed), options).meals }));
  }

  function focusChefRecipe(recipe: Recipe, mealDate?: string) {
    if (view === "plan" || view === "recipes") setChefOrigin(view);
    cancelChef(); setChefError(null);
    if (pinnedRecipe?.id !== recipe.id || chefMealDate !== (mealDate ?? null)) { setChefTurns([]); setChefResult(null); setQuery(""); }
    if (mealDate) {
      setSelectionDate(mealDate);
      const servings = kitchen.state.meals[mealDate]?.servings;
      setChefPortions(servings ? String(servings) : "");
    }
    setPinnedRecipe(recipe); setChefMealDate(mealDate ?? null); setSelectedRecipe(null); setView("chef");
  }

  function newDinnerSearch() {
    cancelChef(); setDiscoveryQuery(""); setPinnedRecipe(null); setChefMealDate(null); setChefTurns([]); setChefResult(null); setChefError(null); setQuery(""); setChefRefinements([]); setChefPortions("");
  }

  function addRecipeToPlan(recipe: Recipe) {
    setSelectedRecipe(null);
    setSelectionNotice("");
    const chosenDate = selectionDate ?? (view === "chef" ? today : null);
    if (!chosenDate) { setPlanPicker(recipe); return; }
    const current = kitchen.state.meals[chosenDate];
    if (current?.locked || current?.status === "cooked") {
      setSelectionNotice("This dinner is locked or cooked. Return to Plan to choose another day or unlock it."); return;
    }
    if (current) setPendingChoice({ date: chosenDate, recipe, expectedId: current.id });
    else chooseMeal(chosenDate, recipe, undefined, null);
  }

  function chooseMeal(date: string, recipe: Recipe, template?: PlannedMeal, expectedId: string | null = null): boolean {
    if (dinnerSelectionStatus(kitchen.state.meals, date, expectedId) !== "available" || !recipeAllowed(recipe)) {
      setSelectionNotice("This dinner or your exclusions changed. Choose again; the saved dinner is unchanged."); return false;
    }
    const portions = Number(chefPortions);
    const validPortions = Number.isInteger(portions) && portions > 0 && portions <= 100;
    const current = chefMealDate === date && pinnedRecipe?.id === recipe.id && kitchen.state.meals[date]?.recipeId === recipe.id ? kitchen.state.meals[date] : undefined;
    const chosenTemplate = template ?? (current || validPortions ? chefMealPreview(current ?? createPlannedMeal(date, recipe), { purpose: "planning", targetDate: date, ...(validPortions ? { servings: portions } : {}) }) : undefined);
    kitchen.update((state) => placePlannedDinner(state, date, recipe, expectedId, chosenTemplate));
    setPinnedRecipe(recipe); setChefMealDate(date); setChefPortions(chosenTemplate?.servings ? String(chosenTemplate.servings) : "");
    setSelectionDate(date); setPendingChoice(null); setPlanPicker(null); setSelectedRecipe(null); setReviewDate(null);
    setWeek(weekStart(date)); setView("plan"); setFocusDate(date); setSelectionNotice("");
    setPlanningNotice(`Dinner saved for ${dateLabel(date)}.`);
    return true;
  }

  function chooseDay(date: string) {
    if (kitchen.state.meals[date]?.locked || kitchen.state.meals[date]?.status === "cooked") return;
    cancelChef(); setChefOrigin("plan"); setDiscoveryQuery(""); setPinnedRecipe(null); setChefTurns([]); setChefRefinements([]); setQuery(""); setChefPortions("");
    setSelectionDate(date); setSelectionNotice(""); setReviewDate(null); setView("chef"); setChefMealDate(null); setChefResult(null);
  }

  function navigate(next: View) {
    if (next === "chef" && (view === "plan" || view === "recipes")) setChefOrigin(view);
    setSelectionNotice(""); setPendingChoice(null); setReviewDate(null); setView(next);
  }

  function reviewMeal(date: string) { setShoppingReviewDate(date); }

  function confirmPurchases(drafts: PurchaseDraft[]) {
    const error = purchasePreviewProblem(kitchen.state, week, today, drafts);
    if (error) { setPurchaseNotice(error); return; }
    const id = crypto.randomUUID(), at = new Date().toISOString();
    kitchen.update((state) => applyBoughtItems(state, week, today, drafts, id, at));
    setPurchaseItems(null); setPurchaseNotice("Purchase preview applied. Review the added batches below.");
  }

  function backFromChef() {
    if (chefOrigin === "plan") {
      const date = selectionDate;
      navigate("plan");
      if (date) setFocusDate(date);
    } else navigate("recipes");
  }

  function cookMeal(date: string) {
    const meal = kitchen.state.meals[date];
    if (!meal?.recipe || meal.status === "cooked") return;
    setCookingMealDate(date);
    const methods = instructionSections(meal.recipe);
    if (methods.length > 1) { setSelectedRecipe(meal.recipe); return; }
    startCooking(meal.recipe, methods[0]?.steps ?? meal.recipe.instructions, methods[0]?.title ?? "Source directions", meal);
  }

  function exportBackup() {
    try {
      const blob = new Blob([serializeKitchenBackup(kitchen.state)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "rag-chef-kitchen-backup.json"; link.click(); URL.revokeObjectURL(url);
      setBackupExportError("");
    } catch (error) { setBackupExportError(error instanceof Error ? error.message : "The backup could not be exported."); }
  }

  function openRecipe(recipe: Recipe) {
    setCookingMealDate(null);
    setSelectedRecipe(recipe);
  }

  function persistCookingSession(next: CookingSession | null) {
    setCookingSession(next);
    try {
      if (next) window.localStorage.setItem(COOKING_SESSION_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(COOKING_SESSION_KEY);
      setCookingStorageNotice("");
    } catch { setCookingStorageNotice("Cooking progress could not be saved in this browser. Keep this tab open to retain it."); }
  }

  function startCooking(
    recipe: Recipe,
    steps: string[],
    method: string,
    plannedDinner?: PlannedMeal,
  ) {
    if (!steps.length) return;
    const meal = plannedDinner ?? (cookingMealDate ? kitchen.state.meals[cookingMealDate] : undefined);
    const next = createCookingSession(recipe, steps, method, meal?.recipeId === recipe.id ? meal : undefined);
    if (cookingSession) { setPendingCookingStart(next); return; }
    persistCookingSession(next);
    setSelectedRecipe(null);
    setCooking(true);
  }

  async function testConnection() {
    setConnectionStatus("Checking…");
    const model =
      settings.provider === "ollama"
        ? settings.ollamaModel
        : settings.openaiModel;
    try {
      const response = await fetch(
        `/api/health?provider=${settings.provider}&model=${encodeURIComponent(model)}`,
      );
      const data = await response.json() as { providers?: Record<string, { message?: string }>; error?: { message?: string }; ok?: boolean };
      const providerStatus = data.providers?.[settings.provider];
      setConnectionStatus(
        providerStatus?.message ??
          data.error?.message ??
          (data.ok ? "Connected" : "Not configured"),
      );
    } catch {
      setConnectionStatus("Could not reach the provider");
    }
  }

  const recommendationIds = new Set(
    chefResult?.recommendations.map((item) => item.recipeId) ?? [],
  );
  const refinedConstraints = chefRefinements.reduce((current, refinement) => constraintsForRecipeQuery(refinement, current), constraints);
  const failedRequestConstraints = chefError ? constraintsForRecipeQuery(chefError.prompt, refinedConstraints) : refinedConstraints;
  const visibleRecipes = pinnedRecipe
    ? [pinnedRecipe].filter(recipeAllowed)
    : chefResult
    ? chefResult.recipes.filter((recipe) => recommendationIds.has(recipe.id) && recipeAllowed(recipe))
    : catalogState === "ready" ? rankedRecipes.filter((recipe) => evaluateRecipeConstraints(recipe, metadataForRecipe(recipe), failedRequestConstraints).eligible) : [];
  const weekPurchases = (kitchen.state.shoppingPurchases ?? []).filter((purchase) => purchase.week === week);
  const addDinnerLabel = selectionDate ? `Add to ${dateLabel(selectionDate, { weekday: "long" })}` : "Add to plan";
  const chefComposerError = !pinnedRecipe && discoveryQuery && (chefResult || chefRefinements.length) && !isChefQuestion(query.trim()) && query.trim().length > MAX_CHEF_REFINEMENT_LENGTH
    ? `Keep dinner refinements to ${MAX_CHEF_REFINEMENT_LENGTH} characters. Shorten your draft and try again; your current choices are unchanged.` : "";

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <button className="brand" onClick={() => navigate("chef")}>
          <span className="brand-mark">R</span>
          <span>
            <strong>RAG Chef</strong>
            <small>Cook with what you have</small>
          </span>
        </button>

        <nav className="side-nav">
          <NavButton active={view === "plan"} icon="▦" label="Plan" onClick={() => navigate("plan")} />
          <NavButton active={view === "chef"} icon="✦" label="Chef" onClick={() => navigate("chef")} />
          <NavButton active={view === "recipes"} icon="▤" label="Recipes" onClick={() => navigate("recipes")} />
          <NavButton active={view === "shop"} icon="✓" label="Shopping" onClick={() => navigate("shop")} count={shoppingItems.filter((item) => !kitchen.state.shoppingChecked[item.key]).length || undefined} />
          <NavButton active={view === "pantry"} icon="◌" label="Pantry" onClick={() => navigate("pantry")} count={pantry.length} />
        </nav>

        <div className="source-mini" id="source-note">
          <span className="status-dot" />
          <div>
            <strong>Approved catalog</strong>
            <small>Persistent recipes + local fallback</small>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <h1>{viewTitle(view)}</h1>
          </div>
          <div className="topbar-actions">
            <span className="save-indicator" role="status" title={kitchen.status}>{kitchen.saveState === "saved" ? "Saved" : kitchen.saveState === "loading" ? "Loading…" : kitchen.saveState === "saving" || kitchen.saveState === "pending" ? "Saving…" : kitchen.saveState === "offline" ? "Offline" : kitchen.saveState === "conflict" ? "Save conflict" : "Save failed"}</span>
            <ThemeToggle />
            <button className="secondary-button" aria-label="Settings" onClick={() => setView("settings")}>⚙</button>
          </div>
        </header>

        {removals.length > 0 && <section ref={recoveryRef} className="removal-recovery" aria-label="Recently removed">
          <div className="removal-message"><span role="status">{removals[removals.length - 1].label}</span><div><button className="secondary-button" disabled={!kitchen.ready} onClick={() => undoRemoval(removals[removals.length - 1])}>Undo</button><button className="text-button" aria-label="Dismiss latest removal" onClick={() => setRemovals((items) => items.slice(0, -1))}>Dismiss</button></div></div>
          {removals.length > 1 && <details><summary>Earlier removals ({removals.length - 1})</summary><div className="earlier-removals">{removals.slice(0, -1).map((removal) => <div className="removal-message" key={removal.id}><span>{removal.label}</span><button className="secondary-button" disabled={!kitchen.ready} onClick={() => undoRemoval(removal)}>Undo</button><button className="text-button" aria-label={`Dismiss ${removal.label}`} onClick={() => setRemovals((items) => items.filter((item) => item.id !== removal.id))}>Dismiss</button></div>)}</div></details>}
          {undoNotice && <p role="status">{undoNotice}</p>}
        </section>}

        {(kitchen.saveState === "offline" || kitchen.saveState === "error" || !kitchen.backupAvailable) && <div className="inline-confirm" role="alert"><span>{kitchen.status}{!kitchen.backupAvailable && " Browser backup is unavailable; keep this tab open until saved to this Mac."}</span><button className="secondary-button" onClick={kitchen.retrySave}>Retry save</button></div>}
        {kitchen.conflict && <div className="inline-confirm" role="alert"><span>Your browser draft and the saved kitchen differ. Choose the version to keep.</span><button className="secondary-button" onClick={() => kitchen.resolveConflict(false)}>Load saved version</button><button className="primary-button" onClick={() => kitchen.resolveConflict(true)}>Save this draft</button></div>}
        {cookingStorageNotice && <p className="quantity-note" role="alert">{cookingStorageNotice}</p>}
        {cookingSession && !cooking && <div className="inline-confirm" role="status"><span>{cookingSession.timer.status === "finished" ? "Timer finished. " : "Saved cooking session: "}{cookingSession.recipe.title}</span><button className="primary-button" onClick={() => setCooking(true)}>Resume cooking</button><button className="secondary-button" onClick={() => persistCookingSession(null)}>Discard cooking session</button></div>}
        {kitchen.recoveryCandidates.length > 0 && <details className="panel recovery-panel"><summary>Unsaved kitchens found ({kitchen.recoveryCandidates.length})</summary><p>Review a saved browser draft before replacing the kitchen in this tab. Other tabs keep their work.</p>{kitchen.recoveryCandidates.map((draft) => <article className="recovery-candidate" key={draft.id}><strong>{draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : "Time unknown"}</strong><p>{draft.pantryCount} pantry rows · {draft.mealCount} dinners</p><p className="quantity-note">Compared with this kitchen: {draft.differences.pantryAdded} pantry rows added, {draft.differences.pantryRemoved} removed, {draft.differences.pantryChanged} changed; {draft.differences.mealsAdded} dinners added, {draft.differences.mealsRemoved} removed, {draft.differences.mealsChanged} changed.</p><div className="modal-actions"><button className="secondary-button" disabled={kitchen.busy} onClick={() => { if (kitchen.recoverDraft(draft.id)) setView("plan"); }}>Recover this draft</button><button className="text-button" disabled={kitchen.busy} onClick={() => kitchen.discardDraft(draft.id)}>Discard this draft</button></div></article>)}</details>}
        <fieldset className="kitchen-workspace" disabled={!kitchen.ready}>

        {(view === "recipes" || view === "chef") && <>
          {selectionDate && <div className="inline-confirm" role="status"><span>Choosing dinner for {dateLabel(selectionDate, { weekday: "long", month: "long", day: "numeric" })}.</span><button className="secondary-button" onClick={() => { cancelChef(); setSelectionDate(null); navigate("plan"); }}>Cancel selection</button></div>}
          {selectionNotice && <p role="alert">{selectionNotice}</p>}
        </>}

        {view === "chef" && (<>
          <div className="discovery-navigation">
            <button className="text-button flow-back" onClick={backFromChef}>{chefOrigin === "plan" ? "← Back to plan" : chefOrigin === "recipes" ? "← Back to Recipes" : "Browse recipes"}</button>
            {chefOrigin === "plan" && <button className="text-button" onClick={() => navigate("recipes")}>Browse recipes</button>}
            {(pinnedRecipe || discoveryQuery) && <button className="text-button" onClick={newDinnerSearch}>New dinner search</button>}
          </div>
          <ChefView key={pinnedRecipe?.id ?? "discovery"}
            dinnerContext={<details className="dinner-context panel" key={pinnedRecipe?.id ?? "search"} open={selectionDate ? true : undefined}>
              <summary>Dinner day and portions <span>{hydrated ? dateLabel(selectionDate ?? today) : "Choose a dinner day"}{chefPortions ? ` · ${chefPortions} servings` : " · Source quantities"}</span></summary>
              <section aria-label="Dinner context" className="dinner-context-fields">
              <label>Dinner day<input type="date" aria-label="Dinner day" value={selectionDate ?? today} onChange={(event) => { if (event.target.value) { cancelChef(); setSelectionDate(event.target.value); setChefMealDate(null); setChefResult(null); } }} /></label>
              <label>Cook for<input type="number" aria-label="Chef portions" min="1" max="100" step="1" placeholder="Source portions" value={chefPortions} onChange={(event) => { const value = event.target.value; if (!value || Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 100) { cancelChef(); setChefPortions(value); setChefResult(null); } }} /></label>
              {pinnedRecipe && !pinnedRecipe.servings && <p className="quantity-note">Yield unknown · use recipe batches in Plan.</p>}
              </section>
            </details>}
            pinnedRecipe={pinnedRecipe}
            pinRecipe={focusChefRecipe}
            turns={chefTurns}
            refinements={chefRefinements}
            changeRefinements={changeChefRefinements}
            pantry={pantry}
            pantryItems={kitchen.state.pantry.filter((item) => availablePantryNames([item], today).length > 0)}
            pantryDraft={pantryDraft}
            setPantryDraft={setPantryDraft}
            query={query}
            composerError={chefComposerError}
            setQuery={setQuery}
            addPantryItem={addPantryItem}
            removePantryItem={removePantryItem}
            askChef={(prompt) => { submitChefQuestion(prompt ?? query); return Promise.resolve(); }}
            askingChef={askingChef}
            refining={Boolean(discoveryQuery && (chefResult || chefRefinements.length))}
            cancelChef={() => { cancelChef(); setQuery(lastChefPrompt.current); }}
            chefResult={chefResult}
            chefError={chefError?.message ?? ""}
            retryChef={() => void askChef(chefError?.prompt ?? chefResult?.requestQuery ?? query)}
            recipes={visibleRecipes}
            catalogState={catalogState}
            catalogEmpty={catalogRecipes.length === 0}
            retryCatalog={() => void loadPlanningCatalog()}
            openRecipe={openRecipe}
            addRecipeToPlan={addRecipeToPlan}
            addLabel={selectionDate ? addDinnerLabel : "Choose this dinner"}
            detailsFor={(recipe) => pantryDetails(recipe, pantry)}
            eligibilityFor={(recipe) => evaluateRecipeConstraints(recipe, metadataForRecipe(recipe), failedRequestConstraints)}
            metadataForRecipe={metadataForRecipe}
          />
        </>)}

        {view === "pantry" && (
          <PantryView
            pantry={kitchen.state.pantry}
            draft={pantryDraft}
            setDraft={setPantryDraft}
            add={addPantryItem}
            remove={removePantryItem}
            update={kitchen.update}
          />
        )}

        {view === "recipes" && (
          <section className="recipe-section catalog-browser" aria-label="Recipe collection">
            <div className="section-heading"><p>Search names and ingredients · pantry matches first.</p><button className="secondary-button" onClick={() => { setChefOrigin("recipes"); navigate("chef"); }}>Ask Chef</button></div>
            <div className="catalog-search panel"><label htmlFor="recipe-search">Search recipes</label><div className="catalog-search-row"><input id="recipe-search" type="search" placeholder="Recipe name or ingredient…" value={recipeQuery} onChange={(event) => { setRecipeQuery(event.target.value); setRecipeLimit(RECIPE_PAGE_SIZE); }} /><button className="secondary-button" disabled={!recipeQuery} onClick={() => { setRecipeQuery(""); setRecipeLimit(RECIPE_PAGE_SIZE); }}>Clear search</button></div><div className="catalog-filters"><label><input type="checkbox" checked={coreDinnersOnly} onChange={(event) => { setCoreDinnersOnly(event.target.checked); setRecipeLimit(RECIPE_PAGE_SIZE); }} />Core dinners</label><label>Maximum total minutes<input type="number" min="1" max="1440" placeholder="Any" value={maxMinutes} onChange={(event) => { setMaxMinutes(event.target.value); setRecipeLimit(RECIPE_PAGE_SIZE); }} /></label></div>{maxMinutes && <p className="quantity-note">Time filtering includes source-backed total times only. Recipes with unknown times are hidden.</p>}</div>
            {catalogState === "loading" ? <div className="empty-state" role="status"><strong>Loading your recipe collection…</strong></div>
              : catalogState === "error" ? <div className="empty-state" role="alert"><strong>The recipe collection could not load.</strong><p>Your saved dinners are unchanged. Retry to browse the approved catalog.</p><button className="primary-button" onClick={() => void loadPlanningCatalog()}>Retry recipes</button></div>
              : <>
                <p className="catalog-count" role="status">{browserResults.length} of {browseCatalog.length} recipes{browserResults.length > recipeLimit ? ` · Showing ${recipeLimit}` : ""}</p>
                {(profile.allergies.length > 0 || constraints.diets.length > 0 || constraints.equipmentSpecified) && <p className="quantity-note">{catalogRecipes.length - browseCatalog.length} recipes hidden by your saved diet, allergy or equipment requirements. Unknown dietary suitability stays visible with a label. Always check source ingredients and labels; recipes are not allergy-certified.</p>}
                {catalogRecipes.length === 0 ? <div className="empty-state"><strong>Your recipe collection is empty.</strong><p>Import approved recipes to start browsing.</p></div>
                  : browserResults.length === 0 ? <div className="empty-state"><strong>No recipes match.</strong><p>{browseCatalog.length === 0 ? "Your saved exclusions hide the available recipes." : "Try fewer words or a different ingredient."}</p></div>
                  : <div className="recipe-grid">{browserResults.slice(0, recipeLimit).map((recipe) => <RecipeCard key={recipe.id} recipe={recipe} metadata={metadataByRecipeId[recipe.id]} details={pantryDetails(recipe, pantry)} dietUnknowns={eligibilityFor(recipe).dietUnknowns} featured={false} open={() => openRecipe(recipe)} add={() => addRecipeToPlan(recipe)} addLabel={addDinnerLabel} />)}</div>}
                {browserResults.length > recipeLimit && <div className="catalog-more"><button className="secondary-button" onClick={() => setRecipeLimit((limit) => limit + RECIPE_PAGE_SIZE)}>Show more</button></div>}
              </>}
          </section>
        )}

        {view === "plan" && hydrated && kitchen.ready && !weekMeals.length && <section className="onboarding-next" aria-label="Get started"><p>Choose tonight’s dinner to get started. Your shopping list builds itself.</p><button className="text-button" onClick={() => navigate("settings")}>Review preferences</button><button className="text-button" onClick={() => navigate("pantry")}>Add pantry ingredients</button></section>}
        {view === "plan" && (
          <DurablePlanView
            focusDate={focusDate}
            clearFocusDate={() => setFocusDate(null)}
            catalogState={catalogState}
            retryCatalog={() => void loadPlanningCatalog()}
            planningNotice={planningNotice}
            planningReasons={planningReasons}
            week={week}
            today={hydrated ? today : undefined}
            setWeek={(value) => { setWeek(value); setPlanningNotice(""); setPlanningReasons({}); setReviewDate(null); }}
            meals={kitchen.state.meals}
            update={kitchen.update}
            removeMeals={removeMeals}
            chooseMeal={chooseMeal}
            chooseDay={chooseDay}
            cookMeal={cookMeal}
            reviewDate={reviewDate}
            setReviewDate={setReviewDate}
            generatePlan={generatePlan}
            preferReviewedMains={preferReviewedMains}
            setPreferReviewedMains={setPreferReviewedMains}
            openMeal={(date) => { const meal = kitchen.state.meals[date]; if (meal?.recipe) { setCookingMealDate(date); setSelectedRecipe(meal.recipe); } }}
            markCooked={(date) => { setCompletionMealId(kitchen.state.meals[date]?.id ?? null); setCompletionFingerprint(plannedDinnerFingerprint(kitchen.state.meals[date])); setCompletionDate(date); setDeductStock(false); }}
            undoCooked={(date) => kitchen.update((state) => undoMeal(state, date))}
            goShopping={() => setView("shop")}
            shoppingCount={shoppingItems.filter((item) => !kitchen.state.shoppingChecked[item.key]).length}
          />
        )}

        {view === "shop" && (
          <DurableShoppingView
            items={shoppingItems}
            checked={kitchen.state.shoppingChecked}
            update={kitchen.update}
            hasPlan={weekMeals.length > 0}
            week={week}
            purchaseAction={unappliedBoughtItems(kitchen.state, shoppingItems).length ? <button className="primary-button" onClick={() => { setPurchaseNotice(""); setPurchaseItems(unappliedBoughtItems(kitchen.state, shoppingItems)); }}>Add bought items to pantry</button> : undefined}
            purchaseHistory={weekPurchases.length || purchaseNotice ? <><p role="status">{purchaseNotice}</p><details className="purchase-history"><summary>Pantry additions ({weekPurchases.length})</summary>
              {weekPurchases.slice().reverse().map((purchase) => {
                const problem = purchaseUndoProblem(kitchen.state, purchase);
                return <div className="purchase-history-row" key={purchase.id}><strong>Added to pantry: {purchase.items.map((item) => `${item.pantry.name} ${item.pantry.measure || "(amount unknown)"}`).join(", ")}</strong><button className="text-button" disabled={Boolean(problem)} onClick={() => kitchen.update((state) => undoPurchase(state, purchase.id))}>Undo pantry additions</button>{problem && <small>{problem}</small>}</div>;
              })}
            </details></> : undefined}
            goPlan={() => setView("plan")}
            reviewMeal={reviewMeal}
          />
        )}

        {view === "settings" && (
          <SettingsView
            profile={profile}
            setProfile={setProfile}
            settings={settings}
            setSettings={setSettings}
            connectionStatus={connectionStatus}
            testConnection={() => void testConnection()}
            exportBackup={exportBackup}
            backupExportError={backupExportError}
            restoreBackup={kitchen.restoreBackup}
            canRestore={kitchen.ready && !kitchen.busy}
            currentKitchen={kitchen.state}
            sources={[...new Map(catalogRecipes.map((recipe) => [recipe.source.name, recipe.source])).values()]}
          />
        )}
        {pantryError && <p role="alert">{pantryError}</p>}

        {undoNotice && !removals.length && <p role="status">{undoNotice}</p>}
        </fieldset>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <NavButton active={view === "plan"} icon="▦" label="Plan" onClick={() => navigate("plan")} />
        <NavButton active={view === "chef"} icon="✦" label="Chef" onClick={() => navigate("chef")} />
        <NavButton active={view === "recipes"} icon="▤" label="Recipes" onClick={() => navigate("recipes")} />
        <NavButton active={view === "shop"} icon="✓" label="Shopping" onClick={() => navigate("shop")} />
        <NavButton active={view === "pantry"} icon="◌" label="Pantry" onClick={() => navigate("pantry")} />
      </nav>

      {pantryPreview && <PantryImportPreview rows={pantryPreview} pantry={kitchen.state.pantry} change={setPantryPreview} close={() => setPantryPreview(null)} disabled={!kitchen.ready || Boolean(kitchen.conflict)} confirm={() => {
        const additions = pantryPreview.map((row) => ({ id: crypto.randomUUID(), name: row.name.trim().toLowerCase(), measure: row.measure.trim() }));
        kitchen.update((state) => pantryInputProblem(additions, state.pantry) ? state : { ...state, pantry: [...state.pantry, ...additions] });
        setPantryPreview(null); setPantryDraft(""); setPantryError("");
      }} />}
      {purchaseItems && <PurchasePreview items={purchaseItems} state={kitchen.state} week={week} today={today} close={() => setPurchaseItems(null)} confirm={confirmPurchases} />}
      {shoppingReviewDate && <Modal className="kitchen-modal-backdrop" label="Review dinner amounts" close={() => setShoppingReviewDate(null)}><section className="panel kitchen-modal">
        {kitchen.state.meals[shoppingReviewDate]?.recipe ? <><h2>{kitchen.state.meals[shoppingReviewDate].title}</h2><p>{dateLabel(shoppingReviewDate)} · Shopping updates as you edit.</p><DinnerAmounts meal={kitchen.state.meals[shoppingReviewDate]} patch={(patch) => {
          const expected = kitchen.state.meals[shoppingReviewDate].id;
          kitchen.update((state) => { const meal = state.meals[shoppingReviewDate]; return !meal || meal.id !== expected || meal.locked || meal.status === "cooked" ? state : { ...state, meals: { ...state.meals, [shoppingReviewDate]: { ...meal, ...patch } } }; });
        }} /></> : <p>This dinner is no longer available. Review the current plan.</p>}
        <button className="primary-button" onClick={() => setShoppingReviewDate(null)}>Back to shopping</button>
      </section></Modal>}
      {pendingChoice && <Modal className="kitchen-modal-backdrop" label="Replace dinner" close={() => setPendingChoice(null)}><section className="panel kitchen-modal"><h2>Replace this dinner?</h2><p>Replace {kitchen.state.meals[pendingChoice.date]?.title} on {dateLabel(pendingChoice.date)} with {pendingChoice.recipe.title}?</p>{dinnerSelectionStatus(kitchen.state.meals, pendingChoice.date, pendingChoice.expectedId) !== "available" && <p>This dinner changed or became locked or cooked. Cancel and choose again.</p>}<div className="modal-actions"><button className="secondary-button" onClick={() => setPendingChoice(null)}>Keep current dinner</button><button className="primary-button" disabled={dinnerSelectionStatus(kitchen.state.meals, pendingChoice.date, pendingChoice.expectedId) !== "available"} onClick={() => chooseMeal(pendingChoice.date, pendingChoice.recipe, undefined, pendingChoice.expectedId)}>Replace dinner</button></div></section></Modal>}
      {planPicker && <PlanPicker key={planPicker.id} today={today} recipe={planPicker} week={week} meals={kitchen.state.meals} close={() => setPlanPicker(null)} choose={(date, recipe, expectedId) => chooseMeal(date, recipe, undefined, expectedId)} />}
      {completionDate && kitchen.state.meals[completionDate] && (() => {
        const meal = kitchen.state.meals[completionDate];
        const unchanged = meal.id === completionMealId && plannedDinnerFingerprint(meal) === completionFingerprint;
        const preview = consumptionPreview(meal, kitchen.state.pantry, today);
        return <Modal className="kitchen-modal-backdrop" label="Complete dinner" close={() => setCompletionDate(null)}><section className="panel kitchen-modal"><span className="eyebrow">Dinner finished</span><h2>{meal.title}</h2><p>Mark this dinner cooked to remove its remaining needs from shopping. You can undo this in the plan.</p>{!unchanged && <p role="alert">This dinner changed. Cancel and open the current dinner before completing it.</p>}<label className="deduct-checkbox"><input type="checkbox" checked={deductStock} onChange={(event) => setDeductStock(event.target.checked)} />Deduct the matching pantry amounts shown below</label><ul>{preview.deductions.map((item) => <li key={item.pantryId}>{kitchen.state.pantry.find((stock) => stock.id === item.pantryId)?.name}: {item.before} → {item.after}</li>)}</ul>{preview.notes.map((note, index) => <p className="quantity-note" key={index}>{note}</p>)}{!preview.deductions.length && <p>No compatible, measured pantry stock to deduct.</p>}<div className="modal-actions"><button className="secondary-button" onClick={() => setCompletionDate(null)}>Cancel</button><button className="primary-button" disabled={!unchanged} onClick={() => { kitchen.update((state) => state.meals[completionDate]?.id === completionMealId && plannedDinnerFingerprint(state.meals[completionDate]) === completionFingerprint ? completeMeal(state, completionDate, deductStock) : state); setCompletionDate(null); setSelectedRecipe(null); setView("plan"); }}>Confirm cooked</button></div></section></Modal>;
      })()}

      {selectedRecipe && !cooking && (
        <RecipeDrawer
          recipe={selectedRecipe}
          plannedMeal={cookingMealDate ? kitchen.state.meals[cookingMealDate] : undefined}
          pantry={pantry}
          metric={metric}
          setMetric={setMetric}
          chefResult={chefResult}
          eligibility={eligibilityFor(selectedRecipe)}
          metadata={metadataForRecipe(selectedRecipe)}
          close={() => setSelectedRecipe(null)}
          askAboutRecipe={() => focusChefRecipe(selectedRecipe, cookingMealDate ?? undefined)}
          addToPlan={() => addRecipeToPlan(selectedRecipe)}
          addLabel={addDinnerLabel}
          start={(steps, method) => void startCooking(selectedRecipe, steps, method)}
        />
      )}

      {cookingSession && (
        <CookingWorkspace
          key={cookingSession.id}
          session={cookingSession}
          visible={cooking}
          chefBusy={askingChef}
          chefError={chefError?.message ?? ""}
          chefReply={chefResult?.resolvedContext?.purpose === "cooking" && chefResult.resolvedContext.recipeId === cookingSession.recipe.id
            && chefResult.resolvedContext.mealId === cookingSession.plannedMeal?.id ? chefResult : null}
          askChefStep={(question) => {
            const sourceStep = cookingSourceStep(cookingSession.recipe, cookingSession.instructions, cookingSession.step);
            const meal = cookingSession.plannedMeal;
            if (pinnedRecipe?.id !== cookingSession.recipe.id || chefMealDate !== (meal?.date ?? null)) { setChefTurns([]); setChefResult(null); }
            setPinnedRecipe(cookingSession.recipe); setChefMealDate(meal?.date ?? null);
            setSelectionDate(meal?.date ?? today); setChefPortions(meal?.servings ? String(meal.servings) : "");
            void Promise.all([chefRecipeHash(cookingSession.recipe), meal ? chefMealHash(meal) : Promise.resolve(undefined)]).then(([recipeHash, mealHash]) => askChef(question, { purpose: "cooking", recipeId: cookingSession.recipe.id, recipeHash, ...(mealHash ? { mealHash } : {}),
              ...(sourceStep ? { stepEvidenceId: sourceStep } : {}), ...(meal ? { mealDate: meal.date, mealId: meal.id, targetDate: meal.date } : { targetDate: today }) }));
          }}
          onChange={persistCookingSession}
          finish={() => {
            setCooking(false);
            const saved = cookingSession.plannedMeal;
            if (saved && canCompleteCookingSession(cookingSession, kitchen.state.meals[saved.date])) { setCompletionMealId(saved.id); setCompletionFingerprint(plannedDinnerFingerprint(saved)); setCompletionDate(saved.date); setDeductStock(false); }
            else if (saved) setPlanningNotice("The saved dinner changed while cooking. Open the current dinner to complete it.");
            persistCookingSession(null);
            setSelectedRecipe(null);
          }}
          close={() => {
            setCooking(false);
            setSelectedRecipe(null);
          }}
        />
      )}
      {pendingCookingStart && <Modal className="kitchen-modal-backdrop" label="Replace cooking session" close={() => setPendingCookingStart(null)}><section className="panel kitchen-modal"><h2>Keep your current cooking session?</h2><p>{cookingSession?.recipe.title} has saved progress{cookingSession?.timer.status === "running" ? " and a running timer" : ""}. Starting {pendingCookingStart.recipe.title} will replace that progress and timer.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setPendingCookingStart(null)}>Keep current session</button><button className="primary-button" onClick={() => { persistCookingSession(pendingCookingStart); setPendingCookingStart(null); setSelectedRecipe(null); setCooking(true); }}>Replace cooking session</button></div></section></Modal>}
    </div>
  );
}

function NavButton({
  active,
  icon,
  label,
  onClick,
  count,
}: {
  active: boolean;
  icon: string;
  label: string;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span>{label}</span>
      {count ? <span className="nav-count">{count}</span> : null}
    </button>
  );
}

function viewTitle(view: View) {
  return {
    chef: "Ask Chef",
    recipes: "Recipes",
    pantry: "Pantry",
    plan: "Weekly plan",
    shop: "Shopping",
    settings: "Settings",
  }[view];
}

function ChefView({
  dinnerContext, pinnedRecipe, pinRecipe, turns, refinements, changeRefinements,
  pantry,
  pantryItems,
  pantryDraft,
  setPantryDraft,
  query,
  composerError,
  setQuery,
  addPantryItem,
  removePantryItem,
  askChef,
  askingChef, refining,
  cancelChef,
  chefResult,
  chefError,
  retryChef,
  recipes,
  catalogState,
  catalogEmpty,
  retryCatalog,
  openRecipe,
  addRecipeToPlan,
  addLabel,
  detailsFor,
  eligibilityFor,
  metadataForRecipe,
}: {
  dinnerContext: React.ReactNode;
  pinnedRecipe: Recipe | null;
  pinRecipe: (recipe: Recipe) => void;
  turns: Array<{ query: string; answer: string }>;
  refinements: string[];
  changeRefinements: (values: string[]) => void;
  pantry: string[];
  pantryItems: PantryStock[];
  pantryDraft: string;
  setPantryDraft: (value: string) => void;
  query: string;
  composerError: string;
  setQuery: (value: string) => void;
  addPantryItem: (value?: string) => void;
  removePantryItem: (value: string) => void;
  askChef: (prompt?: string) => Promise<void>;
  askingChef: boolean;
  refining: boolean;
  cancelChef: () => void;
  chefResult: ChefResponse | null;
  chefError: string;
  retryChef: () => void;
  recipes: Recipe[];
  catalogState: "loading" | "ready" | "error";
  catalogEmpty: boolean;
  retryCatalog: () => void;
  openRecipe: (recipe: Recipe) => void;
  addRecipeToPlan: (recipe: Recipe) => void;
  addLabel: string;
  detailsFor: (recipe: Recipe) => ReturnType<typeof pantryDetails>;
  eligibilityFor: (recipe: Recipe) => ReturnType<typeof evaluateRecipeConstraints>;
  metadataForRecipe: (recipe: Recipe) => RecipeMetadata | undefined;
}) {
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const answerRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!chefResult) return;
    const frame = requestAnimationFrame(() => { answerRef.current?.focus({ preventScroll: true }); answerRef.current?.scrollIntoView({ block: "start", behavior: "instant" }); });
    return () => cancelAnimationFrame(frame);
  }, [chefResult]);
  useEffect(() => { if (pinnedRecipe) inputRef.current?.focus(); }, [pinnedRecipe]);

  return (
    <>
      {dinnerContext}
      <section className={`chef-search ${chefResult || pinnedRecipe ? "has-results" : ""}`} aria-label="Ask Chef">
        {!chefResult && !pinnedRecipe && !refining && <div className="chef-welcome"><h2>What’s for dinner?</h2><p>Find recipes for your kitchen, with sources you can follow.</p></div>}
        {pinnedRecipe && <strong className="chef-topic">Discussing {pinnedRecipe.title}</strong>}
        <form className="chef-composer" onSubmit={(event) => { event.preventDefault(); void askChef(query); }}>
          <label htmlFor="chef-query">{pinnedRecipe ? "Follow-up question" : "Ask your chef"}</label>
          <textarea ref={inputRef} id="chef-query" value={query} rows={2} maxLength={1000}
            aria-invalid={Boolean(composerError)} aria-describedby={composerError ? "chef-composer-error" : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && query.trim()) { event.preventDefault(); void askChef(query); } }}
            placeholder={pinnedRecipe ? "Ask about ingredients or this recipe’s directions…" : refining ? "e.g. without fish, or something quicker…" : "e.g. a comforting dinner with rice and tomatoes"} />
          <div className="composer-bottom"><span>{pinnedRecipe ? "Answers stay with this recipe" : pantry.length ? `${pantry.length} pantry items · Sources included` : "No pantry items yet — you can still choose dinner."}</span>
            <button className="primary-button" disabled={askingChef || Boolean(composerError) || Boolean((pinnedRecipe || refining) && !query.trim())}>{askingChef ? "Checking recipes…" : pinnedRecipe ? "Ask follow-up" : refining ? "Update dinner ideas" : "Find my dinner"}</button>
            {askingChef && <button className="secondary-button" type="button" onClick={cancelChef}>Cancel request</button>}
          </div>
          {composerError && <p id="chef-composer-error" role="alert">{composerError}</p>}
        </form>
        {refinements.length > 0 && <div className="chip-row chef-refinements" aria-label="Dinner refinements">{refinements.map((filter) => <button className="ingredient-chip" key={filter} onClick={() => changeRefinements(refinements.filter((item) => item !== filter))} aria-label={`Remove refinement ${filter}`}>{filter} ×</button>)}</div>}
        {!pinnedRecipe && refinements.length >= 6 && <p className="quantity-note">Six refinements are active. Remove one or start a new dinner search to change these choices. You can still ask a recipe question.</p>}
      </section>
      {askingChef && <p className="grounding-intro" role="status">Searching recipes and checking their sources…</p>}
      {chefError && <section className="inline-confirm chef-error" role="alert"><div><strong>Chef is unavailable</strong><p>{chefError}</p><p>Your local pantry picks are still available below.</p></div><button className="secondary-button" disabled={askingChef} onClick={retryChef}>Retry Chef</button></section>}
      {chefResult && (
        <section ref={answerRef} tabIndex={-1} className="chef-answer" aria-live="polite" aria-label="Chef answer">
          <div className="chef-stamp">{chefResult.answerKind === "planning_quantities" ? "Dinner amounts" : chefResult.generation === "ai" ? "AI + sources" : "Catalog results"}</div>
          <div>
            <p className="chef-request">{chefResult.requestQuery}</p>
            {chefResult.answerKind === "planning_quantities" && <PlanningFacts result={chefResult} />}
            {(chefResult.answerKind !== "planning_quantities" || chefResult.answerStatus !== "answered") && <p>{chefResult.answer}</p>}
            {chefResult.answerStatus === "unsupported" && <strong className="answer-status">Question not established by this source</strong>}
            {chefResult.answerStatus === "unverified" && <><strong className="answer-status">AI answer withheld · Check original evidence</strong><button className="secondary-button" disabled={askingChef} onClick={retryChef}>Retry answer</button></>}
            {chefResult.answerStatus === "needs_clarification" && <strong className="answer-status">{chefResult.answerKind === "planning_quantities" ? "Clarify the ingredient or review its amount" : "Choose a recipe or clarify your question"}</strong>}
            {chefResult.chefChanges.map((change, index) => <div className="advisory-change" key={index}><strong>Suggested change — original recipe unchanged</strong><p>{change.change}</p><small>{change.reason}</small></div>)}
            {chefResult.warnings.map((warning) => <small key={warning}>{warning}</small>)}
          </div>
        </section>
      )}

      {chefResult && <ChefGrounding result={chefResult} openRecipe={openRecipe} />}
      {!askingChef && (!chefResult || chefResult.recommendations.length > 0 && recipes.length > 0) && <section className="recipe-section">
        <div className="section-heading">
          <div>
            <h3>{chefResult ? "Your chef’s shortlist" : pantry.length ? "Pantry picks" : "Dinner ideas"}</h3>
            {chefResult?.retrieval && <p>{chefResult.retrieval.catalogCount} approved recipes searched · {chefResult.generation === "ai" ? "Chef recommendations" : "catalog suggestions"}</p>}
          </div>
        </div>

        <div className="recipe-grid">
          {recipes.slice(0, 3).map((recipe, index) => (
            <RecipeCard
              key={recipe.id}
              recipe={recipe}
              details={detailsFor(recipe)}
              dietUnknowns={eligibilityFor(recipe).dietUnknowns}
              recommendation={chefResult?.recommendations.find((item) => item.recipeId === recipe.id)}
              readiness={chefResult?.readinessByRecipeId?.[recipe.id]}
              evidence={chefResult ? recipeEvidenceExcerpt(chefResult, recipe) : undefined}
              askAbout={() => pinRecipe(recipe)}
              metadata={metadataForRecipe(recipe)}
              featured={index === 0}
              open={() => openRecipe(recipe)}
              add={() => addRecipeToPlan(recipe)}
              addLabel={addLabel}
            />
          ))}
        </div>
        {!chefResult && catalogState === "loading" ? <div className="empty-state" role="status"><strong>Loading your recipe collection…</strong></div>
          : !chefResult && catalogState === "error" ? <div className="empty-state" role="alert"><strong>The recipe collection could not load.</strong><p>Your saved dinners are unchanged.</p><button className="primary-button" onClick={retryCatalog}>Retry recipes</button></div>
          : !chefResult && !recipes.length ? <div className="empty-state"><strong>{catalogEmpty ? "Your recipe collection is empty." : "Your saved exclusions hide the available recipes."}</strong><p>{catalogEmpty ? "Import approved recipes to see dinner ideas." : "Keep your exclusions and review the available recipe collection."}</p></div>
          : !recipes.length && (
          <div className="empty-state">
            <strong>{chefResult?.outcome === "no_match" ? "No relevant recipe found." : "No recipes to show."}</strong>
            <p>{chefResult?.outcome === "constraints_unsatisfied" ? "Keep your exclusions and review the available recipe collection." : "Try a different dish or a broader dinner request."}</p>
          </div>
        )}
      </section>}
      <section className="pantry-strip">
        <div className="section-heading compact">
          <div>
            <span className="eyebrow">On hand</span>
            <h3>Your pantry</h3>
          </div>
          <button
            className="text-button"
            type="button"
            aria-expanded={quickAddOpen}
            aria-controls="chef-pantry-quick-add"
            onClick={() => setQuickAddOpen((open) => !open)}
          >
            {quickAddOpen ? "Close" : "+ Add ingredient"}
          </button>
        </div>
        {quickAddOpen && (
          <form
            className="pantry-quick-add"
            id="chef-pantry-quick-add"
            onSubmit={(event) => {
              event.preventDefault();
              if (!pantryDraft.trim()) return;
              addPantryItem();
              setQuickAddOpen(false);
            }}
          >
            <input
              autoFocus
              aria-label="Ingredient name"
              value={pantryDraft}
              onChange={(event) => setPantryDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuickAddOpen(false);
              }}
              placeholder="e.g. spinach"
            />
            <button className="primary-button" type="submit">Add to pantry</button>
          </form>
        )}
        <div className="chip-row">
          {pantryItems.slice(0, 8).map((item) => (
            <button className="ingredient-chip" key={item.id} onClick={() => removePantryItem(item.id)} title="Remove ingredient">
              <span>{ingredientGlyph(item.name)}</span>{item.name}<b>×</b>
            </button>
          ))}
          {pantry.length > 8 && <span className="more-chip">+{pantry.length - 8} more</span>}
        </div>
      </section>

      {turns.length > 1 && <details className="chef-history"><summary>Earlier questions ({turns.length - 1})</summary>{turns.slice(0, -1).map((turn, index) => <div key={index}><strong>{turn.query}</strong><p>{turn.answer}</p></div>)}</details>}
      <details className="grounding-help"><summary>How source-grounded cooking works</summary><p>Chef retrieves recipes from your approved collection before answering. Open “How Chef found this” to see the search, original evidence, and whether an answer was checked. Proposed changes stay separate from source recipes.</p></details>
    </>
  );
}

export function RecipeCard({
  readiness, askAbout, evidence,
  recipe,
  details,
  featured,
  open,
  add,
  addLabel = "Add to plan",
  dietUnknowns = [],
  recommendation,
  metadata,
}: {
  evidence?: string;
  readiness?: import("../lib/quantities").MealReadiness;
  askAbout?: () => void;
  recipe: Recipe;
  details: ReturnType<typeof pantryDetails>;
  featured: boolean;
  open: () => void;
  add?: () => void;
  addLabel?: string;
  dietUnknowns?: string[];
  recommendation?: ChefResponse["recommendations"][number];
  metadata?: RecipeMetadata;
}) {
  const completeness = recipeCompleteness(recipe);
  return (
    <article className={`recipe-card ${featured ? "featured" : ""}`}>
      {recipe.image && <button className="recipe-image" onClick={open} aria-label={`Open ${recipe.title}`}><img src={recipe.image} alt="" loading="lazy" /></button>}
      <div className="recipe-card-body">
        <div className="recipe-meta">
          <span>{recipe.cuisine || recipe.category}</span>
        </div>
        <h4><button className="recipe-title-button" onClick={open}>{recipe.title}</button></h4>
        {metadata?.coreDinner && <span className="core-badge">Core dinner</span>}
        {!readiness && <><p className="pantry-coverage">{details.matched.length} of {details.total} ingredients in pantry</p><small className="coverage-note">Names only · amounts not checked</small></>}
        {dietUnknowns.length > 0 && <p className="diet-note">Diet not verified: {dietUnknowns.map((diet) => diet.replaceAll("_", " ")).join(", ")}</p>}
        <small className="recipe-quality">{recipe.servings ? `${recipe.servings} source servings` : "Yield unknown · recipe batches"}{completeness.amountReviewCount ? ` · ${completeness.amountReviewCount} amounts to review` : " · Amounts quantified"}{metadata?.totalMinutes !== null && metadata?.totalMinutes !== undefined ? ` · ${metadata.totalMinutes} min${metadata.provenance.totalMinutes?.basis === "source" ? " total" : " estimated"}` : ""}</small>
        {readiness && <div className="recipe-readiness"><strong>Pantry amounts for this dinner</strong><p>{readiness.coveredCount} covered · {readiness.partialCount} partial · {readiness.missingCount} missing · {readiness.reviewCount} need review</p><small>After stock reserved for saved dinners. Estimates use the selected day and portions.</small>{readiness.shopping.length > 0 && <details><summary>Shopping needs ({readiness.shopping.length})</summary><ul>{readiness.shopping.map((item, index) => <li key={index}>{item.name}: {item.measure}{item.needsReview ? " · review" : ""}{item.preparationNote && <small>{item.preparationNote}</small>}</li>)}</ul></details>}</div>}
        {evidence && <blockquote className="card-source-excerpt"><small>Recipe excerpt</small>{evidence}</blockquote>}
        {add && <button className="primary-button recipe-add-action" onClick={add} aria-label={`${addLabel}: ${recipe.title}`}>{addLabel}</button>}
        {askAbout && <button className="secondary-button" onClick={askAbout}>Ask about this recipe</button>}
        {recommendation && <div className="recommendation-details">{recommendation.matchReason && <p className="match-reason"><strong>Why this match:</strong> {recommendation.matchReason}</p>}{recommendation.reason !== recommendation.matchReason && <p>{recommendation.reason}</p>}<p className="quantity-note" hidden={Boolean(readiness)}>{recommendation.missingIngredients.length ? `Missing ingredient names: ${recommendation.missingIngredients.join(", ")}` : "All ingredient names match your pantry; check quantities before cooking."}</p></div>}
        <div className="recipe-footer">
          <a href={recipe.sourceUrl} target={recipe.sourceUrl.startsWith("#") ? undefined : "_blank"} rel="noreferrer" onClick={(event) => event.stopPropagation()}>
            Source: {sourceLabel(recipe)}
          </a>
          <button className="text-button" onClick={open} aria-label={`View ${recipe.title}`}>View recipe</button>
        </div>
      </div>
    </article>
  );
}

function PantryView({
  pantry,
  draft,
  setDraft,
  add,
  remove,
  update,
}: {
  pantry: PantryStock[];
  draft: string;
  setDraft: (value: string) => void;
  add: () => void;
  remove: (value: string) => void;
  update: (change: (state: KitchenState) => KitchenState) => void;
}) {
  return (
    <div className="pantry-page">
      <section className="panel large-panel">
        <div className="section-heading">
          <div>
            <p>Type or paste ingredients, separated by new lines, commas, or semicolons. Amounts are optional.</p>
          </div>
        </div>
        <form className="add-form" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={"rice: 300 g\ncanned tomatoes: 2 cans\ngarlic"} aria-label="New pantry ingredient" rows={3} />
          <button className="primary-button" type="submit">Add to pantry</button>
        </form>
        <p className="quantity-note">Try “rice: 300 g”, “300 g rice”, or just “rice”. Use “cooked rice” for leftovers; plain rice means uncooked. Multiple ingredients open a confirmation preview. Leave unknown amounts blank; they won’t be subtracted from shopping.</p>
        <div className="unified-pantry-list">
          {pantry.map((item) => (
            <div className="unified-pantry-item" key={item.id}>
              <label><strong>{item.name}</strong><ValidatedInput validate={measureInputProblem} aria-label={`Available ${item.name}`} placeholder="Amount unknown" value={item.measure} onCommit={(measure) => {
                update((state) => ({ ...state, pantry: state.pantry.map((stock) => stock.id === item.id ? { ...stock, measure } : stock) }));
              }} />{item.measure && !parseMeasure(item.measure) && <small>Kept as a note; this amount cannot be subtracted automatically.</small>}</label>
              <label className="pantry-use-by">Use by<input type="date" aria-label={`Use by ${item.name}`} value={item.useBy ?? ""} onChange={(event) => {
                const useBy = event.target.value;
                update((state) => ({ ...state, pantry: state.pantry.map((stock) => {
                  if (stock.id !== item.id) return stock;
                  const next = { ...stock };
                  if (useBy) next.useBy = useBy; else delete next.useBy;
                  return next;
                }) }));
              }} />{item.useBy && item.useBy < localDate() && <small>Past entered use-by date; excluded from availability.</small>}</label>
              <button className="text-button" onClick={() => remove(item.id)} aria-label={`Remove ${item.name}`}>Remove</button>
            </div>
          ))}
        </div>
        {!pantry.length && <p>Your pantry is empty. Add an ingredient above.</p>}
      </section>
    </div>
  );
}

function SettingsView({
  profile,
  setProfile,
  settings,
  setSettings,
  connectionStatus,
  testConnection,
  exportBackup,
  backupExportError,
  restoreBackup,
  canRestore,
  currentKitchen,
  sources,
}: {
  profile: Profile;
  setProfile: (profile: Profile) => void;
  settings: AISettings;
  setSettings: (settings: AISettings) => void;
  connectionStatus: string;
  testConnection: () => void;
  exportBackup: () => void;
  backupExportError: string;
  restoreBackup: (state: KitchenState) => boolean;
  canRestore: boolean;
  currentKitchen: KitchenState;
  sources: Recipe["source"][];
}) {
  const [restorePreview, setRestorePreview] = useState<ReturnType<typeof parseKitchenBackup> | null>(null);
  const [restoreError, setRestoreError] = useState("");
  async function readBackup(file: File | undefined) {
    setRestorePreview(null);
    setRestoreError("");
    if (!file) return;
    try {
      if (file.size > 2_000_000) throw new Error("This backup exceeds the 2 MB kitchen limit.");
      setRestorePreview(parseKitchenBackup(await file.text()));
    } catch (error) {
      setRestoreError(error instanceof Error ? error.message : "This backup could not be read.");
    }
  }
  return (
    <div className="settings-grid">
      <section className="panel settings-panel wide-panel" id="kitchen-preferences">
        <div className="section-heading"><div><span className="eyebrow">Personalization</span><h2>How you cook</h2><p>Allergies are filtered before a recipe reaches the model.</p></div></div>
        <div className="form-grid">
          <IngredientChips label="Allergies" values={profile.allergies} onChange={(allergies) => setProfile({ ...profile, allergies })} />
          <label>Diet<select value={profile.diet} onChange={(event) => setProfile({ ...profile, diet: event.target.value })}><option>No restriction</option><option>Vegetarian</option><option>Vegan</option><option>Gluten-free</option><option>Low-carb</option></select><small>Known conflicts are hidden. Unreviewed recipes stay visible as “Diet not verified.”</small></label>
          <fieldset className="equipment-options"><legend>Available equipment</legend>{["Oven", "Stovetop", "Microwave", "Blender", "Slow cooker", "Pressure cooker", "Air fryer", "Grill"].map((equipment) => <label key={equipment}><input type="checkbox" checked={profile.equipment.includes(equipment)} onChange={(event) => setProfile({ ...profile, equipment: event.target.checked ? [...profile.equipment, equipment] : profile.equipment.filter((item) => item !== equipment) })} />{equipment}</label>)}<small>Known required appliances must be selected. Unknown equipment stays visible.</small></fieldset>
          <IngredientChips label="Dislikes" values={profile.dislikes} onChange={(dislikes) => setProfile({ ...profile, dislikes })} />
          <details className="wide secondary-preferences"><summary>More cooking preferences</summary><div className="form-grid">
          <label>Skill level<select value={profile.skillLevel} onChange={(event) => setProfile({ ...profile, skillLevel: event.target.value })}><option>New cook</option><option>Confident beginner</option><option>Experienced home cook</option></select></label>
          <label>Budget<select value={profile.budget} onChange={(event) => setProfile({ ...profile, budget: event.target.value })}><option>Low</option><option>Medium</option><option>Flexible</option></select></label>
          </div></details>
        </div>
      </section>

      <section className="panel settings-panel wide-panel"><h2>Kitchen backup</h2><p>Plans and pantry amounts save automatically on this Mac.</p><button className="secondary-button" onClick={exportBackup}>Export backup</button>{backupExportError && <p role="alert">{backupExportError}</p>}<label className="backup-upload">Restore backup<input type="file" accept="application/json,.json" aria-label="Restore backup file" onChange={(event) => { void readBackup(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label><p className="quantity-note">Restore replaces this kitchen. A recovery copy is preserved first. Recipe catalog and model preferences are separate.</p>{restoreError && <p role="alert">{restoreError}</p>}{restorePreview && <section className="restore-preview" role="region" aria-label="Backup preview"><h3>Review this backup</h3><p>Exported {new Date(restorePreview.exportedAt).toLocaleString()}</p><p>Backup: {restorePreview.state.pantry.length} pantry rows · {Object.keys(restorePreview.state.meals).length} dinners</p><p>Current kitchen: {currentKitchen.pantry.length} pantry rows · {Object.keys(currentKitchen.meals).length} dinners</p><p>Amounts, cooked records, and shopping checks will be replaced with the backup’s values.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setRestorePreview(null)}>Cancel restore</button><button className="primary-button" disabled={!canRestore} onClick={() => { if (restoreBackup(restorePreview.state)) { setRestorePreview(null); setRestoreError(""); } else setRestoreError("Restore could not start. Finish any save or conflict and check browser storage before retrying."); }}>Replace kitchen with backup</button></div></section>}</section>

      <section className="panel settings-panel">
        <div className="section-heading"><div><span className="eyebrow">Cooking assistant</span><h2>AI settings</h2><p>Choose where Chef answers are generated. Recipe search stays local.</p></div></div>
        <div className="provider-grid">
          <button className={`provider-card ${settings.provider === "ollama" ? "selected" : ""}`} onClick={() => setSettings({ ...settings, provider: "ollama" })}><span className="provider-symbol">OL</span><strong>Ollama</strong><small>Private · runs on this Mac</small></button>
          <button className={`provider-card ${settings.provider === "openai" ? "selected" : ""}`} onClick={() => setSettings({ ...settings, provider: "openai" })}><span className="provider-symbol cloud">OA</span><strong>OpenAI</strong><small>Cloud · API key required</small></button>
        </div>
        <label className="model-field">Model<input value={settings.provider === "ollama" ? settings.ollamaModel : settings.openaiModel} onChange={(event) => setSettings(settings.provider === "ollama" ? { ...settings, ollamaModel: event.target.value } : { ...settings, openaiModel: event.target.value })} /></label>
        <div className="connection-row"><button className="secondary-button" onClick={testConnection}>Test connection</button><span>{connectionStatus || "Not tested"}</span></div>
      </section>

      <section className="panel settings-panel wide-panel">
        <div className="section-heading"><div><span className="eyebrow">Source adapters</span><h2>Where recipes come from</h2></div></div>
        <div className="source-list">
          {sources.map((source) => <div key={source.name}><span className="source-logo active">{source.name.slice(0, 1)}</span><div><strong>{source.name}</strong><small>{source.licenseId || "Prototype-approved · attributed"}</small></div><b>Cataloged</b></div>)}
          {!sources.length && <p>Load the recipe collection to see its sources.</p>}
        </div>
      </section>
    </div>
  );
}

export function RecipeDrawer({
  askAboutRecipe,
  recipe,
  plannedMeal,
  pantry,
  metric,
  setMetric,
  chefResult,
  close,
  addToPlan,
  addLabel,
  start,
  eligibility,
  metadata,
}: {
  askAboutRecipe?: () => void;
  recipe: Recipe;
  plannedMeal?: PlannedMeal;
  pantry: string[];
  metric: boolean;
  setMetric: (value: boolean) => void;
  chefResult: ChefResponse | null;
  close: () => void;
  addToPlan: () => void;
  addLabel: string;
  start: (steps: string[], method: string) => void;
  eligibility?: ReturnType<typeof evaluateRecipeConstraints>;
  metadata?: RecipeMetadata;
}) {
  const details = pantryDetails(recipe, pantry);
  const changes = chefResult?.chefChanges.filter((item) => item.recipeId === recipe.id) ?? [];
  const facts = chefResult?.sourceFacts.filter((item) => item.recipeId === recipe.id) ?? [];
  const directions = useMemo(() => instructionSections(recipe), [recipe]);
  const [directionIndex, setDirectionIndex] = useState(0);
  const activeDirection = directions[Math.min(directionIndex, directions.length - 1)];
  const originalIngredients = <><div className="drawer-section-heading"><h3>{plannedMeal ? "Original ingredients" : "Ingredients"}</h3><div className="unit-toggle"><button className={!metric ? "active" : ""} onClick={() => setMetric(false)}>Original</button><button className={metric ? "active" : ""} onClick={() => setMetric(true)}>Metric</button></div></div>
    <ul className="ingredient-list">{recipe.ingredients.map((ingredient, index) => <li key={`${ingredient.name}-${index}`}><strong>{ingredient.name}</strong><small>{metricMeasure(ingredient.measure, metric)}</small></li>)}</ul></>;
  return (
    <Modal className="drawer-backdrop" labelledBy="recipe-title" close={close}>
      <article className="recipe-drawer">
        <button className="drawer-close" onClick={close} aria-label="Close recipe">×</button>
        {recipe.image && <div className="drawer-hero"><img src={recipe.image} alt="" /></div>}
        <div className="drawer-content">
          <span className="eyebrow">{recipe.category}</span>
          <h2 id="recipe-title">{recipe.title}</h2>
          {metadata?.coreDinner && <span className="core-badge">Core dinner · reviewed source record</span>}
          <p className="pantry-coverage">{details.matched.length} of {details.total} ingredients in pantry <small className="coverage-note">Names only · amounts not checked</small></p>
          {eligibility && !eligibility.eligible && <p className="diet-note" role="alert">This recipe conflicts with your saved exclusions. Your saved dinner is unchanged. {eligibility.reasons.join(" ")}</p>}
          {Boolean(eligibility?.dietUnknowns.length) && <p className="diet-note">Diet not verified: {eligibility?.dietUnknowns.map((diet) => diet.replaceAll("_", " ")).join(", ")}</p>}
          {directions.length > 1 && (
            <div className="method-picker" aria-label="Choose cooking method">
              <span>Choose a method</span>
              <div>
                {directions.map((direction, index) => (
                  <button
                    className={index === directionIndex ? "active" : ""}
                    type="button"
                    aria-pressed={index === directionIndex}
                    key={`${direction.title}-${index}`}
                    onClick={() => setDirectionIndex(index)}
                  >
                    {direction.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="drawer-actions">{askAboutRecipe && <button className="secondary-button" onClick={askAboutRecipe}>Ask Chef about this recipe</button>}<button className="primary-button" onClick={() => activeDirection && start(activeDirection.steps, activeDirection.title)} disabled={!activeDirection}>Start cooking{activeDirection && directions.length > 1 ? ` · ${activeDirection.title}` : ""}</button><button className="secondary-button" disabled={eligibility && !eligibility.eligible} onClick={addToPlan}>{addLabel}</button></div>
          <p className="drawer-source-link">Source: <a href={recipe.sourceUrl} target={recipe.sourceUrl.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{sourceLabel(recipe)}</a></p>
          {plannedMeal ? <section className="planned-amounts" aria-label="Planned dinner ingredients"><h3>Ingredients for your dinner</h3><p className="quantity-note">{dateLabel(plannedMeal.date)} · {plannedMeal.servings ? `${plannedMeal.servings} servings` : `${mealScale(plannedMeal)} recipe batches`}. Final amounts for this dinner; source directions below use original recipe quantities.</p><ul className="ingredient-list">{resolvedMealIngredients(plannedMeal).map((ingredient, index) => {
            const amount = `${ingredient.measure || "Amount needs review"}${ingredient.needsReview && mealScale(plannedMeal) !== 1 ? ` · review for ${mealScale(plannedMeal)} batches` : ""}`;
            return <li key={index}><strong>{ingredient.name}</strong><small>{amount}</small></li>;
          })}</ul><details className="original-ingredients"><summary>Original recipe quantities</summary>{originalIngredients}</details></section> : originalIngredients}
          <div className="directions-heading">
            <div><h3>Source directions</h3>{activeDirection && directions.length > 1 && <span>{activeDirection.title} method</span>}</div>
            <small>{activeDirection?.steps.length ?? 0} steps</small>
          </div>
          {activeDirection ? (
            <ol className="instruction-list">{activeDirection.steps.map((step, index) => <li key={`${recipe.id}-${activeDirection.title}-step-${index}`}><span>{index + 1}</span><p>{step}</p></li>)}</ol>
          ) : (
            <div className="empty-directions">No source directions are available for this recipe.</div>
          )}
          <div className="source-citation">
            <span>Source citation</span>
            <p>From <a href={recipe.sourceUrl} target={recipe.sourceUrl.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{sourceLabel(recipe)}</a>.</p>
            {recipe.source.licenseUrl && <p>License: <a href={recipe.source.licenseUrl} target="_blank" rel="noreferrer">{recipe.source.licenseId || "Source license"}</a>.</p>}
            {recipe.source.attributionText && <p>{recipe.source.attributionText}</p>}
            {facts.length > 0 && (
              <ul className="source-facts">
                {facts.map((fact, index) => <li key={`${fact.fact}-${index}`}>{fact.fact}</li>)}
              </ul>
            )}
          </div>
          {changes.length > 0 && <section className="changes-panel"><span className="eyebrow">Chef’s changes</span><h3>Adapted for your kitchen</h3>{changes.map((change, index) => <div key={`${change.change}-${index}`}><strong>{change.change}</strong><p>{change.reason}</p></div>)}</section>}
        </div>
      </article>
    </Modal>
  );
}

function ingredientGlyph(value: string) {
  const ingredient = tidyIngredient(value);
  if (ingredient.includes("chicken")) return "◒";
  if (ingredient.includes("rice") || ingredient.includes("pasta")) return "≋";
  if (ingredient.includes("tomato")) return "●";
  if (ingredient.includes("garlic") || ingredient.includes("onion")) return "◉";
  if (ingredient.includes("lemon")) return "◐";
  if (ingredient.includes("bean") || ingredient.includes("chickpea")) return "◆";
  return "•";
}
