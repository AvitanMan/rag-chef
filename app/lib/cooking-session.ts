import { randomId } from "./random-id";
import type { PlannedMeal } from "./kitchen-types";
import type { Recipe } from "./recipe-types";
import { validateKitchenWrite, validateRecipeSnapshot } from "./kitchen-validation";

export const COOKING_SESSION_KEY = "rag-chef-cooking-v1";

/** Reject stale edits, including deletion, before replacing another tab's progress. */
export function writeCookingSession(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, expected: string | null, next: CookingSession | null) {
  const stored = storage.getItem(COOKING_SESSION_KEY);
  if (stored !== expected) return { saved: false, stored };
  const text = next ? JSON.stringify(next) : null;
  if (text === null) storage.removeItem(COOKING_SESSION_KEY);
  else storage.setItem(COOKING_SESSION_KEY, text);
  return { saved: true, stored: text };
}
export const MAX_TIMER_MS = 86_400_000;
export const MAX_COOKING_TIMERS = 8;
const TIMER_DURATION_ERROR = "Choose a timer between 1 second and 24 hours.";

/** Parse both timer forms' whole-minute/second fields into a bounded duration. */
export function parseTimerDuration(minutes: string, seconds: string): number {
  const mins = Number(minutes), secs = Number(seconds);
  if (!minutes.trim() || !Number.isInteger(mins) || mins < 0 || mins > MAX_TIMER_MS / 60_000) {
    throw new Error(`Enter whole minutes from 0 to ${MAX_TIMER_MS / 60_000}.`);
  }
  if (!seconds.trim() || !Number.isInteger(secs) || secs < 0 || secs > 59) {
    throw new Error("Enter whole seconds from 0 to 59.");
  }
  const duration = mins * 60 + secs;
  if (duration < 1 || duration > MAX_TIMER_MS / 1000) throw new Error(TIMER_DURATION_ERROR);
  return duration;
}

export interface CookingTimer {
  durationMs: number;
  remainingMs: number;
  endAt: number | null;
  status: "idle" | "running" | "paused" | "finished";
}
export interface CookingSession {
  version: 1;
  id: string;
  recipe: Recipe;
  plannedMeal?: PlannedMeal;
  instructions: string[];
  method: string;
  step: number;
  timer: CookingTimer;
  timerLabel?: string;
  extraTimers?: Array<CookingTimer & { id: string; label: string }>;
  soundEnabled: boolean;
}

function validTimer(timer: CookingTimer): boolean {
  return Boolean(timer && ["idle", "running", "paused", "finished"].includes(timer.status)
    && Number.isFinite(timer.durationMs) && timer.durationMs >= 1000 && timer.durationMs <= MAX_TIMER_MS
    && Number.isFinite(timer.remainingMs) && timer.remainingMs >= 0 && timer.remainingMs <= timer.durationMs
    && (timer.endAt === null || Number.isFinite(timer.endAt) && timer.endAt >= 0)
    && (timer.status === "running" ? timer.endAt !== null : timer.endAt === null)
    && (timer.status !== "finished" || timer.remainingMs === 0));
}

export function cookingHasRunningTimer(session: CookingSession): boolean {
  return [session.timer, ...(session.extraTimers ?? [])].some(timer => timer.status === "running");
}

/** Finish all elapsed timers in one update so simultaneous alarms cannot overwrite each other. */
export function finishElapsedTimers(session: CookingSession, now = Date.now()): CookingSession {
  const finish = (timer: CookingTimer) => timer.status === "running" && remainingTimerMs(timer, now) === 0 ? timerAction(timer, "finish", now) : timer;
  const timer = finish(session.timer);
  const extraTimers = session.extraTimers?.map(item => ({ ...item, ...finish(item) }));
  if (timer === session.timer && !session.extraTimers?.some((item, index) => item.status !== extraTimers![index].status)) return session;
  return { ...session, timer, ...(extraTimers ? { extraTimers } : {}) };
}

export function plannedDinnerFingerprint(meal: PlannedMeal): string {
  return JSON.stringify([meal.recipeId, meal.recipe, meal.planningIngredients ?? null, meal.personalAmountIndices ?? null, meal.baseServings, meal.servings, meal.batches, meal.ingredientOverrides]);
}

export function canCompleteCookingSession(session: CookingSession, current: PlannedMeal | undefined): boolean {
  const captured = session.plannedMeal;
  return Boolean(captured && current && current.id === captured.id && current.status === "planned" && plannedDinnerFingerprint(current) === plannedDinnerFingerprint(captured));
}

