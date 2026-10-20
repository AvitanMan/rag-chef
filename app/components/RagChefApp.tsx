"use client";

/* eslint-disable @next/next/no-img-element -- Recipe images come from source adapters with dynamic hostnames. */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { Recipe } from "../lib/recipe-types";

type View = "chef" | "pantry" | "plan" | "shop" | "settings";

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
  retrieval?: { method: string; filteredCount: number };
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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

const STORAGE_KEY = "rag-chef-prototype-v1";

function tidyIngredient(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function ingredientMatches(ingredient: string, pantryItem: string) {
  const ingredientValue = tidyIngredient(ingredient);
  const pantryValue = tidyIngredient(pantryItem);
  return (
    ingredientValue.includes(pantryValue) || pantryValue.includes(ingredientValue)
  );
}

function pantryDetails(recipe: Recipe, pantry: string[]) {
  const matched = recipe.ingredients.filter((ingredient) =>
    pantry.some((item) => ingredientMatches(ingredient.name, item)),
  );
  const missing = recipe.ingredients.filter(
    (ingredient) =>
      !pantry.some((item) => ingredientMatches(ingredient.name, item)),
  );
  const ratio = recipe.ingredients.length
    ? matched.length / recipe.ingredients.length
    : 0;
  return {
    matched: matched.map((item) => item.name),
    missing: missing.map((item) => item.name),
    score: Math.min(98, Math.round(42 + ratio * 56)),
  };
}

function recipeHasAllergen(recipe: Recipe, allergies: string[]) {
  return allergies.some((allergy) =>
    recipe.ingredients.some((ingredient) =>
      ingredientMatches(ingredient.name, allergy),
    ),
  );
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
  const [pantry, setPantry] = useState<string[]>([
    "chicken",
    "rice",
    "garlic",
    "tomatoes",
    "onion",
  ]);
  const [pantryDraft, setPantryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [settings, setSettings] = useState<AISettings>(DEFAULT_SETTINGS);
  const [recipes, setRecipes] = useState<Recipe[]>(LOCAL_RECIPES);
  const [recipeStatus, setRecipeStatus] = useState("Loading licensed recipes…");
  const [loadingRecipes, setLoadingRecipes] = useState(false);
  const [askingChef, setAskingChef] = useState(false);
  const [chefResult, setChefResult] = useState<ChefResponse | null>(null);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [metric, setMetric] = useState(true);
  const [plan, setPlan] = useState<Record<string, string>>({});
  const [shoppingDone, setShoppingDone] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);
  const [cooking, setCooking] = useState(false);
  const [cookingStep, setCookingStep] = useState(0);
  const [cookingSteps, setCookingSteps] = useState<string[]>([]);
  const [cookingMethod, setCookingMethod] = useState("");
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("");

  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const state = JSON.parse(saved);
          if (Array.isArray(state.pantry)) setPantry(state.pantry);
          if (state.profile) setProfile({ ...DEFAULT_PROFILE, ...state.profile });
          if (state.settings)
            setSettings({ ...DEFAULT_SETTINGS, ...state.settings });
          if (state.plan) setPlan(state.plan);
          if (state.shoppingDone) setShoppingDone(state.shoppingDone);
        }
      } catch {
        // A corrupt local draft should never prevent the app from opening.
      }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ pantry, profile, settings, plan, shoppingDone }),
    );
  }, [hydrated, pantry, profile, settings, plan, shoppingDone]);

  useEffect(() => {
    if (!timerRunning || timerSeconds <= 0) return;
    const id = window.setInterval(() => {
      setTimerSeconds((seconds) => {
        if (seconds <= 1) {
          setTimerRunning(false);
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [timerRunning, timerSeconds]);

  const loadRecipes = useCallback(
    async (search = query) => {
      setLoadingRecipes(true);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("q", search.trim());
        if (pantry.length) params.set("pantry", pantry.join(","));
        const response = await fetch(`/api/recipes?${params.toString()}`);
        if (!response.ok) throw new Error("Recipe source unavailable");
        const data = await response.json();
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

  useEffect(() => {
    if (!hydrated) return;
    const id = window.setTimeout(() => void loadRecipes(""), 0);
    return () => window.clearTimeout(id);
    // Initial source hydration should happen once after local state is restored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const rankedRecipes = useMemo(() => {
    const queryTerms = tidyIngredient(query).split(" ").filter(Boolean);
    return recipes
      .filter((recipe) => !recipeHasAllergen(recipe, profile.allergies))
      .filter((recipe) => {
        if (!queryTerms.length) return true;
        const haystack = tidyIngredient(
          [
            recipe.title,
            recipe.category,
            recipe.cuisine,
            ...recipe.tags,
            ...recipe.ingredients.map((item) => item.name),
          ].join(" "),
        );
        return queryTerms.every((term) => haystack.includes(term));
      })
      .sort(
        (a, b) =>
          pantryDetails(b, pantry).score - pantryDetails(a, pantry).score,
      );
  }, [pantry, profile.allergies, query, recipes]);

  const plannedRecipes = useMemo(
    () =>
      DAYS.map((day) => recipes.find((recipe) => recipe.id === plan[day])).filter(
        Boolean,
      ) as Recipe[],
    [plan, recipes],
  );

  const shoppingItems = useMemo(() => {
    const items = new Map<string, { name: string; measures: string[] }>();
    for (const recipe of plannedRecipes) {
      for (const ingredient of recipe.ingredients) {
        if (pantry.some((item) => ingredientMatches(ingredient.name, item))) {
          continue;
        }
        const key = tidyIngredient(ingredient.name);
        const existing = items.get(key) ?? { name: ingredient.name, measures: [] };
        if (ingredient.measure && !existing.measures.includes(ingredient.measure)) {
          existing.measures.push(ingredient.measure);
        }
        items.set(key, existing);
      }
    }
    return [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [pantry, plannedRecipes]);

  function addPantryItem(value = pantryDraft) {
    const next = tidyIngredient(value);
    if (!next || pantry.some((item) => tidyIngredient(item) === next)) return;
    setPantry((items) => [...items, next]);
    setPantryDraft("");
  }

  function removePantryItem(value: string) {
    setPantry((items) => items.filter((item) => item !== value));
  }

  async function askChef(prompt = query) {
    const finalQuery = prompt.trim() || "What can I cook with what I have?";
    setQuery(finalQuery);
    setAskingChef(true);
    try {
      const candidates = rankedRecipes.length ? rankedRecipes.slice(0, 14) : recipes;
      const response = await fetch("/api/chef", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: finalQuery,
          pantry,
          profile,
          candidates,
          provider: settings.provider,
          model:
            settings.provider === "ollama"
              ? settings.ollamaModel
              : settings.openaiModel,
        }),
      });
      if (!response.ok) throw new Error("Chef provider unavailable");
      setChefResult(await response.json());
    } catch {
      const top = rankedRecipes.slice(0, 3);
      setChefResult({
        answer:
          top.length > 0
            ? `You already have a strong start for ${top[0].title}. I found ${top.length} grounded options and kept the source recipes separate from any suggested changes.`
            : "Add a few pantry ingredients and I’ll build a grounded shortlist for you.",
        sourceFacts: [],
        chefChanges: [],
        recommendations: top.map((recipe) => {
          const details = pantryDetails(recipe, pantry);
          return {
            recipeId: recipe.id,
            reason: `${details.matched.length} pantry ingredients already match.`,
            pantryMatch: details.matched,
            missingIngredients: details.missing.slice(0, 3),
          };
        }),
        citations: top.map((recipe) => ({
          recipeId: recipe.id,
          title: recipe.title,
          sourceName: sourceLabel(recipe),
          sourceUrl: recipe.sourceUrl,
        })),
        warnings: [
          "The AI provider was unavailable, so this shortlist uses deterministic pantry matching.",
        ],
        retrieval: { method: "pantry fallback", filteredCount: recipes.length },
      });
    } finally {
      setAskingChef(false);
    }
  }

  function generatePlan() {
    const candidates = rankedRecipes.length ? rankedRecipes : recipes;
    if (!candidates.length) return;
    const next: Record<string, string> = {};
    DAYS.forEach((day, index) => {
      next[day] = candidates[index % candidates.length].id;
    });
    setPlan(next);
    setView("plan");
  }

  function addRecipeToPlan(recipe: Recipe) {
    const day = DAYS.find((item) => !plan[item]) ?? "Mon";
    setPlan((current) => ({ ...current, [day]: recipe.id }));
    setSelectedRecipe(null);
    setView("plan");
  }

  async function startCooking(
    recipe: Recipe,
    steps: string[],
    method: string,
  ) {
    setSelectedRecipe(recipe);
    setCookingSteps(steps);
    setCookingMethod(method);
    setCookingStep(0);
    setCooking(true);
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<unknown> };
      };
      await nav.wakeLock?.request("screen");
    } catch {
      // Wake lock is a progressive enhancement.
    }
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
      const data = await response.json();
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
    ? rankedRecipes.filter((recipe) => recommendationIds.has(recipe.id)).concat(
        rankedRecipes.filter((recipe) => !recommendationIds.has(recipe.id)),
      )
    : rankedRecipes;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <button className="brand" onClick={() => setView("chef")}>
          <span className="brand-mark">R</span>
          <span>
            <strong>RAG Chef</strong>
            <small>Cook with what you have</small>
          </span>
        </button>

        <nav className="side-nav">
          <NavButton active={view === "chef"} icon="⌂" label="Chef" onClick={() => setView("chef")} />
          <NavButton active={view === "pantry"} icon="◌" label="Pantry" onClick={() => setView("pantry")} count={pantry.length} />
          <NavButton active={view === "plan"} icon="▦" label="Weekly plan" onClick={() => setView("plan")} />
          <NavButton active={view === "shop"} icon="✓" label="Shopping" onClick={() => setView("shop")} count={shoppingItems.length || undefined} />
          <NavButton active={view === "settings"} icon="⚙" label="Settings" onClick={() => setView("settings")} />
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
            <span className="eyebrow">Your kitchen, organized</span>
            <h1>{viewTitle(view)}</h1>
          </div>
          <div className="topbar-actions">
            <button className="provider-pill" onClick={() => setView("settings")}>
              <span className="status-dot" />
              {settings.provider === "ollama" ? "Local · Ollama" : "Cloud · OpenAI"}
            </button>
            <button className="avatar" aria-label="Open cooking profile" onClick={() => setView("settings")}>MC</button>
          </div>
        </header>

        {view === "chef" && (
          <ChefView
            pantry={pantry}
            pantryDraft={pantryDraft}
            setPantryDraft={setPantryDraft}
            query={query}
            setQuery={setQuery}
            addPantryItem={addPantryItem}
            removePantryItem={removePantryItem}
            askChef={askChef}
            askingChef={askingChef}
            chefResult={chefResult}
            recipes={visibleRecipes}
            recipeStatus={recipeStatus}
            loadingRecipes={loadingRecipes}
            refreshRecipes={() => void loadRecipes()}
            openRecipe={setSelectedRecipe}
            detailsFor={(recipe) => pantryDetails(recipe, pantry)}
            generatePlan={generatePlan}
          />
        )}

        {view === "pantry" && (
          <PantryView
            pantry={pantry}
            draft={pantryDraft}
            setDraft={setPantryDraft}
            add={addPantryItem}
            remove={removePantryItem}
            profile={profile}
            setView={setView}
          />
        )}

        {view === "plan" && (
          <PlanView
            plan={plan}
            setPlan={setPlan}
            recipes={rankedRecipes.length ? rankedRecipes : recipes}
            generatePlan={generatePlan}
            openRecipe={setSelectedRecipe}
            goShopping={() => setView("shop")}
          />
        )}

        {view === "shop" && (
          <ShoppingView
            items={shoppingItems}
            done={shoppingDone}
            setDone={setShoppingDone}
            hasPlan={plannedRecipes.length > 0}
            goPlan={() => setView("plan")}
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
          />
        )}
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        <NavButton active={view === "chef"} icon="⌂" label="Chef" onClick={() => setView("chef")} />
        <NavButton active={view === "pantry"} icon="◌" label="Pantry" onClick={() => setView("pantry")} />
        <NavButton active={view === "plan"} icon="▦" label="Plan" onClick={() => setView("plan")} />
        <NavButton active={view === "shop"} icon="✓" label="Shop" onClick={() => setView("shop")} />
      </nav>

      {selectedRecipe && !cooking && (
        <RecipeDrawer
          recipe={selectedRecipe}
          pantry={pantry}
          metric={metric}
          setMetric={setMetric}
          chefResult={chefResult}
          close={() => setSelectedRecipe(null)}
          addToPlan={() => addRecipeToPlan(selectedRecipe)}
          start={(steps, method) => void startCooking(selectedRecipe, steps, method)}
        />
      )}

      {selectedRecipe && cooking && (
        <CookingMode
          recipe={selectedRecipe}
          instructions={cookingSteps}
          method={cookingMethod}
          step={cookingStep}
          setStep={setCookingStep}
          seconds={timerSeconds}
          setSeconds={setTimerSeconds}
          running={timerRunning}
          setRunning={setTimerRunning}
          close={() => {
            setCooking(false);
            setSelectedRecipe(null);
            setTimerRunning(false);
          }}
        />
      )}
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
    chef: "Good evening, Matan",
    pantry: "Your pantry",
    plan: "This week’s table",
    shop: "Shopping list",
    settings: "Kitchen profile",
  }[view];
}

function ChefView({
  pantry,
  pantryDraft,
  setPantryDraft,
  query,
  setQuery,
  addPantryItem,
  removePantryItem,
  askChef,
  askingChef,
  chefResult,
  recipes,
  recipeStatus,
  loadingRecipes,
  refreshRecipes,
  openRecipe,
  detailsFor,
  generatePlan,
}: {
  pantry: string[];
  pantryDraft: string;
  setPantryDraft: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  addPantryItem: (value?: string) => void;
  removePantryItem: (value: string) => void;
  askChef: (prompt?: string) => Promise<void>;
  askingChef: boolean;
  chefResult: ChefResponse | null;
  recipes: Recipe[];
  recipeStatus: string;
  loadingRecipes: boolean;
  refreshRecipes: () => void;
  openRecipe: (recipe: Recipe) => void;
  detailsFor: (recipe: Recipe) => ReturnType<typeof pantryDetails>;
  generatePlan: () => void;
}) {
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const prompts = [
    "A quick dinner under 30 minutes",
    "Something cozy and one-pot",
    "Use my most perishable ingredients",
  ];

  return (
    <>
      <section className="chef-hero">
        <div className="hero-copy">
          <span className="hero-kicker">Pantry to plate</span>
          <h2>What sounds good tonight?</h2>
          <p>
            Tell me what you’re craving. I’ll ground every suggestion in a real
            recipe and mark my changes clearly.
          </p>
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
          {pantry.slice(0, 8).map((item) => (
            <button className="ingredient-chip" key={item} onClick={() => removePantryItem(item)} title="Remove ingredient">
              <span>{ingredientGlyph(item)}</span>{item}<b>×</b>
            </button>
          ))}
          {pantry.length > 8 && <span className="more-chip">+{pantry.length - 8} more</span>}
        </div>
      </section>

      {chefResult && (
        <section className="chef-answer" aria-live="polite">
          <div className="chef-stamp">Chef’s note</div>
          <div>
            <p>{chefResult.answer}</p>
            {chefResult.warnings.length > 0 && (
              <small>{chefResult.warnings[0]}</small>
            )}
          </div>
          <button className="secondary-button" onClick={generatePlan}>Plan the week</button>
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
              featured={index === 0}
              open={() => openRecipe(recipe)}
            />
          ))}
        </div>
        {!recipes.length && (
          <div className="empty-state">
            <strong>No safe matches yet.</strong>
            <p>Try a broader request or add another pantry ingredient.</p>
          </div>
        )}
      </section>
    </>
  );
}

function RecipeCard({
  recipe,
  details,
  featured,
  open,
}: {
  recipe: Recipe;
  details: ReturnType<typeof pantryDetails>;
  featured: boolean;
  open: () => void;
}) {
  return (
    <article className={`recipe-card ${featured ? "featured" : ""}`}>
      <button className="recipe-image" onClick={open} aria-label={`Open ${recipe.title}`}>
        {recipe.image ? (
          <img src={recipe.image} alt="" loading="lazy" />
        ) : (
          <span className="food-placeholder">{ingredientGlyph(recipe.ingredients[0]?.name ?? "meal")}</span>
        )}
        <span className="match-badge">{details.score}% pantry match</span>
      </button>
      <div className="recipe-card-body">
        <div className="recipe-meta">
          <span>{recipe.cuisine || recipe.category}</span>
          <span>{details.missing.length} missing</span>
        </div>
        <h4>{recipe.title}</h4>
        <p>
          {details.matched.length
            ? `Uses ${details.matched.slice(0, 3).join(", ")}.`
            : `A grounded ${recipe.category.toLowerCase()} option.`}
        </p>
        <div className="recipe-footer">
          <a href={recipe.sourceUrl} target={recipe.sourceUrl.startsWith("#") ? undefined : "_blank"} rel="noreferrer" onClick={(event) => event.stopPropagation()}>
            Source: {sourceLabel(recipe)}
          </a>
          <button onClick={open} aria-label={`View ${recipe.title}`}>→</button>
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
  profile,
  setView,
}: {
  pantry: string[];
  draft: string;
  setDraft: (value: string) => void;
  add: () => void;
  remove: (value: string) => void;
  profile: Profile;
  setView: (view: View) => void;
}) {
  return (
    <div className="page-grid pantry-page">
      <section className="panel large-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Typed pantry · first prototype</span>
            <h2>What do you have?</h2>
            <p>Ingredient names are saved on this device and used to rank recipes.</p>
          </div>
        </div>
        <form className="add-form" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Try ‘canned tomatoes’" aria-label="New pantry ingredient" />
          <button className="primary-button" type="submit">Add to pantry</button>
        </form>
        <div className="pantry-list">
          {pantry.map((item) => (
            <div className="pantry-item" key={item}>
              <span className="pantry-icon">{ingredientGlyph(item)}</span>
              <div><strong>{item}</strong><small>Available</small></div>
              <button onClick={() => remove(item)} aria-label={`Remove ${item}`}>×</button>
            </div>
          ))}
        </div>
      </section>

      <aside className="stacked-side">
        <section className="panel capture-card">
          <span className="eyebrow">Coming next</span>
          <h3>Capture ingredients</h3>
          <p>Photograph the fridge or scan a receipt, then confirm every detected item.</p>
          <button disabled>Take pantry photo</button>
          <button disabled>Scan a receipt</button>
        </section>
        <section className="panel profile-card">
          <span className="eyebrow">Hard filters</span>
          <h3>Cooking profile</h3>
          <dl>
            <div><dt>Diet</dt><dd>{profile.diet}</dd></div>
            <div><dt>Allergies</dt><dd>{profile.allergies.length ? profile.allergies.join(", ") : "None saved"}</dd></div>
            <div><dt>Skill</dt><dd>{profile.skillLevel}</dd></div>
          </dl>
          <button className="secondary-button" onClick={() => setView("settings")}>Edit profile</button>
        </section>
      </aside>
    </div>
  );
}

function PlanView({
  plan,
  setPlan,
  recipes,
  generatePlan,
  openRecipe,
  goShopping,
}: {
  plan: Record<string, string>;
  setPlan: (value: Record<string, string>) => void;
  recipes: Recipe[];
  generatePlan: () => void;
  openRecipe: (recipe: Recipe) => void;
  goShopping: () => void;
}) {
  return (
    <>
      <section className="planner-intro panel">
        <div>
          <span className="eyebrow">Pantry-aware</span>
          <h2>Make the week easier.</h2>
          <p>Reuse ingredients, keep leftovers moving, and change any meal you don’t love.</p>
        </div>
        <div className="planner-actions">
          <button className="secondary-button" onClick={() => setPlan({})}>Clear</button>
          <button className="primary-button" onClick={generatePlan}>Generate my week</button>
        </div>
      </section>
      <section className="week-grid">
        {DAYS.map((day) => {
          const recipe = recipes.find((item) => item.id === plan[day]);
          return (
            <article className={`day-card ${recipe ? "filled" : ""}`} key={day}>
              <span className="day-name">{day}</span>
              {recipe ? (
                <>
                  <button className="day-image" onClick={() => openRecipe(recipe)}>
                    {recipe.image ? <img src={recipe.image} alt="" /> : <span>{ingredientGlyph(recipe.ingredients[0]?.name ?? "meal")}</span>}
                  </button>
                  <strong>{recipe.title}</strong>
                  <small>{recipe.cuisine}</small>
                </>
              ) : (
                <div className="empty-day"><span>+</span><small>Add a meal</small></div>
              )}
              <select value={plan[day] ?? ""} onChange={(event) => setPlan({ ...plan, [day]: event.target.value })} aria-label={`Choose ${day} meal`}>
                <option value="">Choose…</option>
                {recipes.slice(0, 20).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </article>
          );
        })}
      </section>
      <div className="plan-footer">
        <p><strong>{Object.keys(plan).filter((day) => plan[day]).length} meals planned.</strong> Shopping updates automatically.</p>
        <button className="primary-button" onClick={goShopping}>Open shopping list →</button>
      </div>
    </>
  );
}

function ShoppingView({
  items,
  done,
  setDone,
  hasPlan,
  goPlan,
}: {
  items: Array<{ name: string; measures: string[] }>;
  done: Record<string, boolean>;
  setDone: (value: Record<string, boolean>) => void;
  hasPlan: boolean;
  goPlan: () => void;
}) {
  const remaining = items.filter((item) => !done[item.name]).length;
  return (
    <div className="shopping-layout">
      <section className="panel shopping-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Consolidated from your plan</span>
            <h2>{remaining} items left</h2>
            <p>Pantry matches are removed before the list is built.</p>
          </div>
          {items.length > 0 && <button className="text-button" onClick={() => setDone({})}>Uncheck all</button>}
        </div>
        {items.length > 0 ? (
          <div className="shopping-list">
            {items.map((item) => (
              <label className={done[item.name] ? "checked" : ""} key={item.name}>
                <input type="checkbox" checked={Boolean(done[item.name])} onChange={(event) => setDone({ ...done, [item.name]: event.target.checked })} />
                <span className="checkmark">✓</span>
                <span><strong>{item.name}</strong><small>{item.measures.join(" + ") || "As needed"}</small></span>
              </label>
            ))}
          </div>
        ) : (
          <div className="empty-state tall">
            <strong>{hasPlan ? "Your pantry covers this plan." : "Plan a few meals first."}</strong>
            <p>{hasPlan ? "Nothing extra is needed based on the saved ingredients." : "The shopping list will combine missing ingredients automatically."}</p>
            <button className="primary-button" onClick={goPlan}>Go to weekly plan</button>
          </div>
        )}
      </section>
      <aside className="panel shop-summary">
        <span className="eyebrow">At a glance</span>
        <h3>Shop once, cook all week.</h3>
        <div className="progress-ring" style={{ "--progress": `${items.length ? ((items.length - remaining) / items.length) * 100 : 0}%` } as CSSProperties}>
          <span>{items.length ? Math.round(((items.length - remaining) / items.length) * 100) : 0}%</span>
        </div>
        <p>{items.length - remaining} checked · {remaining} remaining</p>
      </aside>
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
}: {
  profile: Profile;
  setProfile: (profile: Profile) => void;
  settings: AISettings;
  setSettings: (settings: AISettings) => void;
  connectionStatus: string;
  testConnection: () => void;
}) {
  return (
    <div className="settings-grid">
      <section className="panel settings-panel">
        <div className="section-heading"><div><span className="eyebrow">Personalization</span><h2>How you cook</h2><p>Allergies are filtered before a recipe reaches the model.</p></div></div>
        <div className="form-grid">
          <label>Diet<select value={profile.diet} onChange={(event) => setProfile({ ...profile, diet: event.target.value })}><option>No restriction</option><option>Vegetarian</option><option>Vegan</option><option>Gluten-free</option><option>Low-carb</option></select></label>
          <label>Skill level<select value={profile.skillLevel} onChange={(event) => setProfile({ ...profile, skillLevel: event.target.value })}><option>New cook</option><option>Confident beginner</option><option>Experienced home cook</option></select></label>
          <label>Budget<select value={profile.budget} onChange={(event) => setProfile({ ...profile, budget: event.target.value })}><option>Low</option><option>Medium</option><option>Flexible</option></select></label>
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
          <div><span className="source-logo active">T</span><div><strong>TheMealDB</strong><small>Prototype-approved · normalized · attributed</small></div><b>Cataloged</b></div>
          <div><span className="source-logo ready">RC</span><div><strong>Recipe Commons</strong><small>Ready for CC0 recipe imports</small></div><b>Open source</b></div>
        </div>
      </section>
    </div>
  );
}

function RecipeDrawer({
  recipe,
  pantry,
  metric,
  setMetric,
  chefResult,
  close,
  addToPlan,
  start,
}: {
  recipe: Recipe;
  pantry: string[];
  metric: boolean;
  setMetric: (value: boolean) => void;
  chefResult: ChefResponse | null;
  close: () => void;
  addToPlan: () => void;
  start: (steps: string[], method: string) => void;
}) {
  const details = pantryDetails(recipe, pantry);
  const changes = chefResult?.chefChanges.filter((item) => item.recipeId === recipe.id) ?? [];
  const facts = chefResult?.sourceFacts.filter((item) => item.recipeId === recipe.id) ?? [];
  const directions = useMemo(() => instructionSections(recipe), [recipe]);
  const [directionIndex, setDirectionIndex] = useState(0);
  const activeDirection = directions[Math.min(directionIndex, directions.length - 1)];
  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <article className="recipe-drawer" role="dialog" aria-modal="true" aria-labelledby="recipe-title">
        <button className="drawer-close" onClick={close} aria-label="Close recipe">×</button>
        <div className="drawer-hero">
          {recipe.image ? <img src={recipe.image} alt="" /> : <span>{ingredientGlyph(recipe.ingredients[0]?.name ?? "meal")}</span>}
          <div className="drawer-overlay"><span>{recipe.cuisine}</span><strong>{details.score}% pantry match</strong></div>
        </div>
        <div className="drawer-content">
          <span className="eyebrow">{recipe.category}</span>
          <h2 id="recipe-title">{recipe.title}</h2>
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
          <div className="drawer-actions"><button className="primary-button" onClick={() => activeDirection && start(activeDirection.steps, activeDirection.title)} disabled={!activeDirection}>Start cooking{activeDirection && directions.length > 1 ? ` · ${activeDirection.title}` : ""}</button><button className="secondary-button" onClick={addToPlan}>Add to plan</button></div>
          <div className="source-citation">
            <span>Source citation</span>
            <p>This recipe is shown from <a href={recipe.sourceUrl} target={recipe.sourceUrl.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{sourceLabel(recipe)}</a>. Suggested changes appear separately below.</p>
            {facts.length > 0 && (
              <ul className="source-facts">
                {facts.map((fact, index) => <li key={`${fact.fact}-${index}`}>{fact.fact}</li>)}
              </ul>
            )}
          </div>
          <div className="drawer-section-heading"><h3>Ingredients</h3><div className="unit-toggle"><button className={!metric ? "active" : ""} onClick={() => setMetric(false)}>Original</button><button className={metric ? "active" : ""} onClick={() => setMetric(true)}>Metric</button></div></div>
          <ul className="ingredient-list">{recipe.ingredients.map((ingredient, index) => <li key={`${ingredient.name}-${index}`} className={details.matched.includes(ingredient.name) ? "have" : ""}><span>{details.matched.includes(ingredient.name) ? "✓" : "○"}</span><strong>{ingredient.name}</strong><small>{metricMeasure(ingredient.measure, metric)}</small></li>)}</ul>
          <div className="directions-heading">
            <div><h3>Source directions</h3>{activeDirection && directions.length > 1 && <span>{activeDirection.title} method</span>}</div>
            <small>{activeDirection?.steps.length ?? 0} steps</small>
          </div>
          {activeDirection ? (
            <ol className="instruction-list">{activeDirection.steps.map((step, index) => <li key={`${recipe.id}-${activeDirection.title}-step-${index}`}><span>{index + 1}</span><p>{step}</p></li>)}</ol>
          ) : (
            <div className="empty-directions">No source directions are available for this recipe.</div>
          )}
          <section className="changes-panel"><span className="eyebrow">Chef’s changes</span><h3>{changes.length ? "Adapted for your kitchen" : "No changes suggested yet"}</h3>{changes.length ? changes.map((change, index) => <div key={`${change.change}-${index}`}><strong>{change.change}</strong><p>{change.reason}</p></div>) : <p>Ask the chef for substitutions or scaling. The original recipe will stay untouched.</p>}</section>
        </div>
      </article>
    </div>
  );
}

function CookingMode({
  recipe,
  instructions,
  method,
  step,
  setStep,
  seconds,
  setSeconds,
  running,
  setRunning,
  close,
}: {
  recipe: Recipe;
  instructions: string[];
  method: string;
  step: number;
  setStep: (value: number) => void;
  seconds: number;
  setSeconds: (value: number) => void;
  running: boolean;
  setRunning: (value: boolean) => void;
  close: () => void;
}) {
  const total = instructions.length;
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");
  return (
    <div className="cooking-mode" role="dialog" aria-modal="true" aria-label={`Cooking ${recipe.title}`}>
      <header><button onClick={close}>← Exit cooking</button><div><span>Cooking now{method && method !== "Main method" ? ` · ${method}` : ""}</span><strong>{recipe.title}</strong></div><span>{step + 1} / {total}</span></header>
      <div className="cook-progress"><span style={{ width: `${((step + 1) / total) * 100}%` }} /></div>
      <main>
        <div className="cook-step-number">Step {step + 1}</div>
        <p>{instructions[step]}</p>
        <div className="cook-timer">
          <span>Timer</span><strong>{minutes}:{secs}</strong>
          <div><button onClick={() => { setSeconds(300); setRunning(true); }}>5 min</button><button onClick={() => { setSeconds(600); setRunning(true); }}>10 min</button><button onClick={() => setRunning(!running)} disabled={!seconds}>{running ? "Pause" : "Start"}</button></div>
        </div>
      </main>
      <footer><button className="secondary-button" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>Previous</button><span>Screen stays awake where supported · voice comes next</span><button className="primary-button" onClick={() => step === total - 1 ? close() : setStep(step + 1)}>{step === total - 1 ? "Finish cooking" : "Next step →"}</button></footer>
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
