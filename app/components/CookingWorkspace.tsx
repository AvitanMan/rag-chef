"use client";

import { randomId } from "../lib/random-id";

import { CookingTechniqueReferences } from "./CookingTechniqueReferences";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PlanningFacts } from "./PlanningFacts";
import { Modal } from "./Modal";
import { ThemeToggle } from "./ThemeToggle";
import { ValidatedInput } from "./ValidatedInput";
import { mealScale } from "../lib/kitchen-types";
import { mealAmountLabel, normalizePlanningIngredient, resolvedMealIngredients } from "../lib/quantities";
import type { ChefApiResponse } from "../lib/chef-schema";
import { cookingSourceStep } from "../lib/chef-context";
import { cookingHasRunningTimer, finishElapsedTimers, MAX_COOKING_TIMERS, parseTimerDuration, remainingTimerMs, stepTimerSeconds, timerAction, type CookingSession } from "../lib/cooking-session";

function timerDisplay(milliseconds: number): string {
  const remaining = Math.ceil(milliseconds / 1000);
  const hours = Math.floor(remaining / 3600);
  return `${hours ? `${hours}:` : ""}${Math.floor((remaining % 3600) / 60).toString().padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`;
}
const labelProblem = (text: string) => !text.trim() || text.length > 80 || /[\x00-\x1f\x7f]/.test(text) ? "Enter a timer name of 1–80 characters." : "";
const timerFields = (durationMs: number) => ({ minutes: String(Math.floor(durationMs / 60_000)), seconds: String(Math.floor(durationMs / 1000) % 60) });

function ExtraCookingTimers({ session, now, onChange, sourceSeconds }: { session: CookingSession; now: number; onChange: (session: CookingSession) => void; sourceSeconds: number | null }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState("5");
  const [seconds, setSeconds] = useState("0");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const timers = session.extraTimers ?? [];
  const patch = (id: string, change: Partial<(typeof timers)[number]>) => onChange({ ...session, extraTimers: timers.map(timer => timer.id === id ? { ...timer, ...change } : timer) });
  const remove = (id: string) => { onChange({ ...session, extraTimers: timers.filter(timer => timer.id !== id) }); setRemoving(null); };
  return <section className="extra-cooking-timers" aria-label="Additional cooking timers">
    {timers.map(timer => <div className="extra-timer" role="group" aria-label={`${timer.label} timer`} key={timer.id}>
      <label>Name<ValidatedInput value={timer.label} aria-label={`Rename ${timer.label} timer`} maxLength={80} validate={labelProblem} onCommit={label => patch(timer.id, { label })} /></label>
      <strong role="timer" aria-label={`${timer.label} time remaining`}>{timerDisplay(remainingTimerMs(timer, now))}</strong>
      <small>{timer.status === "finished" ? "Finished" : timer.status === "running" ? "Running" : timer.status === "paused" ? "Paused" : "Not started"}</small>
      <div className="extra-timer-actions">
        <button className="secondary-button" onClick={() => patch(timer.id, timerAction(timer, timer.status === "running" ? "pause" : "start"))}>{timer.status === "running" ? "Pause" : timer.status === "paused" ? "Resume" : "Start"} {timer.label} timer</button>
        {timer.status !== "running" && <button className="text-button" onClick={() => patch(timer.id, timerAction(timer, "reset"))}>Reset {timer.label} timer</button>}
        <button className="text-button" onClick={() => timer.status === "running" || timer.status === "paused" ? setRemoving(timer.id) : remove(timer.id)}>Remove {timer.label} timer</button>
      </div>
      {timer.status === "finished" && <p role="status">{timer.label} timer finished. Check your food.</p>}
      {removing === timer.id && <div className="timer-replacement" role="alert"><p>Remove the {timer.label} timer?</p><button onClick={() => setRemoving(null)}>Keep timer</button><button onClick={() => remove(timer.id)}>Remove timer</button></div>}
    </div>)}
    <button className="secondary-button" aria-expanded={adding} disabled={timers.length >= MAX_COOKING_TIMERS - 1} onClick={() => { setAdding(open => !open); setError(""); }}>{adding ? "Cancel new timer" : "Add another timer"}</button>
    {timers.length >= MAX_COOKING_TIMERS - 1 && <p className="quantity-note">Up to {MAX_COOKING_TIMERS} timers can be saved with this cooking session.</p>}
    {adding && <form className="additional-timer-setup" aria-label="New cooking timer" noValidate onSubmit={event => {
      event.preventDefault();
      if (labelProblem(label)) { setError(labelProblem(label)); return; }
      if (timers.length >= MAX_COOKING_TIMERS - 1) { setError("Remove a timer before adding another."); return; }
      try {
        const timer = timerAction({ ...session.timer, status: "idle" }, "start", Date.now(), parseTimerDuration(minutes, seconds) * 1000);
        onChange({ ...session, extraTimers: [...timers, { ...timer, id: randomId(), label: label.trim() }] });
        setLabel(""); setAdding(false); setError("");
      } catch (error) { setError(error instanceof Error ? error.message : "Choose a valid duration."); }
    }}>
      <label>Timer name<input aria-label="New timer name" maxLength={80} value={label} onChange={event => setLabel(event.target.value)} placeholder="Rice, sauce, or oven…" /></label>
      <div className="timer-duration"><label>Minutes<input aria-label="Additional timer minutes" type="number" min="0" max="1440" step="1" value={minutes} onChange={event => setMinutes(event.target.value)} /></label><label>Seconds<input aria-label="Additional timer seconds" type="number" min="0" max="59" step="1" value={seconds} onChange={event => setSeconds(event.target.value)} /></label></div>
      {sourceSeconds && <button type="button" className="text-button" onClick={() => { setMinutes(String(Math.floor(sourceSeconds / 60))); setSeconds(String(sourceSeconds % 60)); }}>Use this step’s duration</button>}
      {error && <p role="alert">{error}</p>}
      <button className="primary-button" type="submit">Start additional timer</button>
    </form>}
  </section>;
}

