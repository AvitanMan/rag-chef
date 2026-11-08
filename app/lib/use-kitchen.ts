"use client";

import { randomId } from "./random-id";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeKitchenDraft } from "./kitchen-merge";
import { useAppSession } from "./app-session";
import type { KitchenDocument, KitchenState } from "./kitchen-types";
import { DEFAULT_COOKING_PROFILE, EMPTY_KITCHEN } from "./kitchen-types";
import { KITCHEN_CACHE_KEY, LEGACY_STORAGE_KEY, PREFERENCES_STORAGE_KEY, migrateLegacyKitchen } from "./kitchen-state";
import type { Recipe } from "./recipe-types";
import { parseCachedKitchen, readRecoveryDrafts, type DraftReason, type RecoveryCandidate, type RecoveryEntry } from "./kitchen-recovery";
import { parseLegacyCookingProfile, validateKitchenWrite } from "./kitchen-validation";
import { buildKitchenChangePreview, type KitchenChangePreview } from "./kitchen-change-preview";

export type KitchenSaveState = "loading" | "pending" | "saving" | "saved" | "offline" | "error" | "conflict";
export type RecoveryDraftPreview = Readonly<{
  id: string;
  updatedAt: string | null;
  revision: number;
  changes: KitchenChangePreview;
  token: string;
}>;

function conflictFailure(error: unknown): string {
  return `Kitchen changes could not be merged safely: ${error instanceof Error ? error.message : "invalid combined kitchen data"} Your draft is unchanged and saving remains paused. Export your kitchen backup before making corrections, then retry the merge. If purchase history is ambiguous, ask the household owner for help reconciling it.`;
}

