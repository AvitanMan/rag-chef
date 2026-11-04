"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AppSessionContext, disablePrivateOfflineShell, kitchenFetch, scheduleSessionExpiry, type AppSession, type SessionWork } from "../lib/app-session";
import { accountStoragePrefix, browserScope, clearAccountStorage, clearStoragePrefix, migrateSecureLocalStorage, mirroredStorage, scopedStorage, SECURE_LOCAL_PREFIX } from "../lib/private-storage";
import { Modal } from "./Modal";

const LOGOUT_EVENT = "rag-chef-session-logout";
const LOGOUT_CHANNEL = "rag-chef-session";

export function AppSessionGate({ hosted, localServer, children }: { hosted: boolean; localServer?: AppSession["localServer"]; children: ReactNode }) {
  const secureLocal = !hosted && Boolean(localServer?.requiresPassword);
  const protectedMode = hosted || secureLocal;
  const anonymous = useCallback((): AppSession => hosted ? { mode: "hosted", authenticated: false } : { mode: "local", authenticated: false, localServer: { requiresPassword: true } }, [hosted]);
  const [session, setSession] = useState<AppSession | null>(protectedMode ? null : { mode: "local", authenticated: true, ...(localServer ? { localServer } : {}) });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [memoryOnly, setMemoryOnly] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [username, setUsername] = useState("chef");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [name, setName] = useState("Our kitchen");
  const [timezone, setTimezone] = useState("");
  const current = useRef(session);
  const sessionRequest = useRef(0);
  const authOperation = useRef(false);
  const works = useRef(new Map<string, SessionWork>());
  const channel = useRef<BroadcastChannel | null>(null);
  const identity = session?.authenticated ? session.mode === "hosted" && session.user && session.household ? `${session.user.id}:${session.household.id}` : secureLocal ? `local:${session.localAccess?.sessionId ?? ""}` : "local" : "";
  const lifetime = useMemo(() => browserScope(identity), [identity]);
  const live = useRef(lifetime);
  useEffect(() => { lifetime.activate(); live.current = lifetime; return () => { lifetime.revoke(); }; }, [lifetime]);
  const memory = useMemo(() => ({ local: new Map<string, string>(), tab: new Map<string, string>() }), []);
  const rawStorage = useMemo(() => ({ local: mirroredStorage(() => window.localStorage, memory.local), tab: mirroredStorage(() => window.sessionStorage, memory.tab) }), [memory]);
  const registerSessionWork = useCallback((key: string, work: SessionWork) => {
    works.current.set(key, work);
    return () => { if (works.current.get(key) === work) works.current.delete(key); };
  }, []);
  const checkpoint = useCallback(() => {
    let durable = true;
    for (const work of works.current.values()) try { work.checkpoint(); } catch { durable = false; }
    if (!durable) setMemoryOnly(true);
  }, []);
  const clearPrivate = useCallback((previous: AppSession | null): boolean => {
    let cleared = true;
    for (const storage of [rawStorage.local, rawStorage.tab]) {
      try {
        if (secureLocal) clearStoragePrefix(storage, SECURE_LOCAL_PREFIX);
        else if (previous?.user) clearAccountStorage(storage, previous.user.id);
      } catch { cleared = false; }
    }
    // Clear mirrors even if browser policy rejected deletion; never hand an old
    // in-memory copy to a later session after an explicit sign-out.
    memory.local.clear(); memory.tab.clear();
    try { window.history.replaceState(null, "", window.location.pathname); } catch { cleared = false; }
    return cleared;
  }, [memory, rawStorage, secureLocal]);
  const lockLocal = useCallback(() => {
    if (!secureLocal || !current.current?.authenticated) return;
    checkpoint(); live.current.revoke();
    sessionRequest.current++;
    current.current = anonymous(); setSession(current.current); setExpired(true); setConfirmSignOut(false); setBusy(false);
  }, [anonymous, checkpoint, secureLocal]);
  const adoptSession = useCallback((next: AppSession) => {
    const previous = current.current;
    if (secureLocal && next.authenticated && (!next.localAccess?.sessionId || !Number.isFinite(Date.parse(next.localAccess.expiresAt)))) throw new Error("The server returned an invalid session. Retry to reconnect.");
    const changed = secureLocal ? previous?.localAccess?.sessionId !== next.localAccess?.sessionId : previous?.user?.id !== next.user?.id || previous?.household?.id !== next.household?.id;
    let cleared = true;
    if (previous?.authenticated && changed) {
      if (secureLocal) checkpoint();
      live.current.revoke();
      if (!secureLocal) cleared = clearPrivate(previous);
    }
    if (secureLocal && next.authenticated) {
      for (const storage of [rawStorage.local, rawStorage.tab]) try { migrateSecureLocalStorage(storage); } catch { setMemoryOnly(true); }
    }
    if (secureLocal && previous?.authenticated && !next.authenticated) setExpired(true);
    current.current = next;
    setSession(previousState => JSON.stringify(previousState) === JSON.stringify(next) ? previousState : next);
    setError(cleared ? "" : "Your account changed. Browser storage cleanup was blocked; clear this site’s data on shared computers.");
  }, [checkpoint, clearPrivate, rawStorage, secureLocal]);
  const refreshSession = useCallback(async () => {
    if (!protectedMode || authOperation.current) return;
    const requestId = ++sessionRequest.current;
    try {
      const response = await fetch("/api/session", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) { const result = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(result?.error?.message ?? "The kitchen server is unavailable. Reconnect and retry."); }
      const next = await response.json() as AppSession;
      if (next.mode !== (hosted ? "hosted" : "local") || typeof next.authenticated !== "boolean") throw new Error("The server returned an invalid session. Retry to reconnect.");
      if (requestId === sessionRequest.current) adoptSession(next);
    } catch (cause) { if (requestId === sessionRequest.current) setError(cause instanceof Error ? cause.message : "Could not check your session."); }
  }, [adoptSession, hosted, protectedMode]);

  useEffect(() => {
    const initial = window.setTimeout(() => { setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone); void refreshSession(); }, 0);
    const check = () => { if (document.visibilityState === "visible") void refreshSession(); };
    const interval = protectedMode ? window.setInterval(check, 30_000) : undefined;
    window.addEventListener("focus", check); window.addEventListener("pageshow", check); window.addEventListener("rag-chef-session-check", check);
    document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(initial); clearInterval(interval); window.removeEventListener("focus", check); window.removeEventListener("pageshow", check); window.removeEventListener("rag-chef-session-check", check); document.removeEventListener("visibilitychange", check); };
  }, [protectedMode, refreshSession]);
  useEffect(() => {
    if (!secureLocal || !session?.localAccess) return;
    return scheduleSessionExpiry(session.localAccess.expiresAt, lockLocal);
  }, [lockLocal, secureLocal, session?.localAccess]);
  useEffect(() => {
    if (!protectedMode) return;
    // A previous worker may still control this page after unregistering. Tell it
    // to stop serving cached pages before removing registration and old caches.
    void disablePrivateOfflineShell();
  }, [protectedMode]);
  useEffect(() => {
    if (!protectedMode) return;
    const receive = () => {
      const previous = current.current;
      live.current.revoke(); sessionRequest.current++;
      const cleared = clearPrivate(previous);
      current.current = anonymous(); setSession(current.current); setExpired(false); setConfirmSignOut(false); setBusy(false);
      setError(cleared ? "This device was signed out in another tab." : "This device was signed out. Browser cleanup was blocked; clear this site’s data on shared computers.");
    };
    try { channel.current = new BroadcastChannel(LOGOUT_CHANNEL); channel.current.onmessage = event => { if (event.data?.type === "logout") receive(); }; } catch { /* Storage events provide a fallback. */ }
    const storageEvent = (event: StorageEvent) => { if (event.key === LOGOUT_EVENT && event.newValue) receive(); };
    window.addEventListener("storage", storageEvent);
    return () => { channel.current?.close(); channel.current = null; window.removeEventListener("storage", storageEvent); };
  }, [anonymous, clearPrivate, protectedMode]);

  const performSignOut = useCallback(async (save: boolean) => {
    authOperation.current = true;
    sessionRequest.current++;
    setBusy(true); setError("");
    try {
      if (save) for (const work of works.current.values()) if (!await work.save()) throw new Error("Your changes could not be saved. Keep working to resolve the problem, or explicitly discard them.");
      checkpoint();
      const headers = new Headers({ "Content-Type": "application/json" });
      if (current.current?.localAccess) headers.set("X-Rag-Chef-Session", current.current.localAccess.sessionId);
      const response = await fetch(secureLocal ? "/api/local-auth/sign-out" : "/api/auth/sign-out", { method: "POST", headers, body: "{}", cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("Sign-out failed. You are still signed in; reconnect and retry.");
      live.current.revoke(); sessionRequest.current++;
      const cleared = clearPrivate(current.current);
      current.current = anonymous(); setSession(current.current); setExpired(false); setConfirmSignOut(false); setMemoryOnly(false);
      channel.current?.postMessage({ type: "logout" });
      try { window.localStorage.setItem(LOGOUT_EVENT, String(Date.now())); window.localStorage.removeItem(LOGOUT_EVENT); } catch { /* BroadcastChannel is the primary signal. */ }
      if (!cleared) setError("You are signed out. Browser storage cleanup was blocked; clear this site’s data on shared computers.");
    } catch (cause) { setError(cause instanceof TypeError ? "Sign-out failed. You are still signed in; reconnect and retry." : cause instanceof Error ? cause.message : "Could not sign out."); }
    finally { authOperation.current = false; setBusy(false); }
  }, [anonymous, checkpoint, clearPrivate, secureLocal]);
  const signOut = useCallback(async () => {
    if ([...works.current.values()].some(work => work.hasPending())) { setError(""); setConfirmSignOut(true); return; }
    await performSignOut(false);
  }, [performSignOut]);
  const prefix = secureLocal ? SECURE_LOCAL_PREFIX : session?.mode === "hosted" && session.user && session.household ? accountStoragePrefix(session.user.id, session.household.id) : "";
  const storage = useMemo(() => ({
    local: scopedStorage(() => secureLocal ? rawStorage.local : window.localStorage, prefix, () => lifetime.isActive()),
    tab: scopedStorage(() => secureLocal ? rawStorage.tab : window.sessionStorage, prefix, () => lifetime.isActive()),
    storageKey: (key: string) => prefix + key,
  }), [lifetime, prefix, rawStorage, secureLocal]);
  const context = useMemo(() => ({ session: session ?? anonymous(), ...storage, refreshSession, signOut, registerSessionWork,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!lifetime.isActive()) throw new Error("Your sign-in changed. Sign in again before continuing.");
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (session?.mode === "hosted" && session.user && session.household) { headers.set("X-Rag-Chef-Actor", session.user.id); headers.set("X-Rag-Chef-Household", session.household.id); }
      if (session?.localAccess) headers.set("X-Rag-Chef-Session", session.localAccess.sessionId);
      const suppliedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const response = await kitchenFetch(input, { ...init, headers, signal: suppliedSignal ? AbortSignal.any([suppliedSignal, lifetime.signal]) : lifetime.signal });
      if (secureLocal && (response.status === 401 || response.status === 403)) {
        const problem = await response.clone().json().catch(() => null) as { error?: { code?: string } } | null;
        if (problem?.error?.code === "LAN_SIGN_IN_REQUIRED" || problem?.error?.code === "SESSION_SCOPE_CHANGED") lockLocal();
      }
      if (!lifetime.isActive()) throw new Error("Your sign-in changed. Your draft is preserved; sign in again.");
      return response;
    },
  }), [anonymous, lifetime, lockLocal, refreshSession, registerSessionWork, secureLocal, session, signOut, storage]);

  async function signInLocal(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    authOperation.current = true;
    const requestId = ++sessionRequest.current;
    try {
      const response = await fetch("/api/local-auth/sign-in", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, remember }), cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as AppSession & { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Could not sign in. Check your kitchen username and password.");
      if (requestId !== sessionRequest.current) return;
      if (result.mode !== "local" || !result.authenticated) throw new Error("Sign-in could not be confirmed. Please retry.");
      adoptSession(result); setPassword(""); setShowPassword(false); setExpired(false);
    } catch (cause) { if (requestId === sessionRequest.current) setError(cause instanceof TypeError ? "Could not reach your kitchen. Reconnect and retry." : cause instanceof Error ? cause.message : "Could not sign in."); }
    finally { authOperation.current = false; setBusy(false); }
  }
  async function signInGoogle() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/sign-in/social", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "google", callbackURL: window.location.href }) });
      const result = await response.json() as { url?: string };
      if (!response.ok || typeof result.url !== "string") throw new Error("Google sign-in is not configured or unavailable. Please retry later.");
      window.location.assign(result.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-in failed."); setBusy(false); }
  }
  async function joinOrCreate() {
    setBusy(true); setError("");
    try {
      const invitationId = new URL(window.location.href).searchParams.get("invitation");
      const response = await fetch(invitationId ? "/api/household/invitations/accept" : "/api/household", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(invitationId ? { invitationId } : { name, timezone }) });
      const result = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Could not join this kitchen.");
      window.history.replaceState(null, "", "/"); await refreshSession();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not join this kitchen."); }
    finally { setBusy(false); }
  }
  if (session?.authenticated && (session.mode === "local" || session.household)) {
    return <AppSessionContext.Provider value={context}><div key={identity}>{error && <div className="session-notice" role="status">{error}<button onClick={() => void refreshSession()}>Retry connection</button></div>}{children}</div>
      {confirmSignOut && <Modal className="kitchen-modal panel signout-dialog" label="Sign out of this device" close={() => { if (!busy) setConfirmSignOut(false); }}><span className="eyebrow">Before you go</span><h2>Keep your kitchen changes?</h2><p>You have unsaved changes or a cooking session on this device. Signing out clears this browser’s drafts, cooking progress, and timers. Saved pantry items and dinners stay in your kitchen.</p>{error && <p role="alert">{error}</p>}<div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => setConfirmSignOut(false)}>Keep working</button><button className="primary-button" disabled={busy} onClick={() => void performSignOut(true)}>{busy ? "Signing out…" : "Save and sign out"}</button><button className="text-button" disabled={busy} onClick={() => void performSignOut(false)}>Discard and sign out</button></div></Modal>}
    </AppSessionContext.Provider>;
  }
  if (secureLocal) return <main className="account-gate local-login"><section className="login-story" aria-label="Welcome to RAG Chef"><span className="brand-mark" aria-hidden="true">R</span><span className="eyebrow">RAG Chef · your home kitchen</span><h1>Something good<br /> starts here.</h1><p>Cook with what you have. Plan a few dinners. Make room for the everyday.</p><div className="login-story-note">Your pantry, your plans, your kitchen.</div></section><section className="panel account-panel login-panel" aria-labelledby="local-login-title"><span className="eyebrow">Welcome back</span><h2 id="local-login-title">Open your kitchen</h2><p>Sign in to the kitchen running on your household computer.</p>
    {!session ? <p role="status">Checking your sign-in…</p> : <form onSubmit={signInLocal} aria-label="Kitchen sign-in"><label htmlFor="kitchen-username">Username</label><input id="kitchen-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64} value={username} onChange={event => setUsername(event.target.value)} disabled={busy} /><label htmlFor="kitchen-password">Password</label><div className="password-field"><input id="kitchen-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required maxLength={128} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /><button className="text-button" type="button" aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? "Hide" : "Show"}</button></div><label className="remember-device"><input name="remember" type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} disabled={busy} /><span>Remember this device for 30 days</span></label><p className="quantity-note">Without this option, your session ends after 12 hours. Leave it unchecked on a shared device.</p><button type="submit" className="primary-button login-submit" disabled={busy || !username.trim() || !password}>{busy ? "Opening your kitchen…" : "Open kitchen"}</button></form>}
    {expired && <p role="status">Your session ended. Sign in again to recover your work.{memoryOnly ? " Keep this tab open: your draft is held here because browser storage is unavailable." : ""}</p>}{error && <p className="login-error" role="alert">{error}</p>}{error && <button className="text-button" disabled={busy} onClick={() => void refreshSession()}>Retry connection</button>}<details className="login-help"><summary>Need help signing in?</summary><p>Use the shared kitchen username and password supplied by the person running RAG Chef. They can find them in <code>.wrangler/local-https/credentials.json</code> on that computer. Keep the computer on and connect to the same Wi-Fi.</p><p>Changing between the friendly kitchen address and its IP address requires a separate sign-in.</p></details></section></main>;
  return <main className="account-gate"><section className="panel account-panel"><span className="eyebrow">RAG Chef · invited families</span><h1>Your kitchen, together</h1>
    {!session ? <p role="status">Checking your sign-in…</p> : !session.authenticated ? <><p>Sign in to your family’s pantry, dinners, and shopping list. Connect your own AI when you are ready.</p><button className="primary-button" disabled={busy} onClick={() => void signInGoogle()}>Continue with Google</button></> : <><p>Signed in as {session.user?.email}.</p>{typeof window !== "undefined" && new URL(window.location.href).searchParams.has("invitation") ? <><p>Accept this invitation to share the family kitchen.</p><button className="primary-button" disabled={busy} onClick={() => void joinOrCreate()}>Accept kitchen invitation</button></> : session.canCreateHousehold ? <><label>Kitchen name<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><label>Household timezone<input value={timezone} onChange={event => setTimezone(event.target.value)} /></label><button className="primary-button" disabled={busy || !name.trim() || !timezone} onClick={() => void joinOrCreate()}>Create family kitchen</button></> : <p>An invitation is needed. Open the link shared by your kitchen owner, or ask the beta administrator for access.</p>}<button className="text-button" disabled={busy} onClick={() => void signOut()}>Sign out</button></>}
    {error && <p role="alert">{error}</p>}<button className="text-button" disabled={busy} onClick={() => void refreshSession()}>Retry sign-in status</button></section></main>;
}