export function remainingTimerMs(timer: CookingTimer, now = Date.now()): number {
  return Math.max(0, timer.status === "running" && timer.endAt !== null ? timer.endAt - now : timer.remainingMs);
}

export function timerAction(timer: CookingTimer, action: "start" | "pause" | "reset" | "finish", now = Date.now(), durationMs = timer.durationMs): CookingTimer {
  if (action === "reset") return { ...timer, endAt: null, remainingMs: timer.durationMs, status: "idle" };
  if (action === "finish") return { ...timer, endAt: null, remainingMs: 0, status: "finished" };
  if (action === "pause") {
    const remainingMs = remainingTimerMs(timer, now);
    return { ...timer, endAt: null, remainingMs, status: remainingMs ? "paused" : "finished" };
  }
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > MAX_TIMER_MS) throw new Error(TIMER_DURATION_ERROR);
  const resuming = timer.status === "paused" && durationMs === timer.durationMs;
  const remainingMs = resuming ? timer.remainingMs : durationMs;
  return { durationMs, remainingMs, endAt: now + remainingMs, status: "running" };
}

export function createCookingSession(recipe: Recipe, instructions: string[], method: string, plannedMeal?: PlannedMeal): CookingSession {
  return { version: 1, id: randomId(), recipe: structuredClone(recipe),
    ...(plannedMeal?.status === "planned" ? { plannedMeal: structuredClone(plannedMeal) } : {}),
    instructions: [...instructions], method, step: 0, soundEnabled: false,
    timer: { durationMs: 300_000, remainingMs: 300_000, endAt: null, status: "idle" } };
}

export function parseCookingSession(text: string | null): CookingSession | null {
  if (!text || new TextEncoder().encode(text).length > 2_000_000) return null;
  try {
    const value = JSON.parse(text) as CookingSession;
    if (value.version !== 1 || typeof value.id !== "string" || !value.id || value.id.length > 200 || typeof value.soundEnabled !== "boolean") return null;
    validateRecipeSnapshot(value.recipe);
    if (!Array.isArray(value.instructions) || value.instructions.length < 1 || value.instructions.length > 300 || value.instructions.some((step) => typeof step !== "string" || !step.trim() || step.length > 4000)) return null;
    if (typeof value.method !== "string" || value.method.length > 200 || !Number.isInteger(value.step) || value.step < 0 || value.step >= value.instructions.length) return null;
    if (!validTimer(value.timer)) return null;
    const validLabel = (label: unknown) => typeof label === "string" && Boolean(label.trim()) && label.length <= 80 && !/[\x00-\x1f\x7f]/.test(label);
    if (Object.hasOwn(value, "timerLabel") && !validLabel(value.timerLabel)) return null;
    if (Object.hasOwn(value, "extraTimers")) {
      if (!Array.isArray(value.extraTimers) || value.extraTimers.length >= MAX_COOKING_TIMERS) return null;
      const ids = new Set<string>(["main"]);
      for (const timer of value.extraTimers) {
        if (!validTimer(timer) || typeof timer.id !== "string" || !timer.id.trim() || timer.id.length > 200 || ids.has(timer.id) || !validLabel(timer.label)) return null;
        ids.add(timer.id);
      }
    }
    if (Object.hasOwn(value, "plannedMeal")) {
      if (!value.plannedMeal) return null;
      const meal = value.plannedMeal;
      validateKitchenWrite({ revision: 0, state: { schemaVersion: 2, pantry: [], meals: { [meal.date]: meal }, shoppingChecked: {}, migratedLegacy: false } });
      if (meal.recipeId !== value.recipe.id || JSON.stringify(meal.recipe) !== JSON.stringify(value.recipe)) return null;
    }
    return value;
  } catch { return null; }
}

/** Only an explicit single source duration supplies a shortcut; never a range. */
export function stepTimerSeconds(text: string): number | null {
  const matches = [...text.matchAll(/\b(\d+)\s*(seconds?|minutes?|hours?)\b/gi)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const prefix = text.slice(0, match.index);
  if (/(?:[\d./¼½¾⅓⅔⅛⅜⅝⅞]|\d\s*[-–—]|\d\s+(?:to|or|and))\s*$/i.test(prefix)) return null;
  const factor = /^hour/i.test(match[2]) ? 3600 : /^minute/i.test(match[2]) ? 60 : 1;
  const seconds = Number(match[1]) * factor;
  return seconds >= 1 && seconds <= 86_400 ? seconds : null;
}
