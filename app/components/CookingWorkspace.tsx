"use client";

import { useEffect, useRef, useState } from "react";
import { PlanningFacts } from "./PlanningFacts";
import { Modal } from "./Modal";
import { ThemeToggle } from "./ThemeToggle";
import { mealScale } from "../lib/kitchen-types";
import { normalizePlanningIngredient, resolvedMealIngredients } from "../lib/quantities";
import type { ChefApiResponse } from "../lib/chef-schema";
import { cookingSourceStep } from "../lib/chef-context";
import { remainingTimerMs, stepTimerSeconds, timerAction, type CookingSession } from "../lib/cooking-session";

export function CookingWorkspace({ session, visible, onChange, close, finish, chefBusy = false, chefError = "", chefReply = null, askChefStep }: {
  session: CookingSession;
  visible: boolean;
  chefBusy?: boolean;
  chefError?: string;
  chefReply?: Pick<ChefApiResponse, "answer" | "sourceFacts" | "chefChanges" | "citations" | "generation" | "resolvedContext" | "answerStatus" | "answerKind" | "planningFacts"> | null;
  askChefStep?: (question: string) => void;
  onChange: (session: CookingSession) => void;
  close: () => void;
  finish: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [helpQuestion, setHelpQuestion] = useState("");
  const [lastHelpQuestion, setLastHelpQuestion] = useState("");
  const [minutesInput, setMinutesInput] = useState(String(Math.floor(session.timer.durationMs / 60_000)));
  const [secondsInput, setSecondsInput] = useState(String(Math.floor(session.timer.durationMs / 1000) % 60));
  const [timerError, setTimerError] = useState("");
  const [timerSetupOpen, setTimerSetupOpen] = useState(false);
  const [pendingTimerSeconds, setPendingTimerSeconds] = useState<number | null>(null);
  const content = useRef<HTMLElement>(null);
  const timerSetup = useRef<HTMLElement>(null);
  const timerDecision = useRef<HTMLDivElement>(null);
  const audio = useRef<AudioContext | null>(null);
  const notified = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (session.timer.status !== "running") return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (remainingTimerMs(session.timer, time) === 0) onChangeRef.current({ ...session, timer: timerAction(session.timer, "finish", time) });
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [session]);
  useEffect(() => {
    if (session.timer.status !== "finished" || notified.current === session.id || !session.soundEnabled) return;
    notified.current = session.id;
    try {
      const context = audio.current ?? new AudioContext();
      audio.current = context;
      void context.resume().then(() => {
        for (const offset of [0, 0.45, 0.9]) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.frequency.value = 880;
          gain.gain.value = 0.15;
          oscillator.connect(gain); gain.connect(context.destination);
          oscillator.start(context.currentTime + offset); oscillator.stop(context.currentTime + offset + 0.25);
        }
      }).catch(() => { /* The visual completion indicator always remains. */ });
    } catch { /* Sound is optional where browser audio is available. */ }
  }, [session]);
  useEffect(() => {
    if (session.timer.status !== "finished") notified.current = null;
  }, [session.timer.status]);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || !navigator.wakeLock) return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (active) lock = next; else await next.release();
      } catch { /* Wake lock is an optional enhancement. */ }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => { active = false; document.removeEventListener("visibilitychange", acquire); void lock?.release(); };
  }, [visible]);
  useEffect(() => () => { void audio.current?.close(); }, []);
  useEffect(() => {
    if (visible) content.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [visible, session.id, session.step]);

  useEffect(() => {
    if (!visible || !timerSetupOpen) return;
    const frame = requestAnimationFrame(() => (pendingTimerSeconds === null ? timerSetup.current : timerDecision.current)?.scrollIntoView({ block: "nearest", behavior: "instant" }));
    return () => cancelAnimationFrame(frame);
  }, [visible, timerSetupOpen, pendingTimerSeconds]);

  if (!visible) return null;
  const remaining = Math.ceil(remainingTimerMs(session.timer, now) / 1000);
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60).toString().padStart(2, "0");
  const seconds = (remaining % 60).toString().padStart(2, "0");
  const display = `${hours ? `${hours}:` : ""}${minutes}:${seconds}`;
  const sourceSeconds = stepTimerSeconds(session.instructions[session.step]);
  const ingredients = session.plannedMeal ? resolvedMealIngredients(session.plannedMeal) : session.recipe.ingredients.map((ingredient) => ({ ...normalizePlanningIngredient(ingredient), needsReview: !ingredient.measure }));
  const start = (seconds: number, replace = false) => {
    if (!replace && (session.timer.status === "running" || session.timer.status === "paused")) { setPendingTimerSeconds(seconds); return; }
    try {
      const time = Date.now();
      const timer = timerAction({ ...session.timer, status: "idle" }, "start", time, seconds * 1000);
      setNow(time); setMinutesInput(String(Math.floor(seconds / 60))); setSecondsInput(String(seconds % 60)); setTimerError(""); setTimerSetupOpen(false); setPendingTimerSeconds(null); onChange({ ...session, timer });
    } catch (error) { setTimerError(error instanceof Error ? error.message : "Choose a valid duration."); }
  };
  return <Modal className="cooking-mode" label={`Cooking ${session.recipe.title}`} close={close}>
    <header><button onClick={close}>← Exit cooking</button><div><span>Cooking now{session.method && session.method !== "Main method" ? ` · ${session.method}` : ""}</span><strong>{session.recipe.title}</strong></div><div className="cook-header-actions"><span>{session.step + 1} / {session.instructions.length}</span><ThemeToggle /></div></header>
    <div className="cook-progress"><span style={{ width: `${((session.step + 1) / session.instructions.length) * 100}%` }} /></div>
    <section className="cook-timer-summary" aria-label="Cooking timer">
      <strong role="timer" aria-label="Time remaining">{display}</strong>
      <small>{session.timer.status === "idle" ? "Not started" : session.timer.status === "paused" ? "Paused" : session.timer.status === "running" ? "Running" : "Finished"}</small>
      {(session.timer.status === "running" || session.timer.status === "paused") && <button className="secondary-button" aria-label={session.timer.status === "running" ? "Pause timer" : "Resume timer"} onClick={() => { setNow(Date.now()); onChange({ ...session, timer: timerAction(session.timer, session.timer.status === "running" ? "pause" : "start") }); }}>{session.timer.status === "running" ? "Pause" : "Resume"}</button>}
      {session.timer.status === "paused" && <button className="text-button" aria-label="Reset timer" onClick={() => { setPendingTimerSeconds(null); onChange({ ...session, timer: timerAction(session.timer, "reset") }); }}>Reset</button>}
      {(session.timer.status === "idle" || session.timer.status === "finished") && sourceSeconds && <button className="secondary-button" onClick={() => start(sourceSeconds)}>Start {sourceSeconds % 60 === 0 ? `${sourceSeconds / 60} min` : `${sourceSeconds} sec`} from this step</button>}
      <button className="text-button" aria-expanded={timerSetupOpen} onClick={() => { setPendingTimerSeconds(null); setTimerSetupOpen((open) => !open); }}>{timerSetupOpen ? "Close timer setup" : session.timer.status === "running" || session.timer.status === "paused" ? "Change timer" : "Set timer"}</button>
      {session.timer.status === "finished" && <p role="status">Timer finished. Check your food; confirm dinner cooked when you finish.</p>}
    </section>
    <main ref={content}>
      <div className="cook-step-number">Step {session.step + 1}</div><p>{session.instructions[session.step]}</p>
      <details className="cook-ingredients"><summary>Ingredients for this dinner</summary><section role="region" aria-label="Ingredients for this dinner">
        <p className="quantity-note">{session.plannedMeal ? session.plannedMeal.servings ? `${session.plannedMeal.servings} servings` : `${mealScale(session.plannedMeal)} recipe batches` : "Original recipe quantities"}. Source directions retain their original wording.</p>
        <ul className="ingredient-list">{ingredients.map((ingredient, index) => <li key={index}><strong>{ingredient.name}</strong><small>{ingredient.measure || "Amount needs review"}{ingredient.needsReview && ingredient.measure ? " · review amount" : ""}</small></li>)}</ul>
      </section></details>
      {askChefStep && <details className="cook-help"><summary>Ask about this step</summary><section aria-label="Cooking step help">
        <p className="quantity-note">{cookingSourceStep(session.recipe, session.instructions, session.step) ? "Uses this source step and nearby directions. Timers keep running." : "This step cannot be mapped uniquely; Chef will use the recipe context."}</p>
        <form onSubmit={(event) => { event.preventDefault(); if (helpQuestion.trim()) { setLastHelpQuestion(helpQuestion); askChefStep(helpQuestion); setHelpQuestion(""); } }}><label>Question about this step<textarea aria-label="Question about this step" maxLength={1000} rows={2} value={helpQuestion} onChange={(event) => setHelpQuestion(event.target.value)} /></label><button className="secondary-button" disabled={chefBusy || !helpQuestion.trim()}>{chefBusy ? "Checking recipe…" : "Ask Chef about step"}</button></form>
        {chefError && <p role="alert">{chefError}</p>}
        {chefReply && chefReply.resolvedContext?.stepEvidenceId === cookingSourceStep(session.recipe, session.instructions, session.step) && <div className="step-chef-reply" aria-live="polite"><strong>{chefReply.answerKind === "planning_quantities" ? "Saved dinner calculation" : chefReply.generation === "ai" ? "Chef help · Source grounded" : "Source recipe · No AI answer used"}</strong>{chefReply.answerKind === "planning_quantities" && <PlanningFacts result={chefReply} />}{(chefReply.answerKind !== "planning_quantities" || chefReply.answerStatus !== "answered") && <p>{chefReply.answer}</p>}{chefReply.answerStatus === "unverified" && lastHelpQuestion && <button className="secondary-button" disabled={chefBusy} onClick={() => askChefStep(lastHelpQuestion)}>Retry step answer</button>}{chefReply.sourceFacts.map((fact, index) => <blockquote key={index}>{fact.fact}</blockquote>)}{chefReply.chefChanges.map((change, index) => <div key={index}><b>Suggested change — original recipe unchanged</b><p>{change.change} {change.reason}</p></div>)}{chefReply.citations.map((citation) => <a key={citation.recipeId} href={citation.sourceUrl} target="_blank" rel="noreferrer">{citation.sourceName} · Original source</a>)}</div>}
      </section></details>}
      {timerSetupOpen && <section ref={timerSetup} className="cook-timer timer-setup" aria-label="Timer setup">
        <h3>Set a timer</h3>
        <div className="timer-duration"><label>Minutes<input type="number" min="0" max="1440" step="1" value={minutesInput} onChange={(event) => setMinutesInput(event.target.value)} /></label><label>Seconds<input type="number" min="0" max="59" step="1" value={secondsInput} onChange={(event) => setSecondsInput(event.target.value)} /></label></div>
        <div className="timer-presets" aria-label="Quick timers">{[1, 5, 10, 15].map((minutes) => <button key={minutes} onClick={() => start(minutes * 60)}>Start {minutes} min timer</button>)}</div>
        {timerError && <p role="alert">{timerError}</p>}
        <button onClick={() => {
          const mins = Number(minutesInput), secs = Number(secondsInput);
          if (!minutesInput.trim() || !secondsInput.trim() || !Number.isInteger(mins) || !Number.isInteger(secs) || mins < 0 || secs < 0 || secs > 59) { setTimerError("Enter whole minutes and seconds from 0 to 59."); return; }
          start(mins * 60 + secs);
        }}>Start custom timer</button>
        <label className="timer-sound"><input type="checkbox" checked={session.soundEnabled} onChange={(event) => {
          if (event.target.checked) { try { audio.current ??= new AudioContext(); void audio.current.resume(); } catch { /* Optional sound. */ } }
          onChange({ ...session, soundEnabled: event.target.checked });
        }} />Sound when finished</label>
        {pendingTimerSeconds !== null && <div ref={timerDecision} className="timer-replacement" role="alert"><p>Replace your {session.timer.status === "paused" ? "paused" : "running"} timer with {Math.floor(pendingTimerSeconds / 60)} min {pendingTimerSeconds % 60} sec?</p><button onClick={() => setPendingTimerSeconds(null)}>Keep current timer</button><button onClick={() => start(pendingTimerSeconds, true)}>Replace timer</button></div>}
      </section>}
    </main>
    <footer><button className="secondary-button" onClick={() => onChange({ ...session, step: Math.max(0, session.step - 1) })} disabled={session.step === 0}>Previous</button><span>Screen stays awake where supported</span><button className="primary-button" onClick={() => session.step === session.instructions.length - 1 ? finish() : onChange({ ...session, step: session.step + 1 })}>{session.step === session.instructions.length - 1 ? "Finish cooking" : "Next step →"}</button></footer>
  </Modal>;
}