export function useKitchen(fallbackRecipes: Recipe[]) {
  const { local: privateStorage, tab: privateTabStorage, storageKey, session, fetch: kitchenFetch, registerSessionWork } = useAppSession();
  const hosted = session.mode === "hosted";
  const requiresPassword = Boolean(session.localServer?.requiresPassword);
  const savedLocation = hosted ? "the shared kitchen" : "the server computer";
  const [state, setState] = useState<KitchenState>(EMPTY_KITCHEN);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Loading your kitchen…");
  const [savePhase, setSavePhase] = useState<KitchenSaveState>("loading");
  const [backupAvailable, setBackupAvailable] = useState(true);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [browserSnapshot, setBrowserSnapshot] = useState("");
  const [conflict, setConflict] = useState<KitchenDocument | null>(null);
  const [mergeError, setMergeError] = useState("");
  const [retry, setRetry] = useState(0);
  const [recoveryCandidates, setRecoveryCandidates] = useState<RecoveryCandidate[]>([]);
  const [recoveryError, setRecoveryError] = useState("");
  const [mergeBase, setMergeBase] = useState<KitchenState | null>(null);
  const baseSnapshot = useRef<KitchenState | null>(null);
  const rememberBase = useCallback((value: KitchenState | null) => { baseSnapshot.current = value; setMergeBase(value); }, []);
  const latest = useRef(state);
  const revision = useRef(0);
  const savedJson = useRef("");
  const saving = useRef(false);
  const paused = useRef(false);
  const recoveryReviewPending = useRef(false);
  const storageAvailable = useRef(true);
  const draftKey = useRef("");
  const connected = useRef(false);
  const recoveryEntries = useRef(new Map<string, RecoveryEntry>());
  const serverDocument = useRef<KitchenDocument | null>(null);
  const recoveryPreview = useRef<{ id: string; token: string; currentState: string; currentRevision: number; candidate: string } | null>(null);

  const refreshRecovery = useCallback(() => {
    try {
      const entries = readRecoveryDrafts(privateStorage, latest.current, draftKey.current);
      recoveryEntries.current = new Map(entries.map((entry) => [entry.summary.id, entry]));
      setRecoveryCandidates(entries.map((entry) => entry.summary));
    } catch { /* Storage failure is reported by the draft writer. */ }
  }, [privateStorage]);

  const cache = useCallback((value: KitchenState, dirty: boolean, onError?: (message: string) => void) => {
    try {
      const serialized = JSON.stringify({ revision: revision.current, state: value, base: baseSnapshot.current, dirty, updatedAt: new Date().toISOString() });
      if (dirty) {
        if (!draftKey.current || privateTabStorage.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`) !== draftKey.current) throw new Error("No recoverable tab draft");
        privateStorage.setItem(draftKey.current, serialized);
      }
      if (!dirty) {
        privateStorage.setItem(KITCHEN_CACHE_KEY, serialized);
        if (draftKey.current) privateStorage.removeItem(draftKey.current);
      }
      setBrowserSnapshot(JSON.stringify(value));
      storageAvailable.current = true;
      setBackupAvailable(true);
      refreshRecovery();
      return true;
    } catch {
      storageAvailable.current = false;
      setBackupAvailable(false);
      const message = `Browser backup is full or unavailable. Keep this tab open until saved to ${savedLocation}.`;
      setStatus(message); onError?.(message);
      return false;
    }
  }, [refreshRecovery, privateStorage, privateTabStorage, savedLocation]);

  const preserveCurrent = useCallback((reason: DraftReason, onError?: (message: string) => void) => {
    try { validateKitchenWrite({ revision: revision.current, state: latest.current }); }
    catch (error) {
      const message = `Correct the current kitchen before replacing it: ${error instanceof Error ? error.message : "invalid kitchen data"}`;
      setStatus(message); onError?.(message);
      return false;
    }
    try {
      const id = `${KITCHEN_CACHE_KEY}:draft:${randomId()}`;
      privateStorage.setItem(id, JSON.stringify({ revision: revision.current, state: latest.current, base: baseSnapshot.current, dirty: true, reason, updatedAt: new Date().toISOString() }));
      return true;
    } catch {
      const message = "Could not preserve your current kitchen. Free browser storage or export it before replacing it.";
      setStatus(message); onError?.(message);
      setBackupAvailable(false);
      return false;
    }
  }, [privateStorage]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let cached: ReturnType<typeof parseCachedKitchen> = null;
      let legacy: Record<string, unknown> | null = null;
      // Initialize recovery before parsing older data, which may be damaged.
      draftKey.current = `${KITCHEN_CACHE_KEY}:draft:${randomId()}`;
      try {
        const previousDraftKey = privateTabStorage.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`);
        // A fresh key on each page load also isolates duplicated browser tabs.
        const previousDraft = previousDraftKey ? privateStorage.getItem(previousDraftKey) : null;
        const parsedDraft = parseCachedKitchen(previousDraft);
        cached = parsedDraft?.dirty ? parsedDraft : parseCachedKitchen(privateStorage.getItem(KITCHEN_CACHE_KEY));
        try { privateTabStorage.setItem(`${KITCHEN_CACHE_KEY}:tab-draft`, draftKey.current); } catch { /* The protected storage mirror retains this tab's pointer in memory. */ }
        const old = privateStorage.getItem(LEGACY_STORAGE_KEY);
        if (old) legacy = JSON.parse(old);
      } catch { /* A damaged cache does not replace the database. */ }
      let browserProfile: ReturnType<typeof parseLegacyCookingProfile> = null;
      try {
        const preferences = privateStorage.getItem(PREFERENCES_STORAGE_KEY);
        browserProfile = parseLegacyCookingProfile(preferences ? JSON.parse(preferences)?.profile : legacy?.profile);
      } catch { /* Invalid browser preferences cannot replace a saved cooking profile. */ }

      let document: KitchenDocument | null = null;
      try {
        const response = await kitchenFetch("/api/kitchen", { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error();
        document = await response.json();
      } catch { /* The browser cache supports temporary offline use. */ }
      if (!alive) return;

      let chosen: KitchenState;
      if (cached?.dirty) {
        recoveryReviewPending.current = requiresPassword;
        chosen = cached.state;
        revision.current = cached.revision;
        if (document && (document.revision !== cached.revision || requiresPassword)) {
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
        // Only an old plan needs recipe resolution. A fresh kitchen must not
        // wait for the discovery adapter or make a third-party recipe request.
        if (legacy?.plan && typeof legacy.plan === "object") try {
          const response = await kitchenFetch("/api/recipes/catalog", { signal: AbortSignal.timeout(5_000) });
          const result = response.ok ? await response.json() as { recipes?: Recipe[] } : null;
          if (Array.isArray(result?.recipes)) knownRecipes = [...fallbackRecipes, ...result.recipes];
        } catch { /* Unresolved old recipes stay visible in the plan. */ }
        if (!alive) return;
        chosen = migrateLegacyKitchen(legacy, knownRecipes);
        revision.current = document?.revision ?? 0;
        savedJson.current = "";
      }
      if (!chosen.cookingProfile) {
        const profile = document?.state?.cookingProfile ?? browserProfile;
        if (profile) chosen = { ...chosen, cookingProfile: structuredClone(profile) };
      }
      rememberBase(cached?.dirty ? cached.base ?? null : document?.state ?? null);
      latest.current = chosen;
      setSavedSnapshot(savedJson.current);
      connected.current = Boolean(document);
      serverDocument.current = document;
      setState(chosen);
      cache(chosen, savedJson.current !== JSON.stringify(chosen));
      setStatus(!storageAvailable.current ? `Browser backup is unavailable. Keep this tab open until saved to ${savedLocation}.` : paused.current ? "A newer saved kitchen exists. Review the changes before saving." : document ? `Kitchen loaded from ${savedLocation}` : "Offline — using the browser backup");
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
    if (recoveryReviewPending.current) {
      // A failed initial read must not turn reauthentication into permission to
      // autosave a recovered draft. Fetch the current kitchen, then await review.
      saving.current = true;
      try {
        const response = await kitchenFetch("/api/kitchen", { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error();
        const current = await response.json() as KitchenDocument;
        if (current.state) validateKitchenWrite({ revision: current.revision, state: current.state });
        serverDocument.current = current; connected.current = true; paused.current = true;
        setConflict(current); setSavePhase("conflict");
        setStatus("Review your recovered draft against the saved kitchen before saving.");
      } catch {
        setSavePhase("offline");
        setStatus("Your recovered draft is kept here. Reconnect and retry to review it against the saved kitchen.");
      } finally { saving.current = false; }
      return;
    }
    const snapshot = latest.current;
    const serialized = JSON.stringify(snapshot);
    if (savedJson.current === serialized) {
      if (!connected.current) {
        try {
          const response = await kitchenFetch("/api/kitchen", { signal: AbortSignal.timeout(5_000) });
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
      setStatus(storageAvailable.current ? `Saved in ${savedLocation} · browser backup ready` : `Saved in ${savedLocation} · browser backup unavailable`);
      return;
    }
    saving.current = true;
    setStatus("Saving your kitchen…");
    setSavePhase("saving");
    let success = false;
    try {
      const response = await kitchenFetch("/api/kitchen", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: revision.current, state: snapshot }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as KitchenDocument & { current?: KitchenDocument; error?: { message?: string } };
      if (response.status === 409) {
        paused.current = true;
        if (result.current) { setConflict(result.current); serverDocument.current = result.current; }
        setStatus("The saved kitchen changed. Your draft is preserved; review the differences.");
        setSavePhase("conflict");
        return;
      }
      if (!response.ok) throw new Error(result.error?.message || "Save failed");
      revision.current = result.revision;
      savedJson.current = serialized;
      rememberBase(snapshot);
      setSavedSnapshot(serialized);
      success = true;
      connected.current = true;
      serverDocument.current = { revision: result.revision, state: snapshot, updatedAt: result.updatedAt };
      cache(latest.current, JSON.stringify(latest.current) !== serialized);
      setStatus(storageAvailable.current ? `Saved in ${savedLocation} · browser backup ready` : `Saved in ${savedLocation} · browser backup unavailable`);
      setSavePhase("saved");
    } catch (error) {
      connected.current = false;
      setSavePhase(error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError") ? "offline" : "error");
      cache(latest.current, true);
      setStatus(storageAvailable.current
        ? `Changes kept in this browser. ${error instanceof Error && error.message !== "Failed to fetch" ? error.message : `Reconnect to save to ${savedLocation}.`}`
        : `Could not save to ${savedLocation} or the browser backup. Keep this tab open and retry saving.`);
    } finally {
      saving.current = false;
      if (success && JSON.stringify(latest.current) !== savedJson.current) setRetry((value) => value + 1);
    }
  }, [cache, ready, savedLocation, rememberBase, kitchenFetch]);

  useEffect(() => registerSessionWork("kitchen", {
    hasPending: () => ready && (saving.current || JSON.stringify(latest.current) !== savedJson.current),
    checkpoint: () => {
      if (ready && !cache(latest.current, JSON.stringify(latest.current) !== savedJson.current)) throw new Error("Kitchen draft is held in memory only.");
    },
    save: async () => {
      if (!ready || paused.current) return false;
      const deadline = Date.now() + 11_000;
      while (saving.current && Date.now() < deadline) await new Promise(resolve => window.setTimeout(resolve, 50));
      if (saving.current) return false;
      await flush();
      return !paused.current && connected.current && JSON.stringify(latest.current) === savedJson.current;
    },
  }), [cache, flush, ready, registerSessionWork]);



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
    if (hosted || requiresPassword) {
      // The session gate removes private caches before login is checked.
      return;
    }
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    void navigator.serviceWorker.register("/kitchen-sw.js").then(async registered => {
      if (cancelled) { await registered.unregister(); return; }
      const registration = await navigator.serviceWorker.ready;
      if (cancelled) { await registration.unregister(); return; }
      const urls = ["/", ...performance.getEntriesByType("resource").map((entry) => entry.name)];
      registration.active?.postMessage({ type: "CACHE_SHELL", urls });
    }).catch(() => { /* D1 and browser drafts still work without an offline shell. */ });
    return () => { cancelled = true; };
  }, [hosted, requiresPassword]);

  const update = useCallback((change: (current: KitchenState) => KitchenState) => {
    setState((current) => {
      const next = change(current);
      latest.current = next;
      return next;
    });
  }, []);

  const refreshSavedKitchen = useCallback(async (signal?: AbortSignal): Promise<KitchenDocument | null> => {
    if (!ready || saving.current || paused.current) return null;
    const startingRevision = revision.current;
    try {
      const timeout = AbortSignal.timeout(5_000);
      const response = await kitchenFetch("/api/kitchen", { cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new Error();
      const current = await response.json() as KitchenDocument;
      if (current.state) validateKitchenWrite({ revision: current.revision, state: current.state });
      // A save or edit may have happened while this read was in flight.
      if (signal?.aborted || saving.current || paused.current || revision.current !== startingRevision) return null;
      serverDocument.current = current;
      connected.current = true;
      if (current.revision === revision.current && !recoveryReviewPending.current) return current;
      if (JSON.stringify(latest.current) !== savedJson.current) {
        cache(latest.current, true);
        paused.current = true;
        setConflict(current);
        setSavePhase("conflict");
        setStatus("The saved kitchen changed. Your draft is preserved; review the differences.");
        return null;
      }
      const next = current.state ?? structuredClone(EMPTY_KITCHEN);
      revision.current = current.revision;
      savedJson.current = JSON.stringify(next);
      rememberBase(next);
      latest.current = next;
      setSavedSnapshot(savedJson.current);
      setState(next);
      cache(next, false);
      setSavePhase("saved");
      setStatus(storageAvailable.current ? `Kitchen refreshed from ${savedLocation} · browser backup ready` : `Kitchen refreshed from ${savedLocation} · browser backup unavailable`);
      return current;
    } catch {
      if (signal?.aborted) return null;
      setStatus("The saved kitchen could not be refreshed. Retry when the connection is available.");
      return null;
    }
  }, [cache, ready, savedLocation, rememberBase, kitchenFetch]);

  useEffect(() => {
    if (!ready) return;
    const refresh = () => { if (document.visibilityState === "visible") void refreshSavedKitchen(); };
    const changed = (event: StorageEvent) => {
      if (event.key !== storageKey(KITCHEN_CACHE_KEY)) return;
      const saved = parseCachedKitchen(event.newValue);
      if (saved && !saved.dirty && saved.revision > revision.current) refresh();
    };
    window.addEventListener("storage", changed);
    window.addEventListener("focus", refresh);
    const poll = hosted ? window.setInterval(refresh, 5_000) : undefined;
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(poll); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("storage", changed); window.removeEventListener("focus", refresh); };
  }, [ready, refreshSavedKitchen, hosted, storageKey]);

  const resolveConflict = useCallback((keepDraft: boolean) => {
    if (!conflict) return;
    const saved = conflict.state ?? structuredClone(EMPTY_KITCHEN);
    let merged: KitchenState | undefined;
    if (hosted) {
      try {
        merged = mergeKitchenDraft(mergeBase, latest.current, saved, keepDraft).state;
        validateKitchenWrite({ revision: conflict.revision, state: merged });
      } catch (error) {
        const message = conflictFailure(error);
        setMergeError(message); setStatus(message);
        return;
      }
    }
    serverDocument.current = conflict;
    recoveryReviewPending.current = false;
    revision.current = conflict.revision;
    paused.current = false;
    setConflict(null);
    setMergeError("");
    if (merged) {
      // Preserve both independent family edits and this tab's independent edits.
      savedJson.current = JSON.stringify(saved); setSavedSnapshot(savedJson.current);
      rememberBase(saved); latest.current = merged; setState(merged);
      cache(merged, JSON.stringify(merged) !== savedJson.current);
      setSavePhase("pending"); setRetry(value => value + 1);
      setStatus("Reviewed kitchen changes merged. Saving against the latest household revision.");
      return;
    }
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
  }, [cache, conflict, hosted, mergeBase, rememberBase]);

  const restoreBackup = useCallback((value: KitchenState): boolean => {
    if (!ready || saving.current || paused.current) {
      setStatus("Finish saving or resolve the current conflict before restoring a backup.");
      return false;
    }
    try { validateKitchenWrite({ revision: revision.current, state: value }); }
    catch (error) { setStatus(error instanceof Error ? error.message : "This kitchen backup is invalid."); return false; }
    if (!preserveCurrent("before-restore")) return false;
    const next = structuredClone({ ...value, ...(hosted ? { tastePreferences: latest.current.tastePreferences, recentActionReceipts: latest.current.recentActionReceipts } : {}), cookingProfile: value.cookingProfile ?? latest.current.cookingProfile ?? DEFAULT_COOKING_PROFILE });
    if (!cache(next, true)) return false;
    latest.current = next;
    savedJson.current = "";
    setState(next);
    setSavePhase("pending");
    setStatus("Backup restored in this browser. Your previous kitchen is available in unsaved kitchens.");
    setRetry((value) => value + 1);
    refreshRecovery();
    return true;
  }, [cache, preserveCurrent, ready, refreshRecovery, hosted]);

  const effectiveRecoveryState = useCallback((candidate: KitchenState): KitchenState => structuredClone({
    ...candidate,
    ...(hosted ? { tastePreferences: latest.current.tastePreferences, recentActionReceipts: latest.current.recentActionReceipts } : {}),
    cookingProfile: candidate.cookingProfile ?? latest.current.cookingProfile ?? DEFAULT_COOKING_PROFILE,
  }), [hosted]);

  // Save/refresh notifications must not replace a recovery decision's error.
  const recoveryFailed = useCallback((message: string) => {
    setRecoveryError(message); setStatus(message);
    return false;
  }, []);

  const previewRecoveryDraft = useCallback((id: string): RecoveryDraftPreview | null => {
    if (!ready) { recoveryFailed("Wait for your kitchen to finish loading before reviewing a draft."); return null; }
    const entry = recoveryEntries.current.get(id);
    try {
      if (!entry || privateStorage.getItem(id) !== entry.serialized) {
        refreshRecovery(); recoveryFailed("That draft changed in another tab. Review its updated details and choose again."); return null;
      }
      const token = randomId();
      recoveryPreview.current = { id, token, currentState: JSON.stringify(latest.current), currentRevision: revision.current, candidate: entry.serialized };
      const preview = Object.freeze({ id, token, updatedAt: entry.summary.updatedAt, revision: entry.cached.revision,
        changes: buildKitchenChangePreview(latest.current, effectiveRecoveryState(entry.cached.state)) });
      setRecoveryError("");
      return preview;
    } catch { recoveryFailed("The browser could not read that draft. Retry before recovering it."); return null; }
  }, [effectiveRecoveryState, privateStorage, ready, refreshRecovery, recoveryFailed]);

  const recoverDraft = useCallback((id: string, expectedReview?: RecoveryDraftPreview): boolean => {
    if (!ready || saving.current || paused.current) {
      return recoveryFailed("Finish saving or resolve the current conflict before recovering another kitchen.");
    }
    const entry = recoveryEntries.current.get(id);
    try {
      if (!entry || privateStorage.getItem(id) !== entry.serialized) {
        refreshRecovery(); return recoveryFailed("That draft changed in another tab. Review its updated details and choose again.");
      }
      if (expectedReview) {
        const reviewed = recoveryPreview.current;
        if (!reviewed || reviewed.id !== id || expectedReview.id !== id || reviewed.token !== expectedReview.token
          || reviewed.candidate !== entry.serialized || reviewed.currentRevision !== revision.current || reviewed.currentState !== JSON.stringify(latest.current)) {
          return recoveryFailed("The kitchen or draft changed after this preview. Review the updated differences before recovering it.");
        }
      }
      if (!preserveCurrent("before-recovery", setRecoveryError)) return false;
      const previousRevision = revision.current;
      const previousBase = baseSnapshot.current;
      revision.current = entry.cached.revision;
      rememberBase(entry.cached.base ?? null);
      const next = effectiveRecoveryState(entry.cached.state);
      if (!cache(next, true, setRecoveryError)) { revision.current = previousRevision; rememberBase(previousBase); return false; }
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
      recoveryPreview.current = null;
      setRecoveryError("");
      return true;
    } catch {
      return recoveryFailed("The browser could not read that draft. Export your current kitchen and retry.");
    }
  }, [cache, effectiveRecoveryState, preserveCurrent, ready, refreshRecovery, privateStorage, rememberBase, recoveryFailed]);

  const discardDraft = useCallback((id: string): boolean => {
    const entry = recoveryEntries.current.get(id);
    try {
      if (!entry || privateStorage.getItem(id) !== entry.serialized) {
        refreshRecovery(); setStatus("That draft changed in another tab. Review it again before discarding."); return false;
      }
      privateStorage.removeItem(id);
      refreshRecovery();
      return true;
    } catch { setStatus("The browser could not remove that draft."); return false; }
  }, [refreshRecovery, privateStorage]);

  let conflictRows: ReturnType<typeof mergeKitchenDraft>["conflicts"] = [];
  let conflictError = conflict ? mergeError : "";
  if (hosted && conflict) {
    try {
      conflictRows = mergeKitchenDraft(mergeBase, state, conflict.state ?? structuredClone(EMPTY_KITCHEN)).conflicts;
    } catch (error) {
      conflictError = conflictFailure(error);
    }
  }

  const saveState: KitchenSaveState = savePhase === "saved" && JSON.stringify(state) !== savedSnapshot ? "pending" : savePhase;
  return { state, update, ready, status, saveState, recoverable: JSON.stringify(state) === browserSnapshot || JSON.stringify(state) === savedSnapshot, getRevision: () => revision.current, refreshSavedKitchen, backupAvailable, conflict, conflictRows, conflictError, resolveConflict, retrySave: () => setRetry((value) => value + 1),
    busy: savePhase === "saving" || Boolean(conflict), recoveryCandidates, recoveryError, previewRecoveryDraft, recoverDraft, discardDraft, restoreBackup };
}
