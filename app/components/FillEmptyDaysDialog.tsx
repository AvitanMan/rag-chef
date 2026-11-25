"use client";

import { useEffect, useRef, useState } from "react";
import type { FillEmptyDaysPreviewResponse, FillEmptyDaysApplyRequest } from "../lib/fill-empty-days-contract";
import { parseFillEmptyDaysApply } from "../lib/kitchen-command-validation";
import { Modal } from "./Modal";
import { dateLabel } from "./WeeklyKitchenViews";

export const PENDING_DINNER_SAVE_KEY = "pending-reviewed-dinners";

export interface PendingDinnerSave {
  request: FillEmptyDaysApplyRequest;
  dinners: { date: string; id: string; reason: string }[];
}

export function readPendingDinnerSave(storage: Storage): PendingDinnerSave | null {
  try {
    const value = JSON.parse(storage.getItem(PENDING_DINNER_SAVE_KEY) ?? "null");
    if (!value || !Array.isArray(value.dinners) || !value.dinners.length || value.dinners.length > 7) return null;
    const request = parseFillEmptyDaysApply(value.request);
    if (!value.dinners.every((meal: PendingDinnerSave["dinners"][number]) => meal && typeof meal.id === "string"
      && /^\d{4}-\d{2}-\d{2}$/.test(meal.date) && typeof meal.reason === "string")) return null;
    return { request, dinners: value.dinners };
  } catch { return null; }
}

export interface DinnerReviewRequest {
  week: string;
  preview: (signal: AbortSignal) => Promise<FillEmptyDaysPreviewResponse>;
}

type Props = DinnerReviewRequest & {
  apply: (attempt: PendingDinnerSave) => Promise<{ stale: string | null }>;
  close: () => void;
};

export function FillEmptyDaysDialog({ week, preview, apply, close }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [proposal, setProposal] = useState<(FillEmptyDaysPreviewResponse & { commandId: string }) | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "applying" | "uncertain" | "stale" | "unavailable">("loading");
  const [message, setMessage] = useState("");
  const submitting = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void preview(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setProposal({ ...result, commandId: crypto.randomUUID() });
      setStatus("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setStatus("unavailable");
      setMessage(error instanceof Error && error.name === "Error" ? error.message : "Could not load the preview. Check your connection and try again.");
    });
    return () => controller.abort();
  }, [attempt, preview]);

  function refresh() {
    setProposal(null);
    setMessage("");
    setStatus("loading");
    setAttempt(n => n + 1);
  }

  async function confirm() {
    if (!proposal || !proposal.preview.additions.length || submitting.current || (status !== "ready" && status !== "uncertain")) return;
    submitting.current = true;
    setMessage("");
    setStatus("applying");
    try {
      const result = await apply({
        request: { review: proposal.review, commandId: proposal.commandId },
        dinners: proposal.preview.additions.map(meal => ({ date: meal.date, id: meal.id, reason: proposal.preview.reasons[meal.date] })),
      });
      if (!mounted.current) return;
      if (result.stale) {
        setStatus("stale");
        setMessage(result.stale);
      } else close();
    } catch (error) {
      if (!mounted.current) return;
      setStatus("uncertain");
      setMessage(error instanceof Error && error.name === "Error" ? error.message : "Could not confirm whether these dinners were saved. Retry to check this plan.");
    } finally { submitting.current = false; }
  }

  const plan = proposal?.preview;
  return <Modal className="kitchen-modal-backdrop" labelledBy="fill-empty-title" close={() => { if (!submitting.current) close(); }}>
    <section className="panel kitchen-modal pantry-import-modal">
      <header><h2 id="fill-empty-title">Review dinners</h2><p>Week of {dateLabel(week, { month: "long", day: "numeric", year: "numeric" })}</p></header>
      <div className="pantry-import-rows" role="region" aria-label="Proposed week plan" tabIndex={0}>
        {status === "loading" && <p role="status">Checking empty dates, pantry stock and shopping…</p>}
        {plan && <>
          {!plan.additions.length && <p>No eligible dinners to add to this week’s upcoming empty days.</p>}
          {plan.additions.map(meal => {
            const estimate = plan.readinessByDate[meal.date];
            return <article key={meal.id} aria-label={dateLabel(meal.date)}>
              <h3><time dateTime={meal.date}>{dateLabel(meal.date)}</time> · {meal.title}</h3>
              <p>{meal.servings ? `${meal.servings} servings` : `${meal.batches} recipe ${meal.batches === 1 ? "batch" : "batches"}`}</p>
              {estimate.shopping.length ? <><strong>Still needed</strong><ul aria-label="Still needed">{estimate.shopping.map((item, index) => <li key={index}>
                {item.name} · {item.measure}{item.needsReview && " · Review amount"}{item.needsReview && <ul>{item.notes?.map(note => <li key={note}>{note}</li>)}</ul>}
              </li>)}</ul></> : <p>Pantry covers the ingredients for this dinner.</p>}
            </article>;
          })}
          {plan.additions.length > 0 && <section aria-label="Weekly shopping changes"><h3>Weekly shopping changes</h3>
            {plan.shoppingDelta.length ? <ul>{plan.shoppingDelta.map(item => <li key={item.key}>
              <strong>{item.name}</strong> · {item.before ?? "None"} → {item.after ?? "None"}{item.added && ` (+${item.added})`}{item.needsReview && " · Review amount"}
            </li>)}</ul> : <p>These dinners add nothing to the weekly shopping list.</p>}
          </section>}
        </>}
      </div>
      <footer>
        {message && <p role="alert">{message}</p>}
        {status === "applying" && <p role="status">Saving the reviewed dinners…</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={status === "applying"} onClick={close}>{status === "uncertain" ? "Close" : "Cancel"}</button>
          {status === "stale" || status === "unavailable" ? <button className="primary-button" onClick={refresh}>{status === "stale" ? "Review again" : "Retry preview"}</button>
            : Boolean(plan?.additions.length) && <button className="primary-button" onClick={() => void confirm()} disabled={status === "applying"}>{status === "uncertain" ? "Retry save" : "Apply dinners"}</button>}
        </div>
      </footer>
    </section>
  </Modal>;
}
