"use client";

/* eslint-disable @next/next/no-img-element -- Recipe images come from source adapters with dynamic hostnames. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Recipe, RecipeMetadata, RecipeMetadataMap } from "../lib/recipe-types";
import { evaluateRecipeConstraints, normalizeConstraints } from "../lib/recipe-constraints";
import { availablePantryNames } from "../lib/kitchen-stock";
import { parseKitchenBackup, serializeKitchenBackup } from "../lib/kitchen-backup";
import { CookingWorkspace } from "./CookingWorkspace";
import { COOKING_SESSION_KEY, canCompleteCookingSession, createCookingSession, parseCookingSession, plannedDinnerFingerprint, type CookingSession } from "../lib/cooking-session";
import { useKitchen } from "../lib/use-kitchen";
import { mealScale, type KitchenState, type PantryStock, type PlannedMeal } from "../lib/kitchen-types";
import { addDateDays, dinnerSelectionStatus, LEGACY_STORAGE_KEY, localDate, placePlannedDinner, weekStart } from "../lib/kitchen-state";
import { fillEmptyDays } from "../lib/kitchen-planning";
import { buildShoppingList, canonicalIngredient, completeMeal, consumptionPreview, parseMeasure, resolvedMealIngredients, undoMeal } from "../lib/quantities";
import { dateLabel, DurablePlanView, DurableShoppingView, PlanPicker } from "./WeeklyKitchenViews";
import { browseRecipes, recipeCompleteness, recipePantryDetails as pantryDetails, RECIPE_PAGE_SIZE } from "../lib/recipe-browser";

type View = "chef" | "recipes" | "pantry" | "plan" | "shop" | "settings";

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
  recipes: Recipe[];
  generation: "ai" | "catalog_fallback";
  answer: string;
  sourceFacts: Array<{ recipeId: string; fact: string }>;
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
  retrieval?: { method: string; catalogCount: number };
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
  const [view, setView] = useState<View>("plan");
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
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); }, [view]);
  const kitchen = useKitchen(LOCAL_RECIPES);
  const pantry = useMemo(() => availablePantryNames(kitchen.state.pantry, today), [kitchen.state.pantry, today]);
  const [pantryDraft, setPantryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [recipeQuery, setRecipeQuery] = useState("");
  const [recipeLimit, setRecipeLimit] = useState(RECIPE_PAGE_SIZE);
  const [coreDinnersOnly, setCoreDinnersOnly] = useState(false);
  const [maxMinutes, setMaxMinutes] = useState("");
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [settings, setSettings] = useState<AISettings>(DEFAULT_SETTINGS);
  const [recipes, setRecipes] = useState<Recipe[]>(LOCAL_RECIPES);
  const [catalogRecipes, setCatalogRecipes] = useState<Recipe[]>([]);
  const [metadataByRecipeId, setMetadataByRecipeId] = useState<RecipeMetadataMap>({});
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [planningNotice, setPlanningNotice] = useState("");
  const [planningReasons, setPlanningReasons] = useState<Record<string, string>>({});
  const [recipeStatus, setRecipeStatus] = useState("Loading licensed recipes…");
  const [loadingRecipes, setLoadingRecipes] = useState(false);
  const chefContext = JSON.stringify({ profile, pantry: kitchen.state.pantry, settings, today });
  const [chefBusyContext, setChefBusyContext] = useState<string | null>(null);
  const askingChef = chefBusyContext === chefContext;
  const [storedChefResult, setChefResult] = useState<(ChefResponse & { contextKey: string }) | null>(null);
  const chefResult = storedChefResult?.contextKey === chefContext ? storedChefResult : null;
  const chefRequest = useRef<{ id: number; controller: AbortController | null }>({ id: 0, controller: null });
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [metric, setMetric] = useState(true);
  const [week, setWeek] = useState(() => weekStart());
  const [planPicker, setPlanPicker] = useState<Recipe | null>(null);
  const [selectionDate, setSelectionDate] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [pendingChoice, setPendingChoice] = useState<{ date: string; recipe: Recipe; expectedId: string } | null>(null);
  const [reviewDate, setReviewDate] = useState<string | null>(null);
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

  const loadRecipes = useCallback(
    async (search = query) => {
      setLoadingRecipes(true);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("q", search.trim());
        if (pantry.length) params.set("pantry", pantry.join(","));
        const response = await fetch(`/api/recipes?${params.toString()}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Recipe source unavailable");
        const data = await response.json() as { recipes?: Recipe[]; meta?: { source?: { name?: string } } };
        const incoming: Recipe[] = data.recipes ?? [];
        if (incoming.length) {
          setRecipes(incoming);
          setRecipeStatus(
            `${incoming.length} recipes from ${data.meta?.source?.name ?? "the approved catalog"}`,
          );
        } else {
          setRecipeStatus("Using the local starter collection");
        }
      } catch {
        setRecipeStatus("Offline — using the local starter collection");
        setRecipes((current) => (current.length ? current : LOCAL_RECIPES));
      } finally {
        setLoadingRecipes(false);
      }
    },
    [pantry, query],
  );

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

  useEffect(() => {
    if (!hydrated || !kitchen.ready) return;
    const id = window.setTimeout(() => void loadRecipes(""), 0);
    return () => window.clearTimeout(id);
    // Initial source hydration should happen once after local state is restored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, kitchen.ready]);

  const constraints = useMemo(() => normalizeConstraints(profile), [profile]);
  const metadataForRecipe = (recipe: Recipe) => {
    const current = catalogRecipes.find((item) => item.id === recipe.id);
    return current && JSON.stringify(current) === JSON.stringify(recipe) ? metadataByRecipeId[recipe.id] : undefined;
  };
  const eligibilityFor = (recipe: Recipe) => evaluateRecipeConstraints(recipe, metadataForRecipe(recipe), constraints);
  const rankedRecipes = useMemo(() => {
    return recipes
      .filter((recipe) => evaluateRecipeConstraints(recipe, metadataByRecipeId[recipe.id], constraints).eligible)
      .sort(
        (a, b) =>
          evaluateRecipeConstraints(a, metadataByRecipeId[a.id], constraints).dislikedIngredients.length - evaluateRecipeConstraints(b, metadataByRecipeId[b.id], constraints).dislikedIngredients.length || pantryDetails(b, pantry).coverage - pantryDetails(a, pantry).coverage,
      );
  }, [pantry, constraints, metadataByRecipeId, recipes]);

  const browseCatalog = useMemo(() => catalogRecipes.filter((recipe) => evaluateRecipeConstraints(recipe, metadataByRecipeId[recipe.id], constraints).eligible), [catalogRecipes, constraints, metadataByRecipeId]);
  const browserResults = useMemo(() => browseRecipes(browseCatalog, recipeQuery, pantry).filter((recipe) => {
    const metadata = metadataByRecipeId[recipe.id];
    if (coreDinnersOnly && !metadata?.coreDinner) return false;
    return !maxMinutes || Number(maxMinutes) <= 0 || Boolean(metadata?.provenance.totalMinutes?.basis === "source" && metadata.totalMinutes !== null && metadata.totalMinutes <= Number(maxMinutes));
  }), [browseCatalog, recipeQuery, pantry, coreDinnersOnly, maxMinutes, metadataByRecipeId]);

  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, index) => addDateDays(week, index)), [week]);
  const weekMeals = useMemo(() => weekDates.flatMap((date) => kitchen.state.meals[date] ? [kitchen.state.meals[date]] : []), [kitchen.state.meals, weekDates]);
  const shoppingItems = useMemo(() => buildShoppingList(weekMeals, kitchen.state.pantry, today).map((item) => ({ ...item, key: `${week}:${item.key}` })), [weekMeals, kitchen.state.pantry, week, today]);
  function recipeAllowed(recipe: Recipe) {
    return eligibilityFor(recipe).eligible;
  }

  function addPantryItem(value = pantryDraft) {
    const next = tidyIngredient(value);
    if (!next || pantry.some((item) => canonicalIngredient(item) === canonicalIngredient(next))) return;
    kitchen.update((state) => ({ ...state, pantry: [...state.pantry, { id: crypto.randomUUID(), name: next, measure: "" }] }));
    setPantryDraft("");
  }

  function removePantryItem(id: string) {
    kitchen.update((state) => ({ ...state, pantry: state.pantry.filter((item) => item.id !== id) }));
  }

  async function askChef(prompt = query) {
    chefRequest.current.controller?.abort();
    const controller = new AbortController();
    const requestId = ++chefRequest.current.id;
    chefRequest.current.controller = controller;
    const contextKey = chefContext;
    const finalQuery = prompt.trim() || "What can I cook with what I have?";
    setQuery(finalQuery);
    setChefBusyContext(contextKey);
    try {
      const response = await fetch("/api/chef", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          query: finalQuery,
          pantry: kitchen.state.pantry.filter((item) => availablePantryNames([item], today).length > 0).map((item) => ({ name: item.name, quantity: item.measure || undefined })),
          profile,
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
      setChefResult({ ...data, contextKey });
      if (data.metadataByRecipeId) setMetadataByRecipeId((current) => ({ ...current, ...data.metadataByRecipeId }));
      setRecipeStatus(`${data.retrieval?.catalogCount ?? 0} approved recipes searched · ${data.generation === "ai" ? "Chef recommendations" : "catalog suggestions"}`);
    } catch (error) {
      if (requestId !== chefRequest.current.id || controller.signal.aborted) return;
      setChefResult({
        contextKey,
        answer: error instanceof Error ? error.message : "Chef could not load the approved catalog. Please retry.",
        recipes: [], generation: "catalog_fallback",
        sourceFacts: [],
        chefChanges: [],
        recommendations: [], citations: [], warnings: [],
      });
    } finally {
      if (requestId === chefRequest.current.id) setChefBusyContext(null);
    }
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
    const proposed = fillEmptyDays(candidates, kitchen.state.pantry, week, kitchen.state.meals, today);
    const emptyDays = weekDates.filter((date) => date >= today && !kitchen.state.meals[date]).length;
    setPlanningReasons(proposed.reasons);
    setPlanningNotice(emptyDays === 0 ? "No upcoming empty days in this week. Past dinners can be added manually." : proposed.additions.length < emptyDays ? `Added ${proposed.additions.length} different eligible dinners. Remaining days were left empty.` : "Upcoming empty days filled without repeats. Saved dinners reserve their pantry stock first.");
    kitchen.update((state) => ({ ...state, meals: fillEmptyDays(candidates, state.pantry, week, state.meals, today).meals }));
  }

  function addRecipeToPlan(recipe: Recipe) {
    setSelectedRecipe(null);
    setSelectionNotice("");
    if (!selectionDate) { setPlanPicker(recipe); return; }
    const current = kitchen.state.meals[selectionDate];
    if (current?.locked || current?.status === "cooked") {
      setSelectionNotice("This dinner is locked or cooked. Return to Plan to choose another day or unlock it."); return;
    }
    if (current) setPendingChoice({ date: selectionDate, recipe, expectedId: current.id });
    else chooseMeal(selectionDate, recipe, undefined, null);
  }

  function chooseMeal(date: string, recipe: Recipe, template?: PlannedMeal, expectedId: string | null = null): boolean {
    if (dinnerSelectionStatus(kitchen.state.meals, date, expectedId) !== "available" || !recipeAllowed(recipe)) {
      setSelectionNotice("This dinner or your exclusions changed. Choose again; the saved dinner is unchanged."); return false;
    }
    kitchen.update((state) => placePlannedDinner(state, date, recipe, expectedId, template));
    setSelectionDate(null); setPendingChoice(null); setPlanPicker(null); setSelectedRecipe(null); setReviewDate(null);
    setWeek(weekStart(date)); setView("plan"); setSelectionNotice("");
    setPlanningNotice(`Dinner saved for ${dateLabel(date)}.`);
    return true;
  }

  function chooseDay(date: string) {
    if (kitchen.state.meals[date]?.locked || kitchen.state.meals[date]?.status === "cooked") return;
    setSelectionDate(date); setSelectionNotice(""); setReviewDate(null); setView("recipes");
  }

  function navigate(next: View) {
    setSelectionDate(null); setSelectionNotice(""); setPendingChoice(null); setReviewDate(null); setView(next);
  }

  function reviewMeal(date: string) {
    setWeek(weekStart(date)); setReviewDate(date); setView("plan");
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
  const visibleRecipes = chefResult
    ? chefResult.recipes.filter((recipe) => recommendationIds.has(recipe.id) && recipeAllowed(recipe))
    : rankedRecipes;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <button className="brand" onClick={() => navigate("plan")}>
          <span className="brand-mark">R</span>
          <span>
            <strong>RAG Chef</strong>
            <small>Cook with what you have</small>
          </span>
        </button>

        <nav className="side-nav">
          <NavButton active={view === "plan"} icon="▦" label="Plan" onClick={() => navigate("plan")} />
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
            <button className="secondary-button" aria-label="Settings" onClick={() => setView("settings")}>⚙</button>
          </div>
        </header>

        {(kitchen.saveState === "offline" || kitchen.saveState === "error" || !kitchen.backupAvailable) && <div className="inline-confirm" role="alert"><span>{kitchen.status}{!kitchen.backupAvailable && " Browser backup is unavailable; keep this tab open until saved to this Mac."}</span><button className="secondary-button" onClick={kitchen.retrySave}>Retry save</button></div>}
        {kitchen.conflict && <div className="inline-confirm" role="alert"><span>Your browser draft and the saved kitchen differ. Choose the version to keep.</span><button className="secondary-button" onClick={() => kitchen.resolveConflict(false)}>Load saved version</button><button className="primary-button" onClick={() => kitchen.resolveConflict(true)}>Save this draft</button></div>}
        {cookingStorageNotice && <p className="quantity-note" role="alert">{cookingStorageNotice}</p>}
        {cookingSession && !cooking && <div className="inline-confirm" role="status"><span>{cookingSession.timer.status === "finished" ? "Timer finished. " : "Saved cooking session: "}{cookingSession.recipe.title}</span><button className="primary-button" onClick={() => setCooking(true)}>Resume cooking</button><button className="secondary-button" onClick={() => persistCookingSession(null)}>Discard cooking session</button></div>}
        {kitchen.recoveryCandidates.length > 0 && <details className="panel recovery-panel"><summary>Unsaved kitchens found ({kitchen.recoveryCandidates.length})</summary><p>Review a saved browser draft before replacing the kitchen in this tab. Other tabs keep their work.</p>{kitchen.recoveryCandidates.map((draft) => <article className="recovery-candidate" key={draft.id}><strong>{draft.updatedAt ? new Date(draft.updatedAt).toLocaleString() : "Time unknown"}</strong><p>{draft.pantryCount} pantry rows · {draft.mealCount} dinners</p><p className="quantity-note">Compared with this kitchen: {draft.differences.pantryAdded} pantry rows added, {draft.differences.pantryRemoved} removed, {draft.differences.pantryChanged} changed; {draft.differences.mealsAdded} dinners added, {draft.differences.mealsRemoved} removed, {draft.differences.mealsChanged} changed.</p><div className="modal-actions"><button className="secondary-button" disabled={kitchen.busy} onClick={() => { if (kitchen.recoverDraft(draft.id)) setView("plan"); }}>Recover this draft</button><button className="text-button" disabled={kitchen.busy} onClick={() => kitchen.discardDraft(draft.id)}>Discard this draft</button></div></article>)}</details>}
        <fieldset className="kitchen-workspace" disabled={!kitchen.ready}>

        {view === "chef" && (<>
          <button className="secondary-button flow-back" onClick={() => setView("recipes")}>← Back to Recipes</button>
          <ChefView
            pantry={pantry}
            pantryItems={kitchen.state.pantry.filter((item) => availablePantryNames([item], today).length > 0)}
            pantryDraft={pantryDraft}
            setPantryDraft={setPantryDraft}
            query={query}
            setQuery={setQuery}
            addPantryItem={addPantryItem}
            removePantryItem={removePantryItem}
            askChef={askChef}
            askingChef={askingChef}
            cancelChef={cancelChef}
            chefResult={chefResult}
            recipes={visibleRecipes}
            recipeStatus={recipeStatus}
            loadingRecipes={loadingRecipes}
            refreshRecipes={() => void loadRecipes()}
            openRecipe={openRecipe}
            detailsFor={(recipe) => pantryDetails(recipe, pantry)}
            eligibilityFor={eligibilityFor}
            metadataForRecipe={metadataForRecipe}
            generatePlan={generatePlan}
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
            {selectionDate && <div className="inline-confirm" role="status"><span>Choosing dinner for {dateLabel(selectionDate, { weekday: "long", month: "long", day: "numeric" })}.</span><button className="secondary-button" onClick={() => navigate("plan")}>Cancel selection</button></div>}
            {selectionNotice && <p role="alert">{selectionNotice}</p>}
            <div className="section-heading"><p>Search names and ingredients · pantry matches first.</p><button className="secondary-button" onClick={() => setView("chef")}>Ask Chef</button></div>
            <div className="catalog-search panel"><label htmlFor="recipe-search">Search recipes</label><div className="catalog-search-row"><input id="recipe-search" type="search" placeholder="Recipe name or ingredient…" value={recipeQuery} onChange={(event) => { setRecipeQuery(event.target.value); setRecipeLimit(RECIPE_PAGE_SIZE); }} /><button className="secondary-button" disabled={!recipeQuery} onClick={() => { setRecipeQuery(""); setRecipeLimit(RECIPE_PAGE_SIZE); }}>Clear search</button></div><div className="catalog-filters"><label><input type="checkbox" checked={coreDinnersOnly} onChange={(event) => { setCoreDinnersOnly(event.target.checked); setRecipeLimit(RECIPE_PAGE_SIZE); }} />Core dinners</label><label>Maximum total minutes<input type="number" min="1" max="1440" placeholder="Any" value={maxMinutes} onChange={(event) => { setMaxMinutes(event.target.value); setRecipeLimit(RECIPE_PAGE_SIZE); }} /></label></div>{maxMinutes && <p className="quantity-note">Time filtering includes source-backed total times only. Recipes with unknown times are hidden.</p>}</div>
            {catalogState === "loading" ? <div className="empty-state" role="status"><strong>Loading your recipe collection…</strong></div>
              : catalogState === "error" ? <div className="empty-state" role="alert"><strong>The recipe collection could not load.</strong><p>Your saved dinners are unchanged. Retry to browse the approved catalog.</p><button className="primary-button" onClick={() => void loadPlanningCatalog()}>Retry recipes</button></div>
              : <>
                <p className="catalog-count" role="status">{browserResults.length} of {browseCatalog.length} recipes{browserResults.length > recipeLimit ? ` · Showing ${recipeLimit}` : ""}</p>
                {(profile.allergies.length > 0 || constraints.diets.length > 0 || constraints.equipmentSpecified) && <p className="quantity-note">{catalogRecipes.length - browseCatalog.length} recipes hidden by your saved diet, allergy or equipment requirements. Unknown dietary suitability stays visible with a label. Always check source ingredients and labels; recipes are not allergy-certified.</p>}
                {catalogRecipes.length === 0 ? <div className="empty-state"><strong>Your recipe collection is empty.</strong><p>Import approved recipes to start browsing.</p></div>
                  : browserResults.length === 0 ? <div className="empty-state"><strong>No recipes match.</strong><p>{browseCatalog.length === 0 ? "Your saved exclusions hide the available recipes." : "Try fewer words or a different ingredient."}</p></div>
                  : <div className="recipe-grid">{browserResults.slice(0, recipeLimit).map((recipe) => <RecipeCard key={recipe.id} recipe={recipe} metadata={metadataByRecipeId[recipe.id]} details={pantryDetails(recipe, pantry)} dietUnknowns={eligibilityFor(recipe).dietUnknowns} featured={false} open={() => openRecipe(recipe)} add={() => addRecipeToPlan(recipe)} addLabel={selectionDate ? `Add to ${dateLabel(selectionDate, { weekday: "long" })}` : "Add to plan"} />)}</div>}
                {browserResults.length > recipeLimit && <div className="catalog-more"><button className="secondary-button" onClick={() => setRecipeLimit((limit) => limit + RECIPE_PAGE_SIZE)}>Show more</button></div>}
              </>}
          </section>
        )}

        {view === "plan" && (
          <DurablePlanView
            catalogState={catalogState}
            retryCatalog={() => void loadPlanningCatalog()}
            planningNotice={planningNotice}
            planningReasons={planningReasons}
            week={week}
            today={hydrated ? today : undefined}
            setWeek={(value) => { setWeek(value); setPlanningNotice(""); setPlanningReasons({}); setReviewDate(null); }}
            meals={kitchen.state.meals}
            update={kitchen.update}
            chooseMeal={chooseMeal}
            chooseDay={chooseDay}
            cookMeal={cookMeal}
            reviewDate={reviewDate}
            setReviewDate={setReviewDate}
            generatePlan={generatePlan}
            openMeal={(date) => { const meal = kitchen.state.meals[date]; if (meal?.recipe) { setCookingMealDate(date); setSelectedRecipe(meal.recipe); } }}
            markCooked={(date) => { setCompletionMealId(kitchen.state.meals[date]?.id ?? null); setCompletionFingerprint(plannedDinnerFingerprint(kitchen.state.meals[date])); setCompletionDate(date); setDeductStock(false); }}
            undoCooked={(date) => kitchen.update((state) => undoMeal(state, date))}
            goShopping={() => setView("shop")}
          />
        )}

        {view === "shop" && (
          <DurableShoppingView
            items={shoppingItems}
            checked={kitchen.state.shoppingChecked}
            update={kitchen.update}
            hasPlan={weekMeals.length > 0}
            week={week}
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
        </fieldset>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <NavButton active={view === "plan"} icon="▦" label="Plan" onClick={() => navigate("plan")} />
        <NavButton active={view === "recipes"} icon="▤" label="Recipes" onClick={() => navigate("recipes")} />
        <NavButton active={view === "shop"} icon="✓" label="Shopping" onClick={() => navigate("shop")} />
        <NavButton active={view === "pantry"} icon="◌" label="Pantry" onClick={() => navigate("pantry")} />
      </nav>

      {pendingChoice && <div className="kitchen-modal-backdrop"><section className="panel kitchen-modal" role="dialog" aria-modal="true" aria-label="Replace dinner"><h2>Replace this dinner?</h2><p>Replace {kitchen.state.meals[pendingChoice.date]?.title} on {dateLabel(pendingChoice.date)} with {pendingChoice.recipe.title}?</p>{dinnerSelectionStatus(kitchen.state.meals, pendingChoice.date, pendingChoice.expectedId) !== "available" && <p>This dinner changed or became locked or cooked. Cancel and choose again.</p>}<div className="modal-actions"><button className="secondary-button" onClick={() => setPendingChoice(null)}>Keep current dinner</button><button className="primary-button" disabled={dinnerSelectionStatus(kitchen.state.meals, pendingChoice.date, pendingChoice.expectedId) !== "available"} onClick={() => chooseMeal(pendingChoice.date, pendingChoice.recipe, undefined, pendingChoice.expectedId)}>Replace dinner</button></div></section></div>}
      {planPicker && <PlanPicker key={planPicker.id} recipe={planPicker} week={week} meals={kitchen.state.meals} close={() => setPlanPicker(null)} choose={(date, recipe, expectedId) => chooseMeal(date, recipe, undefined, expectedId)} />}
      {completionDate && kitchen.state.meals[completionDate] && (() => {
        const meal = kitchen.state.meals[completionDate];
        const unchanged = meal.id === completionMealId && plannedDinnerFingerprint(meal) === completionFingerprint;
        const preview = consumptionPreview(meal, kitchen.state.pantry, today);
        return <div className="kitchen-modal-backdrop"><section className="panel kitchen-modal" role="dialog" aria-modal="true" aria-label="Complete dinner"><span className="eyebrow">Dinner finished</span><h2>{meal.title}</h2><p>Mark this dinner cooked to remove its remaining needs from shopping. You can undo this in the plan.</p>{!unchanged && <p role="alert">This dinner changed. Cancel and open the current dinner before completing it.</p>}<label className="deduct-checkbox"><input type="checkbox" checked={deductStock} onChange={(event) => setDeductStock(event.target.checked)} />Deduct the matching pantry amounts shown below</label><ul>{preview.deductions.map((item) => <li key={item.pantryId}>{kitchen.state.pantry.find((stock) => stock.id === item.pantryId)?.name}: {item.before} → {item.after}</li>)}</ul>{preview.notes.map((note, index) => <p className="quantity-note" key={index}>{note}</p>)}{!preview.deductions.length && <p>No compatible, measured pantry stock to deduct.</p>}<div className="modal-actions"><button className="secondary-button" onClick={() => setCompletionDate(null)}>Cancel</button><button className="primary-button" disabled={!unchanged} onClick={() => { kitchen.update((state) => state.meals[completionDate]?.id === completionMealId && plannedDinnerFingerprint(state.meals[completionDate]) === completionFingerprint ? completeMeal(state, completionDate, deductStock) : state); setCompletionDate(null); setSelectedRecipe(null); setView("plan"); }}>Confirm cooked</button></div></section></div>;
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
          addToPlan={() => addRecipeToPlan(selectedRecipe)}
          addLabel={selectionDate ? `Add to ${dateLabel(selectionDate, { weekday: "long" })}` : "Add to plan"}
          start={(steps, method) => void startCooking(selectedRecipe, steps, method)}
        />
      )}

      {cookingSession && (
        <CookingWorkspace
          key={cookingSession.id}
          session={cookingSession}
          visible={cooking}
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
      {pendingCookingStart && <div className="kitchen-modal-backdrop"><section className="panel kitchen-modal" role="dialog" aria-modal="true" aria-label="Replace cooking session"><h2>Keep your current cooking session?</h2><p>{cookingSession?.recipe.title} has saved progress{cookingSession?.timer.status === "running" ? " and a running timer" : ""}. Starting {pendingCookingStart.recipe.title} will replace that progress and timer.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setPendingCookingStart(null)}>Keep current session</button><button className="primary-button" onClick={() => { persistCookingSession(pendingCookingStart); setPendingCookingStart(null); setSelectedRecipe(null); setCooking(true); }}>Replace cooking session</button></div></section></div>}
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
  pantry,
  pantryItems,
  pantryDraft,
  setPantryDraft,
  query,
  setQuery,
  addPantryItem,
  removePantryItem,
  askChef,
  askingChef,
  cancelChef,
  chefResult,
  recipes,
  recipeStatus,
  loadingRecipes,
  refreshRecipes,
  openRecipe,
  detailsFor,
  eligibilityFor,
  metadataForRecipe,
  generatePlan,
}: {
  pantry: string[];
  pantryItems: PantryStock[];
  pantryDraft: string;
  setPantryDraft: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  addPantryItem: (value?: string) => void;
  removePantryItem: (value: string) => void;
  askChef: (prompt?: string) => Promise<void>;
  askingChef: boolean;
  cancelChef: () => void;
  chefResult: ChefResponse | null;
  recipes: Recipe[];
  recipeStatus: string;
  loadingRecipes: boolean;
  refreshRecipes: () => void;
  openRecipe: (recipe: Recipe) => void;
  detailsFor: (recipe: Recipe) => ReturnType<typeof pantryDetails>;
  eligibilityFor: (recipe: Recipe) => ReturnType<typeof evaluateRecipeConstraints>;
  metadataForRecipe: (recipe: Recipe) => RecipeMetadata | undefined;
  generatePlan: () => void;
}) {
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const prompts = [
    "A quick dinner under 30 minutes",
    "Something cozy and one-pot",
    "Use my pantry ingredients",
  ];

  return (
    <>
      <section className="chef-hero">
        <div className="hero-copy">
          <p>Tell me what sounds good. Suggestions use real recipes; changes are marked separately.</p>
        </div>

        <div className="chef-composer">
          <label htmlFor="chef-query">Ask your chef</label>
          <textarea
            id="chef-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                void askChef();
              }
            }}
            placeholder="I want something comforting, not too heavy…"
          />
          <div className="composer-bottom">
            <span>{pantry.length} pantry items ready</span>
            <button className="primary-button" onClick={() => void askChef()} disabled={askingChef}>
              {askingChef ? "Chef is thinking…" : "Find my dinner"}
              <span aria-hidden="true">→</span>
            </button>
            {askingChef && <button className="secondary-button" onClick={cancelChef}>Cancel request</button>}
          </div>
        </div>

        <div className="quick-prompts" aria-label="Quick prompts">
          {prompts.map((prompt) => (
            <button key={prompt} onClick={() => void askChef(prompt)}>{prompt}</button>
          ))}
        </div>
      </section>

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

      {chefResult && (
        <section className="chef-answer" aria-live="polite">
          <div className="chef-stamp">{chefResult.generation === "ai" ? "Chef’s note" : "Catalog suggestions"}</div>
          <div>
            <p>{chefResult.answer}</p>
            {chefResult.warnings.map((warning) => <small key={warning}>{warning}</small>)}
          </div>
          {chefResult.recommendations.length > 0 && <button className="secondary-button" onClick={generatePlan}>Plan the week</button>}
        </section>
      )}

      <section className="recipe-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Grounded picks</span>
            <h3>{chefResult ? "Your chef’s shortlist" : "Best matches from your pantry"}</h3>
            <p>{recipeStatus}</p>
          </div>
          <button className="refresh-button" onClick={refreshRecipes} disabled={loadingRecipes}>
            {loadingRecipes ? "Refreshing…" : "Refresh matches"}
          </button>
        </div>

        <div className="recipe-grid">
          {recipes.slice(0, 6).map((recipe, index) => (
            <RecipeCard
              key={recipe.id}
              recipe={recipe}
              details={detailsFor(recipe)}
              dietUnknowns={eligibilityFor(recipe).dietUnknowns}
              recommendation={chefResult?.recommendations.find((item) => item.recipeId === recipe.id)}
              metadata={metadataForRecipe(recipe)}
              featured={index === 0}
              open={() => openRecipe(recipe)}
            />
          ))}
        </div>
        {!recipes.length && (
          <div className="empty-state">
            <strong>{chefResult?.outcome === "no_match" ? "No relevant recipe found." : "No recipes to show."}</strong>
            <p>{chefResult?.outcome === "constraints_unsatisfied" ? "Keep your exclusions and review the available recipe collection." : "Try a different dish or a broader dinner request."}</p>
          </div>
        )}
      </section>
    </>
  );
}

export function RecipeCard({
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
        <p className="pantry-coverage">{details.matched.length} of {details.total} ingredients in pantry</p>
        <small className="coverage-note">Names only · amounts not checked</small>
        {dietUnknowns.length > 0 && <p className="diet-note">Diet not verified: {dietUnknowns.map((diet) => diet.replaceAll("_", " ")).join(", ")}</p>}
        <small className="recipe-quality">{recipe.servings ? `${recipe.servings} source servings` : "Yield unknown · recipe batches"}{completeness.amountReviewCount ? ` · ${completeness.amountReviewCount} amounts to review` : " · Amounts quantified"}{metadata?.totalMinutes !== null && metadata?.totalMinutes !== undefined ? ` · ${metadata.totalMinutes} min${metadata.provenance.totalMinutes?.basis === "source" ? " total" : " estimated"}` : " · Total time unknown"}</small>
        {recommendation && <div className="recommendation-details">{recommendation.matchReason && <p className="match-reason"><strong>Why this match:</strong> {recommendation.matchReason}</p>}{recommendation.reason !== recommendation.matchReason && <p>{recommendation.reason}</p>}<p className="quantity-note">{recommendation.missingIngredients.length ? `Missing ingredient names: ${recommendation.missingIngredients.join(", ")}` : "All ingredient names match your pantry; check quantities before cooking."}</p></div>}
        <div className="recipe-footer">
          <a href={recipe.sourceUrl} target={recipe.sourceUrl.startsWith("#") ? undefined : "_blank"} rel="noreferrer" onClick={(event) => event.stopPropagation()}>
            Source: {sourceLabel(recipe)}
          </a>
          <button className="text-button" onClick={open} aria-label={`View ${recipe.title}`}>View recipe</button>
        </div>
        {add && <button className="primary-button recipe-add-action" onClick={add} aria-label={`${addLabel}: ${recipe.title}`}>{addLabel}</button>}
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
            <p>Add ingredients below. Amounts are optional.</p>
          </div>
        </div>
        <form className="add-form" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Try ‘canned tomatoes’" aria-label="New pantry ingredient" />
          <button className="primary-button" type="submit">Add to pantry</button>
        </form>
        <p className="quantity-note">Use amounts such as 300 g or 2 cans. Leave unknown amounts blank; they won’t be subtracted from shopping.</p>
        <div className="unified-pantry-list">
          {pantry.map((item) => (
            <div className="unified-pantry-item" key={item.id}>
              <label><strong>{item.name}</strong><input aria-label={`Available ${item.name}`} placeholder="Amount unknown" value={item.measure} onChange={(event) => {
                const measure = event.target.value;
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
      <section className="panel settings-panel wide-panel"><h2>Kitchen backup</h2><p>Plans and pantry amounts save automatically on this Mac.</p><button className="secondary-button" onClick={exportBackup}>Export backup</button>{backupExportError && <p role="alert">{backupExportError}</p>}<label className="backup-upload">Restore backup<input type="file" accept="application/json,.json" aria-label="Restore backup file" onChange={(event) => { void readBackup(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label><p className="quantity-note">Restore replaces this kitchen. A recovery copy is preserved first. Recipe catalog and model preferences are separate.</p>{restoreError && <p role="alert">{restoreError}</p>}{restorePreview && <section className="restore-preview" role="region" aria-label="Backup preview"><h3>Review this backup</h3><p>Exported {new Date(restorePreview.exportedAt).toLocaleString()}</p><p>Backup: {restorePreview.state.pantry.length} pantry rows · {Object.keys(restorePreview.state.meals).length} dinners</p><p>Current kitchen: {currentKitchen.pantry.length} pantry rows · {Object.keys(currentKitchen.meals).length} dinners</p><p>Amounts, cooked records, and shopping checks will be replaced with the backup’s values.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setRestorePreview(null)}>Cancel restore</button><button className="primary-button" disabled={!canRestore} onClick={() => { if (restoreBackup(restorePreview.state)) { setRestorePreview(null); setRestoreError(""); } else setRestoreError("Restore could not start. Finish any save or conflict and check browser storage before retrying."); }}>Replace kitchen with backup</button></div></section>}</section>
      <section className="panel settings-panel">
        <div className="section-heading"><div><span className="eyebrow">Personalization</span><h2>How you cook</h2><p>Allergies are filtered before a recipe reaches the model.</p></div></div>
        <div className="form-grid">
          <label>Diet<select value={profile.diet} onChange={(event) => setProfile({ ...profile, diet: event.target.value })}><option>No restriction</option><option>Vegetarian</option><option>Vegan</option><option>Gluten-free</option><option>Low-carb</option></select><small>Known conflicts are hidden. Unreviewed recipes stay visible as “Diet not verified.”</small></label>
          <label>Skill level<select value={profile.skillLevel} onChange={(event) => setProfile({ ...profile, skillLevel: event.target.value })}><option>New cook</option><option>Confident beginner</option><option>Experienced home cook</option></select></label>
          <label>Budget<select value={profile.budget} onChange={(event) => setProfile({ ...profile, budget: event.target.value })}><option>Low</option><option>Medium</option><option>Flexible</option></select></label>
          <fieldset className="equipment-options"><legend>Available equipment</legend>{["Oven", "Stovetop", "Microwave", "Blender", "Slow cooker", "Pressure cooker", "Air fryer", "Grill"].map((equipment) => <label key={equipment}><input type="checkbox" checked={profile.equipment.includes(equipment)} onChange={(event) => setProfile({ ...profile, equipment: event.target.checked ? [...profile.equipment, equipment] : profile.equipment.filter((item) => item !== equipment) })} />{equipment}</label>)}<small>Known required appliances must be selected. Unknown equipment stays visible.</small></fieldset>
          <label className="wide">Allergies<input value={profile.allergies.join(", ")} onChange={(event) => setProfile({ ...profile, allergies: event.target.value.split(",").map(tidyIngredient).filter(Boolean) })} placeholder="peanuts, shellfish" /><small>Use ingredient names separated by commas. Ambiguous matches still receive a warning.</small></label>
          <label className="wide">Dislikes<input value={profile.dislikes.join(", ")} onChange={(event) => setProfile({ ...profile, dislikes: event.target.value.split(",").map(tidyIngredient).filter(Boolean) })} placeholder="mushrooms, cilantro" /></label>
        </div>
      </section>

      <section className="panel settings-panel">
        <div className="section-heading"><div><span className="eyebrow">Switchable generation</span><h2>Choose your chef brain</h2><p>Retrieval stays local and provider-independent.</p></div></div>
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
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <article className="recipe-drawer" role="dialog" aria-modal="true" aria-labelledby="recipe-title">
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
          <div className="drawer-actions"><button className="primary-button" onClick={() => activeDirection && start(activeDirection.steps, activeDirection.title)} disabled={!activeDirection}>Start cooking{activeDirection && directions.length > 1 ? ` · ${activeDirection.title}` : ""}</button><button className="secondary-button" disabled={eligibility && !eligibility.eligible} onClick={addToPlan}>{addLabel}</button></div>
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
          {changes.length > 0 && <section className="changes-panel"><span className="eyebrow">Chef’s changes</span><h3>Adapted for your kitchen</h3>{changes.map((change, index) => <div key={`${change.change}-${index}`}><strong>{change.change}</strong><p>{change.reason}</p></div>)}</section>}
        </div>
      </article>
    </div>
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
