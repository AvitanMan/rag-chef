"use client";

import { createContext, useContext } from "react";
import type { AISelection } from "./browser-ai";
import { scopedStorage } from "./private-storage";

export type AppSession = {
  mode: "local" | "hosted";
  localServer?: { origins?: string[]; aiDefaults?: AISelection; requiresPassword?: boolean };
  localAccess?: { sessionId: string; expiresAt: string; remembered: boolean };
  authenticated: boolean;
  user?: { id: string; name: string; email: string };
  household?: { id: string; name: string; role: "owner" | "member"; timezone: string; assistantEnabled: boolean };
  canCreateHousehold?: boolean;
  platformAdmin?: boolean;
};

export type SessionContext = {
  session: AppSession;
  local: Storage;
  tab: Storage;
  storageKey: (key: string) => string;
  fetch: typeof kitchenFetch;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
  registerSessionWork: (key: string, work: SessionWork) => () => void;
};

/** A component checkpoints synchronously before its authenticated scope ends. */
export type SessionWork = {
  hasPending: () => boolean;
  checkpoint: () => void;
  save: () => Promise<boolean>;
};

const localContext: SessionContext = {
  session: { mode: "local", authenticated: true },
  local: scopedStorage(() => window.localStorage),
  tab: scopedStorage(() => window.sessionStorage),
  storageKey: key => key,
  fetch: kitchenFetch,
  refreshSession: async () => {},
  signOut: async () => {},
  registerSessionWork: () => () => {},
};
export const AppSessionContext = createContext(localContext);
export const useAppSession = () => useContext(AppSessionContext);

/** Keep a fixed expiry scheduled even when it exceeds one browser timer. */
export function scheduleSessionExpiry(expiresAt: string, expire: () => void): () => void {
  const deadline = Date.parse(expiresAt);
  let timer: number | undefined;
  let cancelled = false;
  const check = () => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { expire(); return; }
    timer = window.setTimeout(check, Math.min(remaining, 2_147_000_000));
  };
  check();
  return () => { cancelled = true; window.clearTimeout(timer); };
}

/** Run at the authentication boundary, including before an anonymous login. */
export async function disablePrivateOfflineShell(): Promise<void> {
  await Promise.allSettled([
    (async () => {
      if (!("serviceWorker" in navigator)) return;
      navigator.serviceWorker.controller?.postMessage({ type: "DISABLE_SHELL" });
      const rows = await navigator.serviceWorker.getRegistrations();
      await Promise.all(rows.filter(row => [row.active, row.waiting, row.installing].some(worker => worker?.scriptURL.endsWith("/kitchen-sw.js"))).map(row => {
        row.active?.postMessage({ type: "DISABLE_SHELL" });
        return row.unregister();
      }));
    })(),
    (async () => {
      if (!("caches" in window)) return;
      const keys = await caches.keys();
      await Promise.all(keys.filter(key => key.startsWith("rag-chef-shell-")).map(key => caches.delete(key)));
    })(),
  ]);
}

export async function kitchenFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, cache: "no-store" });
  if (response.status === 401 || response.status === 403) {
    // Permission errors can also mean removal from the household. The gate checks
    // the session again; ordinary validation failures never discard local work.
    window.dispatchEvent(new Event("rag-chef-session-check"));
  }
  return response;
}