export function CookingWorkspace({ session, visible, onChange, close, finish, completionReview, chefBusy = false, chefUnavailable = "", chefError = "", chefReply = null, askChefStep }: {
  session: CookingSession;
  visible: boolean;
  chefBusy?: boolean;
  chefUnavailable?: string;
  chefError?: string;
  chefReply?: (Pick<ChefApiResponse, "answer" | "sourceFacts" | "chefChanges" | "citations" | "generation" | "resolvedContext" | "answerStatus" | "answerKind" | "planningFacts" | "cookingTechniques"> & { requestQuery?: string }) | null;
  askChefStep?: (question: string) => void;
  onChange: (session: CookingSession) => void;
  close: () => void;
  finish: () => void;
  completionReview?: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  const [helpQuestion, setHelpQuestion] = useState("");
  const [lastHelpRequest, setLastHelpRequest] = useState<{ question: string; step: number } | null>(null);
  const [timerDraft, setTimerDraft] = useState(() => ({ source: session.timer.durationMs, ...timerFields(session.timer.durationMs) }));
  if (timerDraft.source !== session.timer.durationMs) {
    const previous = timerFields(timerDraft.source);
    const edited = timerDraft.minutes !== previous.minutes || timerDraft.seconds !== previous.seconds;
    // Follow another tab's timer unless this tab has an unfinished duration edit.
    setTimerDraft({ ...(edited ? timerDraft : timerFields(session.timer.durationMs)), source: session.timer.durationMs });
  }
  const { minutes: minutesInput, seconds: secondsInput } = timerDraft;
  const [timerError, setTimerError] = useState("");
  const [timerSetupOpen, setTimerSetupOpen] = useState(false);
  const [pendingTimerSeconds, setPendingTimerSeconds] = useState<number | null>(null);
  const content = useRef<HTMLElement>(null);
  const timerSetup = useRef<HTMLElement>(null);
  const timerDecision = useRef<HTMLDivElement>(null);
  const audio = useRef<AudioContext | null>(null);
  const notified = useRef(new Set<string>());
  const onChangeRef = useRef(onChange);
  const reviewingCompletion = Boolean(completionReview);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!cookingHasRunningTimer(session)) return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      const next = finishElapsedTimers(session, time);
      if (next !== session) onChangeRef.current(next);
    };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [session]);
  useEffect(() => {
    const timers = [{ ...session.timer, id: "main" }, ...(session.extraTimers ?? [])];
    for (const id of notified.current) if (!timers.some(timer => timer.id === id && timer.status === "finished")) notified.current.delete(id);
    const finished = timers.filter(timer => timer.status === "finished" && !notified.current.has(timer.id));
    if (!finished.length || !session.soundEnabled) return;
    finished.forEach(timer => notified.current.add(timer.id));
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
  }, [visible, session.id, session.step, reviewingCompletion]);

  useEffect(() => {
    if (!visible || !timerSetupOpen) return;
    const frame = requestAnimationFrame(() => (pendingTimerSeconds === null ? timerSetup.current : timerDecision.current)?.scrollIntoView({ block: "nearest", behavior: "instant" }));
    return () => cancelAnimationFrame(frame);
  }, [visible, timerSetupOpen, pendingTimerSeconds]);

  if (!visible) return null;
  const display = timerDisplay(remainingTimerMs(session.timer, now));
  const sourceSeconds = stepTimerSeconds(session.instructions[session.step]);
  const ingredients = session.plannedMeal ? resolvedMealIngredients(session.plannedMeal) : session.recipe.ingredients.map((ingredient) => ({ ...normalizePlanningIngredient(ingredient), needsReview: !ingredient.measure }));
  const start = (seconds: number, replace = false) => {
    if (!replace && (session.timer.status === "running" || session.timer.status === "paused")) { setPendingTimerSeconds(seconds); return; }
    try {
      const time = Date.now();
      const timer = timerAction({ ...session.timer, status: "idle" }, "start", time, seconds * 1000);
      setNow(time); setTimerDraft({ source: session.timer.durationMs, ...timerFields(seconds * 1000) }); setTimerError(""); setTimerSetupOpen(false); setPendingTimerSeconds(null); onChange({ ...session, timer });
    } catch (error) { setTimerError(error instanceof Error ? error.message : "Choose a valid duration."); }
  };
  return <Modal className="cooking-mode" label={`Cooking ${session.recipe.title}`} close={close}>
    <header><button onClick={close}>← Exit cooking</button><div><span>Cooking now{session.method && session.method !== "Main method" ? ` · ${session.method}` : ""}</span><strong>{session.recipe.title}</strong></div><div className="cook-header-actions"><span>{session.step + 1} / {session.instructions.length}</span><ThemeToggle /></div></header>
    <div className="cook-progress"><span style={{ width: `${((session.step + 1) / session.instructions.length) * 100}%` }} /></div>
    <section className="cook-timer-summary" aria-label="Cooking timer">
      <span>{session.timerLabel ?? "Main timer"}</span>
      <strong role="timer" aria-label="Time remaining">{display}</strong>
      <small>{session.timer.status === "idle" ? "Not started" : session.timer.status === "paused" ? "Paused" : session.timer.status === "running" ? "Running" : "Finished"}</small>
      {(session.timer.status === "running" || session.timer.status === "paused") && <button className="secondary-button" aria-label={session.timer.status === "running" ? "Pause timer" : "Resume timer"} onClick={() => { setNow(Date.now()); onChange({ ...session, timer: timerAction(session.timer, session.timer.status === "running" ? "pause" : "start") }); }}>{session.timer.status === "running" ? "Pause" : "Resume"}</button>}
      {session.timer.status === "paused" && <button className="text-button" aria-label="Reset timer" onClick={() => { setPendingTimerSeconds(null); onChange({ ...session, timer: timerAction(session.timer, "reset") }); }}>Reset</button>}
      {(session.timer.status === "idle" || session.timer.status === "finished") && sourceSeconds && <button className="secondary-button" onClick={() => start(sourceSeconds)}>Start {sourceSeconds % 60 === 0 ? `${sourceSeconds / 60} min` : `${sourceSeconds} sec`} from this step</button>}
      <button className="text-button" aria-expanded={timerSetupOpen} onClick={() => { setPendingTimerSeconds(null); setTimerSetupOpen((open) => !open); }}>{timerSetupOpen ? "Close timer setup" : session.timer.status === "running" || session.timer.status === "paused" ? "Change timer" : "Set timer"}</button>
      {session.timer.status === "finished" && <p role="status">Timer finished. Check your food; confirm dinner cooked when you finish.</p>}
    </section>
    <main ref={content}>
      {completionReview ?? <>
      <div className="cook-step-number">Step {session.step + 1}</div><p>{session.instructions[session.step]}</p>
      <ExtraCookingTimers session={session} now={now} onChange={onChange} sourceSeconds={sourceSeconds} />
      <details className="cook-ingredients"><summary>Ingredients for this dinner</summary><section role="region" aria-label="Ingredients for this dinner">
        <p className="quantity-note">{session.plannedMeal ? session.plannedMeal.servings ? `${session.plannedMeal.servings} servings` : `${mealScale(session.plannedMeal)} recipe batches` : "Original recipe quantities"}. Source directions retain their original wording.</p>
        <ul className="ingredient-list">{ingredients.map((ingredient, index) => <li key={index}><strong>{ingredient.name}</strong><small>{ingredient.measure || "Amount needs review"}{ingredient.needsReview && ingredient.measure ? " · review amount" : ""}{session.plannedMeal && <span className="amount-basis">{mealAmountLabel(session.plannedMeal, index)}</span>}</small></li>)}</ul>
      </section></details>
      {askChefStep && <details className="cook-help"><summary>Ask about this step</summary><section aria-label="Cooking step help">
        <p className="quantity-note" id="cooking-question-help">{cookingSourceStep(session.recipe, session.instructions, session.step) ? "Ask about this instruction, its ingredients, or timing stated in the recipe. Timers keep running while Chef answers." : "Chef will use the recipe as a whole because this saved step cannot be matched to one source direction."}</p>
        <form onSubmit={(event) => { event.preventDefault(); if (!chefUnavailable && !chefBusy && helpQuestion.trim()) { const question = helpQuestion.trim(); setLastHelpRequest({ question, step: session.step }); askChefStep(question); setHelpQuestion(""); } }}><label>Question about this step<textarea aria-label="Question about this step" aria-describedby="cooking-question-help" placeholder="e.g. What does this instruction mean?" maxLength={1000} rows={2} value={helpQuestion} onChange={(event) => setHelpQuestion(event.target.value)} /></label><button className="secondary-button" disabled={Boolean(chefUnavailable) || chefBusy || !helpQuestion.trim()}>{chefBusy ? "Checking recipe…" : "Ask Chef about step"}</button></form>
        {chefUnavailable && <p className="quantity-note" role="status">Chef is waiting for the kitchen: {chefUnavailable}</p>}
        {chefError && <p role="alert">{chefError}</p>}
        {chefReply && lastHelpRequest?.step === session.step && chefReply.requestQuery === lastHelpRequest.question && chefReply.resolvedContext?.stepEvidenceId === cookingSourceStep(session.recipe, session.instructions, session.step) && <div className="step-chef-reply" aria-live="polite">
          <strong>{chefReply.answerKind === "planning_quantities" ? "Saved dinner calculation" : chefReply.generation === "ai" ? "Chef explanation" : "Recipe reference"}</strong>
          {chefReply.answerKind === "planning_quantities" && <PlanningFacts result={chefReply} />}
          {chefReply.answerKind !== "cooking_technique" && (chefReply.answerKind !== "planning_quantities" || chefReply.answerStatus !== "answered") && <p className="step-explanation">{chefReply.answer}</p>}
          {chefReply.answerStatus === "unverified" && <button className="secondary-button" disabled={Boolean(chefUnavailable) || chefBusy} onClick={() => askChefStep(lastHelpRequest.question)}>Retry step answer</button>}
          <CookingTechniqueReferences guides={chefReply.cookingTechniques} />
          {chefReply.sourceFacts.length > 0 && <details className="step-source-evidence"><summary>Source for this answer</summary>{chefReply.sourceFacts.map((fact, index) => <blockquote key={index}>{fact.fact}</blockquote>)}</details>}
          {chefReply.chefChanges.map((change, index) => <div key={index}><b>Suggested change — original recipe unchanged</b><p>{change.change} {change.reason}</p></div>)}
          {chefReply.citations.map(citation => <a key={citation.recipeId} href={citation.sourceUrl} target="_blank" rel="noreferrer">{citation.sourceName} · Original source</a>)}
        </div>}
      </section></details>}
      {timerSetupOpen && <section ref={timerSetup} className="cook-timer timer-setup" aria-label="Timer setup">
        <h3>Set a timer</h3>
        <label>Timer name<ValidatedInput aria-label="Main timer name" value={session.timerLabel ?? "Main timer"} maxLength={80} validate={labelProblem} onCommit={timerLabel => onChange({ ...session, timerLabel })} /></label>
        <div className="timer-duration"><label>Minutes<input type="number" min="0" max="1440" step="1" value={minutesInput} onChange={(event) => setTimerDraft({ ...timerDraft, minutes: event.target.value })} /></label><label>Seconds<input type="number" min="0" max="59" step="1" value={secondsInput} onChange={(event) => setTimerDraft({ ...timerDraft, seconds: event.target.value })} /></label></div>
        <div className="timer-presets" aria-label="Quick timers">{[1, 5, 10, 15].map((minutes) => <button key={minutes} onClick={() => start(minutes * 60)}>Start {minutes} min timer</button>)}</div>
        {timerError && <p role="alert">{timerError}</p>}
        <button onClick={() => {
          try { start(parseTimerDuration(minutesInput, secondsInput)); }
          catch (error) { setTimerError(error instanceof Error ? error.message : "Choose a valid duration."); }
        }}>Start custom timer</button>
        <label className="timer-sound"><input type="checkbox" checked={session.soundEnabled} onChange={(event) => {
          if (event.target.checked) { try { audio.current ??= new AudioContext(); void audio.current.resume(); } catch { /* Optional sound. */ } }
          onChange({ ...session, soundEnabled: event.target.checked });
        }} />Sound when finished</label>
        {pendingTimerSeconds !== null && <div ref={timerDecision} className="timer-replacement" role="alert"><p>Replace your {session.timer.status === "paused" ? "paused" : "running"} timer with {Math.floor(pendingTimerSeconds / 60)} min {pendingTimerSeconds % 60} sec?</p><button onClick={() => setPendingTimerSeconds(null)}>Keep current timer</button><button onClick={() => start(pendingTimerSeconds, true)}>Replace timer</button></div>}
      </section>}
      </>}
    </main>
    {!completionReview && <footer><button className="secondary-button" onClick={() => onChange({ ...session, step: Math.max(0, session.step - 1) })} disabled={session.step === 0}>Previous</button><span>Screen stays awake where supported</span><button className="primary-button" onClick={() => session.step === session.instructions.length - 1 ? finish() : onChange({ ...session, step: session.step + 1 })}>{session.step === session.instructions.length - 1 ? "Finish cooking" : "Next step →"}</button></footer>}
  </Modal>;
}
