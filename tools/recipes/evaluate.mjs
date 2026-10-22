import { cases } from "./evaluation-cases.mjs";

const base = process.env.RECIPES_APP_URL || "http://localhost:3000";
let passed = 0;
const results = [];
for (const item of cases) {
  const url = new URL("/api/recipes", base);
  url.searchParams.set("q", item.query);
  for (const pantry of item.pantry ?? []) url.searchParams.append("pantry", pantry);
  for (const allergy of item.allergies ?? []) url.searchParams.append("allergy", allergy);
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
    const titles = data.recipes.map((recipe) => recipe.title);
    const hit = titles.slice(0, 3).some((title) => item.expected.includes(title));
    const exclusionsPass = !(item.forbidden ?? []).some((title) => titles.includes(title));
    const ok = hit && exclusionsPass;
    passed += Number(ok);
    results.push({ query: item.query, ok, hit, exclusionsPass, top3: titles.slice(0, 3), method: data.meta?.retrieval?.method, milliseconds: Math.round(performance.now() - started) });
  } catch (error) { results.push({ query: item.query, ok: false, error: error.message }); }
}
console.log(JSON.stringify({ passed, total: cases.length, target: 16, results }, null, 2));
if (passed < 16 || results.some((item) => item.exclusionsPass === false || item.error)) process.exitCode = 1;
