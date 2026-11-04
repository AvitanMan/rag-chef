"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppSessionContext, kitchenFetch, type AppSession } from "../lib/app-session";
import { accountStoragePrefix, browserScope, clearAccountStorage, scopedStorage } from "../lib/private-storage";

export function AppSessionGate({ hosted, localServer, children }: { hosted: boolean; localServer?: AppSession["localServer"]; children: ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(hosted ? null : { mode: "local", authenticated: true, ...(localServer ? { localServer } : {}) });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("Our kitchen");
  const [timezone, setTimezone] = useState("");
  const current = useRef(session);
  const identity = session?.user?.id && session.household ? `${session.user.id}:${session.household.id}` : session?.mode === "local" ? "local" : "";
  const lifetime = useMemo(() => browserScope(identity), [identity]);
  const sessionRequest = useRef(0);
  const clearPrivate = useCallback((userId?: string): boolean => {
    if (!userId) return true;
    let cleared = true;
    // Browser storage can be blocked independently. Cleanup failure must never
    // leave a signed-out account mounted or prevent the next session replacing it.
    try { clearAccountStorage(window.localStorage, userId); } catch { cleared = false; }
    try { clearAccountStorage(window.sessionStorage, userId); } catch { cleared = false; }
    try { window.history.replaceState(null, "", window.location.pathname); } catch { cleared = false; }
    return cleared;
  }, []);
  const refreshSession = useCallback(async () => {
    if (!hosted) return;
    const requestId = ++sessionRequest.current;
    try {
      const response = await fetch("/api/session", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("Sign-in is temporarily unavailable. Retry to reconnect.");
      const next = await response.json() as AppSession;
      if (next.mode !== "hosted" || typeof next.authenticated !== "boolean") throw new Error("The server returned an invalid session. Retry to reconnect.");
      if (requestId !== sessionRequest.current) return;
      const previous = current.current;
      let cleared = true;
      if (previous?.user && (previous.user.id !== next.user?.id || previous.household?.id !== next.household?.id)) {
        lifetime.revoke();
        cleared = clearPrivate(previous.user.id);
      }
      current.current = next;
      setSession(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); setError(cleared ? "" : "Your account changed. Browser storage cleanup was blocked; clear this site’s data on shared computers.");
    } catch (cause) { if (requestId === sessionRequest.current) setError(cause instanceof Error ? cause.message : "Could not check your session."); }
  }, [clearPrivate, hosted, lifetime]);
  useEffect(() => {
    lifetime.activate();
    const timer = window.setTimeout(() => { setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone); void refreshSession(); }, 0);
    const check = () => { if (document.visibilityState === "visible") void refreshSession(); };
    const interval = hosted ? window.setInterval(check, 30_000) : undefined;
    window.addEventListener("focus", check); window.addEventListener("rag-chef-session-check", check);
    return () => { lifetime.revoke(); clearTimeout(timer); clearInterval(interval); window.removeEventListener("focus", check); window.removeEventListener("rag-chef-session-check", check); };
  }, [hosted, lifetime, refreshSession]);
  const signOut = useCallback(async () => {
    sessionRequest.current++;
    setBusy(true);
    try {
      const response = await fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("Sign-out failed. Retry while connected.");
      lifetime.revoke(); const cleared = clearPrivate(current.current?.user?.id);
      sessionRequest.current++;
      current.current = { mode: "hosted", authenticated: false }; setSession(current.current);
      if (!cleared) setError("You are signed out. Browser storage cleanup was blocked; clear this site’s data on shared computers.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign out."); }
    finally { setBusy(false); }
  }, [clearPrivate, lifetime]);
  const prefix = session?.mode === "hosted" && session.user && session.household ? accountStoragePrefix(session.user.id, session.household.id) : "";
  const storage = useMemo(() => ({
    local: scopedStorage(() => window.localStorage, prefix, () => lifetime.isActive()),
    tab: scopedStorage(() => window.sessionStorage, prefix, () => lifetime.isActive()),
    storageKey: (key: string) => prefix + key,
  }), [lifetime, prefix]);
  const context = useMemo(() => ({ session: session ?? { mode: "hosted" as const, authenticated: false }, ...storage, refreshSession, signOut,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      if (!lifetime.isActive()) return Promise.reject(new Error("Your sign-in changed. Refresh the kitchen before continuing."));
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (session?.mode === "hosted" && session.user && session.household) {
        headers.set("X-Rag-Chef-Actor", session.user.id); headers.set("X-Rag-Chef-Household", session.household.id);
      }
      return kitchenFetch(input, { ...init, headers });
    },
  }), [session, storage, refreshSession, signOut, lifetime]);

  async function signIn() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/sign-in/social", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "google", callbackURL: window.location.href }) });
      const result = await response.json() as { url?: string; error?: { message?: string } };
      if (!response.ok || typeof result.url !== "string") throw new Error("Google sign-in is not configured or unavailable. Please retry later.");
      window.location.assign(result.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-in failed."); setBusy(false); }
  }
  async function joinOrCreate() {
    setBusy(true); setError("");
    try {
      const invitationId = new URL(window.location.href).searchParams.get("invitation");
      const response = await fetch(invitationId ? "/api/household/invitations/accept" : "/api/household", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(invitationId ? { invitationId } : { name, timezone }) });
      const result = await response.json() as { url?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Could not join this kitchen.");
      window.history.replaceState(null, "", "/"); await refreshSession();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not join this kitchen."); }
    finally { setBusy(false); }
  }
  if (session && (session.mode === "local" || session.authenticated && session.household)) {
    return <AppSessionContext.Provider value={context}><div key={identity}>{error && <div className="session-notice" role="status">{error}<button onClick={() => void refreshSession()}>Retry connection</button></div>}{children}</div></AppSessionContext.Provider>;
  }
  return <main className="account-gate"><section className="panel account-panel"><span className="eyebrow">RAG Chef · invited families</span><h1>Your kitchen, together</h1>
    {!session ? <p role="status">Checking your sign-in…</p> : !session.authenticated ? <><p>Sign in to your family’s pantry, dinners, and shopping list. Connect your own AI when you are ready.</p><button className="primary-button" disabled={busy} onClick={() => void signIn()}>Continue with Google</button></> : <>
      <p>Signed in as {session.user?.email}.</p>
      {typeof window !== "undefined" && new URL(window.location.href).searchParams.has("invitation") ? <><p>Accept this invitation to share the family kitchen.</p><button className="primary-button" disabled={busy} onClick={() => void joinOrCreate()}>Accept kitchen invitation</button></> : session.canCreateHousehold ? <><label>Kitchen name<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><label>Household timezone<input value={timezone} onChange={event => setTimezone(event.target.value)} /></label><button className="primary-button" disabled={busy || !name.trim() || !timezone} onClick={() => void joinOrCreate()}>Create family kitchen</button></> : <p>An invitation is needed. Open the link shared by your kitchen owner, or ask the beta administrator for access.</p>}
      <button className="text-button" disabled={busy} onClick={() => void signOut()}>Sign out</button></>}
    {error && <p role="alert">{error}</p>}<button className="text-button" disabled={busy} onClick={() => void refreshSession()}>Retry sign-in status</button>
  </section></main>;
}
