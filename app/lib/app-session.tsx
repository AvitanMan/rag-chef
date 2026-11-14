"use client";

import { createContext, useContext } from "react";
import { scopedStorage } from "./private-storage";

export type AppSession = {
  mode: "local" | "hosted";
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
};

const localContext: SessionContext = {
  session: { mode: "local", authenticated: true },
  local: scopedStorage(() => window.localStorage),
  tab: scopedStorage(() => window.sessionStorage),
  storageKey: key => key,
  fetch: kitchenFetch,
  refreshSession: async () => {},
  signOut: async () => {},
};
export const AppSessionContext = createContext(localContext);
export const useAppSession = () => useContext(AppSessionContext);

export async function kitchenFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, cache: "no-store" });
  if (response.status === 401 || response.status === 403) {
    // Permission errors can also mean removal from the household. The gate checks
    // the session again; ordinary validation failures never discard local work.
    window.dispatchEvent(new Event("rag-chef-session-check"));
  }
  return response;
}
