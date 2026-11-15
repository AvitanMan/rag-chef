"use client";

import { useEffect, useRef, useState } from "react";
import { catalogJobStatusPath, CatalogJobFailedError, waitForCatalogJob, type CatalogJobResponse } from "../lib/catalog-job-client";
import { DEMO_RECIPES } from "../lib/demo-recipes";
import { useAppSession } from "../lib/app-session";

export function CatalogSetup({ loaded, expand = false }: { loaded: () => Promise<void>; expand?: boolean }) {
  const { session, tab, fetch: kitchenFetch } = useAppSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const pending = useRef<{ requestId: string; statusUrl?: string } | null>(null);
  const storageKey = "rag-chef-catalog-starter-request-v1";
  useEffect(() => () => active.current?.abort(), []);
  async function load() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    setBusy(true); setError("");
    try {
      if (!pending.current) {
        try {
          const previous = JSON.parse(tab.getItem(storageKey) || "null");
          if (previous && typeof previous.requestId === "string" && /^[a-zA-Z0-9-]{1,200}$/.test(previous.requestId)) {
            pending.current = { requestId: previous.requestId, ...(previous.statusUrl ? { statusUrl: catalogJobStatusPath(previous.statusUrl) } : {}) };
          }
        } catch { /* A damaged or unavailable browser cache cannot block setup. */ }
        pending.current ??= { requestId: crypto.randomUUID() };
      }
      try { tab.setItem(storageKey, JSON.stringify(pending.current)); } catch { /* The current tab still retains the retry key. */ }
      if (!pending.current.statusUrl) {
        const response = await kitchenFetch("/api/admin/catalog/demo", { method: "POST", headers: { "Idempotency-Key": pending.current.requestId }, signal, redirect: "error" });
        const result = await response.json() as Partial<CatalogJobResponse> & { error?: string | { message?: string } };
        if (!response.ok || !result.ok || !result.job) throw new Error(typeof result.error === "string" ? result.error : result.error?.message || "The starter recipes could not be loaded. Please retry.");
        pending.current.statusUrl = catalogJobStatusPath(result.statusUrl);
        try { tab.setItem(storageKey, JSON.stringify(pending.current)); } catch { /* Keep the in-memory status link for retry. */ }
      }
      await waitForCatalogJob(kitchenFetch, pending.current.statusUrl, signal);
      pending.current = null;
      try { tab.removeItem(storageKey); } catch { /* A successful job remains safe to query again. */ }
      await loaded();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof CatalogJobFailedError) {
        pending.current = null;
        try { tab.removeItem(storageKey); } catch { /* A new request key is retained in memory on retry. */ }
      }
      setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "Recipes are still being prepared. Retry to check their progress.");
    } finally { active.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  if (session.mode === "hosted" && !session.platformAdmin && expand) return <p className="quantity-note">Ask the administrator to add the everyday dinner collection, then refresh recipes.</p>;
  if (session.mode === "hosted" && !session.platformAdmin) return <section className="panel catalog-setup" aria-label="Set up your recipe collection"><h2>The shared recipe collection is empty</h2><p>Ask the administrator to add approved recipes. You can still manage pantry stock and saved dinners.</p><button className="secondary-button" onClick={() => void loaded()}>Refresh recipes</button></section>;
  return <section className="panel catalog-setup" aria-label={expand ? "Add everyday dinners" : "Set up your recipe collection"} aria-busy={busy}>
    <span className="eyebrow">Everyday cooking</span>
    <h2>{expand ? "Add eight everyday dinners" : `Start with ${DEMO_RECIPES.length} dinner ideas`}</h2>
    <p>Garlic tomato pasta, chicken and potatoes, egg fried rice, and more familiar meals with complete preparation steps.</p>
    <p>Eight new original dinners alongside the three starters. These recipes have not been kitchen-tested; total times are unmeasured.</p>
    <p>{session.mode === "hosted" ? "Add these recipes to the shared catalog. No AI model or recipe download is needed." : "No AI model, account, or recipe download is needed."} Your pantry and saved dinners stay as they are.</p>
    <button className="primary-button" disabled={busy} onClick={() => void load()}>{busy ? "Adding recipes…" : error ? expand ? "Retry everyday dinners" : "Retry starter recipes" : expand ? "Add everyday dinners" : "Load starter recipes"}</button>
    {busy && <p role="status">Saving your recipe collection {session.mode === "hosted" ? "to the shared catalog" : "on this Mac"}…</p>}
    {error && <p role="alert">{error}</p>}
    <p className="quantity-note">Original recipes shared under MIT. Review ingredients and your cooking preferences before choosing a dinner.</p>
  </section>;
}
