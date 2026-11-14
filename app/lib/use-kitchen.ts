"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppSession } from "./app-session";
import { applyKitchenCommand, type KitchenCommand, type KitchenCommandInput } from "./kitchen-commands";
import { parseKitchenCommand } from "./kitchen-command-validation";
import type { KitchenCommandResult } from "./kitchen-command-types";
import { appendKitchenCommand, appendKitchenSnapshot, hasAttemptedKitchenCommand, prepareKitchenWrite, projectKitchenWrites, type PendingKitchenWrite } from "./kitchen-write-queue";
import type { KitchenDocument, KitchenState } from "./kitchen-types";
import { DEFAULT_COOKING_PROFILE, EMPTY_KITCHEN } from "./kitchen-types";
import { KITCHEN_CACHE_KEY, LEGACY_STORAGE_KEY, PREFERENCES_STORAGE_KEY, migrateLegacyKitchen } from "./kitchen-state";
import type { Recipe } from "./recipe-types";
import { parseCachedKitchen, readRecoveryDrafts, type DraftReason, type RecoveryCandidate, type RecoveryEntry } from "./kitchen-recovery";
import { parseLegacyCookingProfile, validateKitchenWrite } from "./kitchen-validation";

export type KitchenSaveState = "loading" | "pending" | "saving" | "saved" | "offline" | "error" | "conflict";

