"use client";

import { useState } from "react";
import { useAppSession } from "../lib/app-session";

export function CatalogSetup({ loaded }: { loaded: () => Promise<void> }) {
  const { session, fetch: kitchenFetch } = useAppSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setBusy(true); setError("");
    try {
      const response = await kitchenFetch("/api/admin/catalog/demo", { method: "POST", signal: AbortSignal.timeout(30_000) });
      const result = await response.json() as { ok?: boolean; error?: { message?: string } };
      if (!response.ok || !result.ok) throw new Error(result.error?.message || "The starter recipes could not be loaded. Please retry.");
      await loaded();
    } catch (cause) {
      setError(cause instanceof Error && cause.name !== "TimeoutError" ? cause.message : "Loading took too long. Retry to finish adding the recipes.");
    } finally { setBusy(false); }
  }
  if (session.mode === "hosted" && !session.platformAdmin) return <section className="panel catalog-setup"><h2>The recipe collection is being prepared</h2><p>Your kitchen is available. Ask the beta administrator to publish approved recipes, then retry.</p><button className="secondary-button" onClick={() => void loaded()}>Retry recipes</button></section>;
  return <section className="panel catalog-setup" aria-label="Set up your recipe collection" aria-busy={busy}>
    <span className="eyebrow">Your first dinner</span>
    <h2>Start with three pantry-friendly recipes</h2>
    <p>Add original RAG Chef starter recipes, then choose dinner, see what to buy, and follow the cooking steps.</p>
    <p>No AI model or recipe download is needed. Your pantry and saved dinners stay as they are.</p>
    {session.mode === "hosted" && <p>Additional recipe sources require a hosted distribution review and operator approval before import. Local prototype sync and server embedding refresh are unavailable here.</p>}
    <button className="primary-button" disabled={busy} onClick={() => void load()}>{busy ? "Adding starter recipes…" : error ? "Retry starter recipes" : "Load starter recipes"}</button>
    {busy && <p role="status">Saving your recipe collection…</p>}
    {error && <p role="alert">{error}</p>}
    <p className="quantity-note">Original recipes shared under MIT. Review ingredients and your cooking preferences before choosing a dinner.</p>
  </section>;
}
