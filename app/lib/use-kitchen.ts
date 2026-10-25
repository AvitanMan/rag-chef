"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KitchenDocument, KitchenState } from "./kitchen-types";
import { EMPTY_KITCHEN } from "./kitchen-types";
import { KITCHEN_CACHE_KEY, LEGACY_STORAGE_KEY, migrateLegacyKitchen } from "./kitchen-state";
import type { Recipe } from "./recipe-types";
import { parseCachedKitchen, readRecoveryDrafts, type DraftReason, type RecoveryCandidate, type RecoveryEntry } from "./kitchen-recovery";
import { validateKitchenWrite } from "./kitchen-validation";

export type KitchenSaveState = "loading" | "pending" | "saving" | "saved" | "offline" | "error" | "conflict";

export function useKitchen(fallbackRecipes: Recipe[]) {
  const [state, setState] = useState<KitchenState>(EMPTY_KITCHEN);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Loading your kitchen…");
  const [savePhase, setSavePhase] = useState<KitchenSaveState>("loading");
  const [backupAvailable, setBackupAvailable] = useState(true);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [conflict, setConflict] = useState<KitchenDocument | null>(null);
  const [retry, setRetry] = useState(0);
  const [recoveryCandidates, setRecoveryCandidates] = useState<RecoveryCandidate[]>([]);
  const latest = useRef(state);
  const revision = useRef(0);
  const savedJson = useRef("");
  const saving = useRef(false);
  const paused = useRef(false);
  const storageAvailable = useRef(true);
  const draftKey = useRef("");
  const connected = useRef(false);
  const recoveryEntries = useRef(new Map<string, RecoveryEntry>());
  const serverDocument = useRef<KitchenDocument | null>(null);

  const refreshRecovery = useCallback(() => {
    try {
      const entries = readRecoveryDrafts(window.localStorage, latest.current, draftKey.current);
      recoveryEntries.current = new Map(entries.map((entry) => [entry.summary.id, entry]));
      setRecoveryCandidates(entries.map((entry) => entry.summary));
    } catch { /* Storage failure is reported by the draft writer. */ }
  }, []);

  const cache = useCallback((value: KitchenState, dirty: boolean) => {
    try {
      const serialized = JSON.stringify({ revision: revision.current, state: value, dirty, updatedAt: new Date().toISOString() });
      if (dirty) {
        if (!draftKey.current || sessionStorage.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`) !== draftKey.current) throw new Error("No recoverable tab draft");
        window.localStorage.setItem(draftKey.current, serialized);
      }
      if (!dirty) {
        window.localStorage.setItem(KITCHEN_CACHE_KEY, serialized);
        if (draftKey.current) window.localStorage.removeItem(draftKey.current);
      }
      storageAvailable.current = true;
      setBackupAvailable(true);
      refreshRecovery();
      return true;
    } catch {
      storageAvailable.current = false;
      setBackupAvailable(false);
      setStatus("Browser backup is full or unavailable. Keep this tab open until saved to this Mac.");
      return false;
    }
  }, [refreshRecovery]);

  const preserveCurrent = useCallback((reason: DraftReason) => {
    try { validateKitchenWrite({ revision: revision.current, state: latest.current }); }
    catch (error) {
      setStatus(`Correct the current kitchen before replacing it: ${error instanceof Error ? error.message : "invalid kitchen data"}`);
      return false;
    }
    try {
      const id = `${KITCHEN_CACHE_KEY}:draft:${crypto.randomUUID()}`;
      localStorage.setItem(id, JSON.stringify({ revision: revision.current, state: latest.current, dirty: true, reason, updatedAt: new Date().toISOString() }));
      return true;
    } catch {
      setStatus("Could not preserve your current kitchen. Free browser storage or export it before replacing it.");
      setBackupAvailable(false);
      return false;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let cached: ReturnType<typeof parseCachedKitchen> = null;
      let legacy: Record<string, unknown> | null = null;
      // Initialize recovery before parsing older data, which may be damaged.
      draftKey.current = `${KITCHEN_CACHE_KEY}:draft:${crypto.randomUUID()}`;
      try {
        const previousDraftKey = sessionStorage.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`);
        // A fresh key on each page load also isolates duplicated browser tabs.
        sessionStorage.setItem(`${KITCHEN_CACHE_KEY}:tab-draft`, draftKey.current);
        const previousDraft = previousDraftKey ? localStorage.getItem(previousDraftKey) : null;
        const parsedDraft = parseCachedKitchen(previousDraft);
        cached = parsedDraft?.dirty ? parsedDraft : parseCachedKitchen(localStorage.getItem(KITCHEN_CACHE_KEY));
        const old = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (old) legacy = JSON.parse(old);
      } catch { /* A damaged cache does not replace the database. */ }

      let document: KitchenDocument | null = null;
      try {
        const response = await fetch("/api/kitchen", { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error();
        document = await response.json();
      } catch { /* The browser cache supports temporary offline use. */ }
      if (!alive) return;

      let chosen: KitchenState;
      if (cached?.dirty) {
        chosen = cached.state;
        revision.current = cached.revision;
        if (document && document.revision !== cached.revision) {
          paused.current = true;
          setConflict(document);
        }
        savedJson.current = "";
      } else if (document?.state) {
        chosen = document.state;
        revision.current = document.revision;
        savedJson.current = JSON.stringify(chosen);
      } else if (cached) {
        chosen = cached.state;
        revision.current = cached.revision;
        savedJson.current = document ? "" : JSON.stringify(chosen);
      } else {
        let knownRecipes = fallbackRecipes;
        try {
          const response = await fetch("/api/recipes", { signal: AbortSignal.timeout(5_000) });
          const result = response.ok ? await response.json() as { recipes?: Recipe[] } : null;
          if (Array.isArray(result?.recipes)) knownRecipes = [...fallbackRecipes, ...result.recipes];
        } catch { /* Unresolved old recipes stay visible in the plan. */ }
        if (!alive) return;
        chosen = migrateLegacyKitchen(legacy, knownRecipes);
        revision.current = document?.revision ?? 0;
        savedJson.current = "";
      }
      latest.current = chosen;
      setSavedSnapshot(savedJson.current);
      connected.current = Boolean(document);
      serverDocument.current = document;
      setState(chosen);
      cache(chosen, savedJson.current !== JSON.stringify(chosen));
      setStatus(!storageAvailable.current ? "Browser backup is unavailable. Keep this tab open until saved to this Mac." : paused.current ? "A newer saved kitchen exists. Choose which version to keep." : document ? "Kitchen loaded from this Mac" : "Offline — using the browser backup");
      setSavePhase(paused.current ? "conflict" : document ? savedJson.current === JSON.stringify(chosen) ? "saved" : "pending" : "offline");
      setReady(true);
      refreshRecovery();
    })();
    return () => { alive = false; };
    // Initial recovery is intentionally performed only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flush = useCallback(async () => {
    if (saving.current || paused.current || !ready) return;
    const snapshot = latest.current;
    const serialized = JSON.stringify(snapshot);
    if (savedJson.current === serialized) {
      if (!connected.current) {
        try {
          const response = await fetch("/api/kitchen", { signal: AbortSignal.timeout(5_000) });
          if (!response.ok) throw new Error();
          const current = await response.json() as KitchenDocument;
          serverDocument.current = current;
          if (current.revision !== revision.current) {
            paused.current = true; setConflict(current); setSavePhase("conflict");
            setStatus("The saved kitchen changed while offline. Choose which version to keep.");
            return;
          }
          connected.current = true;
          serverDocument.current = current;
        } catch {
          setSavePhase("offline"); setStatus("Offline — using the browser backup. Reconnect and retry."); return;
        }
      }
      setSavePhase("saved");
      setStatus(storageAvailable.current ? "Saved on this Mac · browser backup ready" : "Saved on this Mac · browser backup unavailable");
      return;
    }
    saving.current = true;
    setStatus("Saving your kitchen…");
    setSavePhase("saving");
    let success = false;
    try {
      const response = await fetch("/api/kitchen", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: revision.current, state: snapshot }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as KitchenDocument & { current?: KitchenDocument; error?: { message?: string } };
      if (response.status === 409) {
        paused.current = true;
        if (result.current) { setConflict(result.current); serverDocument.current = result.current; }
        setStatus("Another tab saved changes. Your draft is preserved; choose a version.");
        setSavePhase("conflict");
        return;
      }
      if (!response.ok) throw new Error(result.error?.message || "Save failed");
      revision.current = result.revision;
      savedJson.current = serialized;
      setSavedSnapshot(serialized);
      success = true;
      connected.current = true;
      serverDocument.current = { revision: result.revision, state: snapshot, updatedAt: result.updatedAt };
      cache(latest.current, JSON.stringify(latest.current) !== serialized);
      setStatus(storageAvailable.current ? "Saved on this Mac · browser backup ready" : "Saved on this Mac · browser backup unavailable");
      setSavePhase("saved");
    } catch (error) {
      connected.current = false;
      setSavePhase(error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError") ? "offline" : "error");
      cache(latest.current, true);
      setStatus(storageAvailable.current
        ? `Changes kept in this browser. ${error instanceof Error && error.message !== "Failed to fetch" ? error.message : "Reconnect to save on this Mac."}`
        : "Could not save to this Mac or the browser backup. Keep this tab open and retry saving.");
    } finally {
      saving.current = false;
      if (success && JSON.stringify(latest.current) !== savedJson.current) setRetry((value) => value + 1);
    }
  }, [cache, ready]);

  useEffect(() => {
    if (!ready) return;
    latest.current = state;
    cache(state, JSON.stringify(state) !== savedJson.current);
    const timer = window.setTimeout(() => void flush(), 450);
    return () => window.clearTimeout(timer);
  }, [state, ready, retry, cache, flush]);

  useEffect(() => {
    const retrySave = () => setRetry((value) => value + 1);
    window.addEventListener("online", retrySave);
    window.addEventListener("storage", refreshRecovery);
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (!storageAvailable.current && JSON.stringify(latest.current) !== savedJson.current) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => { window.removeEventListener("online", retrySave); window.removeEventListener("storage", refreshRecovery); window.removeEventListener("beforeunload", warnUnsaved); };
  }, [refreshRecovery]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/kitchen-sw.js").then(async () => {
      const registration = await navigator.serviceWorker.ready;
      const urls = ["/", ...performance.getEntriesByType("resource").map((entry) => entry.name)];
      registration.active?.postMessage({ type: "CACHE_SHELL", urls });
    }).catch(() => { /* D1 and browser drafts still work without an offline shell. */ });
  }, []);

  const update = useCallback((change: (current: KitchenState) => KitchenState) => {
    setState((current) => {
      const next = change(current);
      latest.current = next;
      return next;
    });
  }, []);

  const resolveConflict = useCallback((keepDraft: boolean) => {
    if (!conflict) return;
    serverDocument.current = conflict;
    revision.current = conflict.revision;
    paused.current = false;
    setConflict(null);
    if (keepDraft) {
      savedJson.current = "";
      setSavePhase("pending");
      setRetry((value) => value + 1);
    } else {
      const savedState = conflict.state ?? structuredClone(EMPTY_KITCHEN);
      savedJson.current = JSON.stringify(savedState);
      setSavedSnapshot(savedJson.current);
      latest.current = savedState;
      setState(savedState);
      cache(savedState, false);
      setStatus(conflict.state ? "Loaded the saved version from this Mac" : "No kitchen was saved; loaded an empty kitchen");
      connected.current = true;
      setSavePhase("saved");
    }
  }, [cache, conflict]);

  const restoreBackup = useCallback((value: KitchenState): boolean => {
    if (!ready || saving.current || paused.current) {
      setStatus("Finish saving or resolve the current conflict before restoring a backup.");
      return false;
    }
    try { validateKitchenWrite({ revision: revision.current, state: value }); }
    catch (error) { setStatus(error instanceof Error ? error.message : "This kitchen backup is invalid."); return false; }
    if (!preserveCurrent("before-restore")) return false;
    const next = structuredClone(value);
    if (!cache(next, true)) return false;
    latest.current = next;
    savedJson.current = "";
    setState(next);
    setSavePhase("pending");
    setStatus("Backup restored in this browser. Your previous kitchen is available in unsaved kitchens.");
    setRetry((value) => value + 1);
    refreshRecovery();
    return true;
  }, [cache, preserveCurrent, ready, refreshRecovery]);

  const recoverDraft = useCallback((id: string): boolean => {
    if (!ready || saving.current || paused.current) {
      setStatus("Finish saving or resolve the current conflict before recovering another kitchen.");
      return false;
    }
    const entry = recoveryEntries.current.get(id);
    try {
      if (!entry || localStorage.getItem(id) !== entry.serialized) {
        refreshRecovery(); setStatus("That draft changed in another tab. Review its updated details and choose again."); return false;
      }
      if (!preserveCurrent("before-recovery")) return false;
      const previousRevision = revision.current;
      revision.current = entry.cached.revision;
      const next = structuredClone(entry.cached.state);
      if (!cache(next, true)) { revision.current = previousRevision; return false; }
      latest.current = next;
      savedJson.current = "";
      setState(next);
      const current = serverDocument.current;
      if (current && current.revision !== revision.current) {
        paused.current = true; setConflict(current); setSavePhase("conflict");
        setStatus("Draft recovered. The saved kitchen has changed; choose which version to keep.");
      } else {
        setSavePhase("pending"); setStatus("Draft recovered into this tab. The original draft is preserved.");
        setRetry((value) => value + 1);
      }
      refreshRecovery();
      return true;
    } catch {
      setStatus("The browser could not read that draft. Export your current kitchen and retry."); return false;
    }
  }, [cache, preserveCurrent, ready, refreshRecovery]);

  const discardDraft = useCallback((id: string): boolean => {
    const entry = recoveryEntries.current.get(id);
    try {
      if (!entry || localStorage.getItem(id) !== entry.serialized) {
        refreshRecovery(); setStatus("That draft changed in another tab. Review it again before discarding."); return false;
      }
      localStorage.removeItem(id);
      refreshRecovery();
      return true;
    } catch { setStatus("The browser could not remove that draft."); return false; }
  }, [refreshRecovery]);

  const saveState: KitchenSaveState = savePhase === "saved" && JSON.stringify(state) !== savedSnapshot ? "pending" : savePhase;
  return { state, update, ready, status, saveState, getRevision: () => revision.current, backupAvailable, conflict, resolveConflict, retrySave: () => setRetry((value) => value + 1),
    busy: savePhase === "saving" || Boolean(conflict), recoveryCandidates, recoverDraft, discardDraft, restoreBackup };
}
