"use client";

import { useEffect, useRef, useState } from "react";
import { mealScale } from "../lib/kitchen-types";
import { normalizePlanningIngredient, resolvedMealIngredients } from "../lib/quantities";
import { remainingTimerMs, stepTimerSeconds, timerAction, type CookingSession } from "../lib/cooking-session";

export function CookingWorkspace({ session, visible, onChange, close, finish }: {
  session: CookingSession;
  visible: boolean;
  onChange: (session: CookingSession) => void;
  close: () => void;
  finish: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [secondsInput, setSecondsInput] = useState(String(session.timer.durationMs / 1000));
  const [timerError, setTimerError] = useState("");
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

  if (!visible) return null;
  const remaining = Math.ceil(remainingTimerMs(session.timer, now) / 1000);
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60).toString().padStart(2, "0");
  const seconds = (remaining % 60).toString().padStart(2, "0");
  const display = `${hours ? `${hours}:` : ""}${minutes}:${seconds}`;
  const sourceSeconds = stepTimerSeconds(session.instructions[session.step]);
  const ingredients = session.plannedMeal ? resolvedMealIngredients(session.plannedMeal) : session.recipe.ingredients.map((ingredient) => ({ ...normalizePlanningIngredient(ingredient), needsReview: !ingredient.measure }));
  const start = (seconds: number) => {
    try {
      const time = Date.now();
      const timer = timerAction({ ...session.timer, status: "idle" }, "start", time, seconds * 1000);
      setNow(time); setTimerError(""); onChange({ ...session, timer });
    } catch (error) { setTimerError(error instanceof Error ? error.message : "Choose a valid duration."); }
  };
  return <div className="cooking-mode" role="dialog" aria-modal="true" aria-label={`Cooking ${session.recipe.title}`}>
    <header><button onClick={close}>← Exit cooking</button><div><span>Cooking now{session.method && session.method !== "Main method" ? ` · ${session.method}` : ""}</span><strong>{session.recipe.title}</strong></div><span>{session.step + 1} / {session.instructions.length}</span></header>
    <div className="cook-progress"><span style={{ width: `${((session.step + 1) / session.instructions.length) * 100}%` }} /></div>
    <main>
      <div className="cook-step-number">Step {session.step + 1}</div><p>{session.instructions[session.step]}</p>
      <details className="cook-ingredients" open><summary>Ingredients for this dinner</summary><section role="region" aria-label="Ingredients for this dinner">
        <p className="quantity-note">{session.plannedMeal ? session.plannedMeal.servings ? `${session.plannedMeal.servings} servings` : `${mealScale(session.plannedMeal)} recipe batches` : "Original recipe quantities"}. Source directions retain their original wording.</p>
        <ul className="ingredient-list">{ingredients.map((ingredient, index) => <li key={index}><strong>{ingredient.name}</strong><small>{ingredient.measure || "Amount needs review"}{ingredient.needsReview && ingredient.measure ? " · review amount" : ""}</small></li>)}</ul>
      </section></details>
      <section className="cook-timer" aria-label="Cooking timer"><span>Timer</span><strong role="timer" aria-label="Time remaining">{display}</strong>
        {session.timer.status === "finished" && <p role="status">Timer finished. Check your food; dinner stays planned until you confirm it cooked.</p>}
        <label>Timer duration (seconds)<input type="number" min="1" max="86400" value={secondsInput} onChange={(event) => setSecondsInput(event.target.value)} /></label>
        {timerError && <p role="alert">{timerError}</p>}
        <div>{sourceSeconds && <button onClick={() => start(sourceSeconds)}>Start {sourceSeconds % 60 === 0 ? `${sourceSeconds / 60} min` : `${sourceSeconds} sec`} from this step</button>}<button onClick={() => start(Number(secondsInput))}>Start custom timer</button><button disabled={session.timer.status !== "running" && session.timer.status !== "paused"} aria-label={session.timer.status === "running" ? "Pause timer" : "Resume timer"} onClick={() => { setNow(Date.now()); onChange({ ...session, timer: timerAction(session.timer, session.timer.status === "running" ? "pause" : "start") }); }}>{session.timer.status === "running" ? "Pause" : "Resume"}</button><button aria-label="Reset timer" onClick={() => onChange({ ...session, timer: timerAction(session.timer, "reset") })}>Reset</button></div>
        <label className="timer-sound"><input type="checkbox" checked={session.soundEnabled} onChange={(event) => {
          if (event.target.checked) { try { audio.current ??= new AudioContext(); void audio.current.resume(); } catch { /* Optional sound. */ } }
          onChange({ ...session, soundEnabled: event.target.checked });
        }} />Sound when finished</label>
      </section>
    </main>
    <footer><button className="secondary-button" onClick={() => onChange({ ...session, step: Math.max(0, session.step - 1) })} disabled={session.step === 0}>Previous</button><span>Screen stays awake where supported</span><button className="primary-button" onClick={() => session.step === session.instructions.length - 1 ? finish() : onChange({ ...session, step: session.step + 1 })}>{session.step === session.instructions.length - 1 ? "Finish cooking" : "Next step →"}</button></footer>
  </div>;
}