export function useKitchen(fallbackRecipes: Recipe[]) {
  const { local: privateStorage, tab: privateTabStorage, storageKey, session, fetch: kitchenFetch } = useAppSession();
  const hosted = session.mode === "hosted";
  const canEditProfile = !hosted || session.household?.role === "owner";
  const savedLocation = hosted ? "the shared kitchen" : "this Mac";
  const savedAt = hosted ? "in the shared kitchen" : "on this Mac";
  const [state, setState] = useState<KitchenState>(EMPTY_KITCHEN);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Loading your kitchen…");
  const [savePhase, setSavePhase] = useState<KitchenSaveState>("loading");
  const [backupAvailable, setBackupAvailable] = useState(true);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [browserSnapshot, setBrowserSnapshot] = useState("");
  const [conflict, setConflict] = useState<KitchenDocument | null>(null);
  const [retry, setRetry] = useState(0);
  const [recoveryCandidates, setRecoveryCandidates] = useState<RecoveryCandidate[]>([]);
  const latest = useRef(state);
  const writes = useRef<PendingKitchenWrite[]>([]);
  const revision = useRef(0);
  const savedJson = useRef("");
  const saving = useRef(false);
  const paused = useRef(false);
  const storageAvailable = useRef(true);
  const draftKey = useRef("");
  const reopenedDraftKey = useRef<string | null>(null);
  const connected = useRef(false);
  const recoveryEntries = useRef(new Map<string, RecoveryEntry>());
  const serverDocument = useRef<KitchenDocument | null>(null);

  const refreshRecovery = useCallback(() => {
    try {
      const entries = readRecoveryDrafts(privateStorage, latest.current, draftKey.current);
      recoveryEntries.current = new Map(entries.map((entry) => [entry.summary.id, entry]));
      setRecoveryCandidates(entries.map((entry) => entry.summary));
    } catch { /* Storage failure is reported by the draft writer. */ }
  }, [privateStorage]);

  const cache = useCallback((value: KitchenState, dirty: boolean) => {
    try {
      dirty = dirty || writes.current.length > 0;
      const serialized = JSON.stringify({ revision: revision.current, state: value, dirty, ...(writes.current.length ? { writeQueue: { version: 1, writes: writes.current } } : {}), updatedAt: new Date().toISOString() });
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
      setStatus(`Browser backup is full or unavailable. Keep this tab open until saved to ${savedLocation}.`);
      return false;
    }
  }, [refreshRecovery, privateStorage, privateTabStorage, savedLocation]);

  const preserveCurrent = useCallback((reason: DraftReason) => {
    try { validateKitchenWrite({ revision: revision.current, state: latest.current }); }
    catch (error) {
      setStatus(`Correct the current kitchen before replacing it: ${error instanceof Error ? error.message : "invalid kitchen data"}`);
      return false;
    }
    try {
      const id = `${KITCHEN_CACHE_KEY}:draft:${crypto.randomUUID()}`;
      privateStorage.setItem(id, JSON.stringify({ revision: revision.current, state: latest.current, dirty: true, ...(writes.current.length ? { writeQueue: { version: 1, writes: writes.current } } : {}), reason, updatedAt: new Date().toISOString() }));
      return true;
    } catch {
      setStatus("Could not preserve your current kitchen. Free browser storage or export it before replacing it.");
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
      draftKey.current ||= `${KITCHEN_CACHE_KEY}:draft:${crypto.randomUUID()}`;
      try {
        const previousDraftKey = privateTabStorage.getItem(`${KITCHEN_CACHE_KEY}:tab-draft`);
        // A fresh key on each page load also isolates duplicated browser tabs.
        // React may replay this effect while the first GET is still pending;
        // keep its original source rather than reading our empty destination.
        if (previousDraftKey !== draftKey.current) reopenedDraftKey.current = previousDraftKey;
        privateTabStorage.setItem(`${KITCHEN_CACHE_KEY}:tab-draft`, draftKey.current);
        const previousDraft = reopenedDraftKey.current ? privateStorage.getItem(reopenedDraftKey.current) : null;
        const parsedDraft = parseCachedKitchen(previousDraft);
        cached = parsedDraft?.dirty ? parsedDraft : parseCachedKitchen(privateStorage.getItem(KITCHEN_CACHE_KEY));
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
        chosen = cached.state;
        revision.current = cached.revision;
        writes.current = structuredClone(cached.writeQueue?.writes ?? []);
        // A lost command response can advance the server. Recover that exact
        // receipt before deciding whether later household edits conflict.
        if (document && document.revision !== cached.revision && !hasAttemptedKitchenCommand(writes.current)) {
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
      if (!writes.current.length && savedJson.current !== JSON.stringify(chosen)) writes.current = appendKitchenSnapshot([], chosen);
      latest.current = chosen;
      setSavedSnapshot(savedJson.current);
      connected.current = Boolean(document);
      serverDocument.current = document;
      setState(chosen);
      cache(chosen, savedJson.current !== JSON.stringify(chosen));
      setStatus(!storageAvailable.current ? `Browser backup is unavailable. Keep this tab open until saved to ${savedLocation}.` : paused.current ? "A newer saved kitchen exists. Choose which version to keep." : document ? `Kitchen loaded from ${savedLocation}` : "Offline — using the browser backup");
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
    if (!writes.current.length && savedJson.current !== JSON.stringify(latest.current)) writes.current = appendKitchenSnapshot([], latest.current);
    if (!writes.current.length) {
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
        } catch {
          setSavePhase("offline"); setStatus("Offline — using the browser backup. Reconnect and retry."); return;
        }
      }
      setSavePhase("saved");
      setStatus(storageAvailable.current ? `Saved ${savedAt} · browser backup ready` : `Saved ${savedAt} · browser backup unavailable`);
      return;
    }
    saving.current = true;
    setStatus("Saving your kitchen…"); setSavePhase("saving");
    let success = false;
    try {
      const head = prepareKitchenWrite(writes.current[0], revision.current);
      writes.current = [head, ...writes.current.slice(1)];
      // Persist the exact attempt before sending when browser storage is usable.
      // If storage is blocked, retain it in memory and keep the existing unload
      // warning: an available database can still save the user's kitchen.
      cache(latest.current, true);
      const response = await kitchenFetch(head.kind === "command" ? "/api/kitchen/commands" : "/api/kitchen", {
        method: head.kind === "command" ? "POST" : "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify(head.kind === "command" ? head.command : { revision: head.expectedRevision, state: head.state }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json() as KitchenCommandResult & KitchenDocument & { current?: KitchenDocument; error?: { code?: string; message?: string } };
      if (!response.ok) {
        // A terminal command rejection never turns into an automatic snapshot
        // overwrite. Let the user explicitly select a version for recovery.
        if (response.status === 409 || head.kind === "command" && [400, 403].includes(response.status)) {
          let current = result.current;
          if (!current) {
            const refreshed = await kitchenFetch("/api/kitchen", { signal: AbortSignal.timeout(5_000) });
            if (refreshed.ok) current = await refreshed.json() as KitchenDocument;
          }
          if (current) {
            paused.current = true; setConflict(current); serverDocument.current = current;
            cache(latest.current, true);
            setStatus(result.error?.message ?? "Another tab saved changes. Your draft is preserved; choose a version.");
            setSavePhase("conflict"); return;
          }
        }
        throw new Error(result.error?.message || "Save failed");
      }
      const acknowledged: KitchenDocument = head.kind === "command" ? result.document : result;
      if (!acknowledged || !Number.isSafeInteger(acknowledged.revision) || acknowledged.revision < 0
        || head.kind === "command" && result.commandId !== head.command.commandId) throw new Error("The server returned an invalid save receipt. Retry to confirm the pending write.");
      if (acknowledged.state) validateKitchenWrite({ revision: acknowledged.revision, state: acknowledged.state });
      writes.current = writes.current.slice(1);
      revision.current = acknowledged.revision;
      savedJson.current = JSON.stringify(acknowledged.state ?? EMPTY_KITCHEN);
      setSavedSnapshot(savedJson.current);
      const previouslyKnown = serverDocument.current;
      connected.current = true; serverDocument.current = acknowledged;
      // Replayed receipts intentionally contain an older document. Keep every
      // later local intent in order instead of replacing it with that receipt.
      const projected = projectKitchenWrites(acknowledged, writes.current, canEditProfile);
      latest.current = projected; setState(projected);
      cache(projected, writes.current.length > 0);
      success = true;
      if (head.kind === "command" && result.replayed && !writes.current.length) {
        // A receipt describes the original commit, not necessarily the newest
        // kitchen. Local mode has no poll, so refresh before claiming it current.
        let current = previouslyKnown && previouslyKnown.revision > acknowledged.revision ? previouslyKnown : null;
        let refreshed = false;
        try {
          const response = await kitchenFetch("/api/kitchen", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
          if (!response.ok) throw new Error();
          const received = await response.json() as KitchenDocument;
          if (!Number.isSafeInteger(received.revision) || received.revision < acknowledged.revision) throw new Error();
          if (received.state) validateKitchenWrite({ revision: received.revision, state: received.state });
          if (!current || received.revision >= current.revision) current = received;
          refreshed = true;
        } catch { /* A known newer document remains usable after a failed read. */ }
        if (current && current.revision !== revision.current) {
          serverDocument.current = current;
          if (writes.current.length) {
            // These edits were accepted against the receipt revision while the
            // read was pending. Preserve them without silently rebasing them.
            paused.current = true; setConflict(current); setSavePhase("conflict");
            cache(latest.current, true);
            setStatus("The saved kitchen changed while confirming a previous save. Your draft is preserved; choose a version.");
            return;
          }
          const next = current.state ?? structuredClone(EMPTY_KITCHEN);
          revision.current = current.revision; savedJson.current = JSON.stringify(next);
          latest.current = next; setState(next); setSavedSnapshot(savedJson.current);
          cache(next, false);
        }
        if (!refreshed) {
          connected.current = false;
          setSavePhase(writes.current.length ? "pending" : "offline");
          setStatus("The previous command is confirmed. Reconnect and retry to check for newer saved changes.");
          return;
        }
      }
      setStatus(storageAvailable.current ? `Saved ${savedAt} · browser backup ready` : `Saved ${savedAt} · browser backup unavailable`);
      setSavePhase(writes.current.length ? "pending" : "saved");
    } catch (error) {
      connected.current = false;
      setSavePhase(error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError") ? "offline" : "error");
      cache(latest.current, true);
      setStatus(storageAvailable.current
        ? `Changes kept in this browser. ${error instanceof Error && error.message !== "Failed to fetch" ? error.message : `Reconnect to save ${savedAt}.`}`
        : `Could not save to ${savedLocation} or the browser backup. Keep this tab open and retry saving.`);
    } finally {
      saving.current = false;
      if (success && writes.current.length) setRetry(value => value + 1);
    }
  }, [cache, ready, kitchenFetch, savedLocation, savedAt, canEditProfile]);


  useEffect(() => {
    if (!ready) return;
    cache(latest.current, writes.current.length > 0 || JSON.stringify(latest.current) !== savedJson.current);
    const timer = window.setTimeout(() => void flush(), 450);
    return () => window.clearTimeout(timer);
  }, [state, ready, retry, cache, flush]);

  useEffect(() => {
    const retrySave = () => setRetry((value) => value + 1);
    window.addEventListener("online", retrySave);
    window.addEventListener("storage", refreshRecovery);
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (!storageAvailable.current && (writes.current.length > 0 || JSON.stringify(latest.current) !== savedJson.current)) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => { window.removeEventListener("online", retrySave); window.removeEventListener("storage", refreshRecovery); window.removeEventListener("beforeunload", warnUnsaved); };
  }, [refreshRecovery]);

  useEffect(() => {
    if (hosted || process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    void navigator.serviceWorker.register("/kitchen-sw.js").then(async registered => {
      if (cancelled) { await registered.unregister(); return; }
      const registration = await navigator.serviceWorker.ready;
      if (cancelled) { await registration.unregister(); return; }
      const urls = ["/", ...performance.getEntriesByType("resource").map((entry) => entry.name)];
      registration.active?.postMessage({ type: "CACHE_SHELL", urls });
    }).catch(() => { /* D1 and browser drafts still work without an offline shell. */ });
    return () => { cancelled = true; };
  }, [hosted]);

  const update = useCallback((change: (current: KitchenState) => KitchenState) => {
    const next = change(latest.current);
    if (next === latest.current || JSON.stringify(next) === JSON.stringify(latest.current)) return;
    // Bulk plans are snapshot barriers between command writes. Never enqueue
    // from a React updater: concurrent rendering may replay that function.
    try { writes.current = appendKitchenSnapshot(writes.current, next); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Could not queue this change."); setSavePhase(paused.current ? "conflict" : "error"); return; }
    latest.current = next; setState(next);
    cache(next, true);
    setSavePhase(paused.current ? "conflict" : "pending");
  }, [cache]);

  const dispatch = useCallback((value: KitchenCommand) => {
    try {
      // Match the JSON wire representation, including omitted optional fields.
      const command = parseKitchenCommand(JSON.parse(JSON.stringify(value)));
      const next = applyKitchenCommand(latest.current, command, { revision: revision.current, canEditProfile });
      if (next === latest.current) return;
      if (writes.current.some(write => write.kind === "command" && write.command.commandId === command.commandId)) return;
      const preceding = !writes.current.length && savedJson.current !== JSON.stringify(latest.current) ? appendKitchenSnapshot([], latest.current) : writes.current;
      writes.current = appendKitchenCommand(preceding, command);
      latest.current = next; setState(next);
      cache(next, true);
      setSavePhase(paused.current ? "conflict" : "pending");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The kitchen command could not be prepared.");
      setSavePhase(paused.current ? "conflict" : "error");
    }
  }, [cache, canEditProfile]);

  const command = useCallback((input: KitchenCommandInput) => {
    dispatch({ ...input, commandId: crypto.randomUUID(), expectedRevision: revision.current });
  }, [dispatch]);

  const refreshSavedKitchen = useCallback(async (signal?: AbortSignal): Promise<KitchenDocument | null> => {
    if (!ready || saving.current || paused.current || hasAttemptedKitchenCommand(writes.current)) return null;
    const startingRevision = revision.current;
    try {
      const timeout = AbortSignal.timeout(5_000);
      const response = await kitchenFetch("/api/kitchen", { cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new Error();
      const current = await response.json() as KitchenDocument;
      if (current.state) validateKitchenWrite({ revision: current.revision, state: current.state });
      // A save or edit may have happened while this read was in flight.
      if (signal?.aborted || saving.current || paused.current || hasAttemptedKitchenCommand(writes.current) || revision.current !== startingRevision) return null;
      serverDocument.current = current;
      connected.current = true;
      if (current.revision === revision.current) return current;
      if (writes.current.length || JSON.stringify(latest.current) !== savedJson.current) {
        cache(latest.current, true);
        paused.current = true;
        setConflict(current);
        setSavePhase("conflict");
        setStatus("Another tab saved changes. Your draft is preserved; choose a version.");
        return null;
      }
      const next = current.state ?? structuredClone(EMPTY_KITCHEN);
      revision.current = current.revision;
      savedJson.current = JSON.stringify(next);
      latest.current = next;
      setSavedSnapshot(savedJson.current);
      setState(next);
      cache(next, false);
      setSavePhase("saved");
      setStatus(storageAvailable.current ? `Kitchen refreshed from ${savedLocation} · browser backup ready` : `Kitchen refreshed from ${savedLocation} · browser backup unavailable`);
      return current;
    } catch {
      if (signal?.aborted) return null;
      setStatus(`The saved kitchen could not be refreshed. Your current kitchen is unchanged; retry when ${savedLocation} is available.`);
      return null;
    }
  }, [cache, ready, kitchenFetch, savedLocation]);

  useEffect(() => {
    if (!ready) return;
    const refresh = () => { if (!hosted || document.visibilityState === "visible") void refreshSavedKitchen(); };
    const changed = (event: StorageEvent) => {
      if (event.key !== storageKey(KITCHEN_CACHE_KEY)) return;
      const saved = parseCachedKitchen(event.newValue);
      if (saved && !saved.dirty && saved.revision > revision.current) refresh();
    };
    window.addEventListener("storage", changed);
    window.addEventListener("focus", refresh);
    const poll = hosted ? window.setInterval(refresh, 5_000) : undefined;
    if (hosted) document.addEventListener("visibilitychange", refresh);
    return () => {
      if (poll !== undefined) window.clearInterval(poll);
      if (hosted) document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("storage", changed); window.removeEventListener("focus", refresh);
    };
  }, [ready, refreshSavedKitchen, hosted, storageKey]);

  const resolveConflict = useCallback((keepDraft: boolean) => {
    if (!conflict) return;
    serverDocument.current = conflict;
    // Choosing a complete version explicitly supersedes the old outbox. A
    // previously attempted command is never silently assigned a new revision.
    writes.current = [];
    revision.current = conflict.revision;
    paused.current = false;
    setConflict(null);
    if (keepDraft) {
      if (!canEditProfile) {
        const cookingProfile = conflict.state?.cookingProfile;
        const next = { ...latest.current };
        if (cookingProfile) next.cookingProfile = cookingProfile;
        else delete next.cookingProfile;
        latest.current = next;
        setState(next);
      }
      savedJson.current = "";
      writes.current = appendKitchenSnapshot([], latest.current);
      cache(latest.current, true);
      setSavePhase("pending");
      setRetry((value) => value + 1);
    } else {
      const savedState = conflict.state ?? structuredClone(EMPTY_KITCHEN);
      savedJson.current = JSON.stringify(savedState);
      setSavedSnapshot(savedJson.current);
      latest.current = savedState;
      setState(savedState);
      cache(savedState, false);
      setStatus(conflict.state ? `Loaded the saved version from ${savedLocation}` : "No kitchen was saved; loaded an empty kitchen");
      connected.current = true;
      setSavePhase("saved");
    }
  }, [cache, conflict, savedLocation, canEditProfile]);

  const restoreBackup = useCallback((value: KitchenState): boolean => {
    if (!ready || saving.current || paused.current) {
      setStatus("Finish saving or resolve the current conflict before restoring a backup.");
      return false;
    }
    try { validateKitchenWrite({ revision: revision.current, state: value }); }
    catch (error) { setStatus(error instanceof Error ? error.message : "This kitchen backup is invalid."); return false; }
    if (!preserveCurrent("before-restore")) return false;
    const next = structuredClone({ ...value, cookingProfile: (canEditProfile ? value.cookingProfile : latest.current.cookingProfile) ?? latest.current.cookingProfile ?? DEFAULT_COOKING_PROFILE });
    const previousWrites = writes.current;
    try { writes.current = appendKitchenSnapshot(writes.current, next); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Could not queue the restored kitchen."); setSavePhase("error"); return false; }
    if (!cache(next, true)) { writes.current = previousWrites; return false; }
    latest.current = next;
    savedJson.current = "";
    setState(next);
    setSavePhase("pending");
    setStatus("Backup restored in this browser. Your previous kitchen is available in unsaved kitchens.");
    setRetry((value) => value + 1);
    refreshRecovery();
    return true;
  }, [cache, preserveCurrent, ready, refreshRecovery, canEditProfile]);

  const recoverDraft = useCallback((id: string): boolean => {
    if (!ready || saving.current || paused.current || writes.current.length) {
      setStatus("Finish saving or resolve the current conflict before recovering another kitchen.");
      return false;
    }
    const entry = recoveryEntries.current.get(id);
    try {
      if (!entry || privateStorage.getItem(id) !== entry.serialized) {
        refreshRecovery(); setStatus("That draft changed in another tab. Review its updated details and choose again."); return false;
      }
      if (!preserveCurrent("before-recovery")) return false;
      const previousRevision = revision.current;
      const previousWrites = writes.current;
      revision.current = entry.cached.revision;
      writes.current = structuredClone(entry.cached.writeQueue?.writes ?? []);
      const next = structuredClone({ ...entry.cached.state, cookingProfile: (canEditProfile ? entry.cached.state.cookingProfile : latest.current.cookingProfile) ?? latest.current.cookingProfile ?? DEFAULT_COOKING_PROFILE });
      if (!writes.current.length) writes.current = appendKitchenSnapshot([], next);
      if (!cache(next, true)) { revision.current = previousRevision; writes.current = previousWrites; return false; }
      latest.current = next;
      savedJson.current = "";
      setState(next);
      const current = serverDocument.current;
      if (current && current.revision !== revision.current && !hasAttemptedKitchenCommand(writes.current)) {
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
  }, [cache, preserveCurrent, ready, refreshRecovery, privateStorage, canEditProfile]);

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

  const saveState: KitchenSaveState = savePhase === "saved" && JSON.stringify(state) !== savedSnapshot ? "pending" : savePhase;
  return { state, update, dispatch, command, ready, status, saveState, recoverable: JSON.stringify(state) === browserSnapshot || JSON.stringify(state) === savedSnapshot, getRevision: () => revision.current, refreshSavedKitchen, backupAvailable, conflict, resolveConflict, retrySave: () => setRetry((value) => value + 1),
    busy: savePhase === "saving" || Boolean(conflict), recoveryCandidates, recoverDraft, discardDraft, restoreBackup };
}
